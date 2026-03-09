import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import type { ParsedTurn, SessionInfo } from "../../types.js";
import type { DataSourceInfo, ProviderParseResult } from "../types.js";
import { parseCursorSqlite } from "./sqlite-reader.js";

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function compactErrorMessage(err: unknown, max = 180): string {
  const cleaned = toErrorMessage(err).replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}...`;
}

export async function parseCursorSession(
  filePaths: string | string[],
  sessionInfo?: SessionInfo,
): Promise<ProviderParseResult> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const transcriptPaths = paths.filter((p) => p.endsWith(".jsonl"));
  const explicitToolPaths = paths.filter((p) => p.endsWith(".txt"));
  let sqliteFallbackNote: string | undefined;
  let sqliteAttempted = false;

  // Try SQLite first if session info is available
  if (sessionInfo?.sessionId) {
    sqliteAttempted = true;
    let sqliteResult: ProviderParseResult | null = null;
    try {
      sqliteResult = await parseCursorSqlite(
        sessionInfo.workspacePath || "",
        sessionInfo.sessionId,
      );
    } catch (err) {
      // Cursor DB schemas can vary across versions/hosts; fall back to JSONL when available.
      sqliteFallbackNote = `cursor SQLite parse failed (${compactErrorMessage(err)}); fell back to JSONL transcript`;
      sqliteResult = null;
    }
    if (sqliteResult) {
      // Keep SQLite/global-state as source of truth, but supplement missing
      // thinking markers and user images from JSONL when transcript files are available.
      if (transcriptPaths.length > 0) {
        const thinkingBefore = countThinkingBlocks(sqliteResult.turns);
        const userImagesBefore = countUserImages(sqliteResult.turns);
        const jsonlThinking = await parseCursorJsonl(transcriptPaths, [], {
          inferToolPaths: false,
        });
        sqliteResult.turns = mergeJsonlSupplementsIntoCursorTurns(
          sqliteResult.turns,
          jsonlThinking.turns,
        );
        const thinkingAfter = countThinkingBlocks(sqliteResult.turns);
        const userImagesAfter = countUserImages(sqliteResult.turns);
        const supplementedThinkingBlocks = Math.max(0, thinkingAfter - thinkingBefore);
        const supplementedUserImages = Math.max(0, userImagesAfter - userImagesBefore);
        sqliteResult.dataSourceInfo = withSupplement(
          sqliteResult.dataSourceInfo || defaultDataSourceInfo(sqliteResult.dataSource),
          `cursor/projects/agent-transcripts/*.jsonl (thinking +${supplementedThinkingBlocks}, images +${supplementedUserImages})`,
        );
      }
      return sqliteResult;
    }
  }

  // Fallback to JSONL parsing
  if (transcriptPaths.length === 0) {
    if (sqliteFallbackNote) {
      throw new Error(
        `Cursor parse failed: ${sqliteFallbackNote.replace("; fell back to JSONL transcript", "")}. No transcript .jsonl fallback is available.`,
      );
    }
    if (sqliteAttempted) {
      throw new Error(
        "Cursor parse failed: SQLite data unavailable for this session and no transcript .jsonl fallback is available.",
      );
    }
    throw new Error("Cursor parse requires at least one transcript .jsonl path");
  }
  const jsonlResult = await parseCursorJsonl(transcriptPaths, explicitToolPaths, {
    inferToolPaths: true,
  });
  if (sqliteFallbackNote) {
    jsonlResult.dataSourceInfo = withNote(
      jsonlResult.dataSourceInfo || defaultDataSourceInfo(jsonlResult.dataSource),
      sqliteFallbackNote,
    );
  }
  return jsonlResult;
}

interface ParseJsonlOptions {
  inferToolPaths: boolean;
}

function defaultDataSourceInfo(
  dataSource?: ProviderParseResult["dataSource"],
): DataSourceInfo | undefined {
  if (!dataSource) return undefined;
  return {
    primary: dataSource,
    sources: [],
  };
}

function withSupplement(
  info: DataSourceInfo | undefined,
  supplement: string,
): DataSourceInfo | undefined {
  if (!info) return undefined;
  const supplements = [...(info.supplements || [])];
  if (!supplements.includes(supplement)) supplements.push(supplement);
  return { ...info, supplements };
}

function withNote(info: DataSourceInfo | undefined, note: string): DataSourceInfo | undefined {
  if (!info) return undefined;
  const notes = [...(info.notes || [])];
  if (!notes.includes(note)) notes.push(note);
  return { ...info, notes };
}

async function parseCursorJsonl(
  transcriptPaths: string[],
  explicitToolPaths: string[],
  options: ParseJsonlOptions,
): Promise<ProviderParseResult> {
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
      const userImages: string[] = [];
      const imageFilePaths = new Set<string>();
      for (const block of contentBlocks) {
        if (block.type === "text" && block.text) {
          let text = stripUserQueryWrapper(block.text);
          const extracted = extractImageFilePathsFromText(text);
          text = normalizeImagePlaceholderLines(extracted.cleanedText);
          for (const imagePath of extracted.paths) imageFilePaths.add(imagePath);
          if (text) textParts.push(text);
        } else if (block.type === "image") {
          const source = (block as any).source;
          if (source?.data) {
            const mediaType = source.media_type || "image/png";
            userImages.push(`data:${mediaType};base64,${source.data}`);
          }
        }
      }

      for (const imagePath of imageFilePaths) {
        const dataUrl = await readImageFileAsDataUrl(imagePath);
        if (dataUrl) userImages.push(dataUrl);
      }

      if (textParts.length === 0 && userImages.length === 0) continue;

      const fullText = textParts.join("\n");
      const markerParsed = role === "assistant" ? splitToolMarker(fullText) : undefined;
      const markerName = markerParsed?.markerName;
      const markerTextBody = markerParsed?.textBody;

      if (role === "user") {
        const blocks: any[] = [];
        if (fullText) blocks.push({ type: "text", text: fullText });
        const dedupedImages = [...new Set(userImages)];
        if (dedupedImages.length > 0) {
          blocks.push({ type: "_user_images", images: dedupedImages });
        }
        if (blocks.length > 0) {
          allTurns.push({ role, blocks });
        }
        continue;
      }

      if (markerName) {
        // Markers are status indicators — store as a placeholder that
        // attachToolEvents() can upgrade to a real tool_use if an
        // agent-tools file matches, otherwise convert to thinking.
        const blocks: any[] = [];
        if (markerTextBody) blocks.push({ type: "text", text: markerTextBody });
        blocks.push({
          type: "tool_use",
          id: `cursor-marker-${syntheticToolId++}`,
          name: markerName,
          input: { marker: markerName },
          _isPendingMarker: true,
        });
        allTurns.push({ role, blocks });
      } else {
        allTurns.push({ role, blocks: [{ type: "text", text: fullText }] });
      }
    }
  }

  const toolPaths =
    explicitToolPaths.length > 0
      ? await sortByMtime(explicitToolPaths)
      : options.inferToolPaths
        ? await inferToolPaths(sortedTranscriptPaths)
        : [];
  const toolEvents = await loadToolEvents(toolPaths);
  attachToolEvents(allTurns, toolEvents);

  // Derive slug from session ID
  const slug = sessionId.slice(0, 8);

  // Try to extract a meaningful title from first user prompt
  const firstUser = allTurns.find((t) => t.role === "user");
  const firstText =
    firstUser?.blocks[0]?.type === "text"
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
    dataSourceInfo: {
      primary: hasToolData ? "jsonl+tools" : "jsonl",
      sources: [
        "cursor/projects/agent-transcripts/*.jsonl",
        ...(hasToolData ? ["cursor/projects/agent-tools/*.txt"] : []),
      ],
    },
  };
}

function stripUserQueryWrapper(text: string): string {
  return text.replace(/<\/?user_query>/g, "").trim();
}

function normalizeImagePlaceholderLines(text: string): string {
  const lines = text.split("\n");
  const filtered = lines.filter((line) => !/^\s*\[Image\]\s*$/i.test(line.trim()));
  return filtered.join("\n").trim();
}

function resolveImagePath(pathValue: string): string {
  if (pathValue.startsWith("~/")) return join(homedir(), pathValue.slice(2));
  return pathValue;
}

function imageMediaType(pathValue: string): string {
  const lower = pathValue.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function extractImageFilePathsFromText(text: string): { cleanedText: string; paths: string[] } {
  const blockPattern = /<image_files>([\s\S]*?)<\/image_files>/gi;
  const paths = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(text)) !== null) {
    const blockContent = match[1];
    const pathRegex = /(?:^|\n)\s*(?:\d+\.\s*)?((?:~\/|\/)[^\n]+\.(?:png|jpe?g|gif|webp))/gi;
    let pathMatch: RegExpExecArray | null;
    while ((pathMatch = pathRegex.exec(blockContent)) !== null) {
      const pathValue = pathMatch[1].trim();
      if (pathValue) paths.add(resolveImagePath(pathValue));
    }
  }
  const cleanedText = text.replace(blockPattern, "").trim();
  return { cleanedText, paths: [...paths] };
}

async function readImageFileAsDataUrl(pathValue: string): Promise<string | null> {
  try {
    const data = await readFile(pathValue);
    return `data:${imageMediaType(pathValue)};base64,${data.toString("base64")}`;
  } catch {
    return null;
  }
}

function collectThinkingTexts(turn: ParsedTurn): string[] {
  const texts: string[] = [];
  for (const block of turn.blocks as any[]) {
    if (block?.type !== "thinking") continue;
    const text = typeof block.thinking === "string" ? block.thinking.trim() : "";
    if (text) texts.push(text);
  }
  return texts;
}

function buildThinkingBlocks(texts: string[]): any[] {
  return texts.map((thinking) => ({ type: "thinking", thinking }));
}

function countThinkingBlocks(turns: ParsedTurn[]): number {
  let count = 0;
  for (const turn of turns) {
    for (const block of turn.blocks as any[]) {
      if (block?.type === "thinking") count++;
    }
  }
  return count;
}

function collectUserImages(turn: ParsedTurn): string[] {
  const imageBlocks = (turn.blocks as any[]).filter((block) => block?.type === "_user_images");
  const images: string[] = [];
  for (const block of imageBlocks) {
    if (!Array.isArray(block.images)) continue;
    for (const image of block.images) {
      if (typeof image === "string" && image.trim()) images.push(image);
    }
  }
  return images;
}

function countUserImages(turns: ParsedTurn[]): number {
  let count = 0;
  for (const turn of turns) {
    count += collectUserImages(turn).length;
  }
  return count;
}

/**
 * Merge JSONL-only thinking markers into DB-derived turns.
 * We align assistant turns by index and only add missing thinking blocks.
 */
