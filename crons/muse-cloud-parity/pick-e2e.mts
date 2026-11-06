// Pick E2E subjects: most recent multi-turn Muse session, plus a recent
// session with tool_use blocks if the subject has none. Shapes/counts only.
import { discoverMuseSessions } from "../../packages/provider-muse/src/muse/discover.js";
import { parseMuseSession } from "../../packages/provider-muse/src/muse/parser.js";

async function main(): Promise<void> {
  const now = Date.now();
  const all = await discoverMuseSessions();
  const stable = all.filter((s) => now - Date.parse(s.timestamp) > 60_000);
  const multi = stable.filter((s) => (s.promptCount ?? 0) >= 2);
  const subject = multi[0];
  if (!subject) {
    console.log(JSON.stringify({ error: "no multi-turn session found" }));
    return;
  }
  const parsed = await parseMuseSession(subject.filePath);
  const counts = {
    userTurns: parsed.turns.filter((t) => t.role === "user").length,
    toolUse: parsed.turns.flatMap((t) => t.blocks).filter((b) => b.type === "tool_use").length,
    thinking: parsed.turns.flatMap((t) => t.blocks).filter((b) => b.type === "thinking").length,
    text: parsed.turns.flatMap((t) => t.blocks).filter((b) => b.type === "text").length,
  };
  // Most recent stub (1 prompt) for the cheap spot-check.
  const stub = stable.find((s) => (s.promptCount ?? 0) === 1);
  let companion: { id: string; filePath: string } | null = null;
  if (counts.toolUse === 0) {
    const withTools = stable.find((s) => (s.toolCallCount ?? 0) > 0);
    if (withTools)
      companion = { id: withTools.sessionId.slice(0, 8), filePath: withTools.filePath };
  }
  console.log(
    JSON.stringify(
      {
        subject: {
          id: subject.sessionId.slice(0, 8),
          timestamp: subject.timestamp,
          promptCount: subject.promptCount,
          toolCallCount: subject.toolCallCount,
          filePath: subject.filePath,
        },
        counts,
        stub: stub
          ? { id: stub.sessionId.slice(0, 8), timestamp: stub.timestamp, filePath: stub.filePath }
          : null,
        companion,
      },
      null,
      2,
    ),
  );
}

void main();
