import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import * as cheerio from "cheerio";

const ORIGIN = "https://www.whydrs.org";
const ROOT = new URL("../", import.meta.url).pathname;
const DATA_DIR = join(ROOT, "src/data");
const MEDIA_DIR = join(ROOT, "public/media");
const DOWNLOAD_DIR = join(ROOT, "public/downloads");
const CONCURRENCY = 8;
const BROKEN_LINK_REPLACEMENTS = new Map([
  ["/feedback", "/contact"],
  ["/learn-more/hashtags/34", "/learn-more"],
]);

const cleanText = (value = "") => value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const decodeCloudflareEmail = (value) => {
  const encoded = value.match(/email-protection#([a-f0-9]+)/i)?.[1];
  if (!encoded || encoded.length < 4) return "";
  const key = Number.parseInt(encoded.slice(0, 2), 16);
  let email = "";
  for (let index = 2; index < encoded.length; index += 2) {
    email += String.fromCharCode(Number.parseInt(encoded.slice(index, index + 2), 16) ^ key);
  }
  return email;
};
const absoluteUrl = (value, base) => {
  if (!value || value.startsWith("data:") || value.startsWith("wix:image:")) return "";
  try {
    const resolved = new URL(value, base).href;
    const email = decodeCloudflareEmail(resolved);
    return email ? `mailto:${email}` : resolved;
  } catch {
    return "";
  }
};

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "WhyDRS migration snapshot/1.0" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.text();
}

function xmlLocations(xml) {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1].replaceAll("&amp;", "&"));
}

function sanitizeInline($, element, pageUrl) {
  const fragment = cheerio.load(`<div id="root">${$(element).html() ?? ""}</div>`, null, false);
  fragment("script,style,noscript,svg,form,input,button,iframe").remove();
  fragment("#root").find("*").each((_, node) => {
    const tag = node.tagName?.toLowerCase();
    if (!tag) return;
    if (!["a", "strong", "b", "em", "i", "u", "br", "sup", "sub", "code", "span"].includes(tag)) {
      fragment(node).replaceWith(fragment(node).contents());
      return;
    }
    const href = tag === "a" ? absoluteUrl(fragment(node).attr("href"), pageUrl) : "";
    node.attribs = {};
    if (href) {
      node.attribs.href = href;
      if (href.startsWith("mailto:") && /email.*protected/i.test(fragment(node).text())) {
        fragment(node).text(href.slice(7));
      }
      if (!href.startsWith(ORIGIN)) node.attribs.rel = "noopener noreferrer";
    }
  });
  return fragment("#root").html()?.trim() ?? "";
}

function imageSource($image, pageUrl) {
  const direct = $image.attr("src") || $image.attr("data-src");
  if (direct) return absoluteUrl(direct, pageUrl);
  const srcset = $image.attr("srcset") || "";
  const candidate = srcset.split(",").at(-1)?.trim().split(/\s+/)[0];
  return absoluteUrl(candidate, pageUrl);
}

