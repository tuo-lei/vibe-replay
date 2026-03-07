import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReplaySession } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function generateOutput(
  session: ReplaySession,
  outputDir: string,
): Promise<string> {
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
    } catch {
      continue;
    }
  }

  if (!viewerHtml) {
    throw new Error(
      "Could not find viewer.html. Run `pnpm build` first.",
    );
  }

  // Inject session data — escape </ to prevent browser from closing the script tag
  const jsonData = JSON.stringify(session).replace(/<\//g, "<\\/");
  const dataScript = `<script id="vibe-replay-data">window.__VIBE_REPLAY_DATA__ = ${jsonData};</script>`;
  // Use lastIndexOf to find the ACTUAL </head> HTML tag, not a "</head>" string
  // that may appear inside minified JS code within the viewer bundle.
  const headIdx = viewerHtml.lastIndexOf("</head>");
  const outputHtml = viewerHtml.slice(0, headIdx) + dataScript + "\n" + viewerHtml.slice(headIdx);

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
