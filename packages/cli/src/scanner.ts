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
import { isSystemGeneratedMessage } from "@vibe-replay/provider-core/clean-prompt";
import { estimateActiveDuration } from "@vibe-replay/provider-core/duration";
import {
  FILE_EDIT_TOOLS,
  extractToolFilePath,
  extractToolFilePaths,
} from "@vibe-replay/provider-core/utils";
import { estimateCostIfKnown, estimateCostSimpleIfKnown } from "@vibe-replay/replay-core/pricing";
import { classifyProject, mergeProjectIdentities, projectIdentityKey } from "@vibe-replay/types";
import { parseCodexSession } from "./providers/codex/parser.js";
import { parseClaudeCoworkSession } from "@vibe-replay/provider-claude-code/claude-cowork/parser";
import { parseCursorSession } from "./providers/cursor/parser.js";
import { parsePiSession } from "./providers/pi/parser.js";
import type { ProviderParseResult } from "./providers/types.js";
import type {
  DataSource,
  ProjectIdentity,
  PrLink,
  SessionInfo,
  SessionLocation,
  SessionTranscriptStatus,
  SessionUsageSummary,
  TokenUsage,
  UsageEvent,
} from "./types.js";
import { localDayKey, shortenPath } from "./utils.js";

// Bump this when we extract new fields — forces re-scan of all sessions.
// v19: the usage index distinguishes sessions that were scanned and found to
// have no usage from sessions whose rich usage scan was deferred. Cached v18
// results cannot make that distinction.
// v20: normalize placeholder MCP server names in cached usage summaries.
// v21: persist canonical project identity alongside scan results.
// v22: refine Cursor SDK context-worktree classification and fallback keys.
// v23: disambiguate Cursor SDK workflow display labels.
// v24: persist session location so local and SSH scan results stay isolated.
// v25: persist transcript availability so metadata-only sources do not look
// like ordinary sessions that simply have not been scanned yet.
export const SCANNER_VERSION = 25;
// v26 briefly existed during development for a title-only change. Its result
// shape is identical to v25, so accepting it avoids a second full local rescan.
const COMPATIBLE_SCANNER_VERSIONS = new Set([SCANNER_VERSION, 26]);

// Keep per-invocation detail bounded in the durable insight store. The full
// event set is still used to compute usageSummary below; only the retained
// detail returned to the cache/API is capped.
const MAX_RETAINED_USAGE_EVENTS = 100;

// ─── Types ──────────────────────────────────────────────────────────

