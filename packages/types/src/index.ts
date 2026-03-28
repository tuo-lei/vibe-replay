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

export type Scene =
  | { type: "user-prompt"; content: string; timestamp?: string; images?: string[] }
  | { type: "compaction-summary"; content: string; timestamp?: string }
  | { type: "thinking"; content: string; timestamp?: string }
  | { type: "text-response"; content: string; timestamp?: string }
  | {
      type: "tool-call";
      toolName: string;
      input: Record<string, any>;
      result: string;
      timestamp?: string;
      isError?: boolean;
      diff?: { filePath: string; oldContent: string; newContent: string };
      bashOutput?: { command: string; stdout: string };
      images?: string[];
      subAgent?: SubAgent;
      /** Tool execution duration in ms (assistant timestamp → tool_result timestamp) */
      durationMs?: number;
    };

export interface Annotation {
  id: string;
  sceneIndex: number;
  selectedText?: string;
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

export interface ReplaySession {
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
    /** All branches seen during session, in order of appearance (if switched) */
    gitBranches?: string[];
    /** How the session was started: "cli" | "sdk-ts" */
    entrypoint?: string;
    /** Permission mode: "default" | "bypassPermissions" */
    permissionMode?: string;
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
  };
  scenes: Scene[];
  annotations?: Annotation[];
}
