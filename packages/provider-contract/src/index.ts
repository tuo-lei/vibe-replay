import type {
  CursorSidecars,
  DataSource,
  DataSourceInfo,
  MetricCoverage,
  MetricQuality,
  ParseWarning,
  ProjectIdentity,
  PrLink,
  ProviderCoverage,
  SessionLocation,
  SessionTranscriptStatus,
  SubAgent,
  TokenUsage,
  TokenUsageMetrics,
  TurnStat,
  UsageCoverageReport,
} from "@vibe-replay/types";

export type { DataSource, DataSourceInfo, SessionLocation, TokenUsage };
export type { SessionTranscriptStatus };
export type {
  MetricCoverage,
  MetricQuality,
  ProviderCoverage,
  TokenUsageMetrics,
  UsageCoverageReport,
};

/** Stable provider API version for the current in-repo provider contract. */
export const PROVIDER_API_VERSION = 1;

/** Normalize provider-specific subagent labels to the canonical replay vocabulary. */
export function normalizeSubAgentType(agentType: string): string {
  const normalized = agentType.trim().toLowerCase();
  if (normalized === "explore") return "Explore";
  if (normalized === "plan") return "Plan";
  if (normalized === "generalpurpose") return "general-purpose";
  if (normalized === "shell") return "Shell";
  return agentType;
}

/**
 * Fast session summary returned by provider discovery.
 *
 * This is intentionally lighter than a full parsed session: dashboards and
 * pickers can render from it without paying the cost of parsing every source.
 * Existing fields are preserved exactly to keep CLI/runtime behavior unchanged
 * while provider code moves behind a package boundary.
 */
export interface SessionInfo {
  provider: string;
  sessionId: string;
  slug: string;
  title?: string;
  project: string; // decoded project path (e.g. "~/Code/my-project")
  location?: SessionLocation;
  /** Why a source lacks a normal replay prompt, when discovery can explain it. */
  transcriptStatus?: SessionTranscriptStatus;
  cwd: string;
  version: string;
  gitBranch?: string;
  gitRepo?: string; // normalized remote origin (e.g. "tuo-lei/vibe-replay")
  timestamp: string; // ISO string of last activity (most recent record / lastActivityAt / file mtime depending on provider)
  lineCount: number;
  fileSize: number;
  filePath: string; // primary file (most recent)
  filePaths: string[]; // all JSONL files for this session (sorted by timestamp asc)
  toolPaths?: string[]; // cursor tool outputs associated with this session
  /** Provider-side storage fingerprint used to invalidate rich scan caches. */
  sourceFingerprint?: string;
  workspacePath?: string; // absolute workspace path for Cursor lookup
  hasSqlite?: boolean; // true if any Cursor SQLite source exists (store.db or global state DB)
  hasSdk?: boolean; // true if a Cursor SDK agent record exists in sdk-agent-store/index.db
  /** Canonical project/workspace identity for dashboard aggregation. */
  projectIdentity?: ProjectIdentity;
  firstPrompt: string;
  prompts?: string[]; // first N meaningful user prompts (cleaned)
  promptCount?: number; // total user prompts (counted via lightweight scan)
  toolCallCount?: number; // total tool_use blocks (counted via lightweight scan)
  // Lightweight estimates extracted via regex during discovery (no JSON.parse per line)
  model?: string; // primary model (e.g. "claude-sonnet-4-20250514")
  durationMsEst?: number; // sum of turn_duration durationMs values
  editCountEst?: number; // count of file-editing tool_use blocks (Edit/Write/MultiEdit etc.)
  compactionCount?: number; // context compactions counted during lightweight discovery
  hasPR?: boolean; // whether a pr-link event exists in the session
  isStarred?: boolean; // provider-level favorite/star marker
  spaceId?: string; // provider workspace/space identifier
  spaceIdSetBy?: string; // source of provider workspace/space assignment
  pluginsEnabled?: boolean; // provider session had plugins enabled
  skillsEnabled?: boolean; // provider session had skills enabled
  fsDetectedFiles?: string[]; // files detected by the provider during the session
}