export function mergeJsonlThinkingIntoCursorTurns(
  primaryTurns: ParsedTurn[],
  jsonlTurns: ParsedTurn[],
): ParsedTurn[] {
  if (primaryTurns.length === 0 || jsonlTurns.length === 0) return primaryTurns;

  const merged = primaryTurns.map((turn) => ({
    ...turn,
    blocks: [...turn.blocks],
  }));

  const primaryAssistantIndices = merged
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.role === "assistant")
    .map(({ index }) => index);
  const jsonlAssistantTurns = jsonlTurns.filter((turn) => turn.role === "assistant");

  const paired = Math.min(primaryAssistantIndices.length, jsonlAssistantTurns.length);
  for (let i = 0; i < paired; i++) {
    const targetTurn = merged[primaryAssistantIndices[i]];
    const candidateThinking = collectThinkingTexts(jsonlAssistantTurns[i]);
    if (candidateThinking.length === 0) continue;

    const existingThinking = new Set(collectThinkingTexts(targetTurn));
    const missingThinking = candidateThinking.filter((text) => !existingThinking.has(text));
    if (missingThinking.length === 0) continue;

    targetTurn.blocks = [...buildThinkingBlocks(missingThinking), ...targetTurn.blocks] as any;
  }

  // If JSONL has extra assistant thinking turns (common with marker-only lines),
  // preserve them as standalone assistant thinking turns.
  for (let i = paired; i < jsonlAssistantTurns.length; i++) {
    const extraThinking = collectThinkingTexts(jsonlAssistantTurns[i]);
    if (extraThinking.length === 0) continue;
    merged.push({
      role: "assistant",
      timestamp: jsonlAssistantTurns[i].timestamp,
      blocks: buildThinkingBlocks(extraThinking) as any,
    });
  }

  return merged;
}

