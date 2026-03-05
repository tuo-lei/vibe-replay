import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ParsedTurn, SessionInfo } from "../../types.js";
import type { ProviderParseResult } from "../types.js";
import { parseCursorSqlite } from "./sqlite-reader.js";

export async function parseCursorSession(
  filePaths: string | string[],
  sessionInfo?: SessionInfo,
): Promise<ProviderParseResult> {
  // Try SQLite first if session info with workspace path is available
  if (sessionInfo?.workspacePath && sessionInfo.sessionId) {
    const sqliteResult = await parseCursorSqlite(
      sessionInfo.workspacePath,
      sessionInfo.sessionId,
    );
    if (sqliteResult) return sqliteResult;
  }

  // Fallback to JSONL parsing
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const transcriptPaths = paths.filter((p) => p.endsWith(".jsonl"));
  const explicitToolPaths = paths.filter((p) => p.endsWith(".txt"));
  if (transcriptPaths.length === 0) {
    throw new Error("Cursor parse requires at least one transcript .jsonl path");
  }

  const allTurns: ParsedTurn[] = [];
  let syntheticToolId = 0;
  const sortedTranscriptPaths = await sortByMtime(transcriptPaths);
  const sessionId = basename(sortedTranscriptPaths[sortedTranscriptPaths.length - 1], ".jsonl");

  for (const filePath of sortedTranscriptPaths) {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const role = obj.role as "user" | "assistant";
      const contentBlocks = obj.message?.content;
      if (!Array.isArray(contentBlocks)) continue;

      const textParts: string[] = [];
      for (const block of contentBlocks) {
        if (block.type === "text" && block.text) {
          let text = block.text;
          // Strip Cursor's <user_query> wrapper
          text = text.replace(/<\/?user_query>/g, "").trim();
          if (text) textParts.push(text);
        }
      }

      if (textParts.length === 0) continue;

      const fullText = textParts.join("\n");
      const markerParsed = role === "assistant" ? splitToolMarker(fullText) : undefined;
      const markerName = markerParsed?.markerName;
      const markerTextBody = markerParsed?.textBody;

      allTurns.push({
        role,
        blocks: markerName
          ? [
              ...(markerTextBody
                ? [{ type: "text", text: markerTextBody } as any]
                : []),
              {
                type: "tool_use",
                id: `cursor-marker-${syntheticToolId++}`,
                name: markerName,
                input: { marker: markerName },
              } as any,
            ]
          : [{ type: "text", text: fullText }],
      });
    }
  }

  const toolPaths = explicitToolPaths.length > 0
    ? await sortByMtime(explicitToolPaths)
    : await inferToolPaths(sortedTranscriptPaths);
  const toolEvents = await loadToolEvents(toolPaths);
  attachToolEvents(allTurns, toolEvents);

  // Derive slug from session ID
  const slug = sessionId.slice(0, 8);

  // Try to extract a meaningful title from first user prompt
  const firstUser = allTurns.find((t) => t.role === "user");
  const firstText = firstUser?.blocks[0]?.type === "text"
    ? (firstUser.blocks[0] as any).text?.slice(0, 80)
    : undefined;

  const hasToolData = toolPaths.length > 0;
  return {
    sessionId,
    slug,
    title: firstText,
    cwd: "",
    turns: allTurns,
    dataSource: hasToolData ? "jsonl+tools" : "jsonl",
  };
}

interface TimestampedPath {
  path: string;
  mtimeMs: number;
}

interface ToolEvent {
  id: string;
  name: string;
  input: Record<string, any>;
  result: string;
  timestamp?: string;
}

async function sortByMtime(paths: string[]): Promise<string[]> {
  const entries: TimestampedPath[] = [];
  for (const path of paths) {
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) continue;
    entries.push({ path, mtimeMs: st.mtimeMs });
  }
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return entries.map((e) => e.path);
}

async function inferToolPaths(transcriptPaths: string[]): Promise<string[]> {
  const toolPaths: string[] = [];
  const seen = new Set<string>();
  const projects = new Map<string, Set<string>>();

  for (const transcriptPath of transcriptPaths) {
    const projectRoot = getCursorProjectRoot(transcriptPath);
    if (!projectRoot) continue;
    if (!projects.has(projectRoot)) projects.set(projectRoot, new Set());
    projects.get(projectRoot)!.add(transcriptPath);
  }

  for (const [projectRoot, selectedPaths] of projects.entries()) {
    const transcriptsDir = join(projectRoot, "agent-transcripts");
    const toolDir = join(projectRoot, "agent-tools");
    const transcriptEntries = await collectTranscriptEntries(transcriptsDir);
    const toolEntries = await collectToolEntries(toolDir);
    if (transcriptEntries.length === 0 || toolEntries.length === 0) continue;
    transcriptEntries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    toolEntries.sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (let i = 0; i < transcriptEntries.length; i++) {
      const transcript = transcriptEntries[i];
      if (!selectedPaths.has(transcript.path)) continue;
      const prevMtimeMs = i === 0 ? Number.NEGATIVE_INFINITY : transcriptEntries[i - 1].mtimeMs;
      for (const tool of toolEntries) {
        if (tool.mtimeMs <= prevMtimeMs || tool.mtimeMs > transcript.mtimeMs) continue;
        if (seen.has(tool.path)) continue;
        seen.add(tool.path);
        toolPaths.push(tool.path);
      }
    }
  }

  return sortByMtime(toolPaths);
}

