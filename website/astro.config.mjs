import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://vibe-replay.com",
  integrations: [sitemap()],
  vite: {
    plugins: [
      tailwindcss(),
      {
        name: "public-dir-index",
        configureServer(server) {
          // Cloudflare Pages serves /view/ → /view/index.html automatically.
          // Astro dev server does not, so replicate that behavior here.
          server.middlewares.use((req, _res, next) => {
            if (req.url && /^\/view\/(\?|$)/.test(req.url)) {
              req.url = req.url.replace("/view/", "/view/index.html");
            }
            next();
          });
        },
      },
    ],
  },
});
