/**
 * Session Scanner — lightweight metadata extraction from JSONL sessions.
 *
 * Unlike the full parser (which builds scenes/turns for replay), the scanner
 * extracts only aggregate metadata for project/user-level insights. It reads
 * each JSONL line once and collects counts, timestamps, branches, PRs, etc.
 *
 * Results are cached per-session keyed by input metadata + scannerVersion.
 * Cursor SQLite/global-state scans use discovery fingerprints so dashboard
 * cache checks do not repeatedly query large Cursor databases.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileCache, writeFileCache } from "./cache.js";
import { estimateActiveDuration } from "./duration.js";
import { estimateCost, estimateCostSimple } from "./pricing.js";
import { parseCodexSession } from "./providers/codex/parser.js";
import { parseCursorSession } from "./providers/cursor/parser.js";
import type { ProviderParseResult } from "./providers/types.js";
import type { DataSource, PrLink, SessionInfo, TokenUsage } from "./types.js";
import {
  FILE_EDIT_TOOLS,
  extractToolFilePath,
  extractToolFilePaths,
  localDayKey,
  shortenPath,
} from "./utils.js";

// Bump this when we extract new fields — forces re-scan of all sessions.
const SCANNER_VERSION = 8;

// ─── Types ──────────────────────────────────────────────────────────

export interface SessionScanResult {
  sessionId: string;
  provider: string;
  project: string;
  slug: string;
  title?: string;
  firstPrompt?: string;

  // Time
  startTime?: string;
  endTime?: string;
  durationMs?: number;

  // Git
  gitBranch?: string;
  gitBranches?: string[];

  // PRs
  prLinks?: PrLink[];

  // Model
  model?: string;

  // Stats
  promptCount: number;
  toolCallCount: number;
  editCount: number;
  filesModified: Array<{ file: string; count: number }>;

  // Token usage
  tokenUsage?: TokenUsage;
  costEstimate?: number;

  // Subagents
  subAgentCount: number;

  // Errors
  apiErrorCount: number;

  // Meta
  entrypoint?: string;
  permissionMode?: string;
  skillsUsed?: string[];
  mcpServersUsed?: string[];
  compactionCount: number;
  dataSource?: DataSource;
  dataQualityNotes?: string[];
  turnStatCount?: number;
  /** Per-turn durations in ms — used for median time-to-intervention */
  turnDurations?: number[];
}

interface ScanCacheEntry {
  mtimeMs: number;
  fileSize: number;
  scannedAt: string;
  result: SessionScanResult;
}

export interface ScanCacheData {
  scannerVersion: number;
  entries: Record<string, ScanCacheEntry>; // keyed by sessionId
}

export interface ProjectInsights {
  project: string;
  sessionCount: number;
  totalDurationMs: number;
  totalCost: number;
  totalPrompts: number;
  totalToolCalls: number;
  totalEdits: number;
  models: Record<string, number>; // model → session count
  branches: BranchInfo[];
  hotFiles: Array<{ file: string; editCount: number; sessionCount: number }>;
  subAgentTotal: number;
  apiErrorTotal: number;
  timeRange: { first: string; last: string };
  sessionsPerDay: Record<string, number>; // YYYY-MM-DD → count
  avgSessionDurationMs: number;
  medianTurnDurationMs?: number;
  tokenBreakdown?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  turnDurationHistogram?: TurnDurationHistogram;
  memory?: ProjectMemory;
  dataQuality?: {
    notes: string[];
  };
}

interface BranchInfo {
  branch: string;
  sessionIds: string[];
  prLinks?: PrLink[];
}

interface ProjectMemory {
  memoryFiles: Array<{
    name: string;
    description?: string;
    type?: string;
    content: string;
  }>;
  claudeMd?: string; // project-level CLAUDE.md content
}

