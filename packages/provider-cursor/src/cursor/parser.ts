import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import {
  normalizeSubAgentType,
  type ContentBlock,
  type ParsedTurn,
  type SessionInfo,
} from "@vibe-replay/provider-contract";
import type { DataSourceInfo, ProviderParseResult } from "@vibe-replay/provider-contract";
import type { Scene, SubAgent, TurnStat } from "@vibe-replay/types";
import {
  sanitizeCursorAssistantText,
  extractCursorTimestamp,
  sanitizeCursorReasoningText,
  sanitizeCursorUserText,
} from "./sanitize.js";
import {
  buildTurnDurationIntervals,
  sumDurationIntervals,
} from "@vibe-replay/provider-core/duration";
import {
  applySdkEnrichmentToTurns,
  findSdkAgentById,
  loadSdkAgentEnrichment,
  type SdkAgentEnrichment,
} from "./sdk-reader.js";
import {
  isSystemContextText,
  mapCursorToolName,
  mapToolArgs,
  parseCursorSqlite,
  SESSION_ID_RE,
} from "./sqlite-reader.js";
import { addParseWarning } from "@vibe-replay/provider-contract/warnings";

export interface CursorParserDependencies {
  isSystemContextText: (text: string) => boolean;
  mapCursorToolName: (name: string) => string;
  mapToolArgs: (toolName: string, args: unknown, resultText?: string) => Record<string, any>;
  parseCursorSqlite: (
    workspacePath: string,
    sessionId: string,
  ) => Promise<ProviderParseResult | null>;
}

const defaultDependencies: CursorParserDependencies = {
  isSystemContextText,
  mapCursorToolName,
  mapToolArgs,
  parseCursorSqlite,
};