function mergeJsonlUserImagesIntoCursorTurns(
  primaryTurns: ParsedTurn[],
  jsonlTurns: ParsedTurn[],
): ParsedTurn[] {
  if (primaryTurns.length === 0 || jsonlTurns.length === 0) return primaryTurns;

  const merged = primaryTurns.map((turn) => ({
    ...turn,
    blocks: [...turn.blocks],
  }));

  const primaryUserIndices = merged
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn.role === "user")
    .map(({ index }) => index);
  const jsonlUserTurns = jsonlTurns.filter((turn) => turn.role === "user");
  const paired = Math.min(primaryUserIndices.length, jsonlUserTurns.length);

  for (let i = 0; i < paired; i++) {
    const targetTurn = merged[primaryUserIndices[i]];
    const candidateImages = collectUserImages(jsonlUserTurns[i]);
    if (candidateImages.length === 0) continue;

    const existingImages = collectUserImages(targetTurn);
    const mergedImages = [...new Set([...existingImages, ...candidateImages])];
    if (mergedImages.length === existingImages.length) continue;

    const nonImageBlocks = (targetTurn.blocks as any[]).filter(
      (block) => block?.type !== "_user_images",
    );
    targetTurn.blocks = [...nonImageBlocks, { type: "_user_images", images: mergedImages }] as any;
  }

  return merged;
}

