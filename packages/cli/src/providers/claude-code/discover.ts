import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { cleanPromptText, isSystemGeneratedMessage } from "../../clean-prompt.js";
import type { SessionInfo } from "../../types.js";
import { shortenPath } from "../../utils.js";

const CLAUDE_DIR = join(homedir(), ".claude", "projects");

export async function discoverClaudeCodeSessions(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(CLAUDE_DIR);
  } catch {
    return sessions;
  }

  for (const projDir of projectDirs) {
    const projPath = join(CLAUDE_DIR, projDir);
    const projStat = await stat(projPath).catch(() => null);
    if (!projStat?.isDirectory()) continue;

    const project = decodeProjectDir(projDir);

    let files: string[];
    try {
      files = await readdir(projPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const filePath = join(projPath, file);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) continue;

      const info = await extractSessionInfo(filePath, fileStat.size, project);
      if (info) sessions.push(info);
    }
  }

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

function decodeProjectDir(encoded: string): string {
  // Claude Code encodes project paths by replacing path separators with hyphens
  // e.g. "-Users-tuo-Code-my-project" → "/Users/tuo/Code/my-project"
  // This is a fallback — we prefer cwd from session metadata (see extractSessionInfo)
  if (encoded.startsWith("-")) {
    return `/${encoded.slice(1).replace(/-/g, "/")}`;
  }
  return encoded;
}

// Single-pass streaming scan: reads the JSONL line-by-line instead of slurping
// the whole file into memory. Large sessions routinely hit 30–60MB and V8 keeps
// the backing string alive while any substring view (line) is reachable, so the
// old readFile + split approach retained ~2× file size per session across a
// discovery sweep. Streaming caps peak memory at a single line plus a small
// tail ring-buffer used for end-of-session title / timestamp fallbacks.
const METADATA_SCAN_LINES = 30;
const PROMPT_SCAN_LINES = 150;
const TAIL_BUFFER_LINES = 50;
const MAX_PROMPTS = 2;