export function createCursorParser(deps: Partial<CursorParserDependencies> = {}) {
  const resolved: CursorParserDependencies = { ...defaultDependencies, ...deps };
  return (filePaths: string | string[], sessionInfo?: SessionInfo): Promise<ProviderParseResult> =>
    parseCursorSessionWithDependencies(filePaths, sessionInfo, resolved);
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function compactErrorMessage(err: unknown, max = 180): string {
  const cleaned = toErrorMessage(err).replace(/\s+/g, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}...`;
}

export const parseCursorSession = createCursorParser();

async function parseCursorSessionWithDependencies(
  filePaths: string | string[],
  sessionInfo: SessionInfo | undefined,
  deps: CursorParserDependencies,
): Promise<ProviderParseResult> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const transcriptPaths = paths.filter((p) => p.endsWith(".jsonl"));
  const explicitToolPaths = paths.filter((p) => p.endsWith(".txt"));
  const inferredSqliteSession = inferCursorSqliteSession(paths);
  let sqliteError: string | undefined;
  let sqliteFallbackNote: string | undefined;
  let sqliteAttempted = false;

  // Try SQLite first if session info is available
  // Discovery explicitly marks transcript-only sessions. Probing every one of
  // them against Cursor's SQLite stores adds ~80–100ms per session and rebuilds
  // indexes that cannot contain the session.
  const sqliteSessionId =
    sessionInfo?.hasSqlite === false
      ? inferredSqliteSession?.sessionId
      : sessionInfo?.sessionId || inferredSqliteSession?.sessionId;
  if (sqliteSessionId) {
    sqliteAttempted = true;
    let sqliteResult: ProviderParseResult | null = null;
    try {
      const preferredWorkspacePath = sessionInfo?.workspacePath || sessionInfo?.cwd || "";
      sqliteResult = await deps.parseCursorSqlite(preferredWorkspacePath, sqliteSessionId);
    } catch (err) {
      // Cursor DB schemas can vary across versions/hosts; fall back to JSONL when available.
      sqliteError = compactErrorMessage(err);
      sqliteFallbackNote = `cursor SQLite parse failed (${sqliteError}); fell back to JSONL transcript`;
      sqliteResult = null;
    }
    if (sqliteResult) {
      // Keep SQLite/global-state as source of truth, but supplement missing
      // thinking markers and user images from JSONL when transcript files are available.
      if (transcriptPaths.length > 0) {
        const thinkingBefore = countThinkingBlocks(sqliteResult.turns);
        const userImagesBefore = countUserImages(sqliteResult.turns);
        const timestampsBefore = countTurnTimestamps(sqliteResult.turns);
        const jsonlThinking = await parseCursorJsonl(
          transcriptPaths,
          [],
          {
            inferToolPaths: false,
          },
          deps,
        );
        sqliteResult.parseWarnings = mergeParseWarnings(
          sqliteResult.parseWarnings,
          jsonlThinking.parseWarnings,
        );
        sqliteResult.turns = mergeJsonlSupplementsIntoCursorTurns(
          sqliteResult.turns,
          jsonlThinking.turns,
        );
        mergeJsonlTimingIntoCursorResult(sqliteResult, jsonlThinking);
        const thinkingAfter = countThinkingBlocks(sqliteResult.turns);
        const userImagesAfter = countUserImages(sqliteResult.turns);
        const timestampsAfter = countTurnTimestamps(sqliteResult.turns);
        const supplementedThinkingBlocks = Math.max(0, thinkingAfter - thinkingBefore);
        const supplementedUserImages = Math.max(0, userImagesAfter - userImagesBefore);
        const supplementedTimestamps = Math.max(0, timestampsAfter - timestampsBefore);
        sqliteResult.dataSourceInfo = withSupplement(
          sqliteResult.dataSourceInfo || defaultDataSourceInfo(sqliteResult.dataSource),
          `cursor/projects/agent-transcripts/*.jsonl (thinking +${supplementedThinkingBlocks}, images +${supplementedUserImages}${supplementedTimestamps > 0 ? `, timestamps +${supplementedTimestamps}` : ""})`,
        );
      }
      await attachCursorSubagents(sqliteResult, transcriptPaths, deps);
      return sqliteResult;
    }
  }

  // Fallback to JSONL parsing
  if (transcriptPaths.length === 0) {
    if (sqliteError) {
      throw new Error(
        `Cursor parse failed: ${sqliteError}. No transcript .jsonl fallback is available.`,
      );
    }
    if (sqliteAttempted) {
      throw new Error(
        "Cursor parse failed: SQLite data unavailable for this session and no transcript .jsonl fallback is available.",
      );
    }
    throw new Error("Cursor parse requires at least one transcript .jsonl path");
  }
  const jsonlResult = await parseCursorJsonl(
    transcriptPaths,
    explicitToolPaths,
    {
      inferToolPaths: true,
    },
    deps,
  );
  const preferredWorkspacePath = sessionInfo?.workspacePath || sessionInfo?.cwd || "";
  if (!jsonlResult.cwd && preferredWorkspacePath) {
    jsonlResult.cwd = preferredWorkspacePath;
  }
  if (sqliteFallbackNote) {
    jsonlResult.dataSourceInfo = withNote(
      jsonlResult.dataSourceInfo || defaultDataSourceInfo(jsonlResult.dataSource),
      sqliteFallbackNote,
    );
  }

  // Cursor SDK enrichment — Cursor SDK agents only have a JSONL transcript
  // (no IDE chat store.db), so the SDK index.db is the only place tool *results*
  // are recorded. Apply now so the replay has results, durations, and per-turn model.
  // If Cursor ever also backfills SDK agents into IDE store.db, keep that path
  // SQLite-first and only add SDK enrichment after deciding how to reconcile
  // duplicate tool streams.
  // We accept the sessionId from explicit sessionInfo OR from the transcript filename
  // (Cursor names SDK transcripts `<agentId>.jsonl`, which is exactly what the SDK
  // store keys agents on).
  const sdkSessionId = sessionInfo?.sessionId || deriveSessionIdFromTranscript(transcriptPaths);
  if (sdkSessionId) {
    const enrichment = await tryLoadSdkEnrichment(sdkSessionId);
    if (enrichment) {
      const { toolCallsEnriched, assistantTurnsModelTagged } = applySdkEnrichmentToTurns(
        jsonlResult.turns,
        enrichment,
      );
      if (toolCallsEnriched > 0 || assistantTurnsModelTagged > 0) {
        jsonlResult.dataSourceInfo = withSupplement(
          jsonlResult.dataSourceInfo || defaultDataSourceInfo(jsonlResult.dataSource),
          `cursor-sdk index.db (tool results +${toolCallsEnriched}, model tags +${assistantTurnsModelTagged})`,
        );
      }
      if (enrichment.latestModel && !jsonlResult.model) {
        jsonlResult.model = enrichment.latestModel;
      }
      if (enrichment.startedAt && !jsonlResult.startTime) {
        jsonlResult.startTime = enrichment.startedAt;
      }
      if (enrichment.finishedAt && !jsonlResult.endTime) {
        jsonlResult.endTime = enrichment.finishedAt;
      }
      if (enrichment.totalDurationMs !== undefined) {
        jsonlResult.totalDurationMs = enrichment.totalDurationMs;
        jsonlResult.turnStats = mergeSdkTurnStats(jsonlResult.turnStats, enrichment.turnStats);
        jsonlResult.dataSourceInfo = withSupplement(
          jsonlResult.dataSourceInfo || defaultDataSourceInfo(jsonlResult.dataSource),
          "cursor-sdk index.db (union of run intervals)",
        );
      }
      // SDK transcripts carry no usage of their own, so the index.db totals are
      // the only token accounting available for these sessions.
      if (enrichment.tokenUsage && !jsonlResult.tokenUsage) {
        jsonlResult.tokenUsage = enrichment.tokenUsage;
      }
      if (enrichment.tokenUsageByModel && !jsonlResult.tokenUsageByModel) {
        jsonlResult.tokenUsageByModel = enrichment.tokenUsageByModel;
      }
    }
  }
  await attachCursorSubagents(jsonlResult, transcriptPaths, deps);
  return jsonlResult;
}

function inferCursorSqliteSession(paths: string[]): { sessionId: string } | undefined {
  for (const path of paths) {
    const sessionId = sessionIdFromGlobalStatePath(path) || sessionIdFromStoreDbPath(path);
    if (sessionId) return { sessionId };
  }
  return undefined;
}

function sessionIdFromGlobalStatePath(path: string): string | undefined {
  const marker = "#composerData:";
  const markerIndex = path.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const rawSessionId = path
    .slice(markerIndex + marker.length)
    .split(/[/?#]/, 1)[0]
    ?.trim();
  return rawSessionId || undefined;
}

function sessionIdFromStoreDbPath(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (parts.at(-1) !== "store.db") return undefined;
  const rawSessionId = parts.at(-2)?.trim();
  if (!rawSessionId || !SESSION_ID_RE.test(rawSessionId)) return undefined;
  return rawSessionId;
}

async function tryLoadSdkEnrichment(sessionId: string): Promise<SdkAgentEnrichment | null> {
  // SDK agent IDs are prefixed `agent-`. Skip the lookup for plain UUID sessions
  // (Cursor IDE chats) to avoid touching SDK SQLite when we know it won't match.
  if (!sessionId.startsWith("agent-")) return null;
  try {
    const agent = await findSdkAgentById(sessionId);
    if (!agent) return null;
    return await loadSdkAgentEnrichment(agent);
  } catch {
    return null;
  }
}

function deriveSessionIdFromTranscript(transcriptPaths: string[]): string | null {
  // Pick the latest transcript by name (sortedTranscriptPaths inside parseCursorJsonl
  // sorts by mtime, but here we only need *some* transcript to extract the agent id;
  // for SDK sessions every transcript filename is identical to the agent id).
  for (let i = transcriptPaths.length - 1; i >= 0; i--) {
    const p = transcriptPaths[i];
    const base = basename(p, ".jsonl");
    if (base.startsWith("agent-")) return base;
  }
  return null;
}

function mergeParseWarnings(
  base: ProviderParseResult["parseWarnings"],
  extra: ProviderParseResult["parseWarnings"],
): ProviderParseResult["parseWarnings"] {
  const merged: NonNullable<ProviderParseResult["parseWarnings"]> = [];
  for (const warning of [...(base || []), ...(extra || [])]) {
    addParseWarning(merged, warning);
  }
  return merged.length > 0 ? merged : undefined;
}

interface ParseJsonlOptions {
  inferToolPaths: boolean;
}

interface CursorToolResult {
  result: string;
  timestamp?: string;
}

type ToolUseBlock = Extract<ContentBlock, { type: "tool_use" }>;

interface ParsedCursorSubagentTranscript {
  agentId: string;
  sourcePrompt: string;
  toolCalls: number;
  thinkingBlocks: number;
  textResponses: number;
  scenes: Scene[];
}

interface PendingCursorSubagentTool {
  scene: Extract<Scene, { type: "tool-call" }>;
  id?: string;
  rawName: string;
  rawInput: unknown;
  timestamp?: string;
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

interface CursorTurnTiming {
  startTime?: string;
  endTime?: string;
  totalDurationMs?: number;
  turnStats?: TurnStat[];
}

function buildCursorTurnTiming(turns: ParsedTurn[]): CursorTurnTiming {
  const events = turns.map((turn) => ({
    role: turn.role,
    startMs: turn.role === "user" ? timestampMs(turn.timestamp) : undefined,
    endMs: turn.role === "assistant" ? assistantTurnEndMs(turn) : undefined,
  }));
  const intervals = buildTurnDurationIntervals(events);
  const hasDuration = intervals.some((interval) => interval !== undefined);
  const turnStats = hasDuration
    ? intervals.map((interval, turnIndex) => ({
        turnIndex,
        ...(interval ? { durationMs: interval.endMs - interval.startMs } : {}),
      }))
    : undefined;

  const userTimestamps = turns
    .filter((turn) => turn.role === "user")
    .map((turn) => timestampMs(turn.timestamp))
    .filter((timestamp): timestamp is number => timestamp !== undefined);
  const endTimestamps = turns
    .filter((turn) => turn.role === "assistant")
    .map(assistantTurnEndMs)
    .filter((timestamp): timestamp is number => timestamp !== undefined);

  return {
    ...(userTimestamps.length > 0
      ? { startTime: new Date(Math.min(...userTimestamps)).toISOString() }
      : {}),
    ...(endTimestamps.length > 0
      ? { endTime: new Date(Math.max(...endTimestamps)).toISOString() }
      : {}),
    ...(hasDuration ? { totalDurationMs: sumDurationIntervals(intervals) } : {}),
    ...(turnStats ? { turnStats } : {}),
  };
}

function assistantTurnEndMs(turn: ParsedTurn): number | undefined {
  let latest = timestampMs(turn.timestamp);
  for (const block of turn.blocks) {
    if (block.type !== "tool_use") continue;
    const resultTimestamp = timestampMs(block._resultTimestamp);
    if (resultTimestamp !== undefined && (latest === undefined || resultTimestamp > latest)) {
      latest = resultTimestamp;
    }
  }
  return latest;
}

function timestampMs(timestamp: string | undefined): number | undefined {
  if (!timestamp) return undefined;
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : undefined;
}

async function parseCursorJsonl(
  transcriptPaths: string[],
  explicitToolPaths: string[],
  options: ParseJsonlOptions,
  deps: CursorParserDependencies,
): Promise<ProviderParseResult> {
  const allTurns: ParsedTurn[] = [];
  let syntheticToolId = 0;
  const toolResults = new Map<string, CursorToolResult>();
  const toolErrors = new Map<string, boolean>();
  const toolImages = new Map<string, string[]>();
  const parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]> = [];
  const sortedTranscriptPaths = await sortByMtime(transcriptPaths);
  const sessionId = basename(sortedTranscriptPaths[sortedTranscriptPaths.length - 1], ".jsonl");
  const firstTranscriptPathByRecord = new Map<string, string>();
  let duplicateTranscriptRecords = 0;

  for (const filePath of sortedTranscriptPaths) {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      if (!line.trim()) continue;
      const recordKey = createHash("sha256").update(line.trim()).digest("base64");
      const firstRecordPath = firstTranscriptPathByRecord.get(recordKey);
      if (firstRecordPath && firstRecordPath !== filePath) {
        duplicateTranscriptRecords++;
        continue;
      }
      if (!firstRecordPath) firstTranscriptPathByRecord.set(recordKey, filePath);
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        addParseWarning(parseWarnings, {
          kind: "malformed-json",
          source: "cursor transcript JSONL",
          firstLine: lineIndex + 1,
          message: "Skipped malformed JSONL line",
          sample: line,
        });
        continue;
      }

      const role = obj.role as "user" | "assistant";
      const contentBlocks = obj.message?.content;
      if (!Array.isArray(contentBlocks)) continue;

      const textParts: string[] = [];
      const userImages: string[] = [];
      const imageFilePaths = new Set<string>();
      let recordTimestamp = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
      for (const block of contentBlocks) {
        if (block.type === "tool_result") {
          const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
          if (toolUseId) {
            toolResults.set(toolUseId, {
              result: extractToolResultText(block),
              timestamp: recordTimestamp,
            });
            if (block.is_error) toolErrors.set(toolUseId, true);
            const images = extractToolResultImages(block);
            if (images.length > 0) toolImages.set(toolUseId, images);
          }
        } else if (block.type === "text" && block.text) {
          if (role === "user" && !recordTimestamp && typeof block.text === "string") {
            recordTimestamp = extractCursorTimestamp(block.text);
          }
          let text = stripUserQueryWrapper(block.text);
          if (role === "user" && deps.isSystemContextText(text)) continue;
          const extracted = extractImageFilePathsFromText(text);
          text = normalizeImagePlaceholderLines(extracted.cleanedText);
          for (const imagePath of extracted.paths) imageFilePaths.add(imagePath);
          if (text) textParts.push(text);
        } else if (block.type === "image") {
          if (block.source?.data) {
            const mediaType = block.source.media_type || "image/png";
            userImages.push(`data:${mediaType};base64,${block.source.data}`);
          }
        }
      }

      for (const imagePath of imageFilePaths) {
        const dataUrl = await readImageFileAsDataUrl(imagePath);
        if (dataUrl) {
          userImages.push(dataUrl);
        } else {
          addParseWarning(parseWarnings, {
            kind: "missing-image",
            source: "cursor transcript image reference",
            firstLine: lineIndex + 1,
            message: "Skipped image reference because the file could not be read",
            sample: imagePath,
          });
        }
      }

      if (role === "user" && textParts.length === 0 && userImages.length === 0) continue;

      if (role === "user") {
        const blocks: ContentBlock[] = [];
        const fullText = textParts.join("\n");
        if (fullText) blocks.push({ type: "text", text: fullText });
        const dedupedImages = [...new Set(userImages)];
        if (dedupedImages.length > 0) {
          blocks.push({ type: "_user_images", images: dedupedImages });
        }
        if (blocks.length > 0) {
          allTurns.push({
            role,
            ...(recordTimestamp ? { timestamp: recordTimestamp } : {}),
            blocks,
          });
        }
        continue;
      }

      const hasInlineToolUse = contentBlocks.some((block) => block?.type === "tool_use");
      const blocks: ContentBlock[] = [];
      for (const block of contentBlocks) {
        if (block.type === "text" && block.text) {
          const cleanedText = sanitizeAssistantTextForReplay(block.text, hasInlineToolUse);
          if (!cleanedText) continue;
          const markerParsed = splitToolMarker(cleanedText);
          if (markerParsed?.markerName) {
            if (markerParsed.textBody) blocks.push({ type: "text", text: markerParsed.textBody });
            blocks.push({
              type: "tool_use",
              id: `cursor-marker-${syntheticToolId++}`,
              name: markerParsed.markerName,
              input: { marker: markerParsed.markerName },
              _isPendingMarker: true,
            });
          } else {
            blocks.push({ type: "text", text: cleanedText });
          }
        } else if (block.type === "thinking" || block.type === "reasoning") {
          const rawThinking =
            typeof block.thinking === "string"
              ? block.thinking
              : typeof block.text === "string"
                ? block.text
                : "";
          const thinking = sanitizeCursorReasoningText(rawThinking);
          if (thinking) blocks.push({ type: "thinking", thinking });
        } else if (block.type === "tool_use") {
          const rawName =
            typeof block.name === "string" && block.name.trim() ? block.name.trim() : "Tool";
          const name = deps.mapCursorToolName(rawName);
          blocks.push({
            type: "tool_use",
            id:
              typeof block.id === "string" && block.id.trim()
                ? block.id
                : `cursor-inline-${syntheticToolId++}`,
            name,
            // Keep the raw name here because Cursor raw tools carry different arg
            // schemas even when they map to the same canonical replay tool.
            input: deps.mapToolArgs(rawName, block.input),
          });
        }
      }

      if (blocks.length > 0) {
        allTurns.push({
          role,
          ...(recordTimestamp ? { timestamp: recordTimestamp } : {}),
          blocks,
        });
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
  attachToolResults(allTurns, toolResults, toolErrors, toolImages, deps);
  attachToolEvents(allTurns, toolEvents, deps);
  const timing = buildCursorTurnTiming(allTurns);

  // Derive slug from session ID
  const slug = sessionId.slice(0, 8);

  // Try to extract a meaningful title from first user prompt
  const firstUser = allTurns.find((t) => t.role === "user");
  const firstBlock = firstUser?.blocks[0];
  const firstText = firstBlock?.type === "text" ? firstBlock.text?.slice(0, 80) : undefined;

  const hasToolData = toolPaths.length > 0;
  const dataSourceNotes: string[] = [];
  if (duplicateTranscriptRecords > 0) {
    dataSourceNotes.push(
      `${duplicateTranscriptRecords} duplicate Cursor transcript records were omitted.`,
    );
  }
  return {
    sessionId,
    slug,
    title: firstText,
    cwd: "",
    turns: allTurns,
    ...(timing.startTime ? { startTime: timing.startTime } : {}),
    ...(timing.endTime ? { endTime: timing.endTime } : {}),
    ...(timing.totalDurationMs !== undefined ? { totalDurationMs: timing.totalDurationMs } : {}),
    ...(timing.turnStats ? { turnStats: timing.turnStats } : {}),
    dataSource: hasToolData ? "jsonl+tools" : "jsonl",
    dataSourceInfo: {
      primary: hasToolData ? "jsonl+tools" : "jsonl",
      sources: [
        "cursor/projects/agent-transcripts/*.jsonl",
        ...(hasToolData ? ["cursor/projects/agent-tools/*.txt"] : []),
      ],
      ...(dataSourceNotes.length > 0 ? { notes: dataSourceNotes } : {}),
    },
    parseWarnings: parseWarnings.length > 0 ? parseWarnings : undefined,
  };
}

/**
 * Cursor stores delegated-agent conversations beside the parent transcript:
 *
 *   agent-transcripts/<session>/<session>.jsonl
 *   agent-transcripts/<session>/subagents/<agent>.jsonl
 *
 * The subagent filename is the only stable agent identifier. Parent `Task` /
 * `Subagent` blocks do not carry that identifier, so correlate the two sources
 * by the delegated prompt, which Cursor repeats inside the subagent's initial
 * user message. We deliberately leave unmatched files unattached rather than
 * guessing by position: parallel agents can finish in a different order.
 */
async function attachCursorSubagents(
  parsed: ProviderParseResult,
  transcriptPaths: string[],
  deps: CursorParserDependencies,
): Promise<void> {
  const agentBlocks: ToolUseBlock[] = [];
  for (const turn of parsed.turns) {
    if (turn.role !== "assistant") continue;
    for (const block of turn.blocks) {
      if (block.type === "tool_use" && block.name === "Agent") {
        agentBlocks.push(block);
      }
    }
  }
  if (agentBlocks.length === 0) return;
  const hasStructuredSubagents = agentBlocks.some((block) => !!block._subAgent);

  // SQLite/global-state parsing can identify a structured child composer even
  // when no transcript file is available. Preserve that metadata in the
  // session summary rather than dropping it with the transcript enrichment.
  if (transcriptPaths.length === 0) {
    if (hasStructuredSubagents) appendCursorSubagentSummaries(parsed, agentBlocks);
    return;
  }

  const subagentPaths = await findCursorSubagentPaths(transcriptPaths);
  if (subagentPaths.length === 0) {
    if (hasStructuredSubagents) appendCursorSubagentSummaries(parsed, agentBlocks);
    return;
  }

  const parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]> = [
    ...(parsed.parseWarnings || []),
  ];
  const subagents: ParsedCursorSubagentTranscript[] = [];
  for (const subagentPath of subagentPaths) {
    const subagent = await parseCursorSubagentTranscript(subagentPath, deps, parseWarnings);
    if (subagent) subagents.push(subagent);
  }

  const availableBlocks = new Set(agentBlocks.map((_, index) => index));
  const candidates: Array<{ subagentIndex: number; blockIndex: number; score: number }> = [];
  for (let subagentIndex = 0; subagentIndex < subagents.length; subagentIndex++) {
    for (const blockIndex of availableBlocks) {
      const score = scorePromptMatch(
        subagents[subagentIndex].sourcePrompt,
        agentBlocks[blockIndex].input?.prompt,
      );
      if (score > 0) candidates.push({ subagentIndex, blockIndex, score });
    }
  }
  candidates.sort(
    (a, b) => b.score - a.score || a.subagentIndex - b.subagentIndex || a.blockIndex - b.blockIndex,
  );

  let attached = 0;
  let attachedToolCalls = 0;
  const usedSubagents = new Set<number>();
  for (const candidate of candidates) {
    if (usedSubagents.has(candidate.subagentIndex)) continue;
    if (!availableBlocks.has(candidate.blockIndex)) continue;
    const subagent = subagents[candidate.subagentIndex];
    const block = agentBlocks[candidate.blockIndex];
    usedSubagents.add(candidate.subagentIndex);
    availableBlocks.delete(candidate.blockIndex);
    block._subAgent = block._subAgent
      ? mergeCursorSubagentTranscript(block._subAgent, subagent)
      : buildCursorSubagent(block, subagent);
    attached++;
    attachedToolCalls += subagent.toolCalls;
  }

  if (parseWarnings.length > 0) parsed.parseWarnings = parseWarnings;
  if (attached === 0 && !hasStructuredSubagents) return;
  appendCursorSubagentSummaries(parsed, agentBlocks);
  if (attached === 0) return;
  parsed.dataSourceInfo = withSupplement(
    parsed.dataSourceInfo || defaultDataSourceInfo(parsed.dataSource),
    `cursor subagent transcripts (${attached}/${subagents.length} linked, ${attachedToolCalls} tool calls)`,
  );
}

function appendCursorSubagentSummaries(
  parsed: ProviderParseResult,
  agentBlocks: ToolUseBlock[],
): void {
  const attachedSummaries = agentBlocks.flatMap((block) => {
    const subagent = block._subAgent;
    if (!subagent) {
      const rawAgentType =
        typeof block.input?.subagent_type === "string" && block.input.subagent_type.trim()
          ? block.input.subagent_type.trim()
          : undefined;
      if (!rawAgentType) return [];
      return [
        {
          agentId: block.id,
          agentType: normalizeSubAgentType(rawAgentType),
          description:
            typeof block.input.description === "string" && block.input.description.trim()
              ? block.input.description.trim()
              : undefined,
          toolCalls: 0,
          model:
            typeof block.input.model === "string" && block.input.model.trim()
              ? block.input.model.trim()
              : undefined,
        },
      ];
    }
    return [
      {
        agentId: subagent.agentId,
        agentType: subagent.agentType,
        description: subagent.description,
        toolCalls: subagent.toolCalls,
        model: subagent.model,
      },
    ];
  });
  const summaries = [...(parsed.subAgentSummary || [])];
  const summarizedIds = new Set(summaries.map((summary) => summary.agentId));
  for (const summary of attachedSummaries) {
    if (summarizedIds.has(summary.agentId)) continue;
    summaries.push(summary);
    summarizedIds.add(summary.agentId);
  }
  parsed.subAgentSummary = summaries;
}

async function findCursorSubagentPaths(transcriptPaths: string[]): Promise<string[]> {
  const paths = new Set<string>();
  for (const transcriptPath of transcriptPaths) {
    const subagentsDir = join(dirname(transcriptPath), "subagents");
    let entries: string[];
    try {
      entries = await readdir(subagentsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      paths.add(join(subagentsDir, entry));
    }
  }
  return sortByMtime([...paths]);
}

async function parseCursorSubagentTranscript(
  filePath: string,
  deps: CursorParserDependencies,
  parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]>,
): Promise<ParsedCursorSubagentTranscript | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    addParseWarning(parseWarnings, {
      kind: "unreadable-source",
      source: "cursor subagent transcript",
      message: "Skipped an unreadable Cursor subagent transcript",
      sample: basename(filePath),
    });
    return null;
  }

  let sourcePrompt = "";
  let toolCalls = 0;
  let thinkingBlocks = 0;
  let textResponses = 0;
  const scenes: Scene[] = [];
  const toolResults = new Map<string, CursorToolResult>();
  const toolErrors = new Set<string>();
  const toolImages = new Map<string, string[]>();
  const pendingTools: PendingCursorSubagentTool[] = [];

  const lines = content.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;

    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      addParseWarning(parseWarnings, {
        kind: "malformed-json",
        source: "cursor subagent transcript JSONL",
        firstLine: lineIndex + 1,
        message: "Skipped malformed subagent JSONL line",
        sample: line,
      });
      continue;
    }

    if (obj.type === "progress") continue;

    const role = obj.role as "user" | "assistant" | undefined;
    const contentBlocks = obj.message?.content;
    if (!Array.isArray(contentBlocks)) continue;

    for (const block of contentBlocks) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      toolResults.set(block.tool_use_id, {
        result: extractToolResultText(block),
        timestamp: typeof obj.timestamp === "string" ? obj.timestamp : undefined,
      });
      if (block.is_error) toolErrors.add(block.tool_use_id);
      const images = extractToolResultImages(block);
      if (images.length > 0) toolImages.set(block.tool_use_id, images);
    }

    if (role === "user" && !sourcePrompt) {
      sourcePrompt = contentBlocks
        .filter(
          (block: any): block is { type: "text"; text: string } =>
            block?.type === "text" && typeof block.text === "string",
        )
        .map((block: { text: string }) => block.text)
        .join("\n")
        .trim();
      continue;
    }
    if (role !== "assistant") continue;

    const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : undefined;
    const hasInlineToolUse = contentBlocks.some((block: any) => block?.type === "tool_use");
    for (const block of contentBlocks) {
      if (block?.type === "text" && typeof block.text === "string") {
        const text = sanitizeAssistantTextForReplay(block.text, hasInlineToolUse);
        if (!text) continue;
        scenes.push({ type: "text-response", content: text, timestamp });
        textResponses++;
        continue;
      }

      if (block?.type === "thinking" || block?.type === "reasoning") {
        const rawThinking =
          typeof block.thinking === "string"
            ? block.thinking
            : typeof block.text === "string"
              ? block.text
              : "";
        const thinking = sanitizeCursorReasoningText(rawThinking);
        if (!thinking) continue;
        scenes.push({ type: "thinking", content: thinking, timestamp });
        thinkingBlocks++;
        continue;
      }

      if (block?.type !== "tool_use") continue;
      const rawName =
        typeof block.name === "string" && block.name.trim() ? block.name.trim() : "Tool";
      const scene: Extract<Scene, { type: "tool-call" }> = {
        type: "tool-call",
        toolName: deps.mapCursorToolName(rawName),
        input: deps.mapToolArgs(rawName, block.input),
        result: "",
        timestamp,
        isError: false,
      };
      scenes.push(scene);
      pendingTools.push({
        scene,
        ...(typeof block.id === "string" && block.id.trim() ? { id: block.id } : {}),
        rawName,
        rawInput: block.input,
        timestamp,
      });
      toolCalls++;
    }
  }

  for (const pending of pendingTools) {
    if (!pending.id) continue;
    const result = toolResults.get(pending.id);
    if (result) {
      pending.scene.result = result.result;
      pending.scene.input = deps.mapToolArgs(pending.rawName, pending.rawInput, result.result);
      const durationMs = durationBetween(pending.timestamp, result.timestamp);
      if (durationMs !== undefined) pending.scene.durationMs = durationMs;
    }
    if (toolErrors.has(pending.id)) pending.scene.isError = true;
    const images = toolImages.get(pending.id);
    if (images?.length) pending.scene.images = images;
  }

  return {
    agentId: basename(filePath, ".jsonl"),
    sourcePrompt,
    toolCalls,
    thinkingBlocks,
    textResponses,
    scenes,
  };
}

