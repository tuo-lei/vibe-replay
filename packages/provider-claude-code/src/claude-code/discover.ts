import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { cleanPromptText, isSystemGeneratedMessage } from "@vibe-replay/provider-core/clean-prompt";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { readGitRepo, shortenPath, TOOL_USE_RE } from "@vibe-replay/provider-core/utils";

const CLAUDE_DIR = join(homedir(), ".claude", "projects");

export async function discoverClaudeCodeSessions(
  projectsDir = CLAUDE_DIR,
  resolveGitRepo = true,
  includeUnreplayable = false,
): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(projectsDir);
  } catch {
    return sessions;
  }

  for (const projDir of projectDirs) {
    const projPath = join(projectsDir, projDir);
    const projStat = await stat(projPath).catch(() => null);
    if (!projStat?.isDirectory()) continue;

    const project = decodeProjectDir(projDir);

    let files: string[];
    try {
      files = await readdir(projPath);
    } catch {
      continue;
    }

    // Resolve gitRepo once per project dir using the first session's cwd
    // (decodeProjectDir is lossy for paths with hyphens, but session cwd is accurate)
    let gitRepo: string | undefined;
    let gitRepoResolved = false;

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;

      const filePath = join(projPath, file);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) continue;

      const info = await extractSessionInfo(filePath, fileStat.size, project, includeUnreplayable);
      if (info) {
        if (!gitRepoResolved && info.cwd) {
          gitRepo = resolveGitRepo ? await readGitRepo(info.cwd) : undefined;
          gitRepoResolved = true;
        }
        info.gitRepo = gitRepo;
        sessions.push(info);
      }
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
  includeUnreplayable = false,
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
  let compactionBoundaryCount = 0;
  let compactionSummaryCount = 0;
  const seenCompactionSummaries = new Set<string>();
  let sawParseableRecord = false;
  let readFailed = false;

  // Ring buffer of the most recent non-empty lines. Used in two reverse-scan
  // fallbacks after streaming completes: `custom-title` records written late
  // in the session, and the last record's outer `timestamp` (the session's
  // last activity time). Both rely on JSON.parse to read top-level fields
  // safely — a regex on the whole line would risk capturing nested timestamp
  // fields (e.g. inside user-pasted JSON content).
  const tail: string[] = [];

  const modelRe = /"model"\s*:\s*"(claude-[^"]+)"/;
  const durationRe = /"durationMs"\s*:\s*(\d+)/;
  const editToolRe = /"name"\s*:\s*"(Edit|Write|MultiEdit|NotebookEdit)"/;

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
      const toolMatches = line.match(TOOL_USE_RE);
      if (toolMatches) {
        toolCallCount += toolMatches.length;
        if (editToolRe.test(line)) editCountEst++;
      }
      if (/(?:^|[{,])\s*"subtype"\s*:\s*"compact_boundary"/.test(line)) {
        compactionBoundaryCount++;
      }
      if (/(?:^|[{,])\s*"isCompactSummary"\s*:\s*true/.test(line)) {
        const uuid = line.match(/"uuid"\s*:\s*"([^"]+)"/)?.[1];
        if (!uuid || !seenCompactionSummaries.has(uuid)) {
          if (uuid) seenCompactionSummaries.add(uuid);
          compactionSummaryCount++;
        }
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

      // --- JSON-parse only the first PROMPT_SCAN_LINES lines ---
      // Metadata typically lands in the first ~30 lines; initial prompts within 150.
      if (lineCount <= PROMPT_SCAN_LINES) {
        try {
          const obj = JSON.parse(line);
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
          sawParseableRecord = true;

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
              if (cleaned) prompts.push(cleaned.slice(0, 200));
            }
          }
        } catch {}
      }

      // --- tail buffer for late-session fallbacks ---
      tail.push(line);
      if (tail.length > TAIL_BUFFER_LINES) tail.shift();
    }
  } catch {
    readFailed = true;
    if (!includeUnreplayable) return null;
  } finally {
    rl?.close();
  }

  if (!sessionId) {
    sessionId = basename(filePath, ".jsonl");
  }
  if (!sessionId) return null;

  const unreadable = readFailed || !sawParseableRecord;
  if (!includeUnreplayable && (unreadable || prompts.length === 0)) return null;

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

  // Last activity timestamp: reverse-scan the tail buffer for the most recent
  // record carrying a top-level `timestamp`. JSON.parse is the right primitive
  // here — a substring/regex match on the line would be fooled by nested
  // `"timestamp"` keys inside `message.content` (e.g. user-pasted JSON), and
  // virtually every JSONL record envelope carries an outer timestamp so the
  // first hit is normally the very last record.
  for (let i = tail.length - 1; i >= 0 && !timestamp; i--) {
    try {
      const obj = JSON.parse(tail[i]);
      if (typeof obj.timestamp === "string" && obj.timestamp) {
        timestamp = obj.timestamp;
      }
    } catch {}
  }

  // Last-resort fallback: file mtime. Reaches here only if every record in the
  // tail buffer is unparseable or lacks a timestamp — extremely unusual but
  // keeps discovery resilient.
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
    firstPrompt: prompts[0] || "",
    prompts: prompts.length > 0 ? prompts : undefined,
    promptCount: unreadable ? 0 : promptCount,
    toolCallCount,
    model,
    durationMsEst: durationMsEst || undefined,
    editCountEst: editCountEst || undefined,
    compactionCount: Math.max(compactionBoundaryCount, compactionSummaryCount) || undefined,
    hasPR: hasPR || undefined,
    ...(unreadable || prompts.length === 0
      ? { transcriptStatus: unreadable ? ("unreadable" as const) : ("no-prompts" as const) }
      : {}),
  };
}