async function collectTranscriptEntries(transcriptsDir: string): Promise<TimestampedPath[]> {
  let entries: string[];
  try {
    entries = await readdir(transcriptsDir);
  } catch {
    return [];
  }

  const transcripts: TimestampedPath[] = [];
  for (const entry of entries) {
    const entryPath = join(transcriptsDir, entry);
    const st = await stat(entryPath).catch(() => null);
    if (!st) continue;

    if (entry.endsWith(".jsonl") && st.isFile()) {
      transcripts.push({ path: entryPath, mtimeMs: st.mtimeMs });
      continue;
    }
    if (!st.isDirectory()) continue;
    const nested = join(entryPath, `${entry}.jsonl`);
    const nestedStat = await stat(nested).catch(() => null);
    if (!nestedStat?.isFile()) continue;
    transcripts.push({ path: nested, mtimeMs: nestedStat.mtimeMs });
  }
  return transcripts;
}

async function collectToolEntries(toolDir: string): Promise<TimestampedPath[]> {
  let entries: string[];
  try {
    entries = await readdir(toolDir);
  } catch {
    return [];
  }

  const tools: TimestampedPath[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".txt")) continue;
    const entryPath = join(toolDir, entry);
    const st = await stat(entryPath).catch(() => null);
    if (!st?.isFile()) continue;
    tools.push({ path: entryPath, mtimeMs: st.mtimeMs });
  }
  return tools;
}

function getCursorProjectRoot(transcriptPath: string): string | null {
  const parts = transcriptPath.split(/[/\\]agent-transcripts[/\\]/);
  if (parts.length < 2) return null;
  return parts[0];
}

async function loadToolEvents(toolPaths: string[]): Promise<ToolEvent[]> {
  const events: ToolEvent[] = [];
  for (const path of toolPaths) {
    const content = await readFile(path, "utf-8").catch(() => "");
    const result = content.trim();
    if (!result) continue;
    const st = await stat(path).catch(() => null);
    const id = basename(path, extname(path));
    events.push({
      id,
      name: inferToolName(result),
      input: { source: basename(path) },
      result,
      timestamp: st ? new Date(st.mtimeMs).toISOString() : undefined,
    });
  }
  return events;
}

function inferToolName(result: string): string {
  const firstLine = result.split("\n", 1)[0] || "";
  if (result.startsWith("diff --git")) return "Diff";
  if (firstLine.startsWith("http://") || firstLine.startsWith("https://")) return "WebFetch";
  if (firstLine.startsWith("{") || firstLine.startsWith("[")) return "API";
  if (/\$ |\bCommand\b|^\w+(\s+\w+){0,3}\s+-/.test(firstLine)) return "Bash";
  return "ToolOutput";
}

function attachToolEvents(turns: ParsedTurn[], tools: ToolEvent[]): void {
  const markerBlocks: Array<{ block: any; turn: ParsedTurn }> = [];
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const block of turn.blocks as any[]) {
      if (block?.type === "tool_use" && typeof block.id === "string" && block.id.startsWith("cursor-marker-")) {
        markerBlocks.push({ block, turn });
      }
    }
  }

  const paired = Math.min(markerBlocks.length, tools.length);
  for (let i = 0; i < paired; i++) {
    const marker = markerBlocks[i];
    const tool = tools[i];
    marker.block.name = tool.name;
    marker.block.input = {
      ...(marker.block.input || {}),
      ...(tool.input || {}),
    };
    marker.block._result = tool.result;
    if (!marker.turn.timestamp && tool.timestamp) {
      marker.turn.timestamp = tool.timestamp;
    }
  }

  for (let i = paired; i < markerBlocks.length; i++) {
    markerBlocks[i].block._result = "";
  }

  for (let i = paired; i < tools.length; i++) {
    const tool = tools[i];
    turns.push({
      role: "assistant",
      timestamp: tool.timestamp,
      blocks: [toToolUseBlock(tool) as any],
    });
  }
}

function toToolUseBlock(tool: ToolEvent) {
  return {
    type: "tool_use",
    id: tool.id,
    name: tool.name,
    input: tool.input,
    _result: tool.result,
  };
}

function splitToolMarker(text: string): { markerName: string; textBody?: string } | undefined {
  const trimmed = text.trim();
  const single = trimmed.match(/^\*\*([^*\n]{2,120})\*\*$/);
  if (single) return { markerName: single[1].trim() };

  const trailing = trimmed.match(/^([\s\S]*?)\n+\*\*([^*\n]{2,120})\*\*$/);
  if (trailing) {
    const textBody = trailing[1].trim();
    return {
      markerName: trailing[2].trim(),
      ...(textBody ? { textBody } : {}),
    };
  }
  return undefined;
}
