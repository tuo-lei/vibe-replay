import { isSameOriginSettingsRequest, registerSameOriginMutationGuard } from "./server-origin.js";
import { resolveDefaultAiSelection } from "./server-ai-selection.js";
import { buildInsightsSyncBatches } from "./server-core.js";
import {
  pickSourceRecordForSession,
  providerSessionKey,
  providerSlugKey,
  prioritizeScanInputs,
  selectCursorEnrichmentCandidates,
  sourceSessionKey,
} from "./server-enrichment.js";
import {
  buildSourcesResult,
  isFilesystemProjectKey,
  normalizeSessionProjectsForHome,
} from "./server-replay-catalog.js";
import { buildReplayMaps, findReplayForSource } from "./server-replay-matching.js";
import { countSessionStats } from "./server-session-stats.js";
import {
  buildSourceSessionCatalogCache,
  getStaleSourceProviders,
  mergeSourceCatalogSessionUpdates,
  normalizeSourceSessionCatalogCache,
  probePiSourceFreshness,
  probeSourceRecordsFreshness,
  sourceProviderFingerprint,
  updateSourceSessionCatalogSessions,
} from "./server-source-catalog.js";

export { startDashboard, startServer } from "./server-runtime.js";
export { resolveGenerateInputs } from "./server-core.js";
export type { SourceSummaryRecord } from "./server-types.js";

export const __testables = {
  buildReplayMaps,
  buildSourcesResult,
  buildSourceSessionCatalogCache,
  buildInsightsSyncBatches,
  countSessionStats,
  getStaleSourceProviders,
  findReplayForSource,
  isSameOriginSettingsRequest,
  registerSameOriginMutationGuard,
  isFilesystemProjectKey,
  mergeSourceCatalogSessionUpdates,
  normalizeSessionProjectsForHome,
  normalizeSourceSessionCatalogCache,
  pickSourceRecordForSession,
  providerSessionKey,
  providerSlugKey,
  probePiSourceFreshness,
  probeSourceRecordsFreshness,
  prioritizeScanInputs,
  resolveDefaultAiSelection,
  selectCursorEnrichmentCandidates,
  sourceSessionKey,
  sourceProviderFingerprint,
  updateSourceSessionCatalogSessions,
};
