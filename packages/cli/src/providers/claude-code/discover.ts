import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanPromptText, isSystemGeneratedMessage } from "../../clean-prompt.js";
import type { SessionInfo } from "../../types.js";

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

function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

export async function extractSessionInfo(
  filePath: string,
  fileSize: number,
  project: string,
): Promise<SessionInfo | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return null;

    let sessionId = "";
    let slug = "";
    let cwd = "";
    let version = "";
    let gitBranch: string | undefined;
    let timestamp = "";
    const prompts: string[] = [];
    let title: string | undefined;
    let metadataDone = false;
    const MAX_PROMPTS = 2;

    // Scan lines for metadata (first 30) + first meaningful user prompts (up to 150)
    const scanLimit = Math.min(lines.length, 150);
    for (let i = 0; i < scanLimit; i++) {
      try {
        const obj = JSON.parse(lines[i]);

        if (!metadataDone) {
          if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
          if (!slug && obj.slug) slug = obj.slug;
          if (!cwd && obj.cwd) cwd = obj.cwd;
          if (!version && obj.version) version = obj.version;
          if (!gitBranch && obj.gitBranch) gitBranch = obj.gitBranch;

          if (obj.type === "custom-title" && (obj.customTitle || obj.title)) {
            title = obj.customTitle || obj.title;
          }

          if (obj.type === "file-history-snapshot" && obj.snapshot?.timestamp && !timestamp) {
            timestamp = obj.snapshot.timestamp;
          }

          if (i >= 29) metadataDone = true;
        }

        // Collect meaningful user prompts (skip boilerplate)
        // Content can be a string (CLI / terminal mode) or an array of content blocks
        // (VS Code extension native panel sends [{type:"text",text:"..."}])
        if (prompts.length < MAX_PROMPTS && obj.type === "user" && obj.message?.role === "user") {
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
          if (text && !isSystemGeneratedMessage(text)) {
            const cleaned = cleanPromptText(text);
            if (cleaned.length >= 10) {
              prompts.push(cleaned.slice(0, 200));
            }
          }
        }

        // Stop early if we have everything
        if (prompts.length >= MAX_PROMPTS && metadataDone) break;
      } catch {}
    }

    if (!sessionId || prompts.length === 0) return null;

    // Fallback title: custom-title is often written at session end, beyond scanLimit.
    // Do a cheap reverse scan of the last ~50 lines.
    if (!title) {
      const tailStart = Math.max(0, lines.length - 50);
      for (let i = lines.length - 1; i >= tailStart; i--) {
        const line = lines[i];
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

    // Fallback timestamp: scan last lines for system/turn_duration with timestamp
    if (!timestamp) {
      for (const line of lines.slice(-10)) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "system" && obj.timestamp) {
            timestamp = obj.timestamp;
          }
        } catch {}
      }
    }

    // Last fallback: file mtime
    if (!timestamp) {
      const fileStat2 = await stat(filePath);
      timestamp = fileStat2.mtime.toISOString();
    }

    // Count user prompts and tool calls — data already in memory, zero extra I/O
    // Only count user messages that are actual prompts (have text), not tool_result messages.
    // NOTE: The `!line.includes('"tool_result"')` heuristic could theoretically under-count
    // if a user's actual prompt text literally contains the string "tool_result". This is an
    // accepted edge case — it's extremely rare in practice and the fast string check avoids
    // JSON-parsing every line.
    let promptCount = 0;
    let toolCallCount = 0;
    const toolUseRe = /"type"\s*:\s*"tool_use"/g;
    for (const line of lines) {
      if (
        (line.includes('"type":"user"') || line.includes('"type": "user"')) &&
        !line.includes('"tool_result"')
      ) {
        promptCount++;
      }
      const toolMatches = line.match(toolUseRe);
      if (toolMatches) toolCallCount += toolMatches.length;
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
      lineCount: lines.length,
      fileSize,
      filePath,
      filePaths: [filePath],
      firstPrompt: prompts[0],
      prompts,
      promptCount,
      toolCallCount,
    };
  } catch {
    return null;
  }
}
