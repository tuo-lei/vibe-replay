// Shared types — single source of truth
export type {
  Annotation,
  DataSource,
  DataSourceInfo,
  InsightsStore,
  OverlaySource,
  ProjectIdentity,
  ParseWarning,
  PrLink,
  ReplaySession,
  Scene,
  SceneOverlay,
  SessionInsight,
  SessionUsageSummary,
  SessionOverlays,
  SubAgent,
  TokenUsage,
  TurnStat,
  UsageEvent,
} from "@vibe-replay/types";

export { INSIGHTS_SCHEMA_VERSION } from "@vibe-replay/types";

// Provider contract types — kept re-exported here for backward-compatible
// in-package imports while provider internals move behind a dedicated package.
export type {
  Compaction,
  ContentBlock,
  ParsedTurn,
  Provider,
  ProviderParseResult,
  RawMessage,
  SessionInfo,
  ToolResultContent,
} from "@vibe-replay/provider-contract";
