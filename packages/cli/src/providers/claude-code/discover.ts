import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
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
    return "/" + encoded.slice(1).replace(/-/g, "/");
  }
  return encoded;
}

function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) {
    return "~" + path.slice(home.length);
  }
  return path;
}

async function extractSessionInfo(
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
    let firstPrompt = "";
    let title: string | undefined;
    let metadataDone = false;

    // Scan lines for metadata (first 30) + first meaningful user prompt (up to 100)
    const scanLimit = Math.min(lines.length, 100);
    for (let i = 0; i < scanLimit; i++) {
      try {
        const obj = JSON.parse(lines[i]);

        if (!metadataDone) {
          if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
          if (!slug && obj.slug) slug = obj.slug;
          if (!cwd && obj.cwd) cwd = obj.cwd;
          if (!version && obj.version) version = obj.version;
          if (!gitBranch && obj.gitBranch) gitBranch = obj.gitBranch;

          if (obj.type === "custom-title" && obj.title) {
            title = obj.title;
          }

          if (obj.type === "file-history-snapshot" && obj.snapshot?.timestamp && !timestamp) {
            timestamp = obj.snapshot.timestamp;
          }

          if (i >= 29) metadataDone = true;
        }

        // Look for user prompts — skip boilerplate-only messages
        if (
          !firstPrompt &&
          obj.type === "user" &&
          obj.message?.role === "user" &&
          typeof obj.message.content === "string"
        ) {
          const cleaned = cleanPromptText(obj.message.content);
          if (cleaned.length >= 10) {
            firstPrompt = cleaned.slice(0, 200);
          }
        }

        // Stop early if we have everything
        if (firstPrompt && metadataDone) break;
      } catch {
        continue;
      }
    }

    if (!sessionId) return null;

    // Fallback timestamp: scan last lines for system/turn_duration with timestamp
    if (!timestamp) {
      for (const line of lines.slice(-10)) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "system" && obj.timestamp) {
            timestamp = obj.timestamp;
          }
        } catch {
          continue;
        }
      }
    }

    // Last fallback: file mtime
    if (!timestamp) {
      const fileStat2 = await stat(filePath);
      timestamp = fileStat2.mtime.toISOString();
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
      firstPrompt: firstPrompt || "(no prompt found)",
    };
  } catch {
    return null;
  }
}

/**
 * Strip system-injected boilerplate tags and filler text from a user prompt.
 * Returns the cleaned text (may be empty if the entire message was boilerplate).
 */
function cleanPromptText(text: string): string {
  // Skip array content (tool results, not real prompts)
  if (typeof text !== "string") return "";

  let cleaned = text;
  // Strip XML-style tags
  cleaned = cleaned.replace(/<\/?[a-z][a-z0-9-]*>/gi, "");
  // Remove boilerplate caveat text
  cleaned = cleaned.replace(
    /Caveat:\s*The messages below were generated by the user while running local commands\.[^.]*/g,
    "",
  );
  cleaned = cleaned.replace(/DO NOT respond to these messages[^.]*/g, "");
  // Remove slash commands (e.g. "/clear clear", "/resume resume")
  cleaned = cleaned.replace(/^\/\w+\s*/g, "");
  cleaned = cleaned.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return cleaned;
}

