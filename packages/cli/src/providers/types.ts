import type { DataSource, DataSourceInfo, ParsedTurn, SessionInfo } from "../types.js";

export type { DataSource, DataSourceInfo };

export interface Provider {
  name: string;
  displayName: string;
  discover(): Promise<SessionInfo[]>;
  parse(filePaths: string | string[], sessionInfo?: SessionInfo): Promise<ProviderParseResult>;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface Compaction {
  timestamp: string;
  trigger: string;
  preTokens?: number;
}

export interface ProviderParseResult {
  sessionId: string;
  slug: string;
  title?: string;
  cwd: string;
  model?: string;
  startTime?: string;
  endTime?: string;
  totalDurationMs?: number;
  turns: ParsedTurn[];
  dataSource?: DataSource;
  dataSourceInfo?: DataSourceInfo;
  tokenUsage?: TokenUsage;
  compactions?: Compaction[];
}
