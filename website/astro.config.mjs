import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// When DEV_VIEWER_URL is set (e.g. http://localhost:5173), proxy /view/ to Vite dev server for HMR
const viewerDevUrl = process.env.DEV_VIEWER_URL;
// In dev, proxy /api/* to the local Cloudflare Worker so auth + cloud APIs work
const workerDevUrl = process.env.DEV_WORKER_URL || "http://localhost:8787";

// Pages excluded from sitemap (private / dynamic-only / requires auth).
// Keep in sync with the noindex meta tags on these routes.
const SITEMAP_EXCLUDED = new Set(["/profile", "/shared-insights"]);

export default defineConfig({
  site: "https://vibe-replay.com",
  trailingSlash: "always",
  integrations: [
    sitemap({
      filter: (page) => {
        const path = new URL(page).pathname.replace(/\/$/, "");
        return !SITEMAP_EXCLUDED.has(path);
      },
      serialize(item) {
        const path = new URL(item.url).pathname.replace(/\/$/, "");
        if (path === "") {
          item.priority = 1.0;
          item.changefreq = "weekly";
        } else if (path === "/blog") {
          item.priority = 0.9;
          item.changefreq = "weekly";
        } else if (path.startsWith("/blog/")) {
          item.priority = 0.8;
          item.changefreq = "monthly";
        } else if (path === "/explore") {
          item.priority = 0.7;
          item.changefreq = "daily";
        } else if (path === "/insights") {
          item.priority = 0.7;
          item.changefreq = "weekly";
        }
        return item;
      },
    }),
  ],
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
