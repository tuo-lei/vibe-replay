import type { PrLink, TokenUsage, TurnStat } from "@vibe-replay/types";
import type { DataSource, DataSourceInfo, ParsedTurn, SessionInfo } from "../types.js";

export type { DataSource, DataSourceInfo, TokenUsage };

export interface Provider {
  name: string;
  displayName: string;
  discover(): Promise<SessionInfo[]>;
  parse(filePaths: string | string[], sessionInfo?: SessionInfo): Promise<ProviderParseResult>;
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
  /** Per-model token usage breakdown for accurate cost estimation */
  tokenUsageByModel?: Record<string, TokenUsage>;
  compactions?: Compaction[];
  /** Per-turn metrics (indexed by user-prompt turn, 0-based) */
  turnStats?: TurnStat[];
  /** PR links associated with the session */
  prLinks?: PrLink[];
}