export interface SessionScanResult {
  sessionId: string;
  provider: string;
  location?: SessionLocation;
  transcriptStatus?: SessionTranscriptStatus;
  project: string;
  projectIdentity?: ProjectIdentity;
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
  usageSummary?: SessionUsageSummary;
  usageEvents?: UsageEvent[];
  /** Whether this result has gone through a usage-aware scan, even if empty. */
  usageIndexed?: boolean;
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

function incrementUsage(counts: Record<string, number>, name: string): void {
  counts[name] = (counts[name] || 0) + 1;
}

interface McpUsage {
  server: string;
  tool?: string;
  attribution: UsageEvent["attribution"];
}

/**
 * Cursor scopes user-level MCP servers as `user-<name>` in newer tool payloads
 * but omits the scope in its `mcp-<server>-<tool>` names, which would otherwise
 * split one server across two facet entries. Built-ins (`cursor-ide-browser`)
 * carry no scope prefix in either form. Some payloads also append the profile
 * the server was resolved under (`gdrive::mcpScope:profile:...:cfg:...`), which
 * splits the same server the same way.
 */
function stripCursorServerScope(server: string): string {
  const scopeIndex = server.indexOf("::mcpScope:");
  const base = scopeIndex > 0 ? server.slice(0, scopeIndex) : server;
  return base.startsWith("user-") ? base.slice("user-".length) : base;
}

function normalizeMcpServerName(server: string): string {
  const normalized = server.trim();
  return normalized === "" || normalized === "-" ? "Unknown" : normalized;
}

/** Cursor tools that manage MCP itself rather than call a server. */
const MCP_META_TOOL_NAMES = new Set(["mcp_auth", "mcp_get_tools"]);

function parseMcpUsage(rawName: string, input?: Record<string, unknown>): McpUsage | undefined {
  // Cursor maps some MCP tools (notably the browser integration) to a generic
  // replay name, while its argument mapper preserves the explicit server/tool
  // pair. Prefer that pair before attempting provider-specific name parsing.
  if (
    (rawName === "Browser" || rawName === "CallMcpTool" || rawName.startsWith("mcp")) &&
    typeof input?.server === "string" &&
    input.server
  ) {
    const tool =
      typeof input.toolName === "string"
        ? input.toolName
        : typeof input.tool_name === "string"
          ? input.tool_name
          : undefined;
    if (tool) {
      return {
        server: stripCursorServerScope(input.server),
        tool,
        attribution: "explicit",
      };
    }
  }

  if (rawName.startsWith("mcp__")) {
    const [, server, ...toolParts] = rawName.split("__");
    const tool = toolParts.join("__");
    if (server && tool) {
      return { server: stripCursorServerScope(server), tool, attribution: "parsed-name" };
    }
  }

  if (
    rawName === "CallMcpTool" &&
    typeof input?.server === "string" &&
    typeof input.toolName === "string"
  ) {
    return {
      server: stripCursorServerScope(input.server),
      tool: input.toolName,
      attribution: "explicit",
    };
  }

  // Cursor names MCP calls `mcp-<server>-<tool>` where the server itself may
  // contain dashes (`cursor-ide-browser`). Its normalized input carries the
  // server and tool explicitly; the dash split is only the fallback, and it
  // splits at the last dash because MCP tool names are not kebab-case.
  if (rawName.startsWith("mcp-")) {
    if (typeof input?.server === "string" && input.server) {
      const tool = typeof input.tool_name === "string" ? input.tool_name : undefined;
      return { server: stripCursorServerScope(input.server), tool, attribution: "explicit" };
    }
    const remainder = rawName.slice("mcp-".length);
    const separator = remainder.lastIndexOf("-");
    const server = stripCursorServerScope(
      separator > 0 ? remainder.slice(0, separator) : remainder,
    );
    const tool = separator > 0 ? remainder.slice(separator + 1) : undefined;
    if (server) return { server, tool, attribution: "parsed-name" };
  }

  // Cursor's earlier naming was `mcp_<server>_<tool>`. Server names there are
  // camel/Pascal case while tool names are snake_case, so the first underscore
  // is the boundary. Cursor's own MCP meta-tools share the prefix without
  // naming a server, so they stay ordinary tools.
  if (
    rawName.startsWith("mcp_") &&
    !MCP_META_TOOL_NAMES.has(rawName) &&
    !rawName.startsWith("mcp_meta_tool")
  ) {
    const remainder = rawName.slice("mcp_".length);
    const separator = remainder.indexOf("_");
    if (separator > 0) {
      return {
        server: stripCursorServerScope(remainder.slice(0, separator)),
        tool: remainder.slice(separator + 1),
        attribution: "parsed-name",
      };
    }
  }

  // Pi routes every MCP interaction through one `mcp` tool: discovery calls name
  // the server directly, while invocations carry `<server>_<tool>`.
  if (rawName === "mcp" || rawName === "mcpScript") {
    if (typeof input?.server === "string" && input.server) {
      const tool = typeof input.tool === "string" ? input.tool : undefined;
      return { server: input.server, tool, attribution: "explicit" };
    }
    if (typeof input?.tool === "string" && input.tool.includes("_")) {
      const separator = input.tool.indexOf("_");
      return {
        server: input.tool.slice(0, separator),
        tool: input.tool.slice(separator + 1),
        attribution: "parsed-name",
      };
    }
  }

  return undefined;
}

function toolUsageEvent(
  rawName: unknown,
  options: {
    input?: Record<string, unknown>;
    turnIndex?: number;
    timestamp?: string;
    durationMs?: number;
    isError?: boolean;
    hasResult?: boolean;
    parentAgentId?: string;
    /** Provider attribution fields can identify an MCP call when its tool name is generic. */
    mcpServer?: string;
    mcpTool?: string;
    /** Maps opaque provider server IDs (Cowork UUIDs) to human names. */
    mcpServerNames?: Record<string, string>;
  } = {},
): UsageEvent {
  const name = typeof rawName === "string" && rawName.trim() ? rawName : "Unknown";
  const mcp = options.mcpServer
    ? {
        server: options.mcpServer,
        tool: options.mcpTool,
        attribution: "explicit" as const,
      }
    : parseMcpUsage(name, options.input);
  const serverName = mcp
    ? normalizeMcpServerName(options.mcpServerNames?.[mcp.server] || mcp.server)
    : undefined;
  return {
    kind: "tool",
    name,
    turnIndex: options.turnIndex,
    timestamp: options.timestamp,
    durationMs: options.durationMs,
    status: options.isError ? "error" : options.hasResult ? "success" : "unknown",
    mcpServer: serverName,
    mcpTool: mcp?.tool,
    parentAgentId: options.parentAgentId,
    attribution: mcp?.attribution || "explicit",
  };
}

function summarizeUsage(
  events: UsageEvent[],
  skillsUsed?: Iterable<string>,
  mcpServersUsed?: Iterable<string>,
): SessionUsageSummary | undefined {
  const skills = skillsUsed ? [...skillsUsed] : [];
  const mcpServers = mcpServersUsed ? [...mcpServersUsed].map(normalizeMcpServerName) : [];
  if (events.length === 0 && skills.length === 0 && mcpServers.length === 0) return undefined;
  const summary: SessionUsageSummary = {
    tools: {},
    mcpServers: {},
    mcpTools: {},
    skills: {},
    successCount: 0,
    errorCount: 0,
    totalDurationMs: 0,
    durationCount: 0,
  };

  for (const event of events) {
    if (event.kind === "skill") {
      incrementUsage(summary.skills, event.skillName || event.name);
    } else if (event.mcpServer) {
      // MCP calls are counted under their server/tool only. Their raw tool names
      // (`CallMcpTool`, `mcp__server__tool`, ...) would otherwise duplicate the
      // MCP facets while telling the reader nothing the MCP facets don't.
      incrementUsage(summary.mcpServers, event.mcpServer);
      if (event.mcpTool) incrementUsage(summary.mcpTools, `${event.mcpServer}/${event.mcpTool}`);
    } else {
      incrementUsage(summary.tools, event.name);
    }
    if (event.status === "success") summary.successCount++;
    if (event.status === "error") summary.errorCount++;
    if (event.durationMs != null) {
      summary.totalDurationMs += event.durationMs;
      summary.durationCount++;
    }
  }

  for (const skill of skills) {
    if (!summary.skills[skill]) summary.skills[skill] = 1;
  }
  for (const server of mcpServers) {
    if (!summary.mcpServers[server]) summary.mcpServers[server] = 1;
  }

  return summary;
}

function retainedUsageEvents(events: UsageEvent[]): UsageEvent[] | undefined {
  if (events.length === 0) return undefined;
  return events.length > MAX_RETAINED_USAGE_EVENTS
    ? events.slice(-MAX_RETAINED_USAGE_EVENTS)
    : events;
}

export interface ScanCacheData {
  scannerVersion: number;
  entries: Record<string, ScanCacheEntry>; // keyed by provider + sessionId
}

export interface ProjectInsights {
  project: string;
  projectIdentity?: ProjectIdentity;
  location?: SessionLocation;
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
    projectIdentity?: ProjectIdentity;
    location?: SessionLocation;
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
  location?: SessionLocation;
  transcriptStatus?: SessionTranscriptStatus;
  project: string;
  projectIdentity?: ProjectIdentity;
  slug: string;
  filePaths: string[];
  toolPaths?: string[];
  sourceFilePath?: string;
  sourceFileSize?: number;
  sourceLineCount?: number;
  workspacePath?: string;
  hasSqlite?: boolean;
  hasSdk?: boolean;
  deferRichCursorParse?: boolean;
  timestamp?: string;
  title?: string;
  firstPrompt?: string;
  /** Discovery-computed stats carried through for SQLite-backed providers whose
   *  filePaths point into a database rather than JSONL files. */
  discoveryPromptCount?: number;
  discoveryToolCallCount?: number;
  discoveryEditCount?: number;
  discoveryModel?: string;
  discoveryDurationMs?: number;
  discoveryTokenUsage?: SessionScanResult["tokenUsage"];
  discoveryCostEstimate?: number;
  /** Remote home prefix used to keep parsed file paths display-safe. */
  remoteHome?: string;
}

/** Keep provider-native IDs isolated when caching cross-provider scan results. */
export function scanCacheEntryKey(
  session: Pick<ScanInput, "provider" | "sessionId" | "location">,
): string {
  const targetId = session.location?.kind === "ssh" ? `${session.location.id}::` : "";
  return `${targetId}${session.provider}::${session.sessionId}`;
}

function shortenSessionPath(path: string, input: Pick<ScanInput, "remoteHome">): string {
  const shortened = shortenPath(path);
  const remoteHome = input.remoteHome?.replace(/\/+$/, "");
  if (!remoteHome) return shortened;
  if (shortened === remoteHome) return "~";
  return shortened.startsWith(`${remoteHome}/`)
    ? `~${shortened.slice(remoteHome.length)}`
    : shortened;
}

interface ScanProgress {
  scanned: number;
  total: number;
  currentSession?: string;
  done: boolean;
}

/** Token-usage fields read from a JSONL message during scanning. */
interface ScanLineUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** The `message` envelope read from a JSONL scan line. */
interface ScanLineMessage {
  role?: string;
  content?: unknown;
  id?: string;
  model?: string;
  usage?: ScanLineUsage;
}

/** PR-link payload, present either at the top level of a line or under `data`. */
interface ScanLinePrLink {
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
}

/**
 * The subset of a JSONL line read during lightweight scanning. Every field is
 * optional — lines are heterogeneous across providers and validated field by
 * field. Replaces an untyped `JSON.parse(...)` result.
 */
interface ScanLine extends ScanLinePrLink {
  gitBranch?: string;
  entrypoint?: string;
  permissionMode?: string;
  timestamp?: string;
  type?: string;
  subtype?: string;
  durationMs?: number;
  customTitle?: string;
  title?: string;
  isApiErrorMessage?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  sourceToolAssistantUUID?: string;
  sourceToolUseID?: string;
  origin?: string;
  parent_tool_use_id?: string;
  parentToolUseID?: string;
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  attributionSkill?: string;
  snapshot?: { timestamp?: string };
  data?: ScanLinePrLink;
  message?: ScanLineMessage;
}

/** A content block read from a sub-agent JSONL message. */
interface SubAgentBlock {
  type?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/** The subset of a sub-agent JSONL line read during scanning. */
interface SubAgentLine {
  message?: { role?: string; content?: unknown };
}

/**
 * Scan a single session's JSONL files and extract aggregate metadata.
 * This is much lighter than the full parser — no scene building, no
 * subagent JSONL reading, no transform step.
 */
export async function scanSession(input: ScanInput): Promise<SessionScanResult> {
  let richFallbackProvider: string | undefined;
  if (input.provider === "claude-cowork") {
    try {
      return await scanClaudeCoworkSession(input);
    } catch {
      // Fall through to the generic JSONL scanner if a Cowork audit contains a
      // newer shape that the full normalizer does not yet understand.
      richFallbackProvider = "Claude Cowork";
    }
  }
  if (input.provider === "cursor") {
    try {
      return await scanCursorSession(input);
    } catch {
      // Fall back to the legacy lightweight scanner below so Cursor sessions
      // still show up even if richer parsing fails for one host/schema.
      richFallbackProvider = "Cursor";
    }
  }
  if (input.provider === "codex") {
    try {
      return await scanCodexSession(input);
    } catch {
      // Fall through to the lightweight scanner so a partial Codex rollout
      // still appears in insights if the richer parser hits an unknown event.
      richFallbackProvider = "Codex";
    }
  }
  if (input.provider === "pi") {
    try {
      return await scanPiSession(input);
    } catch {
      // Fall through to the lightweight scanner so Pi sessions still show up
      // if the richer parser hits an unknown entry shape.
      richFallbackProvider = "Pi";
    }
  }
  if (input.provider === "opencode") {
    return buildLightweightOpencodeScanResult(input);
  }
  if (input.provider === "hermes") {
    return buildLightweightHermesScanResult(input);
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
  const usageEvents: UsageEvent[] = [];
  const eventByToolUseId = new Map<string, UsageEvent>();
  let readAnySourceFile = false;

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
      readAnySourceFile = true;
    } catch {
      continue;
    }

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;

      let obj: ScanLine;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      // Extract metadata from top-level fields
      if (obj.gitBranch) {
        const b = obj.gitBranch;
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
          if (name) {
            skillsUsed.add(name);
            usageEvents.push({
              kind: "skill",
              name,
              skillName: name,
              timestamp: obj.timestamp,
              status: "unknown",
              attribution: "session-metadata",
            });
          }
        } else if (text.startsWith("The user just ran /")) {
          const cmd = text.split("/")[1]?.split(/[\s\n]/)[0];
          if (cmd) {
            const name = `/${cmd}`;
            skillsUsed.add(name);
            usageEvents.push({
              kind: "skill",
              name,
              skillName: name,
              timestamp: obj.timestamp,
              status: "unknown",
              attribution: "session-metadata",
            });
          }
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
      if (obj.attributionMcpServer) {
        mcpServersUsed.add(normalizeMcpServerName(obj.attributionMcpServer));
      }
      if (obj.attributionSkill) skillsUsed.add(obj.attributionSkill);

      // Tool results carry the outcome of an earlier tool_use block, which is
      // the only place this raw path can learn whether a call actually failed.
      if (role === "user" && Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
          const event = eventByToolUseId.get(block.tool_use_id);
          if (event) event.status = block.is_error ? "error" : "success";
        }
      }

      // User prompts
      if (role === "user") {
        const isToolResponse =
          !!obj.sourceToolAssistantUUID ||
          !!obj.sourceToolUseID ||
          obj.origin === "tool_result" ||
          !!obj.parent_tool_use_id ||
          !!obj.parentToolUseID;
        if (typeof msgContent === "string") {
          const isCompaction =
            obj.isCompactSummary ||
            msgContent.startsWith("This session is being continued from a previous conversation");
          if (!isCompaction && !isToolResponse && !isSystemGeneratedMessage(msgContent)) {
            promptCount++;
            if (!firstPrompt && msgContent.trim()) {
              firstPrompt = msgContent.slice(0, 200);
            }
          }
        } else if (Array.isArray(msgContent)) {
          // Check if it has text (not just tool_result)
          const text = msgContent
            .filter(
              (b: { type?: string; text?: string }) =>
                b.type === "text" && typeof b.text === "string",
            )
            .map((b: { text?: string }) => b.text || "")
            .join("");
          const hasText = msgContent.some(
            (b: { type?: string; text?: string }) =>
              (b.type === "text" && b.text?.trim()) ||
              b.type === "image" ||
              b.type === "_user_images",
          );
          const isOnlyToolResult = msgContent.every(
            (b: { type?: string }) => b.type === "tool_result",
          );
          if (hasText && !isOnlyToolResult && !isToolResponse && !isSystemGeneratedMessage(text)) {
            promptCount++;
          }
        }
      }

      // Assistant messages: count tool uses and extract file modifications
      if (role === "assistant" && Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block.type === "tool_use") {
            toolCallCount++;
            const event = toolUsageEvent(block.name, {
              input: block.input,
              timestamp: obj.timestamp,
              mcpServer: obj.attributionMcpServer,
              mcpTool: obj.attributionMcpTool,
            });
            if (typeof block.id === "string") eventByToolUseId.set(block.id, event);
            usageEvents.push(event);
            // Track MCP server usage
            if (event.mcpServer) mcpServersUsed.add(event.mcpServer);
            // Track file modifications
            if (FILE_EDIT_TOOLS.has(block.name)) {
              const fp = extractToolFilePath(block.input);
              if (fp) {
                editCount++;
                const short = shortenSessionPath(fp, input);
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
          let saObj: SubAgentLine;
          try {
            saObj = JSON.parse(saLine);
          } catch {
            continue;
          }
          const saMsg = saObj?.message;
          if (saMsg?.role !== "assistant" || !Array.isArray(saMsg.content)) continue;
          for (const block of saMsg.content as SubAgentBlock[]) {
            if (block.type !== "tool_use") continue;
            const event = toolUsageEvent(block.name || "Unknown", {
              input: block.input,
              parentAgentId: saFile.replace(/\.jsonl$/, ""),
            });
            usageEvents.push(event);
            if (event.mcpServer) mcpServersUsed.add(event.mcpServer);
            if (block.name && FILE_EDIT_TOOLS.has(block.name)) {
              const fp = extractToolFilePath(block.input);
              if (fp) {
                editCount++;
                const short = shortenSessionPath(fp, input);
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
    costEstimate = estimateCostIfKnown(usageByModel);
  } else if (tokenUsage && model) {
    costEstimate = estimateCostSimpleIfKnown(tokenUsage, model);
  }

  // Derive duration: prefer turn_duration sum (CLI), fall back to active-duration estimate (VS Code)
  let durationMs = totalDurationMs || undefined;
  if (!durationMs) {
    durationMs = estimateActiveDuration(allTimestamps);
  }

  const gitBranch = gitBranches.length > 0 ? gitBranches[gitBranches.length - 1] : undefined;
  if (richFallbackProvider) {
    promptCount ||= input.discoveryPromptCount || 0;
    toolCallCount ||= input.discoveryToolCallCount || 0;
    editCount ||= input.discoveryEditCount || 0;
    model ||= input.discoveryModel;
    durationMs ||= input.discoveryDurationMs;
  }
  const qualityNotes = [...(costDataQualityNotes(undefined, tokenUsage, costEstimate) || [])];
  if (richFallbackProvider) {
    qualityNotes.push(
      `Partial ${richFallbackProvider} scan: the rich parser failed, so available generic and discovery metadata was used.`,
    );
  }

  return {
    sessionId: input.sessionId,
    provider: input.provider,
    location: input.location,
    transcriptStatus: input.transcriptStatus,
    project: input.project,
    projectIdentity: input.projectIdentity,
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
    usageSummary: summarizeUsage(usageEvents, skillsUsed, mcpServersUsed),
    usageEvents: retainedUsageEvents(usageEvents),
    // A normal generic scan is the usage-aware path even when a source file
    // disappeared between discovery and reading. Rich-parser fallbacks need a
    // readable source before they can claim the usage index is complete.
    usageIndexed: !richFallbackProvider || readAnySourceFile,
    turnDurations: turnDurations.length > 0 ? turnDurations : undefined,
    dataQualityNotes: qualityNotes.length > 0 ? qualityNotes : undefined,
  };
}

function scanFallbackPrompt(input: ScanInput, placeholder = ""): string {
  if (input.transcriptStatus) return "";
  return input.firstPrompt || input.title || placeholder;
}

async function scanClaudeCoworkSession(input: ScanInput): Promise<SessionScanResult> {
  const sessionInfo: SessionInfo = {
    provider: "claude-cowork",
    sessionId: input.sessionId,
    slug: input.slug,
    location: input.location,
    transcriptStatus: input.transcriptStatus,
    title: input.title,
    project: input.project,
    cwd: input.project,
    version: "",
    timestamp: input.timestamp || new Date().toISOString(),
    lineCount: input.sourceLineCount || 0,
    fileSize: input.sourceFileSize || 0,
    filePath: input.filePaths[0] || "",
    filePaths: input.filePaths,
    firstPrompt: scanFallbackPrompt(input, "(Cowork session)"),
    model: input.discoveryModel,
  };
  const parsed = await parseClaudeCoworkSession(input.filePaths, sessionInfo);
  return buildScanResultFromParsed(input, parsed);
}

async function scanCodexSession(input: ScanInput): Promise<SessionScanResult> {
  const sessionInfo: SessionInfo = {
    provider: "codex",
    sessionId: input.sessionId,
    slug: input.slug,
    location: input.location,
    transcriptStatus: input.transcriptStatus,
    title: input.title,
    project: input.project,
    cwd: input.workspacePath || input.project,
    version: "",
    timestamp: input.timestamp || new Date().toISOString(),
    lineCount: 0,
    fileSize: 0,
    filePath: input.filePaths[0] || "",
    filePaths: input.filePaths,
    firstPrompt: scanFallbackPrompt(input),
  };

  const parsed = await parseCodexSession(input.filePaths, sessionInfo);
  return buildScanResultFromParsed(input, parsed);
}

async function scanPiSession(input: ScanInput): Promise<SessionScanResult> {
  const sessionInfo: SessionInfo = {
    provider: "pi",
    sessionId: input.sessionId,
    slug: input.slug,
    location: input.location,
    transcriptStatus: input.transcriptStatus,
    title: input.title,
    project: input.project,
    cwd: input.workspacePath || input.project,
    version: "",
    timestamp: input.timestamp || new Date().toISOString(),
    lineCount: 0,
    fileSize: 0,
    filePath: input.filePaths[0] || "",
    filePaths: input.filePaths,
    firstPrompt: scanFallbackPrompt(input, "(pi session)"),
  };

  const parsed = await parsePiSession(input.filePaths, sessionInfo);
  return buildScanResultFromParsed(input, parsed);
}

async function scanCursorSession(input: ScanInput): Promise<SessionScanResult> {
  if (input.deferRichCursorParse && (input.hasSqlite || input.hasSdk)) {
    return buildLightweightCursorScanResult(input);
  }

  const sessionInfo: SessionInfo = {
    provider: "cursor",
    sessionId: input.sessionId,
    slug: input.slug,
    location: input.location,
    transcriptStatus: input.transcriptStatus,
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
    ...(input.hasSdk !== undefined ? { hasSdk: input.hasSdk } : {}),
    firstPrompt: scanFallbackPrompt(input, "(cursor session)"),
  };

  const parsed = await parseCursorSession(
    [...input.filePaths, ...(input.toolPaths || [])],
    sessionInfo,
  );
  return buildScanResultFromParsed(input, parsed);
}

function buildLightweightCursorScanResult(input: ScanInput): SessionScanResult {
  const firstPrompt = scanFallbackPrompt(input);
  const hasPrompt = typeof firstPrompt === "string" && firstPrompt.trim().length > 0;
  const estimatedPromptCount = Math.max(
    input.transcriptStatus ? 0 : hasPrompt ? 1 : 0,
    input.transcriptStatus ? 0 : input.sourceLineCount ? Math.ceil(input.sourceLineCount / 2) : 0,
  );
  const sourceFilePath = input.sourceFilePath || "";
  const dataSource: DataSource = input.hasSdk
    ? "jsonl"
    : sourceFilePath.includes("#composerData:")
      ? "global-state"
      : "sqlite";
  return {
    sessionId: input.sessionId,
    provider: input.provider,
    location: input.location,
    transcriptStatus: input.transcriptStatus,
    project: input.project,
    projectIdentity: input.projectIdentity,
    slug: input.slug,
    title: input.title,
    firstPrompt,
    startTime: input.timestamp,
    model: input.discoveryModel,
    durationMs: input.discoveryDurationMs,
    promptCount: input.discoveryPromptCount ?? estimatedPromptCount,
    toolCallCount: input.discoveryToolCallCount ?? 0,
    editCount: input.discoveryEditCount ?? 0,
    filesModified: [],
    tokenUsage: input.discoveryTokenUsage,
    costEstimate: input.discoveryCostEstimate,
    subAgentCount: 0,
    apiErrorCount: 0,
    compactionCount: 0,
    dataSource,
    dataQualityNotes: [
      "Cursor SQLite/SDK rich details are deferred during background insights scans; discovery summaries are used when available.",
      "Tool, MCP, and skill usage is not indexed for this session while rich details are deferred.",
    ],
    usageIndexed: false,
  };
}

function buildLightweightOpencodeScanResult(input: ScanInput): SessionScanResult {
  const firstPrompt = scanFallbackPrompt(input);
  return {
    sessionId: input.sessionId,
    provider: input.provider,
    location: input.location,
    transcriptStatus: input.transcriptStatus,
    project: input.project,
    projectIdentity: input.projectIdentity,
    slug: input.slug,
    title: input.title,
    firstPrompt,
    startTime: input.timestamp,
    promptCount: input.transcriptStatus ? 0 : (input.discoveryPromptCount ?? (firstPrompt ? 1 : 0)),
    toolCallCount: input.discoveryToolCallCount ?? 0,
    editCount: input.discoveryEditCount ?? 0,
    filesModified: [],
    model: input.discoveryModel,
    durationMs: input.discoveryDurationMs,
    tokenUsage: input.discoveryTokenUsage,
    costEstimate: input.discoveryCostEstimate,
    subAgentCount: 0,
    apiErrorCount: 0,
    compactionCount: 0,
    dataSource: "sqlite",
    dataQualityNotes: [
      "OpenCode details are read from its SQLite database; rich per-file edit counts are resolved when a replay is generated.",
      "Tool, MCP, and skill usage is not indexed for OpenCode sessions during background scans.",
    ],
    usageIndexed: false,
  };
}

function buildLightweightHermesScanResult(input: ScanInput): SessionScanResult {
  const firstPrompt = scanFallbackPrompt(input);
  return {
    sessionId: input.sessionId,
    provider: input.provider,
    location: input.location,
    transcriptStatus: input.transcriptStatus,
    project: input.project,
    projectIdentity: input.projectIdentity,
    slug: input.slug,
    title: input.title,
    firstPrompt,
    startTime: input.timestamp,
    promptCount: input.transcriptStatus ? 0 : (input.discoveryPromptCount ?? (firstPrompt ? 1 : 0)),
    toolCallCount: input.discoveryToolCallCount ?? 0,
    editCount: input.discoveryEditCount ?? 0,
    filesModified: [],
    model: input.discoveryModel,
    durationMs: input.discoveryDurationMs,
    tokenUsage: input.discoveryTokenUsage,
    costEstimate: input.discoveryCostEstimate,
    subAgentCount: 0,
    apiErrorCount: 0,
    compactionCount: 0,
    dataSource: "sqlite",
    dataQualityNotes: [
      "Hermes details are read from its SQLite database (~/.hermes/state.db); rich per-file edit counts are resolved when a replay is generated.",
      "Tool, MCP, and skill usage is not indexed for Hermes sessions during background scans.",
    ],
    usageIndexed: false,
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
  const usageEvents: UsageEvent[] = [];

  for (const [turnIndex, turn] of parsed.turns.entries()) {
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
      usageEvents.push(
        toolUsageEvent(block.name, {
          input: block.input,
          turnIndex,
          timestamp: turn.timestamp,
          durationMs: block._durationMs,
          isError: block._isError,
          hasResult: block._result !== undefined,
          mcpServerNames: parsed.mcpServerNames,
        }),
      );

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
          usageEvents.push(
            toolUsageEvent(saScene.toolName, {
              input: saScene.input,
              timestamp: saScene.timestamp,
              durationMs: saScene.durationMs,
              isError: saScene.isError,
              hasResult: saScene.result !== "",
              parentAgentId: block._subAgent.agentId,
              mcpServerNames: parsed.mcpServerNames,
            }),
          );
          const saTool = saScene.toolName;
          if (!FILE_EDIT_TOOLS.has(saTool)) continue;
          const saPath = extractToolFilePath(saScene.input);
          if (!saPath) continue;
          editCount++;
          const short = shortenSessionPath(saPath, input);
          fileEditCounts.set(short, (fileEditCounts.get(short) || 0) + 1);
        }
      }

      if (!FILE_EDIT_TOOLS.has(block.name)) continue;

      const rawPaths = extractToolFilePaths(block.input);
      if (rawPaths.length === 0) continue;
      editCount++;
      for (const rawPath of rawPaths) {
        const short = shortenSessionPath(rawPath, input);
        fileEditCounts.set(short, (fileEditCounts.get(short) || 0) + 1);
      }
    }
  }

  const costEstimate = estimateParsedCost(parsed);
  const fallbackStart = parsed.startTime || input.timestamp;
  const durationMs = parsed.totalDurationMs;
  const firstPrompt = input.transcriptStatus
    ? ""
    : firstUserPrompt(parsed.turns) || input.firstPrompt || parsed.title;
  for (const skill of parsed.skillsUsed || []) {
    usageEvents.push({
      kind: "skill",
      name: skill,
      skillName: skill,
      status: "unknown",
      attribution: "session-metadata",
    });
  }
  const derivedMcpServers = new Set(
    (parsed.mcpServersUsed || []).map((server) =>
      normalizeMcpServerName(parsed.mcpServerNames?.[server] || server),
    ),
  );
  for (const event of usageEvents) {
    if (event.mcpServer) derivedMcpServers.add(event.mcpServer);
  }

  return {
    sessionId: input.sessionId,
    provider: input.provider,
    location: input.location,
    transcriptStatus: input.transcriptStatus,
    project: input.project,
    projectIdentity: input.projectIdentity,
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
    mcpServersUsed: derivedMcpServers.size > 0 ? [...derivedMcpServers].sort() : undefined,
    usageSummary: summarizeUsage(usageEvents, parsed.skillsUsed, derivedMcpServers),
    usageEvents: retainedUsageEvents(usageEvents),
    usageIndexed: true,
    dataSource: parsed.dataSource,
    dataQualityNotes: costDataQualityNotes(
      parsed.dataSourceInfo?.notes,
      parsed.tokenUsage,
      costEstimate,
    ),
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
  if (parsed.reportedCostUsd !== undefined) return parsed.reportedCostUsd;
  if (parsed.tokenUsageByModel) return estimateCostIfKnown(parsed.tokenUsageByModel);
  if (parsed.tokenUsage && parsed.model)
    return estimateCostSimpleIfKnown(parsed.tokenUsage, parsed.model);
  return undefined;
}

/** Rich parser fallbacks must be retried instead of being persisted as complete scans. */
export function isPartialScanResult(result: Pick<SessionScanResult, "dataQualityNotes">): boolean {
  return (
    result.dataQualityNotes?.some((note) =>
      /^Partial [a-z0-9_-]+(?: [a-z0-9_-]+)* scan:/i.test(note),
    ) ?? false
  );
}

const UNKNOWN_COST_NOTE =
  "Cost estimate is unavailable because model pricing or attribution is unknown.";

/** Preserve provider notes while explaining why token usage has no cost value. */
function costDataQualityNotes(
  notes: string[] | undefined,
  tokenUsage: TokenUsage | undefined,
  costEstimate: number | undefined,
): string[] | undefined {
  const result = [...(notes || [])];
  if (tokenUsage && costEstimate === undefined && !result.includes(UNKNOWN_COST_NOTE)) {
    result.push(UNKNOWN_COST_NOTE);
  }
  return result.length > 0 ? result : undefined;
}

// ─── Cache management ───────────────────────────────────────────────

const SCAN_CACHE_KEY = "session-scans-v1";
const SCAN_CONCURRENCY = 4;

async function readScanCache(): Promise<ScanCacheData | null> {
  const cached = await readFileCache<ScanCacheData>(SCAN_CACHE_KEY);
  if (!cached) return null;
  if (!COMPATIBLE_SCANNER_VERSIONS.has(cached.data.scannerVersion)) return null;
  return { ...cached.data, scannerVersion: SCANNER_VERSION };
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
): Promise<{ valid: boolean; meta: { mtimeMs: number; fileSize: number } }> {
  const meta = await getScanCacheMeta(session);
  const valid = !!entry && entry.mtimeMs === meta.mtimeMs && entry.fileSize === meta.fileSize;
  return { valid, meta };
}

// ─── Background scanner ────────────────────────────────────────────

export interface BackgroundScanState {
  running: boolean;
  scanned: number;
  total: number;
  results: SessionScanResult[];
  /** Increments whenever the result snapshot changes, including usage backfill. */
  revision: number;
  /** True when results represent a completed or persisted scan, even if empty. */
  hasSnapshot: boolean;
  currentSession?: string;
  phase?: "discovering" | "scanning";
  startedAt?: string;
  finishedAt?: string;
  failedProviders?: string[];
  /** Progress of the follow-up pass that indexes usage for deferred sessions. */
  usageBackfill?: { running: boolean; scanned: number; total: number };
}

export interface BackgroundScanOptions {
  /**
   * Treat an otherwise valid cache entry as stale. Used by the usage backfill
   * pass, whose inputs are unchanged on disk but were scanned in a cheaper mode.
   */
  rescanCached?: (cached: SessionScanResult) => boolean;
  /** Stop picking up new sessions, e.g. because a newer scan superseded this one. */
  shouldStop?: () => boolean;
}

/**
 * Run background scan on a list of sessions. Scans newest first.
 * Uses cache to skip unchanged sessions. Reports progress via callback.
 */
export async function runBackgroundScan(
  sessions: ScanInput[],
  onProgress?: (progress: ScanProgress) => void,
  options: BackgroundScanOptions = {},
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
    const cacheKey = scanCacheEntryKey(session);
    const cached = cache.entries[cacheKey];
    const cacheCheck = await checkCache(cached, session);

    const reusable =
      cacheCheck.valid && cached && !options.rescanCached?.(cached.result) ? cached : undefined;

    if (reusable) {
      results[index] = reusable.result;
    } else {
      try {
        const result = await scanSession(session);
        results[index] = result;

        const partial = isPartialScanResult(result);
        if (partial) {
          delete cache.entries[cacheKey];
        } else {
          cache.entries[cacheKey] = {
            mtimeMs: cacheCheck.meta.mtimeMs,
            fileSize: cacheCheck.meta.fileSize,
            scannedAt: new Date().toISOString(),
            result,
          };
        }
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
      if (options.shouldStop?.()) return;
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
    scanned: completed,
    total: sessions.length,
    done: true,
  });

  return results.filter((result): result is SessionScanResult => Boolean(result));
}

// ─── Aggregation ────────────────────────────────────────────────────

export type ProjectInsightLocation = SessionLocation | "local";

function sessionLocationKey(location?: SessionLocation): string {
  return location?.kind === "ssh" ? `ssh:${location.id}` : "local";
}

/** Keep project insight aggregates separate for local and remote locations. */
export function projectInsightKey(
  project: string,
  identity?: ProjectIdentity,
  location?: SessionLocation | "local",
): string {
  const projectKey = projectIdentityKey(project, identity);
  const locationKey =
    location === undefined
      ? undefined
      : location === "local"
        ? "local"
        : sessionLocationKey(location);
  return locationKey === undefined ? projectKey : `${locationKey}\0${projectKey}`;
}

function identityForScan(
  scan: Pick<SessionScanResult, "project" | "projectIdentity" | "provider">,
) {
  return (
    scan.projectIdentity ||
    classifyProject(scan.project, {
      provider: scan.provider,
    })
  );
}

function projectMatches(
  scan: Pick<SessionScanResult, "project" | "projectIdentity" | "provider" | "location">,
  requestedProject: string,
  location?: ProjectInsightLocation,
): boolean {
  if (location !== undefined) {
    const scanLocation = sessionLocationKey(scan.location);
    const requestedLocation = location === "local" ? "local" : sessionLocationKey(location);
    if (scanLocation !== requestedLocation) return false;
  }
  return (
    scan.project === requestedProject ||
    projectIdentityKey(scan.project, identityForScan(scan)) === requestedProject
  );
}

export function aggregateProjectInsights(
  project: string,
  scans: SessionScanResult[],
  memory?: ProjectMemory,
  location?: ProjectInsightLocation,
): ProjectInsights {
  const projectScans = scans.filter((s) => projectMatches(s, project, location));
  const projectIdentity =
    projectScans
      .map((scan) => identityForScan(scan))
      .find((identity) => identity.key === project) ||
    (projectScans.length > 0 ? identityForScan(projectScans[0]) : undefined);

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
  const branchMap = new Map<
    string,
    { sessionIds: string[]; sessionKeys: Set<string>; prLinks: PrLink[] }
  >();
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
      if (!branchMap.has(b)) {
        branchMap.set(b, { sessionIds: [], sessionKeys: new Set(), prLinks: [] });
      }
      const entry = branchMap.get(b)!;
      const sessionKey = scanCacheEntryKey(s);
      if (!entry.sessionKeys.has(sessionKey)) {
        entry.sessionKeys.add(sessionKey);
        entry.sessionIds.push(s.sessionId);
      }
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
      entry.sessions.add(scanCacheEntryKey(s));
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
    projectIdentity,
    ...(location && location !== "local" ? { location } : {}),
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
      project: string;
      projectIdentity?: ProjectIdentity;
      location?: SessionLocation;
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

    const identity = identityForScan(s);
    const locationKey = sessionLocationKey(s.location);
    const projectKey = `${locationKey}\0${s.project}`;
    // Keep one entry per raw workspace so the Projects page can optionally
    // reveal individual automated runs. Canonical project counts and the
    // default display rollup are derived from projectIdentity below.
    if (!projectStats.has(projectKey)) {
      projectStats.set(projectKey, {
        project: s.project,
        projectIdentity: identity,
        location: s.location,
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
    const ps = projectStats.get(projectKey)!;
    ps.projectIdentity = mergeProjectIdentities(ps.projectIdentity, identity);
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
    } else if (identity.prNumber !== undefined) {
      ps.prUrls.add(`${identity.key}#${identity.prNumber}`);
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
    .map(([, data]) => ({
      project: data.project,
      projectIdentity: data.projectIdentity,
      location: data.location,
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

  const uniqueProjects = new Set(
    scans.map((s) => projectInsightKey(s.project, identityForScan(s), s.location)),
  );
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
      .filter((b: { type?: string }) => b.type === "text")
      .map((b: { text?: string }) => b.text || "")
      .join("\n");
  }
  return "";
}