export interface UserInsights {
  totalSessions: number;
  totalProjects: number;
  totalDurationMs: number;
  totalCost: number;
  totalPrompts: number;
  totalToolCalls: number;
  totalEdits: number;
  providers: Record<string, number>; // provider → session count
  topProjects: Array<{
    project: string;
    sessions: number;
    cost: number;
    prompts: number;
    durationMs: number;
    toolCalls: number;
    edits: number;
    branchCount: number;
    prCount: number;
    memoryFileCount: number;
    lastActivity: string;
    sessionsPerDay: Record<string, number>;
  }>;
  models: Record<string, number>;
  timeRange: { first: string; last: string };
  sessionsPerDay: Record<string, number>;
  subAgentTotal: number;
  apiErrorTotal: number;
  avgSessionDurationMs: number;
  medianTurnDurationMs?: number;
  tokenBreakdown?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
  turnDurationHistogram?: TurnDurationHistogram;
  dataQuality?: {
    notes: string[];
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

interface TurnDurationBucket {
  label: string;
  minMs: number;
  maxMs: number; // Infinity for last bucket (serialized as -1)
  count: number;
  pct: number; // 0-100
}

interface TurnDurationHistogram {
  buckets: TurnDurationBucket[];
  percentiles: { p50Ms: number; p75Ms: number; p90Ms: number };
  totalTurns: number;
}

const DURATION_BUCKETS: Array<{ label: string; minMs: number; maxMs: number }> = [
  { label: "<30s", minMs: 0, maxMs: 30_000 },
  { label: "30s-1m", minMs: 30_000, maxMs: 60_000 },
  { label: "1-2m", minMs: 60_000, maxMs: 120_000 },
  { label: "2-5m", minMs: 120_000, maxMs: 300_000 },
  { label: "5-10m", minMs: 300_000, maxMs: 600_000 },
  { label: "10m+", minMs: 600_000, maxMs: Number.POSITIVE_INFINITY },
];

function buildTurnDurationHistogram(durations: number[]): TurnDurationHistogram | undefined {
  if (durations.length === 0) return undefined;
  const sorted = [...durations].sort((a, b) => a - b);
  const total = sorted.length;

  // Single O(n) pass to count buckets
  const counts: number[] = Array.from({ length: DURATION_BUCKETS.length }, () => 0);
  for (const d of sorted) {
    const i = DURATION_BUCKETS.findIndex((b) => d < b.maxMs);
    if (i >= 0) counts[i]++;
  }
  const buckets: TurnDurationBucket[] = DURATION_BUCKETS.map((b, i) => ({
    label: b.label,
    minMs: b.minMs,
    maxMs: b.maxMs === Number.POSITIVE_INFINITY ? -1 : b.maxMs,
    count: counts[i],
    pct: Math.round((counts[i] / total) * 1000) / 10,
  }));

  return {
    buckets,
    percentiles: {
      p50Ms: Math.round(percentile(sorted, 50)),
      p75Ms: Math.round(percentile(sorted, 75)),
      p90Ms: Math.round(percentile(sorted, 90)),
    },
    totalTurns: total,
  };
}

// ─── Scanner ────────────────────────────────────────────────────────

export interface ScanInput {
  sessionId: string;
  provider: string;
  project: string;
  slug: string;
  filePaths: string[];
  toolPaths?: string[];
  sourceFilePath?: string;
  sourceFileSize?: number;
  sourceLineCount?: number;
  workspacePath?: string;
  hasSqlite?: boolean;
  deferRichCursorParse?: boolean;
  timestamp?: string;
  title?: string;
  firstPrompt?: string;
}

interface ScanProgress {
  scanned: number;
  total: number;
  currentSession?: string;
  done: boolean;
}

/**
 * Scan a single session's JSONL files and extract aggregate metadata.
 * This is much lighter than the full parser — no scene building, no
 * subagent JSONL reading, no transform step.
 */
export async function scanSession(input: ScanInput): Promise<SessionScanResult> {
  if (input.provider === "cursor") {
    try {
      return await scanCursorSession(input);
    } catch {
      // Fall back to the legacy lightweight scanner below so Cursor sessions
      // still show up even if richer parsing fails for one host/schema.
    }
  }
  if (input.provider === "codex") {
    try {
      return await scanCodexSession(input);
    } catch {
      // Fall through to the lightweight scanner so a partial Codex rollout
      // still appears in insights if the richer parser hits an unknown event.
    }
  }

  let startTime: string | undefined;
  let endTime: string | undefined;
  let model: string | undefined;
  let title = input.title;
  let firstPrompt = input.firstPrompt;
  const gitBranches: string[] = [];
  let entrypoint: string | undefined;
  let permissionMode: string | undefined;
  const skillsUsed = new Set<string>();
  // MCP tracking for the raw-JSONL scan path only; parse-based path uses parsed.mcpServersUsed
  const mcpServersUsed = new Set<string>();

  let promptCount = 0;
  let toolCallCount = 0;
  let editCount = 0;
  const fileEditCounts = new Map<string, number>();
  let compactionCount = 0;
  let apiErrorCount = 0;
  let totalDurationMs = 0;
  const turnDurations: number[] = [];
  const allTimestamps: string[] = [];

  // Token usage tracking (deduplicate by message ID)
  const usageByMsgId = new Map<
    string,
    {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      model?: string;
    }
  >();

  const prLinks: PrLink[] = [];
  const prUrls = new Set<string>();

  for (const filePath of input.filePaths) {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;

      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      // Extract metadata from top-level fields
      if (obj.gitBranch) {
        const b = obj.gitBranch as string;
        if (gitBranches.length === 0 || gitBranches[gitBranches.length - 1] !== b) {
          gitBranches.push(b);
        }
      }
      if (!entrypoint && obj.entrypoint) entrypoint = obj.entrypoint;
      if (!permissionMode && obj.permissionMode) permissionMode = obj.permissionMode;

      // Timestamps
      if (obj.timestamp) {
        allTimestamps.push(obj.timestamp);
        if (!startTime || obj.timestamp < startTime) startTime = obj.timestamp;
        if (!endTime || obj.timestamp > endTime) endTime = obj.timestamp;
      }

      // Skip non-message types but extract their data first
      if (obj.type === "file-history-snapshot") {
        if (!startTime && obj.snapshot?.timestamp) startTime = obj.snapshot.timestamp;
        continue;
      }

      if (obj.type === "progress") continue;

      if (obj.type === "custom-title") {
        title = obj.customTitle || obj.title || title;
        continue;
      }

      if (obj.type === "pr-link") {
        const d = obj.data || obj;
        if (d.prNumber && d.prUrl && !prUrls.has(d.prUrl)) {
          prUrls.add(d.prUrl);
          prLinks.push({
            prNumber: d.prNumber,
            prUrl: d.prUrl,
            prRepository: d.prRepository || "",
          });
        }
        continue;
      }

      if (obj.type === "system") {
        if (obj.subtype === "turn_duration" && typeof obj.durationMs === "number") {
          totalDurationMs += obj.durationMs;
          turnDurations.push(obj.durationMs);
        }
        if (obj.subtype === "compact_boundary") compactionCount++;
        if (obj.subtype === "api_error") apiErrorCount++;
        continue;
      }

      if (obj.type === "assistant" && obj.isApiErrorMessage) {
        apiErrorCount++;
      }

      // Extract skill/command names from isMeta messages
      if (obj.isMeta) {
        const text = extractMetaText(obj.message?.content);
        if (text.startsWith("Base directory for this skill:")) {
          const name = text.split("\n")[0].split("/").pop()?.trim();
          if (name) skillsUsed.add(name);
        } else if (text.startsWith("The user just ran /")) {
          const cmd = text.split("/")[1]?.split(/[\s\n]/)[0];
          if (cmd) skillsUsed.add(`/${cmd}`);
        }
        continue;
      }

      if (!obj.message) continue;

      const { role, content: msgContent, id: msgId } = obj.message;

      // Token usage (keep last per message ID)
      if (obj.message.usage && msgId) {
        usageByMsgId.set(msgId, {
          input_tokens: obj.message.usage.input_tokens || 0,
          output_tokens: obj.message.usage.output_tokens || 0,
          cache_creation_input_tokens: obj.message.usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: obj.message.usage.cache_read_input_tokens || 0,
          model: obj.message.model,
        });
      }

      // Model
      if (!model && obj.message.model && obj.message.model !== "<synthetic>") {
        model = obj.message.model;
      }

      // User prompts
      if (role === "user") {
        if (typeof msgContent === "string") {
          promptCount++;
          if (!firstPrompt && msgContent.length >= 10) {
            firstPrompt = msgContent.slice(0, 200);
          }
        } else if (Array.isArray(msgContent)) {
          // Check if it has text (not just tool_result)
          const hasText = msgContent.some(
            (b: any) => (b.type === "text" && b.text?.trim()) || b.type === "_user_images",
          );
          const isOnlyToolResult = msgContent.every((b: any) => b.type === "tool_result");
          if (hasText && !isOnlyToolResult) promptCount++;
        }
      }

      // Assistant messages: count tool uses and extract file modifications
      if (role === "assistant" && Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block.type === "tool_use") {
            toolCallCount++;
            // Track MCP server usage
            if (typeof block.name === "string" && block.name.startsWith("mcp__")) {
              const server = block.name.split("__")[1];
              if (server) mcpServersUsed.add(server);
            }
            // Track file modifications
            if (FILE_EDIT_TOOLS.has(block.name)) {
              const fp = extractToolFilePath(block.input);
              if (fp) {
                editCount++;
                const short = shortenPath(fp);
                fileEditCounts.set(short, (fileEditCounts.get(short) || 0) + 1);
              }
            }
          }
        }
      }
    }
  }

  // Count subagent files and extract their file modifications
  let subAgentCount = 0;
  if (input.filePaths.length > 0) {
    const mainFile = input.filePaths[0];
    const sessionDir = mainFile.replace(/\.jsonl$/, "");
    const subagentsDir = join(sessionDir, "subagents");
    try {
      const files = await readdir(subagentsDir);
      const jsonlFiles = files.filter((f) => f.endsWith(".jsonl"));
      subAgentCount = jsonlFiles.length;

      // Scan sub-agent JSONL files for file modifications
      for (const saFile of jsonlFiles) {
        let saContent: string;
        try {
          saContent = await readFile(join(subagentsDir, saFile), "utf-8");
        } catch {
          continue;
        }
        for (const saLine of saContent.split("\n")) {
          if (!saLine.trim()) continue;
          let saObj: any;
          try {
            saObj = JSON.parse(saLine);
          } catch {
            continue;
          }
          const saMsg = saObj?.message;
          if (saMsg?.role !== "assistant" || !Array.isArray(saMsg.content)) continue;
          for (const block of saMsg.content) {
            if (block.type !== "tool_use") continue;
            if (FILE_EDIT_TOOLS.has(block.name)) {
              const fp = extractToolFilePath(block.input);
              if (fp) {
                editCount++;
                const short = shortenPath(fp);
                fileEditCounts.set(short, (fileEditCounts.get(short) || 0) + 1);
              }
            }
          }
        }
      }
    } catch {
      // No subagents directory
    }
  }

  // Aggregate token usage
  let tokenUsage: TokenUsage | undefined;
  const usageByModel: Record<string, TokenUsage> = {};
  if (usageByMsgId.size > 0) {
    const totals: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    for (const u of usageByMsgId.values()) {
      totals.inputTokens += u.input_tokens;
      totals.outputTokens += u.output_tokens;
      totals.cacheCreationTokens += u.cache_creation_input_tokens;
      totals.cacheReadTokens += u.cache_read_input_tokens;

      if (u.model && u.model !== "<synthetic>") {
        if (!usageByModel[u.model]) {
          usageByModel[u.model] = {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          };
        }
        usageByModel[u.model].inputTokens += u.input_tokens;
        usageByModel[u.model].outputTokens += u.output_tokens;
        usageByModel[u.model].cacheCreationTokens += u.cache_creation_input_tokens;
        usageByModel[u.model].cacheReadTokens += u.cache_read_input_tokens;
      }
    }
    tokenUsage = totals;
  }

  // Estimate cost
  let costEstimate: number | undefined;
  if (Object.keys(usageByModel).length > 0) {
    costEstimate = estimateCost(usageByModel);
  } else if (tokenUsage && model) {
    costEstimate = estimateCostSimple(tokenUsage, model);
  }

  // Derive duration: prefer turn_duration sum (CLI), fall back to active-duration estimate (VS Code)
  let durationMs = totalDurationMs || undefined;
  if (!durationMs) {
    durationMs = estimateActiveDuration(allTimestamps);
  }

  const gitBranch = gitBranches.length > 0 ? gitBranches[gitBranches.length - 1] : undefined;

  return {
    sessionId: input.sessionId,
    provider: input.provider,
    project: input.project,
    slug: input.slug,
    title,
    firstPrompt,
    startTime,
    endTime,
    durationMs,
    gitBranch,
    gitBranches: gitBranches.length > 1 ? gitBranches : undefined,
    prLinks: prLinks.length > 0 ? prLinks : undefined,
    model,
    promptCount,
    toolCallCount,
    editCount,
    filesModified: [...fileEditCounts.entries()]
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 100),
    tokenUsage,
    costEstimate,
    subAgentCount,
    apiErrorCount,
    compactionCount,
    entrypoint,
    permissionMode,
    skillsUsed: skillsUsed.size > 0 ? [...skillsUsed].sort() : undefined,
    mcpServersUsed: mcpServersUsed.size > 0 ? [...mcpServersUsed].sort() : undefined,
    turnDurations: turnDurations.length > 0 ? turnDurations : undefined,
  };
}

