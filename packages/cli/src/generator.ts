import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReplaySession } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function generateOutput(session: ReplaySession, outputDir: string): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  // Load the pre-built viewer HTML
  let viewerHtml: string | undefined;
  const assetsPaths = [
    join(__dirname, "..", "assets", "viewer.html"),
    join(__dirname, "assets", "viewer.html"),
    join(__dirname, "..", "..", "assets", "viewer.html"),
  ];

  for (const p of assetsPaths) {
    try {
      viewerHtml = await readFile(p, "utf-8");
      break;
    } catch {}
  }

  if (!viewerHtml) {
    throw new Error("Could not find viewer.html. Run `pnpm build` first.");
  }

  // Inject session data — escape </ to prevent browser from closing the script tag
  const jsonData = escapeJsonForScript(JSON.stringify(session));
  const dataScript = `<script id="vibe-replay-data">window.__VIBE_REPLAY_DATA__ = ${jsonData};</script>`;
  // Use lastIndexOf to find the ACTUAL </head> HTML tag, not a "</head>" string
  // that may appear inside minified JS code within the viewer bundle.
  const outputHtml = injectDataScript(viewerHtml, dataScript);

  // Update title
  const title = session.meta.title || session.meta.slug;
  const finalHtml = outputHtml.replace(
    "<title>vibe-replay</title>",
    `<title>${escapeHtml(title)} — vibe-replay</title>`,
  );

  const outputPath = join(outputDir, "index.html");
  await writeFile(outputPath, finalHtml, "utf-8");

  // Also write the JSON data separately for URL-based loading
  const jsonPath = join(outputDir, "replay.json");
  await writeFile(jsonPath, JSON.stringify(session), "utf-8");

  return outputPath;
}

/**
 * Write replay JSON to the viewer's public/ dir for HMR dev mode.
 * Usage: vite dev server auto-serves public/, so ?file=/demo.json works.
 */
export async function generateDevJson(
  session: ReplaySession,
  viewerPublicDir: string,
): Promise<string> {
  await mkdir(viewerPublicDir, { recursive: true });
  const outputPath = join(viewerPublicDir, "demo.json");
  await writeFile(outputPath, JSON.stringify(session, null, 2), "utf-8");
  return outputPath;
}

/** Escape HTML special characters to prevent XSS in title and other injected text. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Escape `</` sequences in JSON strings to prevent browsers from prematurely
 * closing `<script>` tags when the JSON is embedded inline.
 */
export function escapeJsonForScript(json: string): string {
  return json.replace(/<\//g, "<\\/");
}

/**
 * Inject a data `<script>` tag into an HTML document just before the closing `</head>`.
 * Uses `lastIndexOf` to find the real `</head>` tag — minified JS in the bundle
 * may contain the literal string `</head>`.
 *
 * Returns the modified HTML string.
 * Throws if no `</head>` tag is found.
 */
export function injectDataScript(html: string, scriptTag: string): string {
  const headIdx = html.lastIndexOf("</head>");
  if (headIdx === -1) {
    throw new Error("Could not find </head> tag in viewer.html — is the build corrupted?");
  }
  return `${html.slice(0, headIdx) + scriptTag}\n${html.slice(headIdx)}`;
}
