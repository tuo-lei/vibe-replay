import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  const auditStat = await stat(auditPath).catch(() => null);
  if (!auditStat || auditStat.size === 0) return null;

  // Derive SessionInfo.sessionId from cliSessionId when available so that
  // if the same session is discovered by multiple sources it dedupes correctly.
  // Fall back to the local_{id} when the Cowork JSON lacks cliSessionId.
  const sessionId = meta.cliSessionId || meta.sessionId.replace(/^local_/, "");

  // Pull first meaningful user prompts for the picker preview. Cheapest source:
  // meta.initialMessage. Supplement by scanning audit.jsonl if needed.
  const prompts = await collectPrompts(auditPath, meta.initialMessage);
  if (prompts.length === 0) return null;

  const timestamp = meta.lastActivityAt
    ? new Date(meta.lastActivityAt).toISOString()
    : meta.createdAt
      ? new Date(meta.createdAt).toISOString()
      : auditStat.mtime.toISOString();

  // Count lines (lightweight — audit.jsonl rarely exceeds 1MB).
  const auditContent = await readFile(auditPath, "utf-8").catch(() => "");
  const lines = auditContent.split("\n").filter((l) => l.trim());
  const lineCount = lines.length;
  // Lightweight tool-call count reused from claude-code discover heuristic.
  const toolUseRe = /"type"\s*:\s*"tool_use"/g;
  let toolCallCount = 0;
  for (const line of lines) {
    const m = line.match(toolUseRe);
    if (m) toolCallCount += m.length;
  }
  const promptCount = lines.filter(
    (line) =>
      (line.includes('"type":"user"') || line.includes('"type": "user"')) &&
      !line.includes('"tool_result"'),
  ).length;

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
    fileSize: auditStat.size,
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
 * only crack open audit.jsonl for additional prompts if needed.
 */
async function collectPrompts(auditPath: string, initialMessage?: string): Promise<string[]> {
  const prompts: string[] = [];
  const MAX = 2;

  const pushCleaned = (text: string | undefined): void => {
    if (!text) return;
    if (isSystemGeneratedMessage(text)) return;
    const cleaned = cleanPromptText(text);
    if (cleaned.length >= 10) prompts.push(cleaned.slice(0, 200));
  };

  pushCleaned(initialMessage);
  if (prompts.length >= MAX) return prompts;

  let content: string;
  try {
    content = await readFile(auditPath, "utf-8");
  } catch {
    return prompts;
  }

  const lines = content.split("\n");
  const scanLimit = Math.min(lines.length, 200);
  for (let i = 0; i < scanLimit && prompts.length < MAX; i++) {
    const line = lines[i].trim();
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