function extractPage(url, html) {
  const $ = cheerio.load(html);
  const $main = $("#PAGES_CONTAINER").first().length ? $("#PAGES_CONTAINER").first() : $("main").first();
  $main.find("script,style,noscript,svg,form,input,textarea,select,button").remove();

  const title = cleanText($("meta[property='og:title']").attr("content") || $("title").text() || new URL(url).pathname);
  const description = cleanText($("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || "");
  const blocks = [];
  const seenImages = new Set();

  $main.find("h1,h2,h3,h4,h5,h6,p,li,img,iframe").each((_, element) => {
    const $element = $(element);
    const tag = element.tagName.toLowerCase();

    if (tag === "img") {
      const src = imageSource($element, url);
      if (!src || seenImages.has(src) || (/\.gif(?:$|\?)/i.test(src) && /loader|loading/i.test(src))) return;
      seenImages.add(src);
      blocks.push({ type: "image", src, alt: cleanText($element.attr("alt") || "") });
      return;
    }

    if (tag === "iframe") {
      const src = absoluteUrl($element.attr("src") || $element.attr("data-src"), url);
      if (src) blocks.push({ type: "embed", src, title: cleanText($element.attr("title") || title) });
      return;
    }

    if (tag === "li" && $element.parents("li").length) return;
    if (tag === "p" && $element.parents("li").length) return;
    const text = cleanText($element.text());
    if (!text) return;
    const content = sanitizeInline($, element, url);
    const type = tag.startsWith("h") ? "heading" : tag === "li" ? "list-item" : "paragraph";
    const level = type === "heading" ? Number(tag.slice(1)) : undefined;
    const previous = blocks.at(-1);
    if (previous?.type === type && previous.text === text) return;
    blocks.push({ type, ...(level ? { level } : {}), text, html: content });
  });

  $main.find("a[href]").each((_, element) => {
    const $element = $(element);
    if ($element.find("h1,h2,h3,h4,h5,h6,p,li").length || $element.parents("h1,h2,h3,h4,h5,h6,p,li").length) return;
    const label = cleanText($element.text() || $element.attr("aria-label") || $element.attr("title") || "");
    const href = absoluteUrl($element.attr("href"), url);
    if (!label || !href) return;
    blocks.push({ type: "link", label, href });
  });

  return {
    path: new URL(url).pathname,
    url,
    title,
    description,
    blocks,
  };
}

function originalWixMedia(url) {
  const parsed = new URL(url);
  if (!/(?:wixstatic\.com|wixmp\.com)$/.test(parsed.hostname)) return url;
  const marker = parsed.pathname.indexOf("/v1/");
  if (marker !== -1) parsed.pathname = parsed.pathname.slice(0, marker);
  parsed.search = "";
  return parsed.href;
}

function assetFilename(url, fallbackExtension = ".bin") {
  const parsed = new URL(url);
  const decoded = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) || "asset");
  const extension = extname(decoded).toLowerCase().slice(0, 8) || fallbackExtension;
  const stem = decoded.slice(0, Math.max(1, decoded.length - extension.length)).replace(/[^a-z0-9_-]+/gi, "-").slice(0, 72);
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 10);
  return `${stem || "asset"}-${hash}${extension}`;
}

async function downloadAsset(url, directory, publicPrefix) {
  const source = originalWixMedia(url);
  const filename = assetFilename(source, /image/i.test(url) ? ".jpg" : ".bin");
  const response = await fetch(source, { headers: { "user-agent": "WhyDRS migration snapshot/1.0" } });
  if (!response.ok) throw new Error(`${response.status} asset: ${source}`);
  await writeFile(join(directory, filename), Buffer.from(await response.arrayBuffer()));
  return `${publicPrefix}/${filename}`;
}

async function pooled(items, worker, concurrency = CONCURRENCY) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

await mkdir(DATA_DIR, { recursive: true });
await mkdir(MEDIA_DIR, { recursive: true });
await mkdir(DOWNLOAD_DIR, { recursive: true });

console.log("Reading Wix sitemaps…");
const sitemapIndex = await fetchText(`${ORIGIN}/sitemap.xml`);
const sitemapUrls = xmlLocations(sitemapIndex);
const sitemapXml = await pooled(sitemapUrls, fetchText);
const seedUrls = [...new Set(sitemapXml.flatMap(xmlLocations).map((url) => new URL(url).href))].sort((a, b) => new URL(a).pathname.localeCompare(new URL(b).pathname));
console.log(`Importing ${seedUrls.length} indexed routes…`);

const failures = [];
const warnings = [];
const pages = [];
const seenUrls = new Set();
let pending = seedUrls;

while (pending.length) {
  const wave = pending.filter((url) => !seenUrls.has(url));
  pending = [];
  wave.forEach((url) => seenUrls.add(url));
  const imported = (await pooled(wave, async (url, index) => {
    try {
      const page = extractPage(url, await fetchText(url));
      if ((index + 1) % 25 === 0 || index + 1 === wave.length) console.log(`  ${index + 1}/${wave.length}`);
      return page;
    } catch (error) {
      failures.push({ url, error: String(error) });
      return null;
    }
  })).filter(Boolean);
  pages.push(...imported);

  for (const page of imported) {
    const hrefs = page.blocks.flatMap((block) => {
      const values = block.href ? [block.href] : [];
      if (block.html) {
        const fragment = cheerio.load(block.html, null, false);
        fragment("a[href]").each((_, anchor) => values.push(fragment(anchor).attr("href")));
      }
      return values;
    });
    for (const href of hrefs) {
      try {
        const linked = new URL(href, ORIGIN);
        if (linked.origin !== ORIGIN || linked.pathname.startsWith("/_") || linked.pathname.startsWith("/cdn-cgi/")) continue;
        if (/\.[a-z0-9]{2,8}$/i.test(linked.pathname)) continue;
        if (BROKEN_LINK_REPLACEMENTS.has(linked.pathname)) linked.pathname = BROKEN_LINK_REPLACEMENTS.get(linked.pathname);
        linked.search = "";
        linked.hash = "";
        if (!seenUrls.has(linked.href) && seenUrls.size + pending.length < 500) pending.push(linked.href);
      } catch {}
    }
  }
  pending = [...new Set(pending)];
  if (pending.length) console.log(`Importing ${pending.length} additional internally linked routes…`);
}