async function scanCodexSession(input: ScanInput): Promise<SessionScanResult> {
  const sessionInfo: SessionInfo = {
    provider: "codex",
    sessionId: input.sessionId,
    slug: input.slug,
    title: input.title,
    project: input.project,
    cwd: input.workspacePath || input.project,
    version: "",
    timestamp: input.timestamp || new Date().toISOString(),
    lineCount: 0,
    fileSize: 0,
    filePath: input.filePaths[0] || "",
    filePaths: input.filePaths,
    firstPrompt: input.firstPrompt || input.title || "",
  };

  const parsed = await parseCodexSession(input.filePaths, sessionInfo);
  return buildScanResultFromParsed(input, parsed);
}

async function scanCursorSession(input: ScanInput): Promise<SessionScanResult> {
  if (input.deferRichCursorParse && input.hasSqlite) {
    return buildLightweightCursorScanResult(input);
  }

  const sessionInfo: SessionInfo = {
    provider: "cursor",
    sessionId: input.sessionId,
    slug: input.slug,
    title: input.title,
    project: input.project,
    cwd: input.workspacePath || input.project,
    version: "",
    timestamp: input.timestamp || new Date().toISOString(),
    lineCount: 0,
    fileSize: 0,
    filePath: input.filePaths[0] || "",
    filePaths: input.filePaths,
    ...(input.toolPaths?.length ? { toolPaths: input.toolPaths } : {}),
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    ...(input.hasSqlite !== undefined ? { hasSqlite: input.hasSqlite } : {}),
    firstPrompt: input.firstPrompt || input.title || "(cursor session)",
  };

  const parsed = await parseCursorSession(
    [...input.filePaths, ...(input.toolPaths || [])],
    sessionInfo,
  );
  return buildScanResultFromParsed(input, parsed);
}

