import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Build config for the E2E live viewer (`/live/<boxId>` share pages).
 *
 * Unlike the main viewer (singlefile HTML for the CLI dashboard), the live
 * viewer is served by the Cloudflare worker as static assets, so plain
 * separate JS/CSS files with fixed names are fine — the worker's tiny shell
 * page references `/live-app/live.js` + `/live-app/live.css` and cache-busts
 * them with the deployment id.
 */
export default defineConfig({
  plugins: [tailwindcss(), react()],
  base: "/live-app/",
  build: {
    outDir: "../../website/public/live-app",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: "src/live/index.html",
      output: {
        entryFileNames: "live.js",
        chunkFileNames: "live-[name].js",
        // The live bundle emits no fonts/images; keep names fixed so the
        // worker shell can reference them without a manifest.
        assetFileNames: "live.[ext]",
      },
    },
  },
});
