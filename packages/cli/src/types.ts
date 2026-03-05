export interface SessionInfo {
  provider: string;
  sessionId: string;
  slug: string;
  title?: string;
  project: string;       // decoded project path (e.g. "~/Code/my-project")
  cwd: string;
  version: string;
  gitBranch?: string;
  timestamp: string;      // ISO string of session start/last update
  lineCount: number;
  fileSize: number;
  filePath: string;       // primary file (most recent)
  filePaths: string[];    // all JSONL files for this session (sorted by timestamp asc)
  toolPaths?: string[];   // cursor tool outputs associated with this session
  workspacePath?: string; // absolute workspace path for SQLite lookup (Cursor)
  hasSqlite?: boolean;    // true if store.db exists for this session
  firstPrompt: string;
}

export interface ParsedTurn {
  role: "user" | "assistant";
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
  type: "user" | "assistant" | "system" | "progress" | "file-history-snapshot" | "custom-title";
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

export type Scene =
  | { type: "user-prompt"; content: string; timestamp?: string; images?: string[] }
  | { type: "thinking"; content: string; timestamp?: string }
  | { type: "text-response"; content: string; timestamp?: string }
  | {
      type: "tool-call";
      toolName: string;
      input: Record<string, any>;
      result: string;
      timestamp?: string;
      diff?: { filePath: string; oldContent: string; newContent: string };
      bashOutput?: { command: string; stdout: string };
      images?: string[];
    };

export interface ReplaySession {
  meta: {
    sessionId: string;
    slug: string;
    title?: string;
    provider: string;
    dataSource?: string;
    startTime: string;
    endTime?: string;
    model?: string;
    cwd: string;
    project: string;
    stats: {
      sceneCount: number;
      userPrompts: number;
      toolCalls: number;
      thinkingBlocks?: number;
      durationMs?: number;
    };
  };
  scenes: Scene[];
}
