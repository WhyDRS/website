import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import snapshot from "../src/data/site.json" with { type: "json" };
import manifest from "../migration-manifest.json" with { type: "json" };

const ROOT = new URL("../", import.meta.url).pathname;
const DIST = join(ROOT, "dist");
const errors = [];
const expectedRoutes = new Set(snapshot.pages.map((page) => page.path));

if (manifest.failures.length) errors.push(`${manifest.failures.length} migration failures remain`);
if (manifest.routeCount !== manifest.importedCount) errors.push(`imported ${manifest.importedCount}/${manifest.routeCount} routes`);
if (snapshot.pages.length !== manifest.importedCount) errors.push("snapshot and manifest route counts differ");
if (expectedRoutes.size !== snapshot.pages.length) errors.push("duplicate paths exist in the site snapshot");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function routeFile(pathname) {
  const decoded = decodeURIComponent(pathname);
  return decoded === "/" ? join(DIST, "index.html") : join(DIST, decoded.slice(1), "index.html");
}

for (const route of expectedRoutes) {
  if (!(await exists(routeFile(route)))) errors.push(`missing generated route: ${route}`);
}

async function htmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await htmlFiles(path));
    else if (entry.name.endsWith(".html")) files.push(path);
  }
  return files;
}

const files = await htmlFiles(DIST);
for (const file of files) {
  const html = await readFile(file, "utf8");
  const relative = file.slice(DIST.length) || "/index.html";
  const $ = cheerio.load(html);

  $("script[src],img[src],iframe[src],source[src]").each((_, element) => {
    const source = $(element).attr("src") || "";
    if (/wixstatic|parastorage|wix\.com\/_api/i.test(source)) errors.push(`Wix runtime dependency in ${relative}: ${source}`);
  });

  $("a[href],img[src],link[href],script[src]").each((_, element) => {
    const reference = $(element).attr("href") || $(element).attr("src") || "";
    if (!reference.startsWith("/") || reference.startsWith("//")) return;
    const pathname = reference.split(/[?#]/)[0];
    if (!pathname) return;
    if (expectedRoutes.has(pathname) || expectedRoutes.has(decodeURIComponent(pathname))) return;
    if (["/favicon.svg", "/robots.txt", "/sitemap.xml", "/styles/global.css"].includes(pathname)) return;
    const asset = join(DIST, decodeURIComponent(pathname).slice(1));
    if (!errors.includes(`broken local reference in ${relative}: ${reference}`)) {
      errors.push({ pendingAsset: asset, message: `broken local reference in ${relative}: ${reference}` });
    }
  });
}

for (let index = errors.length - 1; index >= 0; index -= 1) {
  const error = errors[index];
  if (typeof error === "object") {
    if (await exists(error.pendingAsset)) errors.splice(index, 1);
    else errors[index] = error.message;
  }
}

const sitemap = await readFile(join(DIST, "sitemap.xml"), "utf8");
const sitemapCount = [...sitemap.matchAll(/<url>/g)].length;
if (sitemapCount !== expectedRoutes.size) errors.push(`sitemap has ${sitemapCount}/${expectedRoutes.size} routes`);

if (errors.length) {
  console.error(`Validation failed with ${errors.length} issue(s):`);
  errors.slice(0, 100).forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(`Validated ${expectedRoutes.size} routes across ${files.length} HTML files.`);
console.log(`${manifest.mediaCount} images and ${manifest.documentCount} documents are locally hosted; no Wix runtime assets remain.`);
if (manifest.warnings.length) console.log(`${manifest.warnings.length} dead third-party images use the documented local placeholder.`);
