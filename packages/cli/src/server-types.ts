/**
 * Shared record and cache types for the dashboard server and its extracted
 * helper modules (server-source-catalog, server-enrichment, …). Kept in a
 * dependency-free module so helpers don't need to import back from server.ts.
 */

import type {
  ProjectIdentity,
  ReplaySession,
  SessionLocation,
  SessionTranscriptStatus,
} from "./types.js";

export interface SourceSummaryRecord {
  provider: string;
  slug: string;
  project: string;
  projectIdentity?: ProjectIdentity;
  sessionId?: string;
  location?: SessionLocation;
  transcriptStatus?: SessionTranscriptStatus;
  promptCount?: number;
  toolCallCount?: number;
  filePaths: string[];
  toolPaths?: string[];
  hasSqlite?: boolean;
  hasSdk?: boolean;
  isStarred?: boolean;
  spaceId?: string;
  spaceIdSetBy?: string;
  pluginsEnabled?: boolean;
  skillsEnabled?: boolean;
  fsDetectedFiles?: string[];
  timestamp: string;
  [key: string]: unknown;
}

/** Summary of a generated replay, returned by scanSessionsFromDir / scanSessions */
export interface ReplaySummary {
  slug: string;
  /** Provider/source slug before a remote output slug gets location-scoped. */
  sourceSlug?: string;
  baseDir: string;
  sessionId: string;
  title?: string;
  provider: string;
  location?: SessionLocation;
  transcriptStatus?: SessionTranscriptStatus;
  model?: string;
  gitRepo?: string;
  project: string;
  startTime: string;
  endTime?: string;
  stats: ReplaySession["meta"]["stats"];
  compactionCount?: number;
  replaySize: number;
  generatorVersion?: string;
  replayOutdated: boolean;
  hasAnnotations: boolean;
  annotationCount: number;
  firstMessage?: string;
  messages?: string[];
  gist?: {
    gistId?: string;
    viewerUrl?: string;
    updatedAt?: string;
    outdated: boolean;
  };
  cloud?: {
    id: string;
    url: string;
    expiresAt?: string;
    updatedAt?: string;
  };
}

/** SourceSummaryRecord enriched with replay info for the sources cache */
export interface CachedSourceRecord extends SourceSummaryRecord {
  existingReplay?: string | null;
  replay?: Omit<ReplaySummary, "baseDir" | "generatorVersion" | "replayOutdated">;
}

export interface ProviderDiscoveryState {
  provider: string;
  discoveredAt: string;
  sessionCount: number;
  newestSourceMtimeMs?: number;
  newestSourcePath?: string;
  fingerprint?: string;
}

export interface SourceSessionCatalogCache {
  schemaVersion: 1;
  discoveredAt: string;
  updatedAt?: string;
  failedProviders?: string[];
  providerStates?: Record<string, ProviderDiscoveryState>;
  sessions: CachedSourceRecord[];
}

export interface NormalizedSourceSessionCatalogCache {
  sessions: CachedSourceRecord[];
  cachedAt?: string;
  discoveredAt?: string;
  updatedAt?: string;
  failedProviders?: string[];
  providerStates?: Record<string, ProviderDiscoveryState>;
  legacy?: boolean;
}

export interface SourceProviderFreshnessProbe {
  provider: string;
  sessionsRoot: string;
  fileCount: number;
  newestSourceMtimeMs?: number;
  newestSourcePath?: string;
}
