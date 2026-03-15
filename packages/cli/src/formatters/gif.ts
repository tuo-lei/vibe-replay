/**
 * GIF export: renders animated GIF from SVG frames for universal GitHub sharing.
 *
 * Pipeline: buildSvgFrames() → renderStaticFrameSvg() → @resvg/resvg-js → gifenc
 * Zero native dependencies (WASM + pure JS).
 *
 * Quality notes (from research):
 * - Render at exactly 1x (SVG native size) — non-integer scaling creates extra
 *   anti-aliasing shades that the 256-color quantizer can't preserve well
 * - snapColorsToPalette() pins exact theme colors after quantization
 * - 256 colors with snapColorsToPalette gives the best color accuracy — the
 *   extra palette entries let the quantizer preserve subtle shades while
 *   snapColorsToPalette pins our exact theme colors in the final palette
 * - rgb565 is the best quantization format gifenc offers
 * - No dithering — it makes text worse (adds noise to sharp edges)
 */

import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import type { ReplaySession } from "@vibe-replay/types";
import type { GitHubFormatOptions } from "./github.js";
import { buildSvgFrames, extractPhases, renderStaticFrameSvg } from "./github.js";

// gifenc is CJS-only with no "exports" field — use createRequire for reliable interop
const require = createRequire(import.meta.url);
const gifenc = require("gifenc") as typeof import("gifenc");

// Exact theme colors to preserve during GIF quantization
// These are snapped into the palette so they don't get shifted
const THEME_COLORS = [
  [0x3f, 0xb9, 0x50], // green  (#3fb950)
  [0x79, 0xb8, 0xff], // blue   (#79b8ff)
  [0xd2, 0x99, 0x22], // orange (#d29922)
  [0xb3, 0x92, 0xf0], // purple (#b392f0)
  [0xe6, 0xed, 0xf3], // text   (#e6edf3)
  [0x7d, 0x85, 0x90], // dim    (#7d8590)
  [0x0d, 0x11, 0x17], // bg     (#0d1117)
  [0x16, 0x1b, 0x22], // card   (#161b22)
  [0x30, 0x36, 0x3d], // border (#30363d)
  [0xff, 0x7b, 0x72], // dotRed (#ff7b72)
  [0xf8, 0x51, 0x49], // red    (#f85149)
];

export interface GifExportOptions {
  /** Delay between frames in milliseconds (default: 5000) */
  frameDelay?: number;
  /** Replay URL for footer link */
  replayUrl?: string;
}

/**
 * Generate an animated GIF preview of a replay session.
 * Works universally on GitHub (PRs, issues, READMEs), Slack, Discord, etc.
 */
export async function generateGitHubGif(
  session: ReplaySession,
  opts: GifExportOptions = {},
): Promise<Buffer> {
  const { frameDelay = 5000, replayUrl } = opts;
  const ghOpts: GitHubFormatOptions = { replayUrl };

  const phases = extractPhases(session.scenes);
  const frames = buildSvgFrames(session, phases, ghOpts);

  if (frames.length === 0) {
    throw new Error("No frames to render");
  }

  const defaultCjkFont =
    process.platform === "darwin"
      ? "PingFang SC"
      : process.platform === "win32"
        ? "Microsoft YaHei"
        : "Noto Sans CJK SC";

  const defaultMono =
    process.platform === "darwin"
      ? "Menlo"
      : process.platform === "win32"
        ? "Consolas"
        : "Liberation Mono";

  // Rasterize each frame SVG to RGBA pixels at exactly 1x (SVG native size)
  // Non-integer scaling creates extra anti-aliasing shades that degrade after quantization
  const rasterizedFrames: Array<{ data: Uint8Array; width: number; height: number }> = [];

  for (const frame of frames) {
    const svgString = renderStaticFrameSvg(frame, session, ghOpts);
    const resvg = new Resvg(svgString, {
      font: {
        loadSystemFonts: true,
        defaultFontFamily: defaultMono,
        monospaceFamily: defaultMono,
        sansSerifFamily: defaultCjkFont,
      },
      // Render at native SVG size (960px) — no scaling
      logLevel: "off",
    });
    const rendered = resvg.render();
    rasterizedFrames.push({
      data: new Uint8Array(rendered.pixels),
      width: rendered.width,
      height: rendered.height,
    });
  }

  // All frames should have the same dimensions — use the first
  const { width: w, height: h } = rasterizedFrames[0];

  // Encode to animated GIF
  const gif = gifenc.GIFEncoder();

  for (let i = 0; i < rasterizedFrames.length; i++) {
    // Clone data — quantize reads via shared Uint32Array view
    const data = new Uint8Array(rasterizedFrames[i].data);

    // Quantize then snap palette to exact theme colors
    // This ensures our specific green/blue/orange/purple survive quantization
    const palette = gifenc.quantize(data, 256, { format: "rgb565" });
    gifenc.snapColorsToPalette(palette, THEME_COLORS, 15);
    const index = gifenc.applyPalette(data, palette, "rgb565");

    gif.writeFrame(index, w, h, {
      palette,
      delay: frameDelay,
      dispose: 2, // restore to background between frames
    });
  }

  gif.finish();
  return Buffer.from(gif.bytes());
}
