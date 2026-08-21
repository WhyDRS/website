import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://www.whydrs.org",
  srcDir: "./site",
  output: "static",
  trailingSlash: "never",
  build: {
    format: "directory",
  },
});
