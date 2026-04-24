import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cleanPromptText, isSystemGeneratedMessage } from "../../clean-prompt.js";
import type { SessionInfo } from "../../types.js";

/**
 * Claude Desktop stores Cowork (autonomous agent mode) sessions separately from
 * the Code tab. Layout:
 *   ~/Library/Application Support/Claude/local-agent-mode-sessions/
 *     {accountId}/
 *       {orgId}/
 *         local_{id}.json          ← session metadata
 *         local_{id}/audit.jsonl   ← full transcript (self-contained)
 *
 * Unlike Code-tab sessions, the transcript lives inside the Cowork directory
 * itself — we do not need to cross-reference ~/.claude/projects/.
 */
const COWORK_DIR = join(
  homedir(),
  "Library",
  "Application Support",
  "Claude",
  "local-agent-mode-sessions",
);

interface CoworkSessionJson {
  sessionId: string;
  cliSessionId?: string;
  cwd?: string;
  createdAt?: number;
  lastActivityAt?: number;
  model?: string;
  title?: string;
  isArchived?: boolean;
  initialMessage?: string;
  processName?: string;
}

export async function discoverClaudeCoworkSessions(): Promise<SessionInfo[]> {
  if (process.platform !== "darwin") return [];
  return discoverCoworkFromDir(COWORK_DIR);
}

export async function discoverCoworkFromDir(coworkDir: string): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  let accountDirs: string[];
  try {
    accountDirs = await readdir(coworkDir);
  } catch {
    return sessions;
  }

  for (const accountId of accountDirs) {
    const accountPath = join(coworkDir, accountId);
    const accountStat = await stat(accountPath).catch(() => null);
    if (!accountStat?.isDirectory()) continue;

    let orgDirs: string[];
    try {
      orgDirs = await readdir(accountPath);
    } catch {
      continue;
    }

    for (const orgId of orgDirs) {
      const orgPath = join(accountPath, orgId);
      const orgStat = await stat(orgPath).catch(() => null);
      if (!orgStat?.isDirectory()) continue;

      let entries: string[];
      try {
        entries = await readdir(orgPath);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.startsWith("local_") || !entry.endsWith(".json")) continue;

        const jsonPath = join(orgPath, entry);
        const info = await extractCoworkSessionInfo(jsonPath);
        if (info) sessions.push(info);
      }
    }
  }

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

export async function extractCoworkSessionInfo(jsonPath: string): Promise<SessionInfo | null> {
  let raw: string;
  try {
    raw = await readFile(jsonPath, "utf-8");
  } catch {
    return null;
  }

  let meta: CoworkSessionJson;
  try {
    meta = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!meta.sessionId) return null;

  // Audit.jsonl is co-located inside the local_{id}/ directory next to this JSON.
  const dir = jsonPath.replace(/\.json$/, "");
  const auditPath = join(dir, "audit.jsonl");

  // Stream audit.jsonl line-by-line rather than slurping the whole file into
  // memory. Holding a full 6MB+ audit string + its split-array across every
  // Cowork session during discovery piles up heap fast — V8 keeps the backing
  // buffer alive as long as any substring view is reachable. Streaming caps
  // peak memory at roughly one line per session.
  const auditStat = await stat(auditPath).catch(() => null);
  if (!auditStat || auditStat.size === 0) return null;

  // Derive SessionInfo.sessionId from cliSessionId when available so that
  // if the same session is discovered by multiple sources it dedupes correctly.
  // Fall back to the local_{id} when the Cowork JSON lacks cliSessionId.
  const sessionId = meta.cliSessionId || meta.sessionId.replace(/^local_/, "");

  const toolUseRe = /"type"\s*:\s*"tool_use"/g;
  const PROMPT_SCAN_LINES = 200;
  let lineCount = 0;
  let toolCallCount = 0;
  let promptCount = 0;
  const earlyLines: string[] = [];

  let rl: ReturnType<typeof createInterface> | undefined;
  try {
    const input = createReadStream(auditPath, { encoding: "utf-8" });
    rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      lineCount++;
      if (earlyLines.length < PROMPT_SCAN_LINES) earlyLines.push(line);
      const m = line.match(toolUseRe);
      if (m) toolCallCount += m.length;
      if (
        (line.includes('"type":"user"') || line.includes('"type": "user"')) &&
        !line.includes('"tool_result"')
      ) {
        promptCount++;
      }
    }
  } catch {
    return null;
  } finally {
    rl?.close();
  }

  if (lineCount === 0) return null;

  // Pull first meaningful user prompts for the picker preview. Cheapest source:
  // meta.initialMessage. Supplement by scanning the early audit lines if needed.
  const prompts = collectPromptsFromLines(earlyLines, meta.initialMessage);
  if (prompts.length === 0) return null;

  const timestamp = meta.lastActivityAt
    ? new Date(meta.lastActivityAt).toISOString()
    : meta.createdAt
      ? new Date(meta.createdAt).toISOString()
      : auditStat.mtime.toISOString();

  const fileSize = auditStat.size;

  // Normalize model: strip Cowork-style suffixes (e.g. "claude-opus-4-6[1m]").
  const model = meta.model ? meta.model.replace(/\[[^\]]*\]$/, "") : undefined;

  // Project label: every Cowork session runs inside its own sandbox dir, so the
  // real cwd is noise in the picker. Group all Cowork sessions under a single
  // "Cowork" heading — the session title is enough to tell them apart.
  const project = "Cowork";

  return {
    provider: "claude-cowork",
    sessionId,
    slug: sessionId.slice(0, 8),
    title: meta.title,
    project,
    cwd: meta.cwd || "",
    version: "",
    timestamp,
    lineCount,
    fileSize,
    filePath: auditPath,
    filePaths: [auditPath],
    firstPrompt: prompts[0],
    prompts,
    promptCount,
    toolCallCount,
    model,
  };
}

/**
 * Return up to 2 cleaned user prompts for the picker preview.
 * The Cowork metadata JSON already carries `initialMessage`; use it first and
 * then fall back to the first real user messages in the audit transcript.
 * Duplicates are dropped so `initialMessage` + the identical first audit line
 * don't produce `[x, x]`.
 */
function collectPromptsFromLines(lines: string[], initialMessage?: string): string[] {
  const prompts: string[] = [];
  const MAX = 2;

  const pushCleaned = (text: string | undefined): void => {
    if (!text) return;
    if (isSystemGeneratedMessage(text)) return;
    const cleaned = cleanPromptText(text).slice(0, 200);
    if (cleaned.length < 10) return;
    if (prompts.includes(cleaned)) return;
    prompts.push(cleaned);
  };

  pushCleaned(initialMessage);
  if (prompts.length >= MAX) return prompts;

  const scanLimit = Math.min(lines.length, 200);
  for (let i = 0; i < scanLimit && prompts.length < MAX; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.type !== "user" || obj.message?.role !== "user") continue;
      // parent_tool_use_id != null means this is a subagent tool-result response, not a real prompt.
      if (obj.parent_tool_use_id) continue;
      const raw = obj.message.content;
      const text =
        typeof raw === "string"
          ? raw
          : Array.isArray(raw)
            ? raw
                .filter((b: { type: string }) => b.type === "text")
                .map((b: { type: string; text?: string }) => b.text ?? "")
                .join("")
            : "";
      pushCleaned(text);
    } catch {}
  }

  return prompts;
}