export interface ParsedTurn {
  role: "user" | "assistant";
  subtype?: string;
  messageId?: string;
  model?: string;
  timestamp?: string;
  blocks: ContentBlock[];
  /** Present when the assistant response was truncated (stop_reason: "max_tokens") */
  stopReason?: "max_tokens";
}

export interface RawMessage {
  parentUuid: string | null;
  uuid?: string;
  /** True for system-injected messages (skill injection, context injection, etc.) */
  isMeta?: boolean;
  /** True for compaction summary messages */
  isCompactSummary?: boolean;
  userType: string;
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch?: string;
  slug?: string;
  /** UUID of the assistant message that triggered the tool whose result this message carries */
  sourceToolAssistantUUID?: string;
  /** Newer Claude Code field for tool-originated user messages. */
  sourceToolUseID?: string;
  /** Legacy snake_case spelling of the parent tool for tool-originated messages. */
  parent_tool_use_id?: string;
  /** Source classification for user messages (for example, tool-originated messages). */
  origin?: string;
  /**
   * Origin of a user prompt. `"sdk"` marks prompts driven by the Claude Agent
   * SDK (programmatic / routine-driven runs) rather than direct keyboard input.
   * Absent on normal interactive sessions. These are still genuine prompts that
   * drove the turn, so they render as ordinary user turns.
   *
   * Typed as `"sdk" | (string & {})` so the one known value is discoverable via
   * IDE autocomplete while still accepting any future source string.
   */
  promptSource?: "sdk" | (string & {});
  type:
    | "user"
    | "assistant"
    | "system"
    | "progress"
    | "file-history-snapshot"
    | "custom-title"
    | "queue-operation"
    | "last-prompt"
    | "pr-link"
    | "agent-name"
    | "agent-color"
    | "agent-setting"
    | "summary"
    | "ai-title"
    | "tag"
    | "mode"
    | "permission-mode"
    | "worktree-state"
    | "speculation-accept"
    | "attribution-snapshot"
    | "content-replacement"
    | "attachment";
  subtype?: string;
  timestamp?: string;
  /** Optional provider URL attached to newer Claude Code system messages. */
  url?: string;
  /** True when Claude Code writes a synthetic assistant message describing an API failure. */
  isApiErrorMessage?: boolean;
  /** Newer Claude Code API error status field on assistant entries. */
  apiErrorStatus?: number | string;
  /** Claude Code attribution for assistant output/tool calls that came from MCP or skills. */
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  attributionSkill?: string;
  message?: {
    role: "user" | "assistant";
    id?: string;
    model?: string;
    content: string | ContentBlock[];
    stop_reason?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      service_tier?: string;
    };
  };
  data?: any;
  title?: string;
  durationMs?: number;
  entrypoint?: string;
  permissionMode?: string;
  customTitle?: string;
  aiTitle?: string;
  agentName?: string;
  /** worktree-state entries: null means user exited the worktree */
  worktreeSession?: {
    worktreeName?: string;
    worktreePath?: string;
    worktreeBranch?: string;
  } | null;
  /** queue-operation entry payload */
  operation?: string;
  content?: string;
  snapshot?: {
    timestamp?: string;
    trackedFileBackups?: Record<string, unknown>;
  };
  parentToolUseID?: string;
  compactMetadata?: {
    trigger?: string;
    preTokens?: number;
  };
  // Anthropic API error envelope: outer = HTTP envelope, inner = error object,
  // innermost = error detail. The triple nesting mirrors the on-wire shape.
  error?: {
    status?: number;
    error?: { error?: { type?: string }; type?: string };
    message?: string;
  };
  statusCode?: number;
  retryAttempt?: number;
  /** Hook summary fields on newer system messages. Parsed leniently as metadata-only. */
  hookCount?: number;
  hookErrors?: unknown[];
  hookInfos?: unknown[];
  hasOutput?: boolean;
  preventedContinuation?: boolean;
  /** Top-level hook stop reason; distinct from message.stop_reason on assistant messages. */
  stopReason?: string;
  toolUseID?: string;
}

