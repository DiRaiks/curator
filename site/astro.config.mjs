// @ts-check
import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import icon from "astro-icon";

// GitHub Pages project site: https://diraiks.github.io/curator/
export default defineConfig({
  site: "https://diraiks.github.io",
  base: "/curator",
  trailingSlash: "ignore",
  integrations: [icon()],
  vite: {
    plugins: [tailwindcss()],
  },
  redirects: {
    "/docs": "/docs/quick-start",
  },
});