function buildLightweightCursorScanResult(input: ScanInput): SessionScanResult {
  const firstPrompt = input.firstPrompt || input.title;
  const hasPrompt = typeof firstPrompt === "string" && firstPrompt.trim().length > 0;
  const estimatedPromptCount = Math.max(
    hasPrompt ? 1 : 0,
    input.sourceLineCount ? Math.ceil(input.sourceLineCount / 2) : 0,
  );
  const sourceFilePath = input.sourceFilePath || "";
  const dataSource: DataSource = sourceFilePath.includes("#composerData:")
    ? "global-state"
    : "sqlite";
  return {
    sessionId: input.sessionId,
    provider: input.provider,
    project: input.project,
    slug: input.slug,
    title: input.title,
    firstPrompt,
    startTime: input.timestamp,
    promptCount: estimatedPromptCount,
    toolCallCount: 0,
    editCount: 0,
    filesModified: [],
    subAgentCount: 0,
    apiErrorCount: 0,
    compactionCount: 0,
    dataSource,
    dataQualityNotes: [
      "Cursor SQLite/global-state details are deferred during background insights scans to avoid high dashboard CPU.",
    ],
  };
}

function buildScanResultFromParsed(
  input: ScanInput,
  parsed: ProviderParseResult,
): SessionScanResult {
  let promptCount = 0;
  let toolCallCount = 0;
  let editCount = 0;
  const parsedSubAgentCount = parsed.subAgentSummary?.length || 0;
  let derivedSubAgentCount = 0;
  const fileEditCounts = new Map<string, number>();

  for (const turn of parsed.turns) {
    if (turn.role === "user" && !turn.subtype) {
      const hasText = turn.blocks.some(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
      );
      const hasImages = turn.blocks.some(
        (block) => block.type === "_user_images" && block.images.length > 0,
      );
      if (hasText || hasImages) promptCount++;
    }

    for (const block of turn.blocks) {
      if (block.type !== "tool_use") continue;
      toolCallCount++;

      if (
        parsedSubAgentCount === 0 &&
        block.name === "Agent" &&
        block.input &&
        typeof block.input.subagent_type === "string"
      ) {
        derivedSubAgentCount++;
      }

      // Count file modifications from sub-agent scenes
      if (block.name === "Agent" && block._subAgent?.scenes) {
        for (const saScene of block._subAgent.scenes) {
          if (saScene.type !== "tool-call") continue;
          const saTool = saScene.toolName;
          if (!FILE_EDIT_TOOLS.has(saTool)) continue;
          const saPath = extractToolFilePath(saScene.input);
          if (!saPath) continue;
          editCount++;
          const short = shortenPath(saPath);
          fileEditCounts.set(short, (fileEditCounts.get(short) || 0) + 1);
        }
      }

      if (!FILE_EDIT_TOOLS.has(block.name)) continue;

      const rawPaths = extractToolFilePaths(block.input);
      if (rawPaths.length === 0) continue;
      editCount++;
      for (const rawPath of rawPaths) {
        const short = shortenPath(rawPath);
        fileEditCounts.set(short, (fileEditCounts.get(short) || 0) + 1);
      }
    }
  }

  const costEstimate = estimateParsedCost(parsed);
  const fallbackStart = parsed.startTime || input.timestamp;
  const durationMs = parsed.totalDurationMs;
  const firstPrompt = firstUserPrompt(parsed.turns) || input.firstPrompt || parsed.title;

  return {
    sessionId: input.sessionId,
    provider: input.provider,
    project: input.project,
    slug: input.slug,
    title: parsed.title || input.title,
    firstPrompt,
    startTime: fallbackStart,
    endTime: parsed.endTime,
    durationMs,
    gitBranch: parsed.gitBranch,
    gitBranches: parsed.gitBranches,
    prLinks: parsed.prLinks,
    model: parsed.model,
    promptCount,
    toolCallCount,
    editCount,
    filesModified: [...fileEditCounts.entries()]
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 100),
    tokenUsage: parsed.tokenUsage,
    costEstimate,
    subAgentCount: parsedSubAgentCount || derivedSubAgentCount,
    apiErrorCount: parsed.apiErrors?.length || 0,
    compactionCount: parsed.compactions?.length || 0,
    entrypoint: parsed.entrypoint,
    permissionMode: parsed.permissionMode,
    skillsUsed: parsed.skillsUsed,
    mcpServersUsed: parsed.mcpServersUsed,
    dataSource: parsed.dataSource,
    dataQualityNotes: parsed.dataSourceInfo?.notes,
    turnStatCount: parsed.turnStats?.length,
    turnDurations: parsed.turnStats
      ?.map((t) => t.durationMs)
      .filter((d): d is number => d != null && d > 0),
  };
}

