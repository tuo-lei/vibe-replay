// Pick E2E subjects: most recent multi-turn Muse session, plus a recent
// session with tool_use blocks if the subject has none. Shapes/counts only.
//
// Stability is judged from the transcript file's mtime, not discovery's
// metadata timestamp (an actively appended session can carry a stale
// timestamp). "Multi-turn" means parsed user turns, not discovery's
// promptCount — a prompt the parser drops (e.g. an unavailable image-only
// message) must not qualify a session. Companion candidates must be
// replayable (>= 1 parsed user turn) or source export would fail.
import { stat } from "node:fs/promises";
import { discoverMuseSessions } from "../../packages/provider-muse/src/muse/discover.js";
import { parseMuseSession } from "../../packages/provider-muse/src/muse/parser.js";

const FRESH_MS = 60 * 1000;
const MAX_PARSE_CANDIDATES = 20;

async function userTurns(filePath: string): Promise<number> {
  const parsed = await parseMuseSession(filePath);
  return parsed.turns.filter((t) => t.role === "user").length;
}

async function fingerprint(filePath: string): Promise<string> {
  const st = await stat(filePath);
  return `${st.mtimeMs}:${st.size}`;
}

async function main(): Promise<void> {
  const now = Date.now();
  const all = await discoverMuseSessions();
  const stable: Array<{
    id: string;
    filePath: string;
    promptCount: number;
    toolCallCount: number;
  }> = [];
  for (const s of all) {
    const st = await stat(s.filePath).catch(() => null);
    if (!st || now - st.mtimeMs < FRESH_MS) continue;
    stable.push({
      id: s.sessionId.slice(0, 8),
      filePath: s.filePath,
      promptCount: s.promptCount ?? 0,
      toolCallCount: s.toolCallCount ?? 0,
    });
  }

  let subject: { id: string; filePath: string; userTurns: number; fingerprint: string } | null =
    null;
  let parsedCandidates = 0;
  for (const candidate of stable) {
    if (candidate.promptCount < 2) continue;
    if (parsedCandidates >= MAX_PARSE_CANDIDATES) break;
    parsedCandidates++;
    const turns = await userTurns(candidate.filePath);
    if (turns >= 2) {
      subject = {
        id: candidate.id,
        filePath: candidate.filePath,
        userTurns: turns,
        fingerprint: await fingerprint(candidate.filePath),
      };
      break;
    }
  }
  if (!subject) {
    console.log(JSON.stringify({ error: "no multi-turn session found", parsedCandidates }));
    return;
  }
  const parsed = await parseMuseSession(subject.filePath);
  const blocks = parsed.turns.flatMap((t) => t.blocks);
  const counts = {
    userTurns: parsed.turns.filter((t) => t.role === "user").length,
    toolUse: blocks.filter((b) => b.type === "tool_use").length,
    thinking: blocks.filter((b) => b.type === "thinking").length,
    text: blocks.filter((b) => b.type === "text").length,
  };
  // Most recent stub (1 prompt) for the cheap spot-check.
  const stub = stable.find((s) => s.promptCount === 1);
  let companion: { id: string; filePath: string; fingerprint: string } | null = null;
  if (counts.toolUse === 0) {
    for (const candidate of stable) {
      if (candidate.toolCallCount === 0) continue;
      if ((await userTurns(candidate.filePath)) >= 1) {
        companion = {
          id: candidate.id,
          filePath: candidate.filePath,
          fingerprint: await fingerprint(candidate.filePath),
        };
        break;
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        subject: {
          ...subject,
          timestamp: all.find((s) => s.sessionId.startsWith(subject.id))?.timestamp,
        },
        counts,
        stub: stub
          ? {
              id: stub.id,
              filePath: stub.filePath,
              fingerprint: await fingerprint(stub.filePath),
            }
          : null,
        companion,
      },
      null,
      2,
    ),
  );
}

void main();
