import type { ProjectIdentity } from "./project-identity.js";

export type DataSource = "jsonl" | "sqlite" | "jsonl+tools" | "global-state";

export interface TokenUsage {
  /**
   * Uncached input tokens after provider-specific normalization.
   * The full prompt footprint is input + cacheRead + cacheCreation.
   */
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface TokenUsageMetrics {
  /** Full prompt footprint sent to the model. */
  promptTokens: number;
  /**
   * Prompt tokens not served by a cache read. This is derived as uncached input
   * plus cache writes; providers do not expose a universal "miss" counter.
   */
  cacheMissTokens: number;
  /** Fraction of prompt tokens served by a cache read, when promptTokens > 0. */
  cacheReadShare?: number;
}

export function deriveTokenUsageMetrics(usage: TokenUsage): TokenUsageMetrics {
  const promptTokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
  return {
    promptTokens,
    cacheMissTokens: usage.inputTokens + usage.cacheCreationTokens,
    ...(promptTokens > 0 ? { cacheReadShare: usage.cacheReadTokens / promptTokens } : {}),
  };
}

export interface TurnStat {
  turnIndex: number;
  /**
   * Optional assistant-segment index within the session. Providers that split
   * one user prompt at a compaction or context-injection boundary can use this
   * to keep each rendered assistant card's metrics separate.
   */
  segmentIndex?: number;
  model?: string;
  durationMs?: number;
  tokenUsage?: TokenUsage;
  /**
   * Provider-reported prompt footprint (input + cacheRead + cacheCreation).
   * This is not guaranteed to equal the model's actual context-window size.
   */
  contextTokens?: number;
}

/**
 * A privacy-preserving event used to explain provider/session failures.
 *
 * `compaction` events describe both completed and explicitly failed
 * compaction requests. `assistant-api-error` is intentionally separate: an
 * ordinary model/API failure must never be presented as a compaction failure
 * just because it happened near a compaction boundary.
 */
export type SessionDiagnosticKind = "compaction" | "assistant-api-error";
export type SessionDiagnosticOutcome = "succeeded" | "failed";
export type SessionDiagnosticTrigger = "manual" | "automatic-context" | "unknown";
export type SessionDiagnosticConfidence = "exact" | "inferred" | "unknown";

export interface SessionDiagnostic {
  kind: SessionDiagnosticKind;
  outcome: SessionDiagnosticOutcome;
  timestamp: string;
  confidence: SessionDiagnosticConfidence;
  /** Trigger is present for compaction events; it is absent for API errors. */
  trigger?: SessionDiagnosticTrigger;
  entryId?: string;
  model?: string;
  provider?: string;
  preTokens?: number;
  contextLimit?: number;
  statusCode?: number;
  /** Normalized error category; raw provider error text stays in the replay scene. */
  errorType?: string;
  retryAttempt?: number;
  /** Short, non-content evidence supporting an inferred classification. */
  evidence?: string[];
}

export interface PrLink {
  prNumber: number;
  prUrl: string;
  prRepository: string;
}

export {
  agentRunWorkspaceParent,
  agentWorktreeParent,
  classifyProject,
  cursorSdkWorkflowLabel,
  isAutomatedProject,
  isCursorSdkAutomationPath,
  mergeProjectIdentities,
  projectIdentityKey,
} from "./project-identity.js";
export type {
  ProjectIdentity,
  ProjectIdentityHints,
  ProjectIdentityKind,
} from "./project-identity.js";

export interface CursorSidecars {
  /** Number of non-empty messageRequestContext sidecars observed for the session */
  requestContextCount?: number;
  /** Number of checkpointId state entries observed for the session */
  checkpointCount?: number;
  /** Whether Cursor request context included workspace rules */
  hasWorkspaceRules?: boolean;
  /** Cursor composerData conversationCheckpointLastUpdatedAt timestamp, if reported */
  conversationCheckpointLastUpdatedAt?: string;
  /** Cursor composerData flag limiting agent mode switches */
  restrictAgentModeSwitching?: boolean;
  /** Cursor Background Agent / Glass parent-agent reference, if reported */
  glassMetaParentAgent?: string;
}

export type ParseWarningKind =
  | "malformed-json"
  | "missing-image"
  // Reserved for provider source-read failures, such as unreadable or corrupt sidecars.
  | "unreadable-source";

export interface ParseWarning {
  kind: ParseWarningKind;
  count: number;
  message: string;
  source?: string;
  firstLine?: number;
  sample?: string;
}

export interface SubAgent {
  agentId: string;
  /** Cursor global-state composer that owns this delegated agent. */
  parentComposerId?: string;
  /** Exact parent Agent tool call that launched this delegated agent. */
  toolCallId?: string;
  agentType: string;
  description?: string;
  prompt: string;
  toolCalls: number;
  thinkingBlocks: number;
  textResponses: number;
  tokenUsage?: TokenUsage;
  model?: string;
  scenes: Scene[];
  /**
   * Complete invocation index for scanner aggregation. This is intentionally
   * omitted by replay transformation so large child traces can stay bounded.
   */
  usageEvents?: UsageEvent[];
}

export interface FileDiff {
  filePath: string;
  oldContent: string;
  newContent: string;
}

export type Scene =
  | { type: "user-prompt"; content: string; timestamp?: string; images?: string[] }
  | { type: "compaction-summary"; content: string; timestamp?: string }
  | {
      type: "context-injection";
      content: string;
      timestamp?: string;
      /** What kind of injection: "skill", "local-command", "slash-command", "image", or "other" */
      injectionType?: string;
    }
  | {
      type: "thinking";
      content: string;
      timestamp?: string;
      /** Estimated tokens consumed by this thinking block (chars/4 heuristic) */
      tokens?: number;
    }
  | { type: "text-response"; content: string; timestamp?: string; isTruncated?: boolean }
  | {
      type: "tool-call";
      toolName: string;
      input: Record<string, any>;
      result: string;
      /**
       * Whether the provider recorded a result for this call. This is separate
       * from `result` because an empty string can be a valid completed result.
       */
      hasResult?: boolean;
      timestamp?: string;
      isError?: boolean;
      /** Primary/first diff, retained for backward compatibility. */
      diff?: FileDiff;
      /** All file diffs when one tool call changes multiple files. */
      diffs?: FileDiff[];
      bashOutput?: { command: string; stdout: string };
      images?: string[];
      subAgent?: SubAgent;
      /** Tool execution duration in ms (assistant timestamp → tool_result timestamp) */
      durationMs?: number;
      /** Whether durationMs is anchored at the tool start or result timestamp. */
      durationAnchor?: "start" | "end";
      /**
       * Estimated tokens of the tool result that was injected back into the
       * model's context (chars/4 heuristic on the un-truncated result).
       * Useful for "what is eating my context window?" diagnostics.
       */
      resultTokens?: number;
    };

export interface Annotation {
  id: string;
  sceneIndex: number;
  selectedText?: string;
  selectedTextStart?: number;
  selectedTextEnd?: number;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
}

export interface DataSourceInfo {
  primary: DataSource;
  sources: string[];
  supplements?: string[];
  notes?: string[];
}

/** Where a source session was discovered. */
export interface SessionLocation {
  kind: "local" | "ssh";
  /** Stable user-configured id for the source location. */
  id: string;
  /** Safe display label; never needs to contain a hostname. */
  label: string;
}

/** Stable opaque suffix for filesystem keys scoped to one remote location. */
export function sessionLocationHash(targetId: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const character of targetId) {
    const codePoint = character.codePointAt(0) || 0;
    first = Math.imul(first ^ codePoint, 0x01000193);
    second = Math.imul(second ^ codePoint, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

/** Explains why a discovered source may not have a normal user prompt. */
export type SessionTranscriptStatus = "no-prompts" | "unreadable";

// ---------------------------------------------------------------------------
// Scene Overlay System — non-destructive modifications for AI Studio
// ---------------------------------------------------------------------------

export type OverlaySource =
  | { type: "translate"; params: { from: string; to: string } }
  | { type: "tone"; params: { style: "professional" | "neutral" | "friendly" } }
  | { type: "manual" };

export interface SceneOverlay {
  id: string;
  sceneIndex: number;
  /** Which field was modified */
  field: "content";
  /** Snapshot of the original value (from replay.json) for diffing and reverting */
  originalValue: string;
  /** The current modified value to display/export */
  modifiedValue: string;
  /** What created or last modified this overlay */
  source: OverlaySource;
  createdAt: string;
  updatedAt: string;
}

export interface SessionOverlays {
  version: 1;
  overlays: SceneOverlay[];
}

// ---------------------------------------------------------------------------
// Session Insights — durable local cache that survives source file deletion
// ---------------------------------------------------------------------------

/** Schema version for the insights store. Bump when adding breaking changes. */
export const INSIGHTS_SCHEMA_VERSION = 2;

/** Current replay JSON schema. Missing means a legacy v0 replay. */
export const REPLAY_SCHEMA_VERSION = 1;

export type UsageEventStatus = "success" | "error" | "unknown";

/**
 * Privacy-bounded record of one tool invocation or skill activation.
 * Inputs and results intentionally stay in the source replay rather than this index.
 */
export interface UsageEvent {
  kind: "tool" | "skill";
  name: string;
  turnIndex?: number;
  timestamp?: string;
  durationMs?: number;
  status: UsageEventStatus;
  mcpServer?: string;
  mcpTool?: string;
  skillName?: string;
  parentAgentId?: string;
  attribution: "explicit" | "parsed-name" | "session-metadata";
}

/** Per-session facet counts derived from usage events. */
export interface SessionUsageSummary {
  tools: Record<string, number>;
  mcpServers: Record<string, number>;
  /** Keys use the stable `server/tool` form. */
  mcpTools: Record<string, number>;
  skills: Record<string, number>;
  successCount: number;
  errorCount: number;
  totalDurationMs: number;
  durationCount: number;
}

export type MetricQuality = "exact" | "estimated" | "partial" | "unavailable";

export interface MetricCoverage {
  /** Sessions for which this metric was observed or conclusively indexed. */
  availableSessions: number;
  totalSessions: number;
  quality: MetricQuality;
}

/** Provider-level observability audit data; contains no prompt or tool payloads. */
export interface ProviderCoverage {
  provider: string;
  totalSessions: number;
  indexedSessions: number;
  invocationSessions: number;
  invocationCalls: number;
  missingInvocationSessions: number;
  mcpSessions: number;
  mcpCalls: number;
  mcpToolSessions: number;
  mcpToolCalls: number;
  tokenSessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  promptTokens: number;
  cacheMissTokens: number;
  compactionSessions: number;
  compactionCount: number;
  notes?: string[];
  metrics: {
    invocations: MetricCoverage;
    mcpTools: MetricCoverage;
    tokens: MetricCoverage;
    cache: MetricCoverage;
    compactions: MetricCoverage;
  };
}

export interface UsageCoverageReport {
  totalSessions: number;
  indexedSessions: number;
  invocationSessions: number;
  invocationCalls: number;
  missingInvocationSessions: number;
  mcpCalls: number;
  mcpToolSessions: number;
  mcpToolCalls: number;
  tokenSessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  promptTokens: number;
  cacheMissTokens: number;
  compactionSessions: number;
  compactionCount: number;
  providers: ProviderCoverage[];
}

/**
 * A single session's insights — lightweight metadata persisted locally so it
 * survives after source JSONL files are deleted (e.g. Claude Code 30-day cleanup).
 * Maps closely to SessionScanResult but is schema-versioned independently.
 */
export interface SessionInsight {
  // Identity
  sessionId: string;
  slug: string;
  provider: string;
  location?: SessionLocation;
  transcriptStatus?: SessionTranscriptStatus;

  // Metadata
  title?: string;
  project: string;
  projectIdentity?: ProjectIdentity;
  model?: string;
  gitBranch?: string;
  gitBranches?: string[];

  // Time
  startTime?: string;
  endTime?: string;
  durationMs?: number;

  // Stats
  promptCount: number;
  toolCallCount: number;
  editCount: number;
  filesModified?: Array<{ file: string; count: number }>;

  // Cost
  tokenUsage?: TokenUsage;
  costEstimate?: number;

  // Derived signals
  hasPR: boolean;
  prLinks?: PrLink[];
  skillsUsed?: string[];
  mcpServersUsed?: string[];
  usageSummary?: SessionUsageSummary;
  usageEvents?: UsageEvent[];
  subAgentCount: number;
  apiErrorCount: number;
  compactionCount: number;
  diagnostics?: SessionDiagnostic[];
  diagnosticNotes?: string[];

  // Session context
  entrypoint?: string;
  permissionMode?: string;

  // Display
  firstPrompt?: string;

  // Provenance
  capturedAt: string;
  capturedByVersion: string;
  updatedAt?: string;
  dataSource?: DataSource;

  // Machine identity (for multi-machine aggregation)
  machineId?: string;
  machineName?: string;
}

/** The on-disk structure for ~/.vibe-replay/insights/store.json */
export interface InsightsStore {
  schemaVersion: number;
  lastUpdated: string;
  sessions: SessionInsight[];
}

/**
 * Wire format for the per-session entries returned by `/api/scan/results`.
 * This is the canonical client-facing subset of `SessionScanResult`
 * (defined in `packages/cli/src/scanner.ts`). Keep in sync with that type
 * when adding fields the viewer needs.
 */
export interface SessionScanWireData {
  sessionId: string;
  provider: string;
  location?: SessionLocation;
  transcriptStatus?: SessionTranscriptStatus;
  project: string;
  projectIdentity?: ProjectIdentity;
  slug: string;
  title?: string;
  firstPrompt?: string;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  gitBranch?: string;
  gitBranches?: string[];
  model?: string;
  promptCount: number;
  toolCallCount: number;
  editCount: number;
  filesModified: Array<{ file: string; count: number }>;
  tokenUsage?: TokenUsage;
  costEstimate?: number;
  subAgentCount: number;
  apiErrorCount: number;
  entrypoint?: string;
  permissionMode?: string;
  prLinks?: PrLink[];
  skillsUsed?: string[];
  mcpServersUsed?: string[];
  usageSummary?: SessionUsageSummary;
  usageIndexed?: boolean;
  compactionCount: number;
  diagnostics?: SessionDiagnostic[];
  diagnosticNotes?: string[];
  dataSource?: DataSource;
  dataQualityNotes?: string[];
  turnStatCount?: number;
  turnDurations?: number[];
}

export interface ReplaySession {
  /** Optional for backward compatibility with replays generated before schema versioning. */
  schemaVersion?: number;
  meta: {
    sessionId: string;
    slug: string;
    title?: string;
    provider: string;
    location?: SessionLocation;
    transcriptStatus?: SessionTranscriptStatus;
    dataSource?: DataSource;
    dataSourceInfo?: DataSourceInfo;
    startTime: string;
    endTime?: string;
    model?: string;
    cwd: string;
    project: string;
    generator?: {
      name: string;
      version: string;
      generatedAt: string;
    };
    stats: {
      sceneCount: number;
      userPrompts: number;
      toolCalls: number;
      thinkingBlocks?: number;
      durationMs?: number;
      tokenUsage?: TokenUsage;
      tokenMetrics?: TokenUsageMetrics;
      costEstimate?: number;
      turnStats?: TurnStat[];
    };
    /** Max context window tokens for the primary model (e.g. 200000 for Claude) */
    contextLimit?: number;
    /** Provider/session diagnostic events, kept separate from ordinary API errors. */
    diagnostics?: SessionDiagnostic[];
    /** Limitations or quality notes for interpreting diagnostic events. */
    diagnosticNotes?: string[];
    tokenUsageByModel?: Record<string, TokenUsage>;
    prLinks?: PrLink[];
    compactions?: Array<{
      timestamp: string;
      trigger: string;
      preTokens?: number;
      /** Cursor only exposes the latest persisted summary, so this can be a lower bound. */
      accuracy?: "exact" | "estimated" | "lower-bound";
    }>;
    subAgentSummary?: Array<{
      agentId: string;
      agentType: string;
      description?: string;
      toolCalls: number;
      model?: string;
    }>;
    /** Git branch (last seen — usually the feature branch) */
    gitBranch?: string;
    /** Normalized git remote origin (for example, "owner/repo") */
    gitRepo?: string;
    /** All branches seen during session, in order of appearance (if switched) */
    gitBranches?: string[];
    /** How the session was started: "cli" | "sdk-ts" */
    entrypoint?: string;
    /** Permission mode: "default" | "bypassPermissions" */
    permissionMode?: string;
    /** Codex memory mode, when reported by session_meta.memory_mode */
    memoryMode?: string;
    /** API errors encountered during the session */
    apiErrors?: Array<{
      timestamp: string;
      statusCode?: number;
      errorType?: string;
      retryAttempt?: number;
    }>;
    /** Files tracked/backed up during this session */
    trackedFiles?: string[];
    /** Files Cursor appears to have used as request context breadcrumbs */
    contextFiles?: string[];
    /** Cursor-only sidecar coverage from global-state session metadata */
    cursorSidecars?: CursorSidecars;
    /** Parser data-loss warnings collected while reading provider source data */
    parseWarnings?: ParseWarning[];
    /** API service tier observed (e.g. "standard") */
    serviceTier?: string;
    /** Skills / slash commands used (e.g. ["playwright-cli", "/insights"]) */
    skillsUsed?: string[];
    /** MCP servers used (e.g. ["claude-in-chrome", "playwright"]) */
    mcpServersUsed?: string[];
    /** Number of assistant responses truncated by max_tokens */
    truncatedResponses?: number;
    /** Agent's custom name (from `/rename` or swarm) — Claude Code only */
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
  };
  scenes: Scene[];
  annotations?: Annotation[];
}
