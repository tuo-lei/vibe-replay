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
      diff?: { filePath: string; oldContent: string; newContent: string };
      bashOutput?: { command: string; stdout: string };
      images?: string[];
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
  primary: string;
  sources: string[];
  supplements?: string[];
  notes?: string[];
}

export interface ReplaySession {
  meta: {
    sessionId: string;
    slug: string;
    title?: string;
    provider: string;
    dataSource?: string;
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
      tokenUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreationTokens: number;
        cacheReadTokens: number;
      };
      costEstimate?: number;
    };
    compactions?: Array<{
      timestamp: string;
      trigger: string;
      preTokens?: number;
    }>;
  };
  scenes: Scene[];
  annotations?: Annotation[];
}

export interface SessionSummary {
  slug: string;
  title?: string;
  provider: string;
  model?: string;
  project: string;
  startTime: string;
  endTime?: string;
  stats: ReplaySession["meta"]["stats"];
  hasAnnotations: boolean;
  annotationCount: number;
  firstMessage?: string;
  gist?: {
    gistId: string;
    viewerUrl: string;
    updatedAt: string;
    outdated?: boolean;
  };
}

export interface SourceSession {
  provider: string;
  slug: string;
  title?: string;
  project: string;
  timestamp: string;
  fileSize: number;
  lineCount: number;
  firstPrompt: string;
  filePaths: string[];
  toolPaths?: string[];
  hasSqlite?: boolean;
  gitBranch?: string;
  existingReplay: string | null;
  projectExists?: boolean;
  replay?: SessionSummary;
}

declare global {
  interface Window {
    __VIBE_REPLAY_DATA__?: ReplaySession;
    __VIBE_REPLAY_EDITOR__?: boolean;
  }
}
