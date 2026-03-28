import type { CursorSidecars, PrLink, TokenUsage, TurnStat } from "@vibe-replay/types";
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
  /** Summary of subagents used in this session */
  subAgentSummary?: Array<{
    agentId: string;
    agentType: string;
    description?: string;
    toolCalls: number;
    model?: string;
  }>;
  gitBranch?: string;
  /** All branches seen during session in order (if >1) */
  gitBranches?: string[];
  entrypoint?: string;
  permissionMode?: string;
  apiErrors?: Array<{
    timestamp: string;
    statusCode?: number;
    errorType?: string;
    retryAttempt?: number;
  }>;
  trackedFiles?: string[];
  contextFiles?: string[];
  cursorSidecars?: CursorSidecars;
}
