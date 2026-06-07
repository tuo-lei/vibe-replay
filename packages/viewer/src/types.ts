// Shared types — single source of truth
export type {
  Annotation,
  DataSource,
  DataSourceInfo,
  OverlaySource,
  PrLink,
  ReplaySession,
  Scene,
  SceneOverlay,
  SessionOverlays,
  SubAgent,
  TokenUsage,
  TurnStat,
} from "@vibe-replay/types";

// Re-import for local use in this file
import type { ReplaySession } from "@vibe-replay/types";

// Viewer-only types below

export interface SessionSummary {
  slug: string;
  sessionId?: string;
  title?: string;
  provider: string;
  model?: string;
  gitRepo?: string;
  project: string;
  startTime: string;
  endTime?: string;
  stats: ReplaySession["meta"]["stats"];
  hasAnnotations: boolean;
  annotationCount: number;
  firstMessage?: string;
  messages?: string[];
  replaySize?: number;
  /** Version of vibe-replay that generated this replay */
  generatorVersion?: string;
  /** True if replay was generated with an older CLI version */
  replayOutdated?: boolean;
  gist?: {
    gistId: string;
    viewerUrl: string;
    updatedAt: string;
    outdated?: boolean;
  };
  cloud?: {
    id: string;
    url: string;
    expiresAt: string;
    updatedAt: string;
  };
}

export interface SourceSession {
  provider: string;
  /** Stable per-session id from the provider (e.g. Claude Code JSONL `sessionId`). */
  sessionId?: string;
  slug: string;
  title?: string;
  project: string;
  timestamp: string;
  fileSize: number;
  lineCount: number;
  promptCount?: number;
  toolCallCount?: number;
  firstPrompt: string;
  prompts?: string[];
  filePaths: string[];
  toolPaths?: string[];
  hasSqlite?: boolean;
  hasSdk?: boolean;
  gitBranch?: string;
  gitRepo?: string;
  existingReplay: string | null;
  projectExists?: boolean;
  isGitRepo?: boolean;
  replay?: SessionSummary;
  // Lightweight estimates from discovery (regex-based, no full parse)
  model?: string;
  durationMsEst?: number;
  editCountEst?: number;
  hasPR?: boolean;
  isStarred?: boolean;
  spaceId?: string;
  spaceIdSetBy?: string;
  pluginsEnabled?: boolean;
  skillsEnabled?: boolean;
  fsDetectedFiles?: string[];
  // Days until Claude Code cleanup (undefined for non-claude-code or if disabled)
  expiresInDays?: number;
}

declare global {
  const __CLI_VERSION__: string;
  interface Window {
    __VIBE_REPLAY_DATA__?: ReplaySession;
    __VIBE_REPLAY_EDITOR__?: boolean;
  }
}
