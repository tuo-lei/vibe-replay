import type { SessionInfo, ParsedTurn } from "../types.js";

export interface Provider {
  name: string;
  displayName: string;
  discover(): Promise<SessionInfo[]>;
  parse(filePaths: string | string[]): Promise<ProviderParseResult>;
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
}
