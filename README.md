# WhyDRS standalone site

This branch is a complete static migration of the public WhyDRS website away from Wix. It preserves the live route structure, snapshots page content, hosts media and downloads locally, and can be deployed to any static host or container platform.

## Migration coverage

- 425 routes declared by Wix sitemaps
- 1 additional live page discovered through internal links
- 104 locally hosted images
- 17 locally hosted downloadable documents
- Search across every migrated route
- Native replacements for the contact, broker advocacy, investor-relations, SEC-comment, and DRS-request workflows
- A local placeholder for three third-party profile images whose original URLs are already dead
- No Wix runtime, API, package, media, or rendering dependency in the generated site

The detailed source-to-output record is in `migration-manifest.json`. The legacy Velo export remains under `src/pages` for reference and is not part of the Astro build.

## Local development

```sh
npm install
npm run dev
```

The development server prints its local URL. The production workflow is:

```sh
npm run build
npm run validate
npm run preview
```

The deployable site is written to `dist`.

## Refresh from the live Wix site

Run this immediately before the final cutover so the snapshot includes last-minute content updates:

```sh
npm run import:site
npm run build
npm run validate
```

The importer reads every sitemap, follows additional internal page links, downloads remote page media and documents, decodes protected contact addresses, records unavailable assets, and regenerates both `src/data/site.json` and `migration-manifest.json`.

## Hosting

Any static host can publish `dist`. Build with `npm run build`; no server-side adapter or environment variable is required.

For a standalone container:

```sh
docker build -t whydrs-site .
docker run --rm -p 8080:8080 whydrs-site
```

The included Nginx configuration serves extensionless legacy routes, a custom 404 page, and long-lived cache headers for versioned static assets.

## Cutover checklist

1. Run the refresh, build, and validation commands above.
2. Review the generated site on a preview host at desktop and mobile widths.
3. Verify the email-client and clipboard workflows in a real browser.
4. Point both the apex domain and `www` record at the new host.
5. Confirm HTTPS, the canonical hostname, `robots.txt`, `sitemap.xml`, and representative legacy URLs.
6. Keep Wix available but disconnected during a short rollback window, then cancel it only after production monitoring is clean.

The external WhyDRS database remains an intentional separate service. The main site itself does not require Wix or a backend.