export type ContentBlock =
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, any>;
      _result?: string;
      /**
       * Whether the provider recorded a result for this call. This is separate
       * from `_result` because an empty string can be a valid completed result.
       */
      _hasResult?: boolean;
      /** Internal source timestamp for the tool result; omitted from replay scenes. */
      _resultTimestamp?: string;
      _images?: string[];
      _isError?: boolean;
      _subAgent?: SubAgent;
      _durationMs?: number;
      _isPendingMarker?: boolean;
      /** Provider attribution retained for usage indexing; omitted from replay output. */
      _mcpServer?: string;
      _mcpTool?: string;
      /** Canonical skill name for provider-native skill invocation records. */
      _skillName?: string;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ToolResultContent[];
      is_error?: boolean;
    }
  | { type: "image"; source: { type: string; media_type: string; data: string } }
  | { type: "_user_images"; images: string[] };

export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "tool_result"; tool_use_id: string; content: string }
  | { type: "image"; source: { type: string; media_type: string; data: string } };

export interface Provider {
  name: string;
  displayName: string;
  discover(): Promise<SessionInfo[]>;
  parse(filePaths: string | string[], sessionInfo?: SessionInfo): Promise<ProviderParseResult>;
}

export interface Compaction {
  timestamp: string;
  trigger: string;
  preTokens?: number;
  accuracy?: "exact" | "estimated" | "lower-bound";
}

export interface ProviderParseResult {
  sessionId: string;
  slug: string;
  title?: string;
  cwd: string;
  model?: string;
  startTime?: string;
  endTime?: string;
  totalDurationMs?: number;
  turns: ParsedTurn[];
  dataSource?: DataSource;
  dataSourceInfo?: DataSourceInfo;
  tokenUsage?: TokenUsage;
  /** Per-model token usage breakdown for accurate cost estimation */
  tokenUsageByModel?: Record<string, TokenUsage>;
  /**
   * Cost in USD reported by the provider itself. Preferred over local pricing
   * estimates, which cannot price model generations they do not know about.
   */
  reportedCostUsd?: number;
  compactions?: Compaction[];
  /** Per-turn metrics (indexed by user-prompt turn, 0-based) */
  turnStats?: TurnStat[];
  /** Provider-reported context window limit for the primary model, if available */
  contextLimit?: number;
  /** PR links associated with the session */
  prLinks?: PrLink[];
  /** Summary of subagents used in this session */
  subAgentSummary?: Array<{
    agentId: string;
    agentType: string;
    description?: string;
    toolCalls: number;
    model?: string;
  }>;
  gitBranch?: string;
  /** Normalized git remote origin (for example, "owner/repo") */
  gitRepo?: string;
  /** All branches seen during session in order (if >1) */
  gitBranches?: string[];
  entrypoint?: string;
  permissionMode?: string;
  /** Codex session memory setting from session_meta.memory_mode */
  memoryMode?: string;
  apiErrors?: Array<{
    timestamp: string;
    statusCode?: number;
    errorType?: string;
    retryAttempt?: number;
  }>;
  trackedFiles?: string[];
  contextFiles?: string[];
  cursorSidecars?: CursorSidecars;
  /** Parser data-loss warnings collected while reading provider source data */
  parseWarnings?: ParseWarning[];
  /** API service tier (e.g. "standard") from usage data */
  serviceTier?: string;
  /** Skills / slash commands used in the session (e.g. ["playwright-cli", "/insights"]) */
  skillsUsed?: string[];
  /**
   * One entry per skill activation, preserving repeated activations. `skillsUsed`
   * remains the distinct display/filter vocabulary.
   */
  skillActivations?: string[];
  /** MCP servers used in the session (e.g. ["claude-in-chrome", "playwright"]) */
  mcpServersUsed?: string[];
  /**
   * Display names for MCP server identifiers, when the provider records servers
   * by opaque ID. Cowork names tool calls `mcp__<uuid>__<tool>`, so without this
   * map every MCP facet would read as a UUID.
   */
  mcpServerNames?: Record<string, string>;
  /** Count of assistant responses truncated by max_tokens */
  truncatedResponses?: number;
  /** Agent's custom name (from `/rename` or swarm) */
  agentName?: string;
  /** Worktree state at session end (Claude Code EnterWorktree / --worktree) */
  worktree?: {
    name?: string;
    path?: string;
    branch?: string;
  };
  /** Queue-operation event counts — proxy for "user changed their mind" frequency */
  queueOperationStats?: {
    enqueued: number;
    cancelled: number;
  };
}