function scorePromptMatch(sourcePrompt: unknown, blockPrompt: unknown): number {
  const source = normalizePromptForMatch(sourcePrompt);
  const prompt = normalizePromptForMatch(blockPrompt);
  if (!source || !prompt) return 0;
  if (prompt === source) return 3;
  if (prompt.length >= 8 && source.includes(prompt)) {
    return 2 + prompt.length / Math.max(prompt.length, source.length);
  }
  if (source.length >= 8 && prompt.includes(source)) {
    return 1 + source.length / Math.max(prompt.length, source.length);
  }
  return 0;
}

function normalizePromptForMatch(value: unknown): string {
  if (typeof value !== "string") return "";
  return sanitizeCursorUserText(value).replace(/\s+/g, " ").trim();
}

function buildCursorSubagent(
  block: ToolUseBlock,
  transcript: ParsedCursorSubagentTranscript,
): SubAgent {
  const input = block.input || {};
  const rawAgentType =
    typeof input.subagent_type === "string" && input.subagent_type.trim()
      ? input.subagent_type.trim()
      : "unknown";
  return {
    agentId: transcript.agentId,
    agentType: normalizeSubAgentType(rawAgentType),
    ...(typeof input.description === "string" && input.description.trim()
      ? { description: input.description.trim() }
      : {}),
    prompt: typeof input.prompt === "string" ? input.prompt : transcript.sourcePrompt,
    ...(typeof input.model === "string" && input.model.trim() ? { model: input.model.trim() } : {}),
    toolCalls: transcript.toolCalls,
    thinkingBlocks: transcript.thinkingBlocks,
    textResponses: transcript.textResponses,
    scenes: transcript.scenes,
  };
}

