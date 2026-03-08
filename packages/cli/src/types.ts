// Shared types — single source of truth
export type {
  Annotation,
  DataSource,
  DataSourceInfo,
  ReplaySession,
  Scene,
} from "@vibe-replay/types";

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
  timestamp: string; // ISO string of session start/last update
  lineCount: number;
  fileSize: number;
  filePath: string; // primary file (most recent)
  filePaths: string[]; // all JSONL files for this session (sorted by timestamp asc)
  toolPaths?: string[]; // cursor tool outputs associated with this session
  workspacePath?: string; // absolute workspace path for Cursor lookup
  hasSqlite?: boolean; // true if any Cursor SQLite source exists (store.db or global state DB)
  firstPrompt: string;
  prompts?: string[]; // first N meaningful user prompts (cleaned)
}

export interface ParsedTurn {
  role: "user" | "assistant";
  subtype?: string;
  messageId?: string;
  model?: string;
  timestamp?: string;
  blocks: ContentBlock[];
}

export interface RawMessage {
  parentUuid: string | null;
  uuid?: string;
  isSidechain: boolean;
  userType: string;
  cwd: string;
  sessionId: string;
  version: string;
  gitBranch?: string;
  slug: string;
  type:
    | "user"
    | "assistant"
    | "system"
    | "progress"
    | "file-history-snapshot"
    | "custom-title"
    | "queue-operation"
    | "last-prompt"
    | "pr-link";
  subtype?: string;
  timestamp?: string;
  message?: {
    role: "user" | "assistant";
    id?: string;
    model?: string;
    content: string | ContentBlock[];
  };
  data?: any;
  title?: string;
  durationMs?: number;
}

export type ContentBlock =
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, any> }
  | { type: "tool_result"; tool_use_id: string; content: string | ToolResultContent[] }
  | { type: "image"; source: { type: string; media_type: string; data: string } };

export type ToolResultContent =
  | { type: "text"; text: string }
  | { type: "tool_result"; tool_use_id: string; content: string };
