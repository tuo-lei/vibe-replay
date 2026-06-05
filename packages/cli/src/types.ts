// Shared types — single source of truth
// SubAgent is imported separately so it can be referenced locally in this file;
// a `export type { ... } from` re-export alone does not add names to local scope.
import type { SubAgent } from "@vibe-replay/types";

export type {
  Annotation,
  DataSource,
  DataSourceInfo,
  InsightsStore,
  OverlaySource,
  ParseWarning,
  PrLink,
  ReplaySession,
  Scene,
  SceneOverlay,
  SessionInsight,
  SessionOverlays,
  SubAgent,
  TokenUsage,
  TurnStat,
} from "@vibe-replay/types";

export { INSIGHTS_SCHEMA_VERSION } from "@vibe-replay/types";

// CLI-only types below

export interface SessionInfo {
  provider: string;
  sessionId: string;
  slug: string;
  title?: string;
  project: string; // decoded project path (e.g. "~/Code/my-project")
  cwd: string;
  version: string;
  gitBranch?: string;
  timestamp: string; // ISO string of last activity (most recent record / lastActivityAt / file mtime depending on provider)
  lineCount: number;
  fileSize: number;
  filePath: string; // primary file (most recent)
  filePaths: string[]; // all JSONL files for this session (sorted by timestamp asc)
  toolPaths?: string[]; // cursor tool outputs associated with this session
  workspacePath?: string; // absolute workspace path for Cursor lookup
  hasSqlite?: boolean; // true if any Cursor SQLite source exists (store.db or global state DB)
  hasSdk?: boolean; // true if a Cursor SDK agent record exists in sdk-agent-store/index.db
  firstPrompt: string;
  prompts?: string[]; // first N meaningful user prompts (cleaned)
  promptCount?: number; // total user prompts (counted via lightweight scan)
  toolCallCount?: number; // total tool_use blocks (counted via lightweight scan)
  // Lightweight estimates extracted via regex during discovery (no JSON.parse per line)
  model?: string; // primary model (e.g. "claude-sonnet-4-20250514")
  durationMsEst?: number; // sum of turn_duration durationMs values
  editCountEst?: number; // count of file-editing tool_use blocks (Edit/Write/MultiEdit etc.)
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
  /** Source classification for user messages (for example, tool-originated messages). */
  origin?: string;
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
      _images?: string[];
      _isError?: boolean;
      _subAgent?: SubAgent;
      _durationMs?: number;
      _isPendingMarker?: boolean;
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
