// Verify an E2E replay: HTML well-formed/non-empty, scene inventory matches
// parsed blocks, embedded window.__VIBE_REPLAY_DATA__ (from the
// <script id="vibe-replay-data"> tag only) parses and equals replay.json
// ignoring meta.generator.generatedAt, with no unescaped </script>.
import { readFileSync } from "node:fs";
import { parseMuseSession } from "../../packages/provider-muse/src/muse/parser.js";

const [htmlPath, jsonPath, sessionFile] = process.argv.slice(2);
const html = readFileSync(htmlPath, "utf-8");
const replay = JSON.parse(readFileSync(jsonPath, "utf-8")) as {
  meta: Record<string, unknown>;
  scenes: Array<{ type: string }>;
};

const parsed = await parseMuseSession(sessionFile);
const blocks = parsed.turns.flatMap((t) => t.blocks);
const byType = (type: string): number => blocks.filter((b) => b.type === type).length;
const userTurns = parsed.turns.filter((t) => t.role === "user").length;
const userTextBlocks = parsed.turns
  .filter((t) => t.role === "user")
  .flatMap((t) => t.blocks)
  .filter((b) => b.type === "text").length;
const assistantTextBlocks = byType("text") - userTextBlocks;
// thinking blocks already drop empty content in the parser (case "thinking"
// breaks on empty/whitespace), so expected thinking scenes == parsed blocks
const nonEmptyThinking = byType("thinking");

const from = (type: string): number => replay.scenes.filter((s) => s.type === type).length;
const expected = {
  "user-prompt": userTurns,
  "tool-call": byType("tool_use"),
  thinking: nonEmptyThinking,
  "text-response": assistantTextBlocks,
};
const actual = {
  "user-prompt": from("user-prompt"),
  "tool-call": from("tool-call"),
  thinking: from("thinking"),
  "text-response": from("text-response"),
};
const inventoryMatch = (Object.keys(expected) as Array<keyof typeof expected>).every(
  (k) => expected[k] === actual[k],
);

// Embedded data: only the <script id="vibe-replay-data"> tag.
const tagMatch = html.match(/<script id="vibe-replay-data"[^>]*>([\s\S]*?)<\/script>/);
let embeddedMatch = false;
let embeddedError = "";
if (!tagMatch) {
  embeddedError = 'no <script id="vibe-replay-data"> tag found';
} else {
  const payloadText = tagMatch[1];
  if (payloadText.includes("</script>")) embeddedError = "unescaped </script> in payload";
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

const wellFormed = html.length > 0 && html.includes("</html>") && html.includes("vibe-replay-data");

console.log(
  JSON.stringify(
    {
      htmlBytes: html.length,
      wellFormed,
      expected,
      actual,
      inventoryMatch,
      userTextBlocks,
      rawTextBlocks: byType("text"),
      embeddedMatch,
      embeddedError,
    },
    null,
    2,
  ),
);
process.exit(inventoryMatch && embeddedMatch && wellFormed ? 0 : 1);