pages.sort((a, b) => a.path.localeCompare(b.path));

const mediaUrls = [...new Set(pages.flatMap((page) => page.blocks.filter((block) => block.type === "image").map((block) => block.src)))];
const mediaMap = new Map();
console.log(`Downloading ${mediaUrls.length} image assets…`);
await pooled(mediaUrls, async (url, index) => {
  try {
    mediaMap.set(url, await downloadAsset(url, MEDIA_DIR, "/media"));
  } catch (error) {
    mediaMap.set(url, "/media/external-image-unavailable.svg");
    warnings.push({ url, error: String(error), fallback: "/media/external-image-unavailable.svg" });
  }
  if ((index + 1) % 25 === 0 || index + 1 === mediaUrls.length) console.log(`  ${index + 1}/${mediaUrls.length}`);
});

const downloadable = [...new Set(pages.flatMap((page) => page.blocks.flatMap((block) => {
  const values = [];
  if (block.href) values.push(block.href);
  if (block.html) {
    const fragment = cheerio.load(block.html, null, false);
    fragment("a[href]").each((_, anchor) => values.push(fragment(anchor).attr("href")));
  }
  return values;
})).filter((href) => href
  && /(?:whydrs\.org|wixstatic\.com|wixmp\.com)/.test(href)
  && /\.(?:pdf|docx?|xlsx?|csv|zip|png|jpe?g|webp)(?:$|\?)/i.test(href)))];
const downloadMap = new Map();
console.log(`Downloading ${downloadable.length} linked documents…`);
await pooled(downloadable, async (url) => {
  try {
    downloadMap.set(url, await downloadAsset(url, DOWNLOAD_DIR, "/downloads"));
  } catch (error) {
    warnings.push({ url, error: String(error) });
  }
});

for (const page of pages) {
  for (const block of page.blocks) {
    const replaceBrokenLink = (href) => {
      try {
        const linked = new URL(href, ORIGIN);
        if (linked.origin === ORIGIN && BROKEN_LINK_REPLACEMENTS.has(linked.pathname)) {
          linked.pathname = BROKEN_LINK_REPLACEMENTS.get(linked.pathname);
          return linked.href;
        }
      } catch {}
      return href;
    };
    if (block.src && mediaMap.has(block.src)) block.src = mediaMap.get(block.src);
    if (block.href && downloadMap.has(block.href)) block.href = downloadMap.get(block.href);
    else if (block.href) block.href = replaceBrokenLink(block.href);
    if (block.html) {
      const fragment = cheerio.load(block.html, null, false);
      fragment("a[href]").each((_, anchor) => {
        const href = fragment(anchor).attr("href");
        if (downloadMap.has(href)) fragment(anchor).attr("href", downloadMap.get(href));
        else fragment(anchor).attr("href", replaceBrokenLink(href));
      });
      block.html = fragment.html();
    }
  }
}

const snapshot = {
  source: ORIGIN,
  generatedAt: new Date().toISOString(),
  routeCount: seenUrls.size,
  importedCount: pages.length,
  mediaCount: mediaMap.size,
  documentCount: downloadMap.size,
  failures,
  warnings,
  pages,
};
await writeFile(join(DATA_DIR, "site.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
await writeFile(join(ROOT, "migration-manifest.json"), `${JSON.stringify({
  source: snapshot.source,
  generatedAt: snapshot.generatedAt,
  routeCount: snapshot.routeCount,
  importedCount: snapshot.importedCount,
  mediaCount: snapshot.mediaCount,
  documentCount: snapshot.documentCount,
  failures,
  warnings,
  routes: pages.map((page) => page.path),
}, null, 2)}\n`);

console.log(`Imported ${pages.length}/${seenUrls.size} routes, ${mediaMap.size} images, and ${downloadMap.size} documents.`);
if (failures.length) {
  console.error(`${failures.length} import failures were recorded in migration-manifest.json.`);
  process.exitCode = 1;
}
if (warnings.length) console.warn(`${warnings.length} unavailable assets use documented fallbacks.`);
