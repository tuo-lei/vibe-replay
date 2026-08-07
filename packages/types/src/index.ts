export type DataSource = "jsonl" | "sqlite" | "jsonl+tools" | "global-state";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface TurnStat {
  turnIndex: number;
  model?: string;
  durationMs?: number;
  tokenUsage?: TokenUsage;
  /** Total prompt tokens (input + cacheRead + cacheCreation) — the context window usage for this turn */
  contextTokens?: number;
}

export interface PrLink {
  prNumber: number;
  prUrl: string;
  prRepository: string;
}

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
  agentType: string;
  description?: string;
  prompt: string;
  toolCalls: number;
  thinkingBlocks: number;
  textResponses: number;
  tokenUsage?: TokenUsage;
  model?: string;
  scenes: Scene[];
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

  // Metadata
  title?: string;
  project: string;
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
  subAgentCount: number;
  apiErrorCount: number;
  compactionCount: number;

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
  project: string;
  slug: string;
  title?: string;
  firstPrompt?: string;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  gitBranch?: string;
  model?: string;
  promptCount: number;
  toolCallCount: number;
  editCount: number;
  filesModified: Array<{ file: string; count: number }>;
  costEstimate?: number;
  subAgentCount: number;
  entrypoint?: string;
  prLinks?: PrLink[];
  dataSource?: DataSource;
  dataQualityNotes?: string[];
}

export interface ReplaySession {
  /** Optional for backward compatibility with replays generated before schema versioning. */
  schemaVersion?: number;
  meta: {
    sessionId: string;
    slug: string;
    title?: string;
    provider: string;
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
      costEstimate?: number;
      turnStats?: TurnStat[];
    };
    /** Max context window tokens for the primary model (e.g. 200000 for Claude) */
    contextLimit?: number;
    tokenUsageByModel?: Record<string, TokenUsage>;
    prLinks?: PrLink[];
    compactions?: Array<{
      timestamp: string;
      trigger: string;
      preTokens?: number;
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