export async function extractSessionInfo(
  filePath: string,
  fileSize: number,
  project: string,
): Promise<SessionInfo | null> {
  let sessionId = "";
  let slug = "";
  let cwd = "";
  let version = "";
  let gitBranch: string | undefined;
  // `timestamp` carries the *last activity* on this session — the timestamp of
  // the most recent record in the JSONL. This matches what Claude Code's own
  // `/resume` list and Cursor's chat list show ("X minutes ago" reflects when
  // the session was last touched, not when it started). claude-desktop and
  // claude-cowork already pull lastActivityAt from their metadata; cursor uses
  // file mtime — keeping all four providers in sync.
  let timestamp = "";
  const prompts: string[] = [];
  let title: string | undefined;

  let lineCount = 0;
  let promptCount = 0;
  let toolCallCount = 0;
  let editCountEst = 0;
  let durationMsEst = 0;
  let hasPR = false;
  let model: string | undefined;

  // Ring buffer of the most recent non-empty lines — used to look back for
  // `custom-title` records that are written late in the session.
  const tail: string[] = [];

  const toolUseRe = /"type"\s*:\s*"tool_use"/g;
  const modelRe = /"model"\s*:\s*"(claude-[^"]+)"/;
  const durationRe = /"durationMs"\s*:\s*(\d+)/;
  const editToolRe = /"name"\s*:\s*"(Edit|Write|MultiEdit|NotebookEdit)"/;
  // Matches the outer record `timestamp` — every JSONL record carries one and
  // records are written in append-order, so overwriting on each line lands on
  // the last activity. Anchored on `{"` to avoid grabbing a nested timestamp
  // inside a stringified message body.
  const recordTsRe = /"timestamp"\s*:\s*"([^"]+)"/;

  let rl: ReturnType<typeof createInterface> | undefined;
  try {
    const input = createReadStream(filePath, { encoding: "utf-8" });
    rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) continue;
      lineCount++;

      // --- cheap string-based counters (every line) ---
      if (
        (line.includes('"type":"user"') || line.includes('"type": "user"')) &&
        !line.includes('"tool_result"')
      ) {
        // NOTE: `!line.includes('"tool_result"')` could theoretically under-count
        // if a user's actual prompt text literally contains the string "tool_result".
        // Extremely rare in practice; the fast string check avoids JSON-parsing every line.
        promptCount++;
      }
      const toolMatches = line.match(toolUseRe);
      if (toolMatches) {
        toolCallCount += toolMatches.length;
        if (editToolRe.test(line)) editCountEst++;
      }
      if (!model && line.includes('"assistant"') && line.includes('"model"')) {
        const m = line.match(modelRe);
        if (m && m[1] !== "<synthetic>") model = m[1];
      }
      if (line.includes('"turn_duration"')) {
        const d = line.match(durationRe);
        if (d) durationMsEst += Number(d[1]);
      }
      if (!hasPR && line.includes('"pr-link"')) hasPR = true;

      // Track the most recent record timestamp — JSONL is append-order, so the
      // final overwrite is the last activity time.
      const tsMatch = line.match(recordTsRe);
      if (tsMatch) timestamp = tsMatch[1];

      // --- JSON-parse only the first PROMPT_SCAN_LINES lines ---
      // Metadata typically lands in the first ~30 lines; initial prompts within 150.
      if (lineCount <= PROMPT_SCAN_LINES) {
        try {
          const obj = JSON.parse(line);

          if (lineCount <= METADATA_SCAN_LINES) {
            if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
            if (!slug && obj.slug) slug = obj.slug;
            if (!cwd && obj.cwd) cwd = obj.cwd;
            if (!version && obj.version) version = obj.version;
            if (!gitBranch && obj.gitBranch) gitBranch = obj.gitBranch;

            if (obj.type === "custom-title" && (obj.customTitle || obj.title)) {
              title = obj.customTitle || obj.title;
            }
          }

          // Collect meaningful user prompts (skip boilerplate).
          // Content can be a string (CLI / terminal mode) or an array of content blocks
          // (VS Code extension native panel sends [{type:"text",text:"..."}]).
          if (prompts.length < MAX_PROMPTS && obj.type === "user" && obj.message?.role === "user") {
            const contentField = obj.message.content;
            const text =
              typeof contentField === "string"
                ? contentField
                : Array.isArray(contentField)
                  ? contentField
                      .filter((b: { type: string }) => b.type === "text")
                      .map((b: { type: string; text?: string }) => b.text ?? "")
                      .join("")
                  : "";
            if (text && !isSystemGeneratedMessage(text)) {
              const cleaned = cleanPromptText(text);
              if (cleaned.length >= 10) prompts.push(cleaned.slice(0, 200));
            }
          }
        } catch {}
      }

      // --- tail buffer for late-session fallbacks ---
      tail.push(line);
      if (tail.length > TAIL_BUFFER_LINES) tail.shift();
    }
  } catch {
    return null;
  } finally {
    rl?.close();
  }

  if (!sessionId || prompts.length === 0) return null;

  // Fallback title: `custom-title` is often written at session end, beyond the
  // front-loaded metadata scan. Reverse-scan the tail ring buffer.
  if (!title) {
    for (let i = tail.length - 1; i >= 0; i--) {
      const line = tail[i];
      if (!line.includes("custom-title")) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "custom-title" && (obj.customTitle || obj.title)) {
          title = obj.customTitle || obj.title;
          break;
        }
      } catch {}
    }
  }

  // Fallback: file mtime. Reaches here only if no record on any line had a
  // `timestamp` field — extremely unusual but keeps discovery resilient.
  if (!timestamp) {
    const fileStat2 = await stat(filePath).catch(() => null);
    if (fileStat2) timestamp = fileStat2.mtime.toISOString();
    else return null;
  }

  return {
    provider: "claude-code",
    sessionId,
    slug: slug || sessionId.slice(0, 8),
    title,
    project: shortenPath(cwd || project),
    cwd,
    version,
    gitBranch,
    timestamp,
    lineCount,
    fileSize,
    filePath,
    filePaths: [filePath],
    firstPrompt: prompts[0],
    prompts,
    promptCount,
    toolCallCount,
    model,
    durationMsEst: durationMsEst || undefined,
    editCountEst: editCountEst || undefined,
    hasPR: hasPR || undefined,
  };
}