function firstUserPrompt(turns: ProviderParseResult["turns"]): string | undefined {
  for (const turn of turns) {
    if (turn.role !== "user" || turn.subtype) continue;
    for (const block of turn.blocks) {
      if (block.type !== "text") continue;
      const text = block.text.replace(/\s+/g, " ").trim();
      if (text.length >= 10) return text.slice(0, 200);
    }
  }
  return undefined;
}

function estimateParsedCost(parsed: ProviderParseResult): number | undefined {
  if (parsed.tokenUsageByModel) return estimateCost(parsed.tokenUsageByModel);
  if (parsed.tokenUsage && parsed.model) return estimateCostSimple(parsed.tokenUsage, parsed.model);
  return undefined;
}

// ─── Cache management ───────────────────────────────────────────────

const SCAN_CACHE_KEY = "session-scans-v1";
const SCAN_CONCURRENCY = 4;

async function readScanCache(): Promise<ScanCacheData | null> {
  const cached = await readFileCache<ScanCacheData>(SCAN_CACHE_KEY);
  if (!cached) return null;
  if (cached.data.scannerVersion !== SCANNER_VERSION) return null;
  return cached.data;
}

async function writeScanCache(data: ScanCacheData): Promise<void> {
  await writeFileCache(SCAN_CACHE_KEY, data);
}

async function getFileMeta(filePaths: string[]): Promise<{ mtimeMs: number; fileSize: number }> {
  let totalSize = 0;
  let maxMtime = 0;
  for (const fp of filePaths) {
    try {
      const s = await stat(fp);
      totalSize += s.size;
      if (s.mtimeMs > maxMtime) maxMtime = s.mtimeMs;
    } catch {
      // File may have been deleted
    }
  }
  return { mtimeMs: maxMtime, fileSize: totalSize };
}

async function getScanCacheMeta(session: ScanInput): Promise<{
  mtimeMs: number;
  fileSize: number;
}> {
  const paths = [...session.filePaths, ...(session.toolPaths || [])];
  const sourceFilePath = session.sourceFilePath || "";
  if (sourceFilePath && !sourceFilePath.includes("#") && !paths.includes(sourceFilePath)) {
    paths.push(sourceFilePath);
  }

  const meta = await getFileMeta([...new Set(paths)]);
  if (session.provider === "cursor" && session.hasSqlite) {
    const sessionTimestampMs = session.timestamp ? Date.parse(session.timestamp) : NaN;
    if (Number.isFinite(sessionTimestampMs) && sessionTimestampMs > meta.mtimeMs) {
      meta.mtimeMs = sessionTimestampMs;
    }
    meta.fileSize += session.sourceFileSize || 0;
  }
  return meta;
}

/**
 * Check if a cached scan entry is still valid for the given file(s).
 * Returns the file meta on cache miss (avoids a second stat() round).
 */
async function checkCache(
  entry: ScanCacheEntry | undefined,
  session: ScanInput,
): Promise<{ valid: true } | { valid: false; meta: { mtimeMs: number; fileSize: number } }> {
  const meta = await getScanCacheMeta(session);
  if (entry && entry.mtimeMs === meta.mtimeMs && entry.fileSize === meta.fileSize) {
    return { valid: true };
  }
  return { valid: false, meta };
}

