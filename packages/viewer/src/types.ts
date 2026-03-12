// Shared types — single source of truth
export type {
  Annotation,
  DataSource,
  DataSourceInfo,
  PrLink,
  ReplaySession,
  Scene,
  TokenUsage,
  TurnStat,
} from "@vibe-replay/types";

// Re-import for local use in this file
import type { ReplaySession } from "@vibe-replay/types";

// Viewer-only types below

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
  messages?: string[];
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
  prompts?: string[];
  filePaths: string[];
  toolPaths?: string[];
  hasSqlite?: boolean;
  gitBranch?: string;
  existingReplay: string | null;
  projectExists?: boolean;
  isGitRepo?: boolean;
  replay?: SessionSummary;
}

declare global {
  interface Window {
    __VIBE_REPLAY_DATA__?: ReplaySession;
    __VIBE_REPLAY_EDITOR__?: boolean;
  }
}
