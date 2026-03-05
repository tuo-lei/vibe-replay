import { readdir, stat, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import type { SessionInfo } from "../../types.js";

const CURSOR_DIR = join(homedir(), ".cursor", "projects");

export async function discoverCursorSessions(): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(CURSOR_DIR);
  } catch {
    return sessions;
  }

  for (const projDir of projectDirs) {
    const transcriptsDir = join(CURSOR_DIR, projDir, "agent-transcripts");
    const dirStat = await stat(transcriptsDir).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    const project = decodeProjectDir(projDir);

    let entries: string[];
    try {
      entries = await readdir(transcriptsDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = join(transcriptsDir, entry);
      const entryStat = await stat(entryPath).catch(() => null);
      if (!entryStat) continue;

      let jsonlPath: string;
      let fileSize: number;

      if (entry.endsWith(".jsonl")) {
        jsonlPath = entryPath;
        fileSize = entryStat.size;
      } else if (entryStat.isDirectory()) {
        // Subdirectory with same-name .jsonl inside
        const innerPath = join(entryPath, entry + ".jsonl");
        const innerStat = await stat(innerPath).catch(() => null);
        if (!innerStat) continue;
        jsonlPath = innerPath;
        fileSize = innerStat.size;
      } else {
        continue;
      }

      const info = await extractSessionInfo(jsonlPath, fileSize, project);
      if (info) sessions.push(info);
    }
  }

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

function decodeProjectDir(encoded: string): string {
  // Cursor uses similar encoding: "Users-tlei-Code-project" → "/Users/tlei/Code/project"
  return "/" + encoded.replace(/-/g, "/");
}

function shortenPath(path: string): string {
  const home = homedir();
  if (path.startsWith(home)) return "~" + path.slice(home.length);
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
    if (lines.length < 2) return null; // too short to be useful

    const sessionId = basename(filePath, ".jsonl");
    let firstPrompt = "";

    // Find first user prompt
    for (const line of lines.slice(0, 10)) {
      try {
        const obj = JSON.parse(line);
        if (obj.role === "user") {
          const textBlock = obj.message?.content?.find?.(
            (b: any) => b.type === "text",
          );
          if (textBlock?.text) {
            // Strip <user_query> wrapper if present
            firstPrompt = textBlock.text
              .replace(/<\/?user_query>/g, "")
              .trim()
              .slice(0, 200);
            break;
          }
        }
      } catch {
        continue;
      }
    }

    // Use file mtime as timestamp (Cursor doesn't store timestamps in JSONL)
    const fileStat2 = await stat(filePath);
    const timestamp = fileStat2.mtime.toISOString();

    return {
      provider: "cursor",
      sessionId,
      slug: sessionId.slice(0, 8),
      project: shortenPath(project),
      cwd: project,
      version: "",
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