// ─── Background scanner ────────────────────────────────────────────

export interface BackgroundScanState {
  running: boolean;
  scanned: number;
  total: number;
  results: SessionScanResult[];
  currentSession?: string;
  phase?: "discovering" | "scanning";
  startedAt?: string;
  finishedAt?: string;
}

/**
 * Run background scan on a list of sessions. Scans newest first.
 * Uses cache to skip unchanged sessions. Reports progress via callback.
 */
export async function runBackgroundScan(
  sessions: ScanInput[],
  onProgress?: (progress: ScanProgress) => void,
): Promise<SessionScanResult[]> {
  const cache = (await readScanCache()) || { scannerVersion: SCANNER_VERSION, entries: {} };
  const results: (SessionScanResult | undefined)[] = Array.from({ length: sessions.length });
  let completed = 0;
  let nextIndex = 0;
  let writeChain: Promise<void> = Promise.resolve();

  const queueCacheWrite = (): void => {
    writeChain = writeChain.then(() => writeScanCache(cache)).catch(() => {});
  };

  const processSession = async (index: number): Promise<void> => {
    const session = sessions[index];
    const cached = cache.entries[session.sessionId];
    const cacheCheck = await checkCache(cached, session);

    if (cacheCheck.valid && cached) {
      results[index] = cached.result;
    } else {
      try {
        const result = await scanSession(session);
        results[index] = result;

        const { meta } = cacheCheck as {
          valid: false;
          meta: { mtimeMs: number; fileSize: number };
        };
        cache.entries[session.sessionId] = {
          mtimeMs: meta.mtimeMs,
          fileSize: meta.fileSize,
          scannedAt: new Date().toISOString(),
          result,
        };
      } catch {
        // Skip failed sessions silently
      }
    }

    completed++;
    onProgress?.({
      scanned: completed,
      total: sessions.length,
      currentSession: session.slug,
      done: false,
    });
    if (completed % 25 === 0) queueCacheWrite();
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= sessions.length) return;
      await processSession(index);
    }
  };

  onProgress?.({
    scanned: 0,
    total: sessions.length,
    done: false,
  });

  const workerCount = Math.min(SCAN_CONCURRENCY, sessions.length || 1);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  queueCacheWrite();
  await writeChain;

  onProgress?.({
    scanned: sessions.length,
    total: sessions.length,
    done: true,
  });

  return results.filter((result): result is SessionScanResult => Boolean(result));
}

// ─── Aggregation ────────────────────────────────────────────────────

export function aggregateProjectInsights(
  project: string,
  scans: SessionScanResult[],
  memory?: ProjectMemory,
): ProjectInsights {
  const projectScans = scans.filter((s) => s.project === project);

  let totalDurationMs = 0;
  let totalCost = 0;
  let totalPrompts = 0;
  let totalToolCalls = 0;
  let totalEdits = 0;
  let subAgentTotal = 0;
  let apiErrorTotal = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  const allTurnDurations: number[] = [];
  const models: Record<string, number> = {};
  const branchMap = new Map<string, { sessionIds: string[]; prLinks: PrLink[] }>();
  const fileEditCounts = new Map<string, { edits: number; sessions: Set<string> }>();
  const sessionsPerDay: Record<string, number> = {};
  let first = "";
  let last = "";
  let sessionsWithDuration = 0;

  for (const s of projectScans) {
    totalDurationMs += s.durationMs || 0;
    if (s.durationMs) sessionsWithDuration++;
    totalCost += s.costEstimate || 0;
    totalPrompts += s.promptCount;
    totalToolCalls += s.toolCallCount;
    totalEdits += s.editCount;
    subAgentTotal += s.subAgentCount;
    apiErrorTotal += s.apiErrorCount;
    if (s.tokenUsage) {
      totalInputTokens += s.tokenUsage.inputTokens;
      totalOutputTokens += s.tokenUsage.outputTokens;
      totalCacheRead += s.tokenUsage.cacheReadTokens;
      totalCacheCreation += s.tokenUsage.cacheCreationTokens;
    }
    if (s.turnDurations) allTurnDurations.push(...s.turnDurations);

    if (s.model) models[s.model] = (models[s.model] || 0) + 1;

    // Branches
    const branches = s.gitBranches || (s.gitBranch ? [s.gitBranch] : []);
    for (const b of branches) {
      if (!branchMap.has(b)) branchMap.set(b, { sessionIds: [], prLinks: [] });
      const entry = branchMap.get(b)!;
      if (!entry.sessionIds.includes(s.sessionId)) entry.sessionIds.push(s.sessionId);
    }
    if (s.prLinks) {
      for (const pr of s.prLinks) {
        // Attach PRs to the most relevant branch (last one)
        const branch = s.gitBranch || branches[branches.length - 1];
        if (branch && branchMap.has(branch)) {
          const entry = branchMap.get(branch)!;
          if (!entry.prLinks.some((p) => p.prUrl === pr.prUrl)) {
            entry.prLinks.push(pr);
          }
        }
      }
    }

    // File hotspots — use actual per-file edit counts from scanner
    for (const fm of s.filesModified) {
      if (!fileEditCounts.has(fm.file))
        fileEditCounts.set(fm.file, { edits: 0, sessions: new Set() });
      const entry = fileEditCounts.get(fm.file)!;
      entry.edits += fm.count;
      entry.sessions.add(s.sessionId);
    }

    // Time range
    const ts = s.startTime || "";
    if (ts && (!first || ts < first)) first = ts;
    if (ts && (!last || ts > last)) last = ts;

    // Sessions per day (local timezone — UTC bucketing misses evening sessions west of UTC)
    const day = localDayKey(ts);
    if (day) {
      sessionsPerDay[day] = (sessionsPerDay[day] || 0) + 1;
    }
  }

  const branches: BranchInfo[] = [...branchMap.entries()]
    .map(([branch, data]) => ({
      branch,
      sessionIds: data.sessionIds,
      prLinks: data.prLinks.length > 0 ? data.prLinks : undefined,
    }))
    .sort((a, b) => b.sessionIds.length - a.sessionIds.length);

  const hotFiles = [...fileEditCounts.entries()]
    .map(([file, data]) => ({
      file,
      editCount: data.edits,
      sessionCount: data.sessions.size,
    }))
    .sort((a, b) => b.editCount - a.editCount)
    .slice(0, 20);

  const hasTokens = totalInputTokens + totalOutputTokens + totalCacheRead + totalCacheCreation > 0;
  const histogram = buildTurnDurationHistogram(allTurnDurations);

  return {
    project,
    sessionCount: projectScans.length,
    totalDurationMs,
    totalCost,
    totalPrompts,
    totalToolCalls,
    totalEdits,
    models,
    branches,
    hotFiles,
    subAgentTotal,
    apiErrorTotal,
    timeRange: { first, last },
    sessionsPerDay,
    avgSessionDurationMs:
      sessionsWithDuration > 0 ? Math.round(totalDurationMs / sessionsWithDuration) : 0,
    medianTurnDurationMs: histogram?.percentiles.p50Ms,
    tokenBreakdown: hasTokens
      ? {
          input: totalInputTokens,
          output: totalOutputTokens,
          cacheRead: totalCacheRead,
          cacheCreation: totalCacheCreation,
        }
      : undefined,
    turnDurationHistogram: histogram,
    memory,
    dataQuality: buildAggregateDataQuality(projectScans),
  };
}

