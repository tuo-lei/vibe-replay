import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// When DEV_VIEWER_URL is set (e.g. http://localhost:5173), proxy /view/ to Vite dev server for HMR
const viewerDevUrl = process.env.DEV_VIEWER_URL;
// In dev, proxy /api/* to the local Cloudflare Worker so auth + cloud APIs work
const workerDevUrl = process.env.DEV_WORKER_URL || "http://localhost:8787";

export default defineConfig({
  site: "https://vibe-replay.com",
  trailingSlash: "always",
  integrations: [sitemap()],
  vite: {
    server: {
      proxy: {
        "/api": {
          target: workerDevUrl,
          changeOrigin: true,
        },
        "/auth": {
          target: workerDevUrl,
          changeOrigin: true,
        },
      },
    },
    plugins: [
      tailwindcss(),
      {
        name: "public-dir-index",
        configureServer(server) {
          server.middlewares.use((req, _res, next) => {
            if (req.url && /^\/view\/(\?|$)/.test(req.url)) {
              if (viewerDevUrl) {
                // Proxy to Vite dev server for live HMR
                const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
                _res.writeHead(302, { Location: `${viewerDevUrl}/${query}` });
                _res.end();
                return;
              }
              // Cloudflare Pages serves /view/ → /view/index.html automatically.
              // Astro dev server does not, so replicate that behavior here.
              req.url = req.url.replace("/view/", "/view/index.html");
            }
            next();
          });
        },
      },
    ],
  },
});