function mergeCursorSubagentTranscript(
  structured: SubAgent,
  transcript: ParsedCursorSubagentTranscript,
): SubAgent {
  return {
    ...structured,
    toolCalls: transcript.toolCalls,
    thinkingBlocks: transcript.thinkingBlocks,
    textResponses: transcript.textResponses,
    scenes: transcript.scenes,
  };
}

function stripUserQueryWrapper(text: string): string {
  return sanitizeCursorUserText(text);
}

function sanitizeAssistantTextForReplay(text: string, hasInlineToolUse: boolean): string {
  return sanitizeCursorAssistantText(stripUserQueryWrapper(text), hasInlineToolUse);
}

function normalizeImagePlaceholderLines(text: string): string {
  const lines = text.split("\n");
  const filtered = lines.filter((line) => !/^\s*\[Image\]\s*$/i.test(line.trim()));
  return filtered.join("\n").trim();
}

function resolveImagePath(pathValue: string): string {
  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    return join(homedir(), pathValue.slice(2));
  }
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
    // Match POSIX (`~/`, `/`) and Windows (`~\`, `\`, `C:\`) absolute image paths.
    const pathRegex =
      /(?:^|\n)\s*(?:\d+\.\s*)?((?:~[\\/]|[\\/]|[A-Za-z]:[\\/])[^\n]+\.(?:png|jpe?g|gif|webp))/gi;
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
  for (const block of turn.blocks) {
    if (block.type !== "thinking") continue;
    const text = block.thinking.trim();
    if (text) texts.push(text);
  }
  return texts;
}