export function aggregateUserInsights(scans: SessionScanResult[]): UserInsights {
  let totalDurationMs = 0;
  let totalCost = 0;
  let totalPrompts = 0;
  let totalToolCalls = 0;
  let totalEdits = 0;
  let subAgentTotal = 0;
  let apiErrorTotal = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  const allTurnDurations: number[] = [];
  const providers: Record<string, number> = {};
  const models: Record<string, number> = {};
  const projectStats = new Map<
    string,
    {
      sessions: number;
      cost: number;
      prompts: number;
      durationMs: number;
      toolCalls: number;
      edits: number;
      branches: Set<string>;
      prUrls: Set<string>;
      lastActivity: string;
      sessionsPerDay: Record<string, number>;
    }
  >();
  const sessionsPerDay: Record<string, number> = {};
  let first = "";
  let last = "";
  let sessionsWithDuration = 0;

  for (const s of scans) {
    totalDurationMs += s.durationMs || 0;
    if (s.durationMs) sessionsWithDuration++;
    totalCost += s.costEstimate || 0;
    totalPrompts += s.promptCount;
    totalToolCalls += s.toolCallCount;
    totalEdits += s.editCount;
    subAgentTotal += s.subAgentCount;
    apiErrorTotal += s.apiErrorCount;
    if (s.tokenUsage) {
      totalInputTokens += s.tokenUsage.inputTokens;
      totalOutputTokens += s.tokenUsage.outputTokens;
      totalCacheRead += s.tokenUsage.cacheReadTokens;
      totalCacheCreation += s.tokenUsage.cacheCreationTokens;
    }
    if (s.turnDurations) allTurnDurations.push(...s.turnDurations);

    providers[s.provider] = (providers[s.provider] || 0) + 1;
    if (s.model) models[s.model] = (models[s.model] || 0) + 1;

    if (!projectStats.has(s.project)) {
      projectStats.set(s.project, {
        sessions: 0,
        cost: 0,
        prompts: 0,
        durationMs: 0,
        toolCalls: 0,
        edits: 0,
        branches: new Set(),
        prUrls: new Set(),
        lastActivity: "",
        sessionsPerDay: {},
      });
    }
    const ps = projectStats.get(s.project)!;
    ps.sessions++;
    ps.cost += s.costEstimate || 0;
    ps.prompts += s.promptCount;
    ps.durationMs += s.durationMs || 0;
    ps.toolCalls += s.toolCallCount;
    ps.edits += s.editCount;
    const branches = s.gitBranches || (s.gitBranch ? [s.gitBranch] : []);
    for (const b of branches) ps.branches.add(b);
    if (s.prLinks) {
      for (const pr of s.prLinks) ps.prUrls.add(pr.prUrl);
    }
    const ts = s.startTime || "";
    if (ts && (!ps.lastActivity || ts > ps.lastActivity)) ps.lastActivity = ts;
    if (ts && (!first || ts < first)) first = ts;
    if (ts && (!last || ts > last)) last = ts;

    const day = localDayKey(ts);
    if (day) {
      ps.sessionsPerDay[day] = (ps.sessionsPerDay[day] || 0) + 1;
      sessionsPerDay[day] = (sessionsPerDay[day] || 0) + 1;
    }
  }

  const topProjects = [...projectStats.entries()]
    .map(([project, data]) => ({
      project,
      sessions: data.sessions,
      cost: data.cost,
      prompts: data.prompts,
      durationMs: data.durationMs,
      toolCalls: data.toolCalls,
      edits: data.edits,
      branchCount: data.branches.size,
      prCount: data.prUrls.size,
      memoryFileCount: 0, // populated later via readProjectMemory
      lastActivity: data.lastActivity,
      sessionsPerDay: data.sessionsPerDay,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  const uniqueProjects = new Set(scans.map((s) => s.project));
  const hasTokens = totalInputTokens + totalOutputTokens + totalCacheRead + totalCacheCreation > 0;
  const histogram = buildTurnDurationHistogram(allTurnDurations);

  return {
    totalSessions: scans.length,
    totalProjects: uniqueProjects.size,
    totalDurationMs,
    totalCost,
    totalPrompts,
    totalToolCalls,
    totalEdits,
    providers,
    topProjects,
    models,
    timeRange: { first, last },
    sessionsPerDay,
    subAgentTotal,
    apiErrorTotal,
    avgSessionDurationMs:
      sessionsWithDuration > 0 ? Math.round(totalDurationMs / sessionsWithDuration) : 0,
    medianTurnDurationMs: histogram?.percentiles.p50Ms,
    tokenBreakdown: hasTokens
      ? {
          input: totalInputTokens,
          output: totalOutputTokens,
          cacheRead: totalCacheRead,
          cacheCreation: totalCacheCreation,
        }
      : undefined,
    turnDurationHistogram: histogram,
    dataQuality: buildAggregateDataQuality(scans),
  };
}

function buildAggregateDataQuality(scans: SessionScanResult[]): { notes: string[] } | undefined {
  const cursorScans = scans.filter((s) => s.provider === "cursor");
  if (cursorScans.length === 0) return undefined;

  const total = cursorScans.length;
  const estimatedDurationCount = cursorScans.filter((s) =>
    s.dataQualityNotes?.some((note) => /duration.*estimated|estimated.*duration/i.test(note)),
  ).length;
  const missingDurationCount = cursorScans.filter((s) => !s.durationMs).length;
  const missingTokenCount = cursorScans.filter((s) => !s.tokenUsage).length;
  const missingTurnStatsCount = cursorScans.filter((s) => !s.turnStatCount).length;

  const notes: string[] = [];
  if (estimatedDurationCount > 0) {
    notes.push(
      `${estimatedDurationCount}/${total} Cursor sessions use best-effort duration estimates.`,
    );
  }
  if (missingDurationCount > 0) {
    notes.push(
      `${missingDurationCount}/${total} Cursor sessions do not have enough timing data to compute duration.`,
    );
  }
  if (missingTokenCount > 0) {
    notes.push(
      `${missingTokenCount}/${total} Cursor sessions do not include token snapshots, so token and cost totals are partial.`,
    );
  }
  if (missingTurnStatsCount > 0) {
    notes.push(`${missingTurnStatsCount}/${total} Cursor sessions do not include per-turn stats.`);
  }

  return notes.length > 0 ? { notes } : undefined;
}

// ─── Memory reader ──────────────────────────────────────────────────

const CLAUDE_DIR = join(homedir(), ".claude", "projects");

/**
 * Encode a project path the way Claude Code does: path separators → hyphens.
 * e.g. "/Users/tuo/Code/my-project" → "-Users-tuo-Code-my-project"
 * e.g. "~/Code/my-project" → expand ~ first
 */
function encodeProjectDir(project: string): string {
  let resolved = project;
  if (resolved.startsWith("~/")) {
    resolved = join(homedir(), resolved.slice(2));
  } else if (resolved === "~") {
    resolved = homedir();
  }
  return resolved.replace(/\//g, "-");
}

export async function readProjectMemory(project: string): Promise<ProjectMemory | null> {
  const encoded = encodeProjectDir(project);
  const projectDir = join(CLAUDE_DIR, encoded);
  const memoryDir = join(projectDir, "memory");

  const memoryFiles: ProjectMemory["memoryFiles"] = [];
  let claudeMd: string | undefined;

  // Read CLAUDE.md
  try {
    const content = await readFile(join(projectDir, "CLAUDE.md"), "utf-8");
    if (content.trim()) claudeMd = content.slice(0, 5000);
  } catch {
    // No CLAUDE.md
  }

  // Read memory files
  try {
    const files = await readdir(memoryDir);
    for (const file of files) {
      if (!file.endsWith(".md") || file === "MEMORY.md") continue;
      try {
        const content = await readFile(join(memoryDir, file), "utf-8");
        // Parse frontmatter
        const fm = parseFrontmatter(content);
        memoryFiles.push({
          name: fm.name || file.replace(/\.md$/, ""),
          description: fm.description,
          type: fm.type,
          content: fm.body.slice(0, 2000),
        });
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // No memory directory
  }

  if (memoryFiles.length === 0 && !claudeMd) return null;

  return { memoryFiles, claudeMd };
}

function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  type?: string;
  body: string;
} {
  // Normalize \r\n → \n for Windows-edited files
  const normalized = content.replace(/\r\n/g, "\n");
  const fmMatch = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!fmMatch) return { body: content };

  const yaml = fmMatch[1];
  const body = fmMatch[2];

  const getName = (s: string) => s.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const getDesc = (s: string) => s.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  const getType = (s: string) => s.match(/^type:\s*(.+)$/m)?.[1]?.trim();

  return {
    name: getName(yaml),
    description: getDesc(yaml),
    type: getType(yaml),
    body,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Extract plain text from a message content field (string or content block array). */
function extractMetaText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text || "")
      .join("\n");
  }
  return "";
}
