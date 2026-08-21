import snapshot from "../../src/data/site.json";

export function GET() {
  const urls = snapshot.pages.map((page) => `<url><loc>https://www.whydrs.org${page.path === "/" ? "" : page.path.replaceAll("&", "&amp;")}</loc></url>`).join("");
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`, {
    headers: { "content-type": "application/xml" },
  });
}
