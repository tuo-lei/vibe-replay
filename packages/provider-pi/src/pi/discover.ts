import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { cleanPromptText } from "@vibe-replay/provider-core/clean-prompt";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import { readGitRepo } from "@vibe-replay/provider-core/utils";
import { getPiSessionsDir } from "./config.js";
const PROMPT_SCAN_LIMIT = 2;

interface PiSessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd?: string;
}

export async function discoverPiSessions(): Promise<SessionInfo[]> {
  const sessionsRoot = getPiSessionsDir();
  const sessions: SessionInfo[] = [];

  let projectDirs: string[];
  try {
    projectDirs = await readdir(sessionsRoot);
  } catch {
    return sessions;
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(sessionsRoot, projectDir);
    const projectStat = await stat(projectPath).catch(() => null);
    if (!projectStat?.isDirectory()) continue;

    let files: string[];
    try {
      files = await readdir(projectPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const filePath = join(projectPath, file);
      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat) continue;

      const info = await extractPiSessionInfo(filePath, fileStat.size, projectDir);
      if (info) sessions.push(info);
    }
  }

  sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return sessions;
}

async function extractPiSessionInfo(
  filePath: string,
  fileSize: number,
  encodedProjectDir: string,
): Promise<SessionInfo | null> {
  let header: PiSessionHeader | undefined;
  let timestamp = "";
  let lineCount = 0;
  let promptCount = 0;
  let toolCallCount = 0;
  let editCountEst = 0;
  let model: string | undefined;
  let title: string | undefined;
  const prompts: string[] = [];

  const input = createReadStream(filePath, { encoding: "utf-8" });
  const rl = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;
      lineCount++;

      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (typeof entry.timestamp === "string" && entry.timestamp) {
        timestamp = entry.timestamp;
      }

      if (!header) {
        if (entry.type !== "session" || typeof entry.id !== "string") return null;
        header = entry;
        if (typeof entry.timestamp === "string" && entry.timestamp) timestamp = entry.timestamp;
        continue;
      }

      if (entry.type === "session_info") {
        const name = typeof entry.name === "string" ? entry.name.trim() : "";
        title = name || undefined;
        continue;
      }

      if (entry.type === "model_change" && typeof entry.modelId === "string") {
        model = entry.modelId;
        continue;
      }

      if (entry.type !== "message") continue;
      const message = entry.message;
      if (!message || typeof message !== "object") continue;

      if (message.role === "user") {
        const text = extractText(message.content).trim();
        if (text) {
          promptCount++;
          if (prompts.length < PROMPT_SCAN_LIMIT) {
            prompts.push(cleanPromptText(text).slice(0, 200));
          }
        }
      } else if (message.role === "assistant") {
        if (!model && typeof message.model === "string") model = message.model;
        if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block?.type !== "toolCall") continue;
            toolCallCount++;
            if (isEditTool(block.name)) editCountEst++;
          }
        }
      }
    }
  } catch {
    return null;
  } finally {
    rl.close();
  }

  if (!header || prompts.length === 0) return null;

  const cwd = header.cwd || decodeProjectDir(encodedProjectDir);
  const gitRepo = await readGitRepo(cwd);
  const slug = basename(filePath, ".jsonl").replace(/^\d{4}-\d{2}-\d{2}T[^_]+_/, "");
  const fallbackTimestamp = timestamp || header.timestamp || new Date().toISOString();

  return {
    provider: "pi",
    sessionId: header.id,
    slug,
    title,
    project: cwd,
    cwd,
    version: String(header.version || 1),
    gitRepo,
    timestamp: fallbackTimestamp,
    lineCount,
    fileSize,
    filePath,
    filePaths: [filePath],
    firstPrompt: prompts[0] || "(pi session)",
    prompts,
    promptCount,
    toolCallCount,
    model,
    editCountEst,
  };
}

function decodeProjectDir(encoded: string): string {
  if (encoded.startsWith("--") && encoded.endsWith("--")) {
    return `/${encoded.slice(2, -2).replace(/-/g, "/")}`;
  }
  return encoded;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } => block?.type === "text")
    .map((block) => block.text || "")
    .join("\n");
}

function isEditTool(name: unknown): boolean {
  return name === "edit" || name === "write" || name === "Edit" || name === "Write";
}