export function mergeJsonlSupplementsIntoCursorTurns(
  primaryTurns: ParsedTurn[],
  jsonlTurns: ParsedTurn[],
): ParsedTurn[] {
  const withThinking = mergeJsonlThinkingIntoCursorTurns(primaryTurns, jsonlTurns);
  return mergeJsonlUserImagesIntoCursorTurns(withThinking, jsonlTurns);
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
    projects.get(projectRoot)?.add(transcriptPath);
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
  const markerBlocks: Array<{ block: any; turn: ParsedTurn; blockIndex: number }> = [];
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (let bi = 0; bi < turn.blocks.length; bi++) {
      const block = turn.blocks[bi] as any;
      if (block?._isPendingMarker) {
        markerBlocks.push({ block, turn, blockIndex: bi });
      }
    }
  }

  // Pair markers with real tool outputs (chronological order)
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
    delete marker.block._isPendingMarker;
    if (!marker.turn.timestamp && tool.timestamp) {
      marker.turn.timestamp = tool.timestamp;
    }
  }

  // Unpaired markers → convert to thinking (they're just status text, not tool calls)
  for (let i = paired; i < markerBlocks.length; i++) {
    const { turn, blockIndex, block } = markerBlocks[i];
    const thinkingBlock = {
      type: "thinking",
      thinking: block.name || block.input?.marker || "",
    };
    (turn.blocks as any[])[blockIndex] = thinkingBlock;
  }

  // Extra tool outputs with no matching marker → append as real tool calls
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
