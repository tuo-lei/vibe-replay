import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/** Inject __VIBE_REPLAY_EDITOR__ flag in dev mode so the viewer enters editor mode */
function editorFlagPlugin(): Plugin {
  return {
    name: "vibe-replay-editor-flag",
    apply: "serve",
    transformIndexHtml(html) {
      const flag = `<script>window.__VIBE_REPLAY_EDITOR__ = true;</script>`;
      return html.replace("</head>", `${flag}\n</head>`);
    },
  };
}

export default defineConfig({
  plugins: [react(), viteSingleFile(), editorFlagPlugin()],
  build: {
    outDir: "dist",
    target: "es2022",
  },
  server: {
    port: process.env.VITE_PORT ? Number(process.env.VITE_PORT) : undefined,
    strictPort: !!process.env.VITE_PORT,
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.VITE_API_PORT || "13456"}`,
        changeOrigin: true,
      },
    },
  },
});
