import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

/** Read CLI package.json version at build time */
function getCliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../cli/package.json"), "utf-8"));
    return pkg.version || "dev";
  } catch {
    return "dev";
  }
}

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
  define: {
    // Bake cloud API URL at build time. Vite's import.meta.env.VITE_* replacement
    // runs before define, so we use a custom global instead.
    __CLOUD_API_URL__: JSON.stringify(process.env.VITE_CLOUD_API_URL || "https://vibe-replay.com"),
    __CLI_VERSION__: JSON.stringify(getCliVersion()),
  },
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