function buildThinkingBlocks(texts: string[]): ContentBlock[] {
  return texts.map((thinking) => ({ type: "thinking" as const, thinking }));
}

function countThinkingBlocks(turns: ParsedTurn[]): number {
  let count = 0;
  for (const turn of turns) {
    for (const block of turn.blocks) {
      if (block.type === "thinking") count++;
    }
  }
  return count;
}

function collectUserImages(turn: ParsedTurn): string[] {
  const images: string[] = [];
  for (const block of turn.blocks) {
    if (block.type !== "_user_images") continue;
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

function countTurnTimestamps(turns: ParsedTurn[]): number {
  return turns.filter((turn) => typeof turn.timestamp === "string" && turn.timestamp.length > 0)
    .length;
}

function mergeJsonlTimingIntoCursorResult(
  primary: ProviderParseResult,
  enrichment: ProviderParseResult,
): void {
  const enrichmentStartMs = timestampMs(enrichment.startTime);
  const primaryStartMs = timestampMs(primary.startTime);
  if (
    enrichment.startTime &&
    enrichmentStartMs !== undefined &&
    (primaryStartMs === undefined || enrichmentStartMs < primaryStartMs)
  ) {
    primary.startTime = enrichment.startTime;
  }
  const enrichmentEndMs = timestampMs(enrichment.endTime);
  const primaryEndMs = timestampMs(primary.endTime);
  if (
    enrichment.endTime &&
    enrichmentEndMs !== undefined &&
    (primaryEndMs === undefined || enrichmentEndMs > primaryEndMs)
  ) {
    primary.endTime = enrichment.endTime;
  }
  if (enrichment.totalDurationMs === undefined) return;

  const enrichmentDurations = new Map(
    (enrichment.turnStats || [])
      .filter((stat): stat is typeof stat & { durationMs: number } => stat.durationMs !== undefined)
      .map((stat) => [stat.turnIndex, stat.durationMs]),
  );
  const primaryStats = primary.turnStats || [];
  const mergedStats = [...primaryStats];
  for (const stat of enrichment.turnStats || []) {
    const current = mergedStats.find((candidate) => candidate.turnIndex === stat.turnIndex);
    if (!current) {
      mergedStats.push(stat);
      continue;
    }
    const durationMs = enrichmentDurations.get(stat.turnIndex);
    if (durationMs !== undefined) current.durationMs = durationMs;
  }
  mergedStats.sort((a, b) => a.turnIndex - b.turnIndex);
  if (mergedStats.length > 0) primary.turnStats = mergedStats;

  const fallbackDurationMs =
    primaryStats.length > 0
      ? primaryStats.reduce(
          (sum, stat) =>
            sum + (enrichmentDurations.has(stat.turnIndex) ? 0 : (stat.durationMs ?? 0)),
          0,
        )
      : (primary.totalDurationMs ?? 0);
  const mergedDurationMs = enrichment.totalDurationMs + fallbackDurationMs;
  primary.totalDurationMs = mergedDurationMs > 0 ? mergedDurationMs : undefined;
  primary.dataSourceInfo = replaceDurationNote(
    primary.dataSourceInfo,
    "Per-turn duration is inferred from Cursor transcript timestamps (user prompt to final assistant or tool result).",
  );
}

function mergeSdkTurnStats(
  primary: TurnStat[] | undefined,
  sdk: TurnStat[] | undefined,
): TurnStat[] | undefined {
  if (!primary?.length) return sdk;
  if (!sdk?.length) return primary;

  const byIndex = new Map(primary.map((stat) => [stat.turnIndex, { ...stat }]));
  for (const stat of sdk) {
    const current = byIndex.get(stat.turnIndex);
    byIndex.set(stat.turnIndex, {
      ...current,
      ...stat,
      ...(current?.model && !stat.model ? { model: current.model } : {}),
      ...(current?.tokenUsage && !stat.tokenUsage ? { tokenUsage: current.tokenUsage } : {}),
      ...(current?.contextTokens !== undefined && stat.contextTokens === undefined
        ? { contextTokens: current.contextTokens }
        : {}),
    });
  }
  return [...byIndex.values()].sort((a, b) => a.turnIndex - b.turnIndex);
}

function replaceDurationNote(
  info: DataSourceInfo | undefined,
  note: string,
): DataSourceInfo | undefined {
  if (!info) return undefined;
  const notes = (info.notes || []).filter(
    (existing) => !/duration/i.test(existing) || existing === note,
  );
  if (!notes.includes(note)) notes.push(note);
  return { ...info, notes };
}

function extractToolResultText(block: Extract<ContentBlock, { type: "tool_result" }>): string {
  if (typeof block.content === "string") return block.content;
  if (!Array.isArray(block.content)) return "";
  return block.content
    .map((item) => {
      if (item.type === "text") return item.text;
      if (item.type === "tool_result") return item.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function extractToolResultImages(block: Extract<ContentBlock, { type: "tool_result" }>): string[] {
  if (!Array.isArray(block.content)) return [];
  return block.content
    .map((item) => {
      if (item?.type !== "image" || !item.source?.data) return null;
      const source = item.source;
      const mediaType = source.media_type || "image/png";
      return `data:${mediaType};base64,${source.data}`;
    })
    .filter((value): value is string => typeof value === "string");
}

function attachToolResults(
  turns: ParsedTurn[],
  toolResults: Map<string, CursorToolResult>,
  toolErrors: Map<string, boolean>,
  toolImages: Map<string, string[]>,
  deps: CursorParserDependencies,
): void {
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const block of turn.blocks) {
      if (block.type !== "tool_use" || typeof block.id !== "string") continue;
      const result = toolResults.get(block.id);
      if (result !== undefined) {
        block._result = result.result;
        block.input = deps.mapToolArgs(block.name, block.input, result.result);
        const durationMs = durationBetween(turn.timestamp, result.timestamp);
        if (durationMs !== undefined) block._durationMs = durationMs;
        if (result.timestamp) block._resultTimestamp = result.timestamp;
      }
      const images = toolImages.get(block.id);
      if (images?.length) block._images = images;
      if (toolErrors.get(block.id)) block._isError = true;
    }
  }
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

    targetTurn.blocks = [...buildThinkingBlocks(missingThinking), ...targetTurn.blocks];
  }

  // If JSONL has extra assistant thinking turns (common with marker-only lines),
  // preserve them as standalone assistant thinking turns.
  for (let i = paired; i < jsonlAssistantTurns.length; i++) {
    const extraThinking = collectThinkingTexts(jsonlAssistantTurns[i]);
    if (extraThinking.length === 0) continue;
    merged.push({
      role: "assistant",
      timestamp: jsonlAssistantTurns[i].timestamp,
      blocks: buildThinkingBlocks(extraThinking),
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

    const nonImageBlocks = targetTurn.blocks.filter((block) => block?.type !== "_user_images");
    targetTurn.blocks = [...nonImageBlocks, { type: "_user_images", images: mergedImages }];
  }

  return merged;
}

function mergeJsonlTimestampsIntoCursorTurns(
  primaryTurns: ParsedTurn[],
  jsonlTurns: ParsedTurn[],
): ParsedTurn[] {
  if (primaryTurns.length === 0 || jsonlTurns.length === 0) return primaryTurns;

  const merged = primaryTurns.map((turn) => ({
    ...turn,
    blocks: [...turn.blocks],
  }));

  for (const role of ["user", "assistant"] as const) {
    const primaryIndices = merged
      .map((turn, index) => ({ turn, index }))
      .filter(({ turn }) => turn.role === role)
      .map(({ index }) => index);
    const jsonlTurnsForRole = jsonlTurns.filter((turn) => turn.role === role);
    const paired = Math.min(primaryIndices.length, jsonlTurnsForRole.length);

    for (let i = 0; i < paired; i++) {
      const target = merged[primaryIndices[i]];
      const candidate = jsonlTurnsForRole[i];
      if (!target.timestamp && candidate.timestamp) target.timestamp = candidate.timestamp;
    }
  }

  return merged;
}

export function mergeJsonlSupplementsIntoCursorTurns(
  primaryTurns: ParsedTurn[],
  jsonlTurns: ParsedTurn[],
): ParsedTurn[] {
  const withTimestamps = mergeJsonlTimestampsIntoCursorTurns(primaryTurns, jsonlTurns);
  const withThinking = mergeJsonlThinkingIntoCursorTurns(withTimestamps, jsonlTurns);
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

function attachToolEvents(
  turns: ParsedTurn[],
  tools: ToolEvent[],
  deps: CursorParserDependencies,
): void {
  const markerBlocks: Array<{ block: ToolUseBlock; turn: ParsedTurn; blockIndex: number }> = [];
  const inlineBlocks: ToolUseBlock[] = [];
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (let bi = 0; bi < turn.blocks.length; bi++) {
      const block = turn.blocks[bi];
      if (block.type === "tool_use" && block._isPendingMarker) {
        markerBlocks.push({ block, turn, blockIndex: bi });
      } else if (block.type === "tool_use") {
        inlineBlocks.push(block);
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
      ...marker.block.input,
      ...tool.input,
    };
    marker.block._result = tool.result;
    if (tool.timestamp) marker.block._resultTimestamp = tool.timestamp;
    const durationMs = durationBetween(marker.turn.timestamp, tool.timestamp);
    if (durationMs !== undefined) marker.block._durationMs = durationMs;
    marker.block._isPendingMarker = undefined;
    if (!marker.turn.timestamp && tool.timestamp) {
      marker.turn.timestamp = tool.timestamp;
    }
  }

  // Unpaired markers → convert to thinking (they're just status text, not tool calls)
  for (let i = paired; i < markerBlocks.length; i++) {
    const { turn, blockIndex, block } = markerBlocks[i];
    const markerText = typeof block.input?.marker === "string" ? block.input.marker : "";
    const thinkingBlock: ContentBlock = {
      type: "thinking",
      thinking: block.name || markerText,
    };
    turn.blocks[blockIndex] = thinkingBlock;
  }

  let nextToolIndex = paired;
  // Current transcripts already contain structured tool_use blocks. A sidecar
  // may fill a missing result only when its inferred tool name agrees; it must
  // never become an additional synthetic call beside an inline call.
  for (const block of inlineBlocks) {
    const matchIndex = findCompatibleSidecarTool(tools, nextToolIndex, block.name);
    if (matchIndex === -1) continue;
    const tool = tools[matchIndex];
    nextToolIndex = matchIndex + 1;
    // Consume the sidecar belonging to an inline-resolved call as well. Without
    // advancing here, consecutive same-name calls can reuse the first call's
    // sidecar result when the later call is still unresolved.
    if (typeof block._result === "string") continue;
    block._result = tool.result;
    if (tool.timestamp) block._resultTimestamp = tool.timestamp;
    block.input = { ...block.input, ...tool.input };
    try {
      block.input = deps.mapToolArgs(block.name, block.input, tool.result);
    } catch {
      // Keep the merged input when a provider-specific mapper cannot enrich it.
    }
  }

  // Legacy transcripts with no inline tools depended on unmarked sidecars.
  // Preserve that fallback, but suppress extras when structured calls exist.
  if (inlineBlocks.length > 0) return;
  for (let i = nextToolIndex; i < tools.length; i++) {
    const tool = tools[i];
    turns.push({
      role: "assistant",
      timestamp: tool.timestamp,
      blocks: [toToolUseBlock(tool)],
    });
  }
}

function findCompatibleSidecarTool(
  tools: ToolEvent[],
  startIndex: number,
  blockName: string,
): number {
  const editFamily = new Set(["Edit", "MultiEdit", "Write"]);
  for (let i = startIndex; i < tools.length; i++) {
    if (tools[i].name === blockName) return i;
    if (editFamily.has(tools[i].name) && editFamily.has(blockName)) return i;
  }
  return -1;
}

function toToolUseBlock(tool: ToolEvent): ContentBlock {
  return {
    type: "tool_use",
    id: tool.id,
    name: tool.name,
    input: tool.input,
    _result: tool.result,
    ...(tool.timestamp ? { _resultTimestamp: tool.timestamp } : {}),
  };
}

function durationBetween(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return undefined;
  return Math.round(endMs - startMs);
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
