// Verify an E2E replay: HTML is structurally well-formed and non-empty,
// scene inventory matches the parsed blocks (mirroring replay-core's
// transform rules, including compaction-summary / context-injection user
// turns), and the embedded window.__VIBE_REPLAY_DATA__ (from the
// <script id="vibe-replay-data"> tag only) parses and equals replay.json
// ignoring meta.generator.generatedAt, with no unescaped script end tag.
// Optional 4th arg: "<mtimeMs>:<size>" fingerprint from pick-e2e — fail if
// the session file changed between selection and verification.
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { parseMuseSession } from "../../packages/provider-muse/src/muse/parser.js";

const [htmlPath, jsonPath, sessionFile, expectedFingerprint] = process.argv.slice(2);
const html = readFileSync(htmlPath, "utf-8");
const replay = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
  meta: Record<string, unknown>;
  scenes: Array<{ type: string }>;
};

const parsed = await parseMuseSession(sessionFile);

// Expected scene counts, mirroring replay-core/src/transform.ts:
// - user turn with text content or images -> compaction-summary,
//   context-injection, or user-prompt by subtype; content-less user turns
//   produce no scene.
// - assistant thinking/text blocks produce scenes only when non-empty;
//   tool_use blocks always produce a tool-call scene.
const expected: Record<string, number> = {
  "user-prompt": 0,
  "tool-call": 0,
  thinking: 0,
  "text-response": 0,
  "compaction-summary": 0,
  "context-injection": 0,
};
for (const turn of parsed.turns) {
  if (turn.role === "user") {
    const content = turn.blocks
      .filter((b) => b.type === "text")
      .map((b) => ("text" in b ? (b.text as string) : "") || "")
      .join("\n");
    const images = turn.blocks.find((b) => b.type === "_user_images");
    const imageCount =
      images && "images" in images && Array.isArray(images.images) ? images.images.length : 0;
    if (content.trim() || imageCount > 0) {
      if (turn.subtype === "compaction-summary") expected["compaction-summary"]++;
      else if (turn.subtype === "context-injection" || turn.subtype === "automation-trigger")
        expected["context-injection"]++;
      else expected["user-prompt"]++;
    }
    continue;
  }
  for (const block of turn.blocks) {
    if (block.type === "thinking") {
      if (typeof block.thinking === "string" && block.thinking.trim()) expected.thinking++;
    } else if (block.type === "text") {
      if (typeof block.text === "string" && block.text.trim()) expected["text-response"]++;
    } else if (block.type === "tool_use") {
      expected["tool-call"]++;
    }
  }
}

const actual: Record<string, number> = {};
for (const scene of replay.scenes) {
  actual[scene.type] = (actual[scene.type] ?? 0) + 1;
}
const knownTypes = new Set(Object.keys(expected));
const unexpectedTypes = Object.keys(actual).filter((t) => !knownTypes.has(t));
const inventoryMatch =
  unexpectedTypes.length === 0 &&
  Object.keys(expected).every((t) => (actual[t] ?? 0) === expected[t]) &&
  replay.scenes.length === Object.values(expected).reduce((a, b) => a + b, 0);

// Structural HTML check: document shell present, and script elements pair
// up in order. A global "<script" count is useless here — the viewer bundle
// and the replay text contain "<script>" inside JS string literals — so
// walk element by element: each opening tag must be followed by its own
// closing tag, and anything between them is content, not markup.
let scriptOpens = 0;
let scriptCloses = 0;
let dataTags = 0;
let unterminatedScript = false;
{
  const openRe = /<script\b[^>]*>/gi;
  let pos = 0;
  for (;;) {
    openRe.lastIndex = pos;
    const m = openRe.exec(html);
    if (!m) break;
    scriptOpens++;
    if (/id="vibe-replay-data"/.test(m[0])) dataTags++;
    const closeIdx = html.toLowerCase().indexOf("</script", m.index + m[0].length);
    if (closeIdx === -1) {
      unterminatedScript = true;
      break;
    }
    const closeEnd = html.indexOf(">", closeIdx);
    if (closeEnd === -1) {
      unterminatedScript = true;
      break;
    }
    scriptCloses++;
    pos = closeEnd + 1;
  }
}
const wellFormed =
  html.length > 0 &&
  /<!doctype html>/i.test(html) &&
  html.includes("</html>") &&
  html.includes("</head>") &&
  html.includes("</body>") &&
  scriptOpens > 0 &&
  !unterminatedScript &&
  scriptOpens === scriptCloses &&
  dataTags === 1;

// Embedded data: only the <script id="vibe-replay-data"> tag.
const tagMatch = html.match(/<script id="vibe-replay-data"[^>]*>([\s\S]*?)<\/script>/i);
let embeddedMatch = false;
let embeddedError = "";
if (!tagMatch) {
  embeddedError = 'no <script id="vibe-replay-data"> tag found';
} else {
  const payloadText = tagMatch[1];
  // Script end tags are ASCII case-insensitive and allow whitespace before
  // ">", so a bare "</script>" check misses </SCRIPT> and </script >.
  if (/<\/script(?=[\t\n\f\r />])/i.test(payloadText))
    embeddedError = "unescaped script end tag in payload";
  // The tag holds a JS assignment: window.__VIBE_REPLAY_DATA__ = {...};
  const jsonText = payloadText
    .replace(/^\s*window\.__VIBE_REPLAY_DATA__\s*=\s*/, "")
    .replace(/;\s*$/, "");
  try {
    const embedded = JSON.parse(jsonText) as typeof replay;
    const a = structuredClone(embedded);
    const b = structuredClone(replay);
    const genA = (a.meta as { generator?: { generatedAt?: string } }).generator;
    const genB = (b.meta as { generator?: { generatedAt?: string } }).generator;
    if (genA) delete genA.generatedAt;
    if (genB) delete genB.generatedAt;
    embeddedMatch = JSON.stringify(a) === JSON.stringify(b) && !embeddedError;
  } catch (err) {
    embeddedError = `embedded JSON parse failed: ${String(err).slice(0, 120)}`;
  }
}

// Optional fingerprint: the session file must not have changed since pick-e2e.
let fileChanged = false;
if (expectedFingerprint) {
  const st = await stat(sessionFile).catch(() => null);
  fileChanged = !st || `${st.mtimeMs}:${st.size}` !== expectedFingerprint;
}

console.log(
  JSON.stringify(
    {
      htmlBytes: html.length,
      wellFormed,
      scriptOpens,
      scriptCloses,
      dataTags,
      expected,
      actual,
      unexpectedTypes,
      inventoryMatch,
      embeddedMatch,
      embeddedError,
      fileChanged,
    },
    null,
    2,
  ),
);
process.exit(inventoryMatch && embeddedMatch && wellFormed && !fileChanged ? 0 : 1);
