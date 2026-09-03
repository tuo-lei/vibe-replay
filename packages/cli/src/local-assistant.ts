/**
 * Read-only tools for the local Vibe Replay assistant.
 *
 * This module deliberately knows nothing about Hono or the browser. The
 * server supplies local data accessors, while the viewer consumes the
 * citations and navigation actions returned in tool details.
 */

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  deriveTokenUsageMetrics,
  sessionLocationHash,
  type Annotation,
  type SessionOverlays,
} from "@vibe-replay/types";
import { redactSensitiveText } from "./ai-runtime.js";
import type { CachedSourceRecord, ReplaySummary } from "./server-types.js";
import {
  aggregateProjectInsights,
  aggregateUserInsights,
  type ProjectInsights,
  type SessionScanResult,
  type UserInsights,
} from "./scanner.js";
import { buildUsageCoverageReport } from "./usage-coverage.js";
import type { ReplaySession, Scene, SessionDiagnostic, SessionLocation } from "./types.js";
import { localDayKey } from "./utils.js";

const MAX_SEARCH_RESULTS = 20;
const MAX_CONTENT_CHARS = 18_000;
const MAX_SCENE_CHARS = 2_400;
const MAX_USAGE_ENTRIES = 12;
const MAX_DIAGNOSTIC_EVENTS = 50;
const MAX_ANNOTATIONS = 40;
const MAX_OVERLAYS = 40;
const MAX_SESSION_LIST = 20;

type LocalAssistantTool = AgentTool<any, LocalAssistantToolDetails>;

export interface LocalAssistantContext {
  mode: "dashboard" | "replay";
  tab?: string;
  project?: string;
  /** SSH-backed session content requires an explicit UI consent toggle. */
  allowRemoteData?: boolean;
  currentSession?: {
    slug: string;
    provider: string;
    title?: string;
    targetId?: string;
    sceneIndex?: number;
  };
}

export interface LocalAssistantData {
  listSources: () => Promise<readonly CachedSourceRecord[]>;
  listReplays: () => Promise<readonly ReplaySummary[]>;
  getSession: (slug: string, targetId?: string) => Promise<ReplaySession>;
  /** Load the persisted non-destructive AI Studio edits for a replay. */
  getOverlays?: (slug: string, targetId?: string) => Promise<SessionOverlays>;
  getScanResults: () => readonly SessionScanResult[];
  getUserInsights: (allowRemoteData?: boolean) => Promise<UserInsights | null>;
  getProjectInsights: (project: string, targetId?: string) => Promise<ProjectInsights | null>;
  /** Archive markers are optional so the assistant remains usable in tests and embedded mode. */
  getArchivedKeys?: () => Promise<readonly string[]>;
  /** A bounded status snapshot owned by the server, when available. */
  getDataStatus?: (replayCount?: number) => Promise<LocalAssistantDataStatus>;
}

export interface LocalAssistantDataStatus {
  scan?: {
    running: boolean;
    phase?: string;
    scanned?: number;
    total?: number;
    resultCount?: number;
    revision?: number;
    finishedAt?: string;
    cachedAt?: string;
    failedProviders?: string[];
    usageBackfill?: { running: boolean; scanned?: number; total?: number };
    usageIndexPending?: number;
  };
  sources?: {
    count: number;
    cachedAt?: string;
    discoveredAt?: string;
    stale?: boolean;
    staleProviders?: string[];
    failedProviders?: string[];
  };
  replays?: { count: number };
  archivedCount?: number;
}

export interface LocalAssistantCitation {
  type: "session" | "scene" | "insight";
  label: string;
  /** Same-origin deep link for this resource. */
  permalink?: string;
  slug?: string;
  provider?: string;
  sessionId?: string;
  targetId?: string;
  sceneIndex?: number;
  project?: string;
  /** False when the citation points to a source session that has no replay yet. */
  replayAvailable?: boolean;
}

export type LocalAssistantAction =
  | {
      type: "open_replay";
      label: string;
      slug: string;
      targetId?: string;
      sceneIndex?: number;
      view?: "replay" | "summary" | "export";
      drawer?: "comments" | "ai";
      permalink: string;
    }
  | {
      type: "open_dashboard";
      label: string;
      tab: "home" | "sessions" | "replays" | "projects" | "insights" | "settings";
      project?: string;
      targetId?: string;
      selected?: string;
      selectedProvider?: string;
      selectedSessionId?: string;
      selectedTargetId?: string;
      settingsSection?: "ai" | "remote" | "more";
      projectView?: "timeline" | "overview" | "files";
      insightsSection?: "overview" | "activity" | "usage" | "coverage" | "workspace";
      query?: string;
      providers?: string[];
      repos?: string[];
      tools?: string[];
      mcpServers?: string[];
      mcpTools?: string[];
      skills?: string[];
      compacted?: boolean;
      archived?: boolean;
      agentRuns?: boolean;
      insightsRange?: "7d" | "30d" | "90d" | "all";
      permalink: string;
    };

export interface LocalAssistantToolDetails {
  toolName: string;
  summary: string;
  remoteData?: boolean;
  citations?: LocalAssistantCitation[];
  actions?: LocalAssistantAction[];
}

interface AssistantSessionRecord {
  source?: CachedSourceRecord;
  replay?: ReplaySummary;
  scan?: SessionScanResult;
}

interface SessionRef {
  slug: string;
  targetId?: string;
}

interface SearchArgs {
  query?: string;
  provider?: string;
  project?: string;
  targetId?: string;
  repo?: string;
  model?: string;
  branch?: string;
  tool?: string | string[];
  mcpServer?: string | string[];
  mcpTool?: string | string[];
  skill?: string | string[];
  compacted?: boolean;
  archived?: boolean;
  hasReplay?: boolean;
  sortBy?: "recent" | "oldest" | "cost" | "duration" | "prompts" | "toolCalls" | "edits";
  since?: string;
  until?: string;
  limit?: number;
}

interface SessionArgs extends SessionRef {}

interface ContentArgs extends SessionRef {
  sceneStart?: number;
  sceneEnd?: number;
  query?: string;
}

interface SceneArgs extends SessionRef {
  sceneIndex: number;
}

interface InsightsArgs {
  scope: "user" | "project";
  project?: string;
  targetId?: string;
  range?: "7d" | "30d" | "90d" | "all";
  since?: string;
  until?: string;
}

interface UsageArgs {
  slug?: string;
  targetId?: string;
  project?: string;
  provider?: string;
  tool?: string;
  mcpServer?: string;
  mcpTool?: string;
  skill?: string;
  range?: "7d" | "30d" | "90d" | "all";
  since?: string;
  until?: string;
  includeEvents?: boolean;
  limit?: number;
}

interface DiagnosticArgs {
  slug?: string;
  targetId?: string;
  project?: string;
  provider?: string;
  since?: string;
  until?: string;
  limit?: number;
}

interface OpenReplayArgs extends SessionRef {
  sceneIndex?: number;
  view?: "replay" | "summary" | "export";
  drawer?: "comments" | "ai";
}

interface OpenDashboardArgs {
  tab: "home" | "sessions" | "replays" | "projects" | "insights" | "settings";
  project?: string;
  targetId?: string;
  selected?: string;
  selectedProvider?: string;
  selectedSessionId?: string;
  selectedTargetId?: string;
  settingsSection?: "ai" | "remote" | "more";
  projectView?: "timeline" | "overview" | "files";
  insightsSection?: "overview" | "activity" | "usage" | "coverage" | "workspace";
  query?: string;
  providers?: string[];
  repos?: string[];
  tools?: string[];
  mcpServers?: string[];
  mcpTools?: string[];
  skills?: string[];
  compacted?: boolean;
  archived?: boolean;
  agentRuns?: boolean;
  insightsRange?: "7d" | "30d" | "90d" | "all";
}

interface AnnotationArgs extends SessionRef {
  sceneIndex?: number;
  unresolvedOnly?: boolean;
  limit?: number;
}

interface OverlayArgs extends SessionRef {
  sceneIndex?: number;
  source?: "translate" | "tone" | "manual";
  limit?: number;
}

interface DataStatusArgs {
  includeRemote?: boolean;
}

type UserActionIntent =
  | "generate_replay"
  | "regenerate_replay"
  | "delete_replay"
  | "archive_replay"
  | "annotate_replay"
  | "ai_coach"
  | "translate_replay"
  | "soften_tone"
  | "export_replay"
  | "publish_replay";

interface UserActionArgs extends SessionRef {
  intent: UserActionIntent;
  sceneIndex?: number;
}

type DashboardPermalinkInput = Omit<OpenDashboardArgs, "tab"> & {
  tab: OpenDashboardArgs["tab"];
};

/**
 * Build same-origin query-only links so the assistant never has to guess the
 * port or hostname of the local editor. The viewer resolves these against its
 * current origin and keeps them usable in dev, packaged, and embedded modes.
 */
function permalinkQuery(params: Record<string, string | readonly string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (typeof value !== "string") {
      for (const item of value) {
        if (item) query.append(key, item);
      }
    } else if (value) {
      query.set(key, value);
    }
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "?";
}

function replayPermalink(
  slug: string,
  targetId?: string,
  sceneIndex?: number,
  view: "replay" | "summary" | "export" = "replay",
  drawer?: "comments" | "ai",
): string {
  return permalinkQuery({
    session: slug,
    targetId,
    v: view === "replay" ? undefined : view,
    s: sceneIndex === undefined ? undefined : String(sceneIndex),
    drawer,
  });
}

function dashboardPermalink(args: DashboardPermalinkInput): string {
  return permalinkQuery({
    view: "dashboard",
    tab: args.tab,
    project: args.project,
    targetId: args.targetId,
    selected: args.selected,
    selectedProvider: args.selectedProvider,
    selectedSessionId: args.selectedSessionId,
    selectedTargetId: args.selectedTargetId || args.targetId,
    settingsSection: args.settingsSection,
    projectView: args.projectView,
    insightsSection: args.insightsSection,
    q: args.query,
    provider: args.providers,
    repo: args.repos,
    tool: args.tools,
    mcp: args.mcpServers,
    mcpTool: args.mcpTools,
    skill: args.skills,
    compacted: args.compacted ? "true" : undefined,
    archived: args.archived ? "true" : undefined,
    agentRuns: args.agentRuns ? "true" : undefined,
    insightsRange:
      args.insightsRange && args.insightsRange !== "all" ? args.insightsRange : undefined,
  });
}

function targetIdFor(location?: SessionLocation): string | undefined {
  return location?.kind === "ssh" ? location.id : undefined;
}

function recordProvider(record: AssistantSessionRecord): string {
  return record.replay?.provider || record.source?.provider || record.scan?.provider || "unknown";
}

function recordTargetId(record: AssistantSessionRecord): string | undefined {
  return targetIdFor(record.replay?.location || record.source?.location || record.scan?.location);
}

function isRemoteRecord(record: AssistantSessionRecord): boolean {
  return recordTargetId(record) !== undefined;
}

function assertRecordAccess(record: AssistantSessionRecord, context: LocalAssistantContext): void {
  if (isRemoteRecord(record) && !context.allowRemoteData) {
    throw new Error(
      "This session came from an SSH source. Enable SSH session data in Ask Replay before reading it.",
    );
  }
}

function recordSessionId(record: AssistantSessionRecord): string | undefined {
  return record.replay?.sessionId || record.source?.sessionId || record.scan?.sessionId;
}

function sourceString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sourceStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function recordSlugs(record: AssistantSessionRecord): string[] {
  return [
    record.replay?.slug,
    record.replay?.sourceSlug,
    record.source?.slug,
    record.source?.existingReplay || undefined,
    record.scan?.slug,
  ].filter((value): value is string => Boolean(value));
}

function recordsMatch(a: AssistantSessionRecord, b: AssistantSessionRecord): boolean {
  if (recordProvider(a) !== recordProvider(b) || recordTargetId(a) !== recordTargetId(b)) {
    return false;
  }
  const aSessionId = recordSessionId(a);
  const bSessionId = recordSessionId(b);
  const bSlugs = new Set(recordSlugs(b));
  if (recordSlugs(a).some((slug) => bSlugs.has(slug))) return true;
  return aSessionId !== undefined && bSessionId !== undefined && aSessionId === bSessionId;
}

async function buildSessionRecords(data: LocalAssistantData): Promise<AssistantSessionRecord[]> {
  const [sources, replays] = await Promise.all([data.listSources(), data.listReplays()]);
  const records: AssistantSessionRecord[] = [];

  for (const source of sources) {
    records.push({
      source,
      replay: source.replay
        ? ({ ...source.replay, baseDir: "", replayOutdated: false } as ReplaySummary)
        : undefined,
    });
  }

  for (const replay of replays) {
    const existing = records.find((record) => recordsMatch(record, { replay }));
    if (existing) existing.replay = replay;
    else records.push({ replay });
  }

  for (const scan of data.getScanResults()) {
    const existing = records.find((record) => recordsMatch(record, { scan }));
    if (existing) existing.scan = scan;
    else records.push({ scan });
  }

  return records;
}

function recordTitle(record: AssistantSessionRecord): string {
  return (
    record.replay?.title ||
    sourceString(record.source?.title) ||
    record.scan?.title ||
    record.replay?.firstMessage ||
    sourceString(record.source?.firstPrompt) ||
    record.scan?.firstPrompt ||
    recordSlugs(record)[0] ||
    "Untitled session"
  );
}

function recordProject(record: AssistantSessionRecord): string | undefined {
  return record.replay?.project || record.source?.project || record.scan?.project;
}

function recordRepo(record: AssistantSessionRecord): string | undefined {
  return record.replay?.gitRepo || sourceString(record.source?.gitRepo);
}

function recordBranch(record: AssistantSessionRecord): string | undefined {
  return sourceString(record.source?.gitBranch) || record.scan?.gitBranch;
}

function recordModel(record: AssistantSessionRecord): string | undefined {
  return record.replay?.model || sourceString(record.source?.model) || record.scan?.model;
}

function recordTimestamp(record: AssistantSessionRecord): string | undefined {
  return record.scan?.startTime || record.replay?.startTime || record.source?.timestamp;
}

function replaySlug(record: AssistantSessionRecord): string | undefined {
  return record.replay?.slug || sourceString(record.source?.existingReplay);
}

function recordRef(record: AssistantSessionRecord): SessionRef | undefined {
  const slug = replaySlug(record);
  if (!slug) return undefined;
  const targetId = recordTargetId(record);
  return targetId ? { slug, targetId } : { slug };
}

function sourceSlugFor(record: AssistantSessionRecord): string | undefined {
  return (
    record.source?.slug || record.scan?.slug || record.replay?.sourceSlug || record.replay?.slug
  );
}

function sourcePermalink(record: AssistantSessionRecord): string {
  const slug = sourceSlugFor(record);
  if (!slug) return dashboardPermalink({ tab: "sessions" });
  return dashboardPermalink({
    tab: "sessions",
    project: recordProject(record),
    targetId: recordTargetId(record),
    selected: slug,
    selectedProvider: recordProvider(record),
    selectedSessionId: recordSessionId(record),
    selectedTargetId: recordTargetId(record),
  });
}

function recordPermalink(record: AssistantSessionRecord, sceneIndex?: number): string {
  const ref = recordRef(record);
  return ref ? replayPermalink(ref.slug, ref.targetId, sceneIndex) : sourcePermalink(record);
}

function locationFor(record: AssistantSessionRecord): SessionLocation | undefined {
  return record.replay?.location || record.source?.location || record.scan?.location;
}

function compact(value: string | undefined, max = 500): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

function compactList(values: readonly string[] | undefined, max = 24): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const result = values.filter((value) => typeof value === "string" && value.trim()).slice(0, max);
  return result.length > 0 ? result : undefined;
}

function sourceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function argumentStrings(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter((entry) => typeof entry === "string" && entry);
  return typeof value === "string" && value.trim() ? [value.trim()] : [];
}

function matchesStringFilters(
  values: readonly string[],
  wanted: string | string[] | undefined,
): boolean {
  const filters = argumentStrings(wanted).map((value) => value.toLowerCase());
  if (filters.length === 0) return true;
  return filters.some((filter) => values.some((value) => value.toLowerCase().includes(filter)));
}

function recordToolNames(record: AssistantSessionRecord): string[] {
  return Object.keys(record.scan?.usageSummary?.tools || {});
}

function recordMcpServers(record: AssistantSessionRecord): string[] {
  const names = new Set<string>([
    ...Object.keys(record.scan?.usageSummary?.mcpServers || {}),
    ...(record.scan?.mcpServersUsed || []),
  ]);
  return [...names];
}

function recordMcpTools(record: AssistantSessionRecord): string[] {
  return Object.keys(record.scan?.usageSummary?.mcpTools || {});
}

function recordSkills(record: AssistantSessionRecord): string[] {
  return [
    ...new Set([
      ...Object.keys(record.scan?.usageSummary?.skills || {}),
      ...(record.scan?.skillsUsed || []),
    ]),
  ];
}

function recordArchiveKeys(record: AssistantSessionRecord): string[] {
  const targetId = recordTargetId(record);
  const slugs = recordSlugs(record);
  if (!targetId) return slugs;
  const suffix = `--ssh-${sessionLocationHash(targetId)}`;
  return [...slugs, ...slugs.map((slug) => `${slug}${suffix}`)];
}

function isArchivedRecord(
  record: AssistantSessionRecord,
  archivedKeys?: ReadonlySet<string>,
): boolean {
  if (!archivedKeys || archivedKeys.size === 0) return false;
  return recordArchiveKeys(record).some((key) => archivedKeys.has(key));
}

function sessionCitation(
  record: AssistantSessionRecord,
  sceneIndex?: number,
): LocalAssistantCitation {
  const ref = recordRef(record);
  const sourceSlug =
    record.source?.slug || record.scan?.slug || sourceString(record.replay?.sourceSlug);
  const replayAvailable = Boolean(ref);
  return {
    type: sceneIndex === undefined ? "session" : "scene",
    label: `${recordTitle(record)} · ${recordProvider(record)}`,
    permalink: recordPermalink(record, sceneIndex),
    ...(ref || (sourceSlug ? { slug: sourceSlug } : {})),
    provider: recordProvider(record),
    ...(recordSessionId(record) ? { sessionId: recordSessionId(record) } : {}),
    ...(ref?.targetId || recordTargetId(record)
      ? { targetId: ref?.targetId || recordTargetId(record) }
      : {}),
    ...(sceneIndex === undefined ? {} : { sceneIndex }),
    replayAvailable,
  };
}

function toolResult(
  toolName: string,
  summary: string,
  payload: unknown,
  details: Omit<LocalAssistantToolDetails, "toolName" | "summary"> = {},
) {
  return {
    // Tool content is sent to the configured provider. Apply the same
    // credential-shaped redaction used for AI output before it leaves the CLI.
    content: [{ type: "text" as const, text: redactSensitiveText(JSON.stringify(payload)) }],
    details: { toolName, summary, ...details } satisfies LocalAssistantToolDetails,
  };
}

function parseDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const relative = value.trim().match(/^(\d+)d$/i);
  if (relative) return new Date(Date.now() - Number(relative[1]) * 86_400_000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function resultStats(record: AssistantSessionRecord) {
  const stats = record.replay?.stats;
  const scan = record.scan;
  const start = record.replay?.startTime || scan?.startTime || record.source?.timestamp;
  const end = record.replay?.endTime || scan?.endTime;
  const inferredDurationMs =
    start && end ? Math.max(0, new Date(end).getTime() - new Date(start).getTime()) : undefined;
  return {
    prompts:
      stats?.userPrompts ?? scan?.promptCount ?? sourceNumber(record.source?.promptCount) ?? 0,
    toolCalls:
      stats?.toolCalls ?? scan?.toolCallCount ?? sourceNumber(record.source?.toolCallCount) ?? 0,
    edits: scan?.editCount ?? 0,
    durationMs: stats?.durationMs ?? scan?.durationMs ?? inferredDurationMs,
    cost: stats?.costEstimate ?? scan?.costEstimate,
    compactions:
      record.replay?.compactionCount ??
      record.scan?.compactionCount ??
      sourceNumber(record.source?.compactionCount) ??
      0,
  };
}

function fallbackDiagnostics(session: ReplaySession | ReplaySummary): SessionDiagnostic[] {
  const diagnostics: SessionDiagnostic[] = [];
  const compactions = "meta" in session ? session.meta.compactions : session.compactions;
  const apiErrors = "meta" in session ? session.meta.apiErrors : session.apiErrors;
  for (const compaction of compactions || []) {
    diagnostics.push({
      kind: "compaction",
      outcome: "succeeded",
      timestamp: compaction.timestamp,
      confidence: "unknown",
      trigger: "unknown",
      ...(compaction.preTokens !== undefined ? { preTokens: compaction.preTokens } : {}),
      evidence: [
        "This replay predates structured diagnostic events; only the persisted compaction entry is available.",
      ],
    });
  }
  for (const error of apiErrors || []) {
    diagnostics.push({
      kind: "assistant-api-error",
      outcome: "failed",
      timestamp: error.timestamp,
      confidence: "unknown",
      ...(error.statusCode !== undefined ? { statusCode: error.statusCode } : {}),
      ...(error.errorType ? { errorType: error.errorType } : {}),
      ...(error.retryAttempt !== undefined ? { retryAttempt: error.retryAttempt } : {}),
      evidence: [
        "This replay predates structured diagnostic events; the error was not attributed to compaction.",
      ],
    });
  }
  return diagnostics;
}

function diagnosticsForRecord(record: AssistantSessionRecord): {
  events: SessionDiagnostic[];
  notes: string[];
} {
  if (record.replay?.diagnostics?.length) {
    return {
      events: record.replay.diagnostics,
      notes: record.replay.diagnosticNotes || [],
    };
  }
  if (record.scan?.diagnostics?.length) {
    return {
      events: record.scan.diagnostics,
      notes: record.scan.diagnosticNotes || [],
    };
  }
  if (record.replay) {
    return {
      events: fallbackDiagnostics(record.replay),
      notes: record.replay.diagnosticNotes || [],
    };
  }
  return {
    events: [],
    notes: record.scan?.diagnosticNotes || [],
  };
}

function diagnosticCounts(events: readonly SessionDiagnostic[]) {
  return {
    successfulCompactions: events.filter(
      (event) => event.kind === "compaction" && event.outcome === "succeeded",
    ).length,
    automaticContextCompactions: events.filter(
      (event) =>
        event.kind === "compaction" &&
        event.outcome === "succeeded" &&
        event.trigger === "automatic-context",
    ).length,
    unknownCompactions: events.filter(
      (event) => event.kind === "compaction" && event.trigger === "unknown",
    ).length,
    compactionFailures: events.filter(
      (event) => event.kind === "compaction" && event.outcome === "failed",
    ).length,
    assistantApiErrors: events.filter((event) => event.kind === "assistant-api-error").length,
  };
}

function diagnosticRecord(record: AssistantSessionRecord) {
  const { events, notes } = diagnosticsForRecord(record);
  const visibleEvents = events.slice(-MAX_DIAGNOSTIC_EVENTS);
  const omittedEventCount = events.length - visibleEvents.length;
  return {
    title: recordTitle(record),
    provider: recordProvider(record),
    project: recordProject(record),
    location: locationFor(record),
    sessionId: recordSessionId(record),
    permalink: recordPermalink(record),
    slug: recordRef(record)?.slug || record.source?.slug || record.scan?.slug,
    targetId: recordTargetId(record),
    startTime: recordTimestamp(record),
    model: recordModel(record),
    counts: diagnosticCounts(events),
    events: visibleEvents,
    ...(omittedEventCount > 0 ? { eventsTruncated: true, omittedEventCount } : {}),
    notes,
  };
}

function searchableText(record: AssistantSessionRecord): string {
  const source = record.source;
  const scan = record.scan;
  const diagnostics = diagnosticsForRecord(record).events;
  return [
    recordTitle(record),
    recordProject(record),
    recordProvider(record),
    recordModel(record),
    recordRepo(record),
    record.replay?.firstMessage,
    ...(record.replay?.messages || []),
    sourceString(source?.firstPrompt),
    ...sourceStrings(source?.prompts),
    ...(source?.filePaths || []),
    ...(source?.toolPaths || []),
    recordBranch(record),
    ...(scan?.gitBranches || []),
    sourceString(source?.gitRepo),
    ...sourceStrings(source?.gitBranches),
    ...recordToolNames(record),
    ...recordMcpServers(record),
    ...recordMcpTools(record),
    ...recordSkills(record),
    scan?.firstPrompt,
    ...(scan?.filesModified || []).map((file) => file.file),
    ...sourceStrings(scan?.skillsUsed),
    ...sourceStrings(scan?.mcpServersUsed),
    ...diagnostics.flatMap((event) => [
      event.kind,
      event.outcome,
      event.trigger || "",
      event.errorType || "",
    ]),
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
}

function searchMatches(
  record: AssistantSessionRecord,
  args: SearchArgs,
  archived?: boolean,
): boolean {
  const terms = (args.query || "")
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  const text = searchableText(record);
  if (terms.some((term) => !text.includes(term))) return false;

  if (
    args.provider &&
    !recordProvider(record).toLowerCase().includes(args.provider.toLowerCase())
  ) {
    return false;
  }
  if (args.project && !recordProject(record)?.toLowerCase().includes(args.project.toLowerCase())) {
    return false;
  }

  if (args.repo && !recordRepo(record)?.toLowerCase().includes(args.repo.toLowerCase())) {
    return false;
  }
  if (args.model && !recordModel(record)?.toLowerCase().includes(args.model.toLowerCase())) {
    return false;
  }
  if (args.branch && !recordBranch(record)?.toLowerCase().includes(args.branch.toLowerCase())) {
    return false;
  }
  if (!matchesStringFilters(recordToolNames(record), args.tool)) return false;
  if (!matchesStringFilters(recordMcpServers(record), args.mcpServer)) return false;
  if (!matchesStringFilters(recordMcpTools(record), args.mcpTool)) return false;
  if (!matchesStringFilters(recordSkills(record), args.skill)) return false;
  if (args.compacted !== undefined) {
    const compactions = resultStats(record).compactions > 0;
    if (compactions !== args.compacted) return false;
  }
  if (args.hasReplay !== undefined && Boolean(recordRef(record)) !== args.hasReplay) return false;
  if (args.archived !== undefined && archived !== args.archived) return false;

  const timestamp = recordTimestamp(record);
  const time = timestamp ? new Date(timestamp).getTime() : Number.NaN;
  const since = parseDate(args.since)?.getTime();
  const until = parseDate(args.until)?.getTime();
  if (since !== undefined && (!Number.isFinite(time) || time < since)) return false;
  if (until !== undefined && (!Number.isFinite(time) || time > until)) return false;
  return true;
}

function resultRecord(record: AssistantSessionRecord, archived = false) {
  const ref = recordRef(record);
  const stats = resultStats(record);
  return {
    title: recordTitle(record),
    provider: recordProvider(record),
    project: recordProject(record),
    location: locationFor(record),
    sessionId: recordSessionId(record),
    permalink: recordPermalink(record),
    slug: ref?.slug,
    targetId: ref?.targetId || recordTargetId(record),
    sourceSlug: sourceSlugFor(record),
    startTime: recordTimestamp(record),
    model: recordModel(record),
    gitRepo: recordRepo(record),
    gitBranch: recordBranch(record),
    gitBranches: compactList(
      sourceStrings(record.source?.gitBranches).length > 0
        ? sourceStrings(record.source?.gitBranches)
        : record.scan?.gitBranches,
    ),
    filePaths: compactList(
      record.source?.filePaths || record.scan?.filesModified.map((f) => f.file),
    ),
    toolPaths: compactList(record.source?.toolPaths),
    tools: compactList(recordToolNames(record)),
    mcpServers: compactList(recordMcpServers(record)),
    mcpTools: compactList(recordMcpTools(record)),
    skills: compactList(recordSkills(record)),
    dataSource: record.scan?.dataSource,
    hasSqlite: record.source?.hasSqlite,
    hasSdk: record.source?.hasSdk,
    isStarred: record.source?.isStarred,
    projectExists: record.source?.projectExists,
    isGitRepo: record.source?.isGitRepo,
    archived,
    replayOutdated: record.replay?.replayOutdated,
    annotationCount: record.replay?.annotationCount ?? 0,
    transcriptStatus:
      record.replay?.transcriptStatus ||
      record.source?.transcriptStatus ||
      record.scan?.transcriptStatus,
    dataQualityNotes: record.scan?.dataQualityNotes,
    diagnostics: diagnosticCounts(diagnosticsForRecord(record).events),
    firstPrompt: compact(
      record.replay?.firstMessage ||
        sourceString(record.source?.firstPrompt) ||
        record.scan?.firstPrompt,
      360,
    ),
    replayAvailable: Boolean(ref),
    stats,
  };
}

function findRecord(
  records: readonly AssistantSessionRecord[],
  ref: SessionRef,
): AssistantSessionRecord | undefined {
  return records.find((record) => {
    const targetId = recordTargetId(record);
    if (targetId !== ref.targetId) return false;
    return recordSlugs(record).includes(ref.slug);
  });
}

function sceneText(scene: Scene, index: number): string {
  const timestamp = scene.timestamp ? `\ntime: ${scene.timestamp}` : "";
  switch (scene.type) {
    case "user-prompt":
      return `[scene ${index}] USER${timestamp}\n${scene.content}`;
    case "thinking":
      return `[scene ${index}] THINKING${timestamp}\n${scene.content}`;
    case "text-response":
      return `[scene ${index}] ASSISTANT${timestamp}\n${scene.content}`;
    case "compaction-summary":
      return `[scene ${index}] CONTEXT COMPACTION${timestamp}\n${scene.content}`;
    case "context-injection":
      return `[scene ${index}] CONTEXT (${scene.injectionType || "other"})${timestamp}\n${scene.content}`;
    case "tool-call": {
      const lines = [`[scene ${index}] TOOL ${scene.toolName}${timestamp}`];
      const input = compact(JSON.stringify(scene.input), 1_200);
      if (input) lines.push(`input: ${input}`);
      const result = compact(scene.result, 1_000);
      if (result) lines.push(`result: ${result}`);
      const diffs = scene.diffs || (scene.diff ? [scene.diff] : []);
      for (const diff of diffs.slice(0, 12)) lines.push(`file: ${diff.filePath}`);
      if (scene.bashOutput?.command)
        lines.push(`command: ${compact(scene.bashOutput.command, 500)}`);
      if (scene.durationMs !== undefined) lines.push(`durationMs: ${scene.durationMs}`);
      if (scene.isError) lines.push("status: error");
      return lines.join("\n");
    }
  }
}

type ReplayOverlay = SessionOverlays["overlays"][number];

function latestOverlayByScene(overlays?: SessionOverlays): Map<number, ReplayOverlay> | undefined {
  if (!overlays) return undefined;
  const latest = new Map<number, ReplayOverlay>();
  for (const overlay of overlays.overlays) {
    const previous = latest.get(overlay.sceneIndex);
    if (!previous || overlay.updatedAt > previous.updatedAt) {
      latest.set(overlay.sceneIndex, overlay);
    }
  }
  return latest;
}

function effectiveScene(
  session: ReplaySession,
  sceneIndex: number,
  overlays?: SessionOverlays,
  latestByScene?: Map<number, ReplayOverlay>,
): Scene {
  const scene = session.scenes[sceneIndex]!;
  const latest = latestByScene
    ? latestByScene.get(sceneIndex)
    : overlays?.overlays
        .filter((overlay) => overlay.sceneIndex === sceneIndex)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (!latest || (scene.type !== "user-prompt" && scene.type !== "text-response")) return scene;
  return { ...scene, content: latest.modifiedValue };
}

function annotationPayload(annotation: Annotation) {
  return {
    id: annotation.id,
    sceneIndex: annotation.sceneIndex,
    body: compact(annotation.body, 1_200),
    author: compact(annotation.author, 120),
    selectedText: compact(annotation.selectedText, 800),
    resolved: annotation.resolved,
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
  };
}

function overlayPayload(overlay: SessionOverlays["overlays"][number]) {
  return {
    id: overlay.id,
    sceneIndex: overlay.sceneIndex,
    source: overlay.source,
    originalValue: compact(overlay.originalValue, 1_200),
    modifiedValue: compact(overlay.modifiedValue, 1_200),
    createdAt: overlay.createdAt,
    updatedAt: overlay.updatedAt,
  };
}

function sessionSummary(
  session: ReplaySession,
  record: AssistantSessionRecord,
  overlays?: SessionOverlays,
) {
  const latestByScene = latestOverlayByScene(overlays);
  const promptScenes = session.scenes
    .map((scene, index) => {
      const effective = effectiveScene(session, index, overlays, latestByScene);
      return effective.type === "user-prompt"
        ? {
            index,
            prompt: compact(effective.content, 500),
            permalink: recordPermalink(record, index),
          }
        : null;
    })
    .filter((value): value is { index: number; prompt: string | undefined; permalink: string } =>
      Boolean(value),
    )
    .slice(0, 12);
  const toolCounts: Record<string, number> = {};
  for (const scene of session.scenes) {
    if (scene.type === "tool-call")
      toolCounts[scene.toolName] = (toolCounts[scene.toolName] || 0) + 1;
  }
  const turnStats = session.meta.stats.turnStats;
  const boundedStats = {
    ...session.meta.stats,
    ...(turnStats && turnStats.length > 80
      ? {
          turnStats: [...turnStats.slice(0, 40), ...turnStats.slice(-40)],
          turnStatsTruncated: true,
        }
      : {}),
  };
  return {
    title: session.meta.title || recordTitle(record),
    provider: session.meta.provider,
    project: session.meta.project,
    location: session.meta.location,
    sessionId: session.meta.sessionId,
    slug: session.meta.slug,
    permalink: recordPermalink(record),
    model: session.meta.model,
    transcriptStatus: session.meta.transcriptStatus,
    dataSource: session.meta.dataSource,
    dataSourceInfo: session.meta.dataSourceInfo,
    startTime: session.meta.startTime,
    endTime: session.meta.endTime,
    stats: boundedStats,
    contextBreakdown: session.meta.contextBreakdown,
    compactions: session.meta.compactions || [],
    diagnostics:
      (session.meta.diagnostics?.length ?? 0) > 0
        ? session.meta.diagnostics
        : fallbackDiagnostics(session),
    diagnosticNotes: session.meta.diagnosticNotes || [],
    apiErrors: session.meta.apiErrors || [],
    sceneCount: session.scenes.length,
    prompts: promptScenes,
    toolCounts,
    gitRepo: session.meta.gitRepo,
    gitBranch: session.meta.gitBranch,
    gitBranches: session.meta.gitBranches,
    prLinks: session.meta.prLinks,
    cwd: session.meta.cwd,
    contextLimit: session.meta.contextLimit,
    tokenUsageByModel: session.meta.tokenUsageByModel,
    generator: session.meta.generator,
    subAgentSummary: session.meta.subAgentSummary?.slice(0, 20),
    trackedFiles: compactList(session.meta.trackedFiles, 50),
    contextFiles: compactList(session.meta.contextFiles, 50),
    cursorSidecars: session.meta.cursorSidecars,
    parseWarnings: session.meta.parseWarnings?.slice(0, 20),
    skillsUsed: compactList(session.meta.skillsUsed),
    mcpServersUsed: compactList(session.meta.mcpServersUsed),
    entrypoint: session.meta.entrypoint,
    permissionMode: session.meta.permissionMode,
    memoryMode: session.meta.memoryMode,
    worktree: session.meta.worktree,
    serviceTier: session.meta.serviceTier,
    agentName: session.meta.agentName,
    truncatedResponses: session.meta.truncatedResponses,
    queueOperationStats: session.meta.queueOperationStats,
    annotationCount: session.annotations?.length || record.replay?.annotationCount || 0,
    unresolvedAnnotationCount:
      session.annotations?.filter((annotation) => !annotation.resolved).length || 0,
    overlayCount: overlays?.overlays.length || 0,
    overlayScenes: overlays
      ? [...new Set(overlays.overlays.map((overlay) => overlay.sceneIndex))].sort((a, b) => a - b)
      : undefined,
    dataQualityNotes: record.scan?.dataQualityNotes,
  };
}

function usageEntries(counts: Record<string, number> | undefined) {
  return Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_USAGE_ENTRIES)
    .map(([name, calls]) => ({ name, calls }));
}

type AssistantInsightsRange = "7d" | "30d" | "90d" | "all";

function rangeStart(range?: AssistantInsightsRange): Date | undefined {
  if (!range || range === "all") return undefined;
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return start;
}

function inDateWindow(
  timestamp: string | undefined,
  range?: AssistantInsightsRange,
  since?: string,
  until?: string,
): boolean {
  const time = timestamp ? new Date(timestamp).getTime() : Number.NaN;
  if (!Number.isFinite(time)) return !range && !since && !until;
  const rangeTime = rangeStart(range)?.getTime();
  const sinceTime = parseDate(since)?.getTime();
  const untilTime = parseDate(until)?.getTime();
  if (rangeTime !== undefined && time < rangeTime) return false;
  if (sinceTime !== undefined && time < sinceTime) return false;
  if (untilTime !== undefined && time > untilTime) return false;
  return true;
}

function filterScansByWindow(
  scans: readonly SessionScanResult[],
  args: Pick<InsightsArgs | UsageArgs, "range" | "since" | "until">,
): SessionScanResult[] {
  return scans.filter((scan) => inDateWindow(scan.startTime, args.range, args.since, args.until));
}

interface AssistantMetricDistribution {
  buckets: Array<{ label: string; count: number; pct: number }>;
  percentiles: { p25: number; p50: number; p75: number; p95: number; p99: number };
  sampleCount: number;
}

interface AssistantMetricDistributions {
  durationMs?: AssistantMetricDistribution;
  toolCalls?: AssistantMetricDistribution;
  turns?: AssistantMetricDistribution;
  tokens?: AssistantMetricDistribution;
}

interface AssistantPerTurnDistributions {
  durationMs?: AssistantMetricDistribution;
  toolCalls?: AssistantMetricDistribution;
  tokens?: AssistantMetricDistribution;
}

const SESSION_DISTRIBUTION_BUCKETS = {
  durationMs: [
    { label: "<30s", max: 30_000 },
    { label: "30s-1m", max: 60_000 },
    { label: "1-2m", max: 120_000 },
    { label: "2-5m", max: 300_000 },
    { label: "5-10m", max: 600_000 },
    { label: "10m+", max: Number.POSITIVE_INFINITY },
  ],
  toolCalls: [
    { label: "0", max: 1 },
    { label: "1-5", max: 6 },
    { label: "6-10", max: 11 },
    { label: "11-25", max: 26 },
    { label: "26-50", max: 51 },
    { label: "51-100", max: 101 },
    { label: "100+", max: Number.POSITIVE_INFINITY },
  ],
  turns: [
    { label: "0", max: 1 },
    { label: "1-2", max: 3 },
    { label: "3-5", max: 6 },
    { label: "6-10", max: 11 },
    { label: "11-20", max: 21 },
    { label: "21-50", max: 51 },
    { label: "50+", max: Number.POSITIVE_INFINITY },
  ],
  tokens: [
    { label: "<1k", max: 1_000 },
    { label: "1-10k", max: 10_000 },
    { label: "10-50k", max: 50_000 },
    { label: "50-100k", max: 100_000 },
    { label: "100-250k", max: 250_000 },
    { label: "250-500k", max: 500_000 },
    { label: "500k+", max: Number.POSITIVE_INFINITY },
  ],
} as const;

function percentile(sorted: readonly number[], percent: number): number {
  if (sorted.length === 0) return 0;
  const index = (percent / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower] || 0;
  return (sorted[lower] || 0) + ((sorted[upper] || 0) - (sorted[lower] || 0)) * (index - lower);
}

function buildMetricDistribution(
  values: readonly number[],
  buckets: readonly { label: string; max: number }[],
): AssistantMetricDistribution | undefined {
  const sorted = values
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const counts = buckets.map(() => 0);
  for (const value of sorted) {
    const index = buckets.findIndex((bucket) => value < bucket.max);
    if (index >= 0) counts[index]++;
  }
  return {
    buckets: buckets.map((bucket, index) => ({
      label: bucket.label,
      count: counts[index] || 0,
      pct: Math.round(((counts[index] || 0) / sorted.length) * 1000) / 10,
    })),
    percentiles: {
      p25: percentile(sorted, 25),
      p50: percentile(sorted, 50),
      p75: percentile(sorted, 75),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    },
    sampleCount: sorted.length,
  };
}

function buildSessionMetricDistributions(
  scans: readonly SessionScanResult[],
): AssistantMetricDistributions | undefined {
  const values = {
    durationMs: [] as number[],
    toolCalls: [] as number[],
    turns: [] as number[],
    tokens: [] as number[],
  };
  for (const scan of scans) {
    if (scan.durationMs !== undefined) values.durationMs.push(scan.durationMs);
    values.toolCalls.push(scan.toolCallCount);
    values.turns.push(scan.promptCount);
    if (scan.tokenUsage) {
      values.tokens.push(
        scan.tokenUsage.inputTokens +
          scan.tokenUsage.outputTokens +
          scan.tokenUsage.cacheReadTokens +
          scan.tokenUsage.cacheCreationTokens,
      );
    }
  }
  const result: AssistantMetricDistributions = {};
  for (const key of Object.keys(SESSION_DISTRIBUTION_BUCKETS) as Array<keyof typeof values>) {
    const distribution = buildMetricDistribution(values[key], SESSION_DISTRIBUTION_BUCKETS[key]);
    if (distribution) result[key] = distribution;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function buildPerTurnDistributions(
  scans: readonly SessionScanResult[],
): AssistantPerTurnDistributions | undefined {
  const values = { durationMs: [] as number[], toolCalls: [] as number[], tokens: [] as number[] };
  for (const scan of scans) {
    for (const turn of scan.turnMetrics || []) {
      if (turn.durationMs !== undefined) values.durationMs.push(turn.durationMs);
      values.toolCalls.push(turn.toolCalls);
      if (turn.tokens !== undefined) values.tokens.push(turn.tokens);
    }
  }
  const result: AssistantPerTurnDistributions = {};
  for (const key of Object.keys(values) as Array<keyof typeof values>) {
    const distribution = buildMetricDistribution(values[key], SESSION_DISTRIBUTION_BUCKETS[key]);
    if (distribution) result[key] = distribution;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function activitySummary(sessionsPerDay: Record<string, number>) {
  const dates = Object.keys(sessionsPerDay)
    .filter((date) => sessionsPerDay[date] > 0)
    .sort();
  let longest = 0;
  let longestStart: string | undefined;
  let longestEnd: string | undefined;
  let currentLength = 0;
  let currentStart = "";
  const previousLocalDayKey = (date: string): string | undefined => {
    const cursor = new Date(`${date}T00:00:00`);
    cursor.setDate(cursor.getDate() - 1);
    return localDayKey(cursor);
  };
  for (let index = 0; index < dates.length; index++) {
    const date = dates[index]!;
    if (index === 0 || previousLocalDayKey(date) !== dates[index - 1]) {
      if (currentLength > longest) {
        longest = currentLength;
        longestStart = currentStart;
        longestEnd = dates[index - 1];
      }
      currentLength = 1;
      currentStart = date;
    } else {
      currentLength++;
    }
  }
  if (currentLength > longest) {
    longest = currentLength;
    longestStart = currentStart;
    longestEnd = dates[dates.length - 1];
  }

  const today = new Date();
  let current = 0;
  const cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  while (true) {
    const day = localDayKey(cursor);
    if (!day || !sessionsPerDay[day]) break;
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }
  const peak = dates.reduce<{ date: string; sessions: number } | undefined>((best, date) => {
    const sessions = sessionsPerDay[date] || 0;
    return !best || sessions > best.sessions ? { date, sessions } : best;
  }, undefined);
  return {
    activeDays: dates.length,
    currentStreak: current,
    longestStreak: longest,
    longestStreakStart: longestStart,
    longestStreakEnd: longestEnd,
    peakDay: peak,
  };
}

interface AggregatedUsage {
  sessions: number;
  indexedSessions: number;
  tools: Record<string, number>;
  mcpServers: Record<string, number>;
  mcpTools: Record<string, number>;
  skills: Record<string, number>;
  successCount: number;
  errorCount: number;
  unknownCount: number;
  totalDurationMs: number;
  durationCount: number;
  qualityNotes: string[];
}

function aggregateUsage(scans: readonly SessionScanResult[]): AggregatedUsage {
  const result: AggregatedUsage = {
    sessions: scans.length,
    indexedSessions: scans.filter((scan) => scan.usageIndexed === true).length,
    tools: {},
    mcpServers: {},
    mcpTools: {},
    skills: {},
    successCount: 0,
    errorCount: 0,
    unknownCount: 0,
    totalDurationMs: 0,
    durationCount: 0,
    qualityNotes: [],
  };
  for (const scan of scans) {
    const usage = scan.usageSummary;
    if (!usage) {
      result.qualityNotes.push(`${scan.provider}/${scan.slug}: usage summary unavailable`);
      continue;
    }
    for (const [name, count] of Object.entries(usage.tools || {})) {
      result.tools[name] = (result.tools[name] || 0) + count;
    }
    for (const [name, count] of Object.entries(usage.mcpServers || {})) {
      result.mcpServers[name] = (result.mcpServers[name] || 0) + count;
    }
    for (const [name, count] of Object.entries(usage.mcpTools || {})) {
      result.mcpTools[name] = (result.mcpTools[name] || 0) + count;
    }
    for (const [name, count] of Object.entries(usage.skills || {})) {
      result.skills[name] = (result.skills[name] || 0) + count;
    }
    result.successCount += usage.successCount;
    result.errorCount += usage.errorCount;
    const knownEvents = (scan.usageEvents || []).filter(
      (event) => event.status === "success" || event.status === "error",
    );
    result.unknownCount += Math.max(0, (scan.usageEvents || []).length - knownEvents.length);
    result.totalDurationMs += usage.totalDurationMs;
    result.durationCount += usage.durationCount;
    result.qualityNotes.push(...(scan.dataQualityNotes || []));
  }
  result.qualityNotes = [...new Set(result.qualityNotes)].slice(0, 20);
  return result;
}

export function createLocalAssistantTools(
  data: LocalAssistantData,
  context: LocalAssistantContext,
): LocalAssistantTool[] {
  const searchSessions: LocalAssistantTool = {
    name: "search_sessions",
    label: "Search local sessions",
    description:
      "Search local AI coding sessions and generated replays using the same dimensions as the Sessions/Replays explorer: prompt, project, provider, model, repository, branch, tool, MCP server/tool, skill, compaction, replay availability, date range, archive state, and sort order. Use this before making factual claims about the user's sessions.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Words to find in session metadata or prompts" }),
      ),
      provider: Type.Optional(
        Type.String({ description: "Provider filter such as claude-code, cursor, codex, or pi" }),
      ),
      project: Type.Optional(Type.String({ description: "Project path or repository filter" })),
      targetId: Type.Optional(Type.String({ description: "SSH source id for remote sessions" })),
      repo: Type.Optional(Type.String({ description: "Git repository or owner/repo filter" })),
      model: Type.Optional(Type.String({ description: "Model id filter" })),
      branch: Type.Optional(Type.String({ description: "Git branch filter" })),
      tool: Type.Optional(
        Type.Union([
          Type.String({ description: "Tool name or partial name" }),
          Type.Array(Type.String(), { description: "Tool names; match any" }),
        ]),
      ),
      mcpServer: Type.Optional(
        Type.Union([
          Type.String({ description: "MCP server name or partial name" }),
          Type.Array(Type.String(), { description: "MCP server names; match any" }),
        ]),
      ),
      mcpTool: Type.Optional(
        Type.Union([
          Type.String({ description: "MCP server/tool name or partial name" }),
          Type.Array(Type.String(), { description: "MCP tool names; match any" }),
        ]),
      ),
      skill: Type.Optional(
        Type.Union([
          Type.String({ description: "Skill name or partial name" }),
          Type.Array(Type.String(), { description: "Skill names; match any" }),
        ]),
      ),
      compacted: Type.Optional(Type.Boolean({ description: "Only sessions with compaction" })),
      archived: Type.Optional(
        Type.Boolean({ description: "Only archived or only active sessions" }),
      ),
      hasReplay: Type.Optional(
        Type.Boolean({ description: "Require (or exclude) generated replay" }),
      ),
      sortBy: Type.Optional(
        Type.Union([
          Type.Literal("recent"),
          Type.Literal("oldest"),
          Type.Literal("cost"),
          Type.Literal("duration"),
          Type.Literal("prompts"),
          Type.Literal("toolCalls"),
          Type.Literal("edits"),
        ]),
      ),
      since: Type.Optional(
        Type.String({ description: "ISO date/time or relative form such as 7d" }),
      ),
      until: Type.Optional(Type.String({ description: "ISO date/time upper bound" })),
      limit: Type.Optional(Type.Number({ description: "Maximum results, from 1 to 20" })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as SearchArgs;
      const allRecords = await buildSessionRecords(data);
      const archivedKeys = new Set(await data.getArchivedKeys?.());
      const records = allRecords.filter(
        (record) =>
          (context.allowRemoteData || !isRemoteRecord(record)) &&
          (!args.targetId || recordTargetId(record) === args.targetId),
      );
      const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(args.limit || 8)));
      const sortBy = args.sortBy || "recent";
      const matches = records.filter((record) =>
        searchMatches(record, args, isArchivedRecord(record, archivedKeys)),
      );
      const metric = (record: AssistantSessionRecord): number => {
        const stats = resultStats(record);
        if (sortBy === "cost") return stats.cost || 0;
        if (sortBy === "duration") return stats.durationMs || 0;
        if (sortBy === "prompts") return stats.prompts;
        if (sortBy === "toolCalls") return stats.toolCalls;
        if (sortBy === "edits") return stats.edits;
        return new Date(recordTimestamp(record) || 0).getTime() || 0;
      };
      matches.sort((a, b) => {
        const difference = metric(b) - metric(a);
        if (difference !== 0) return sortBy === "oldest" ? -difference : difference;
        return recordTitle(a).localeCompare(recordTitle(b));
      });
      const results = matches
        .slice(0, limit)
        .map((record) => resultRecord(record, isArchivedRecord(record, archivedKeys)));
      const citations = matches.slice(0, limit).map((record) => sessionCitation(record));
      return toolResult(
        "search_sessions",
        `Found ${matches.length} matching local session${matches.length === 1 ? "" : "s"}${!context.allowRemoteData && allRecords.some(isRemoteRecord) ? " (SSH sessions are hidden until enabled)" : ""}`,
        {
          total: matches.length,
          results,
          truncated: matches.length > limit,
          sortBy,
          filters: {
            provider: args.provider,
            project: args.project,
            repo: args.repo,
            tool: argumentStrings(args.tool),
            mcpServer: argumentStrings(args.mcpServer),
            mcpTool: argumentStrings(args.mcpTool),
            skill: argumentStrings(args.skill),
            compacted: args.compacted,
            archived: args.archived,
            hasReplay: args.hasReplay,
            since: args.since,
            until: args.until,
          },
          remoteSessionsHidden: context.allowRemoteData
            ? undefined
            : allRecords.filter(isRemoteRecord).length || undefined,
        },
        {
          citations,
          remoteData: context.allowRemoteData && matches.some(isRemoteRecord),
        },
      );
    },
  };

  const getSessionSummary: LocalAssistantTool = {
    name: "get_session_summary",
    label: "Read session summary",
    description:
      "Read structured metadata and a compact prompt/tool summary for one generated local replay. Requires a slug returned by search_sessions or the current replay context.",
    parameters: Type.Object({
      slug: Type.String({ description: "Generated replay slug" }),
      targetId: Type.Optional(
        Type.String({ description: "SSH source id when the session is remote" }),
      ),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as SessionArgs;
      const record = findRecord(await buildSessionRecords(data), args);
      if (!record?.replay) throw new Error(`Generated replay not found: ${args.slug}`);
      assertRecordAccess(record, context);
      const session = await data.getSession(args.slug, args.targetId);
      const overlays = await data.getOverlays?.(args.slug, args.targetId);
      const payload = sessionSummary(session, record, overlays);
      return toolResult("get_session_summary", `Read summary for ${payload.title}`, payload, {
        citations: [sessionCitation(record)],
        remoteData: isRemoteRecord(record),
      });
    },
  };

  const getSessionContent: LocalAssistantTool = {
    name: "get_session_content",
    label: "Read replay scenes",
    description:
      "Read a bounded slice of scenes from one generated local replay. Use sceneStart/sceneEnd or query to avoid loading an entire large replay.",
    parameters: Type.Object({
      slug: Type.String({ description: "Generated replay slug" }),
      targetId: Type.Optional(
        Type.String({ description: "SSH source id when the session is remote" }),
      ),
      sceneStart: Type.Optional(Type.Number({ description: "Inclusive scene index" })),
      sceneEnd: Type.Optional(Type.Number({ description: "Inclusive scene index" })),
      query: Type.Optional(Type.String({ description: "Text to find in scene content" })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as ContentArgs;
      const record = findRecord(await buildSessionRecords(data), args);
      if (!record?.replay) throw new Error(`Generated replay not found: ${args.slug}`);
      assertRecordAccess(record, context);
      const session = await data.getSession(args.slug, args.targetId);
      const overlays = await data.getOverlays?.(args.slug, args.targetId);
      const latestByScene = latestOverlayByScene(overlays);
      const requestedQuery = args.query?.trim().toLowerCase();
      let indices: number[];
      if (requestedQuery) {
        indices = session.scenes
          .map((scene, index) =>
            sceneText(effectiveScene(session, index, overlays, latestByScene), index)
              .toLowerCase()
              .includes(requestedQuery)
              ? index
              : -1,
          )
          .filter((index) => index >= 0);
      } else {
        const start = Math.max(
          0,
          Math.floor(args.sceneStart ?? context.currentSession?.sceneIndex ?? 0),
        );
        const end = Math.min(
          session.scenes.length - 1,
          Math.max(start, Math.floor(args.sceneEnd ?? start + 24)),
        );
        indices = Array.from(
          { length: Math.max(0, end - start + 1) },
          (_, offset) => start + offset,
        );
      }
      if (requestedQuery && indices.length > 0) {
        const expanded = new Set<number>();
        for (const index of indices.slice(0, 12)) {
          for (let offset = -1; offset <= 1; offset++) {
            if (index + offset >= 0 && index + offset < session.scenes.length)
              expanded.add(index + offset);
          }
        }
        indices = [...expanded].sort((a, b) => a - b);
      }

      let chars = 0;
      const scenes: Array<{ index: number; text: string; permalink: string }> = [];
      for (const index of indices) {
        const text = sceneText(effectiveScene(session, index, overlays, latestByScene), index);
        const bounded = text.length > MAX_SCENE_CHARS ? `${text.slice(0, MAX_SCENE_CHARS)}…` : text;
        if (chars + bounded.length > MAX_CONTENT_CHARS) break;
        chars += bounded.length;
        scenes.push({ index, text: bounded, permalink: recordPermalink(record, index) });
      }

      const payload = {
        title: session.meta.title || recordTitle(record),
        slug: session.meta.slug,
        permalink: recordPermalink(record, context.currentSession?.sceneIndex),
        sceneCount: session.scenes.length,
        query: requestedQuery || undefined,
        contentSource: overlays?.overlays.length ? "effective-with-overlays" : "replay",
        overlayCount: overlays?.overlays.length || 0,
        scenes,
        truncated: scenes.length < indices.length,
      };
      return toolResult(
        "get_session_content",
        `Read ${scenes.length} replay scene${scenes.length === 1 ? "" : "s"}`,
        payload,
        {
          citations: scenes.map(({ index }) => sessionCitation(record, index)),
          remoteData: isRemoteRecord(record),
        },
      );
    },
  };

  const getScene: LocalAssistantTool = {
    name: "get_scene",
    label: "Read replay scene",
    description:
      "Read one exact scene from a generated local replay. Use the scene index from a citation or get_session_content.",
    parameters: Type.Object({
      slug: Type.String({ description: "Generated replay slug" }),
      targetId: Type.Optional(
        Type.String({ description: "SSH source id when the session is remote" }),
      ),
      sceneIndex: Type.Number({ description: "Exact zero-based scene index" }),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as SceneArgs;
      const record = findRecord(await buildSessionRecords(data), args);
      if (!record?.replay) throw new Error(`Generated replay not found: ${args.slug}`);
      assertRecordAccess(record, context);
      const session = await data.getSession(args.slug, args.targetId);
      const overlays = await data.getOverlays?.(args.slug, args.targetId);
      const latestByScene = latestOverlayByScene(overlays);
      const sceneIndex = Math.floor(args.sceneIndex);
      if (sceneIndex < 0 || sceneIndex >= session.scenes.length) {
        throw new Error(`Scene index out of range: ${args.sceneIndex}`);
      }
      const scene = effectiveScene(session, sceneIndex, overlays, latestByScene);
      const payload = {
        slug: session.meta.slug,
        sceneIndex,
        permalink: recordPermalink(record, sceneIndex),
        scene: sceneText(scene, sceneIndex),
        type: scene.type,
        timestamp: scene.timestamp,
        contentSource: overlays?.overlays.some((overlay) => overlay.sceneIndex === sceneIndex)
          ? "effective-with-overlay"
          : "replay",
        annotationCount:
          session.annotations?.filter((annotation) => annotation.sceneIndex === sceneIndex)
            .length || 0,
        annotations: session.annotations
          ?.filter((annotation) => annotation.sceneIndex === sceneIndex)
          .slice(0, MAX_ANNOTATIONS)
          .map(annotationPayload),
        ...(scene.type === "tool-call"
          ? {
              toolName: scene.toolName,
              input: compact(JSON.stringify(scene.input), 2_000),
              result: compact(scene.result, 2_500),
              isError: scene.isError,
              durationMs: scene.durationMs,
              diffs: (scene.diffs || (scene.diff ? [scene.diff] : [])).slice(0, 4).map((diff) => ({
                filePath: diff.filePath,
                oldContent: compact(diff.oldContent, 1_600),
                newContent: compact(diff.newContent, 1_600),
              })),
              bashOutput: scene.bashOutput
                ? {
                    command: compact(scene.bashOutput.command, 1_000),
                    stdout: compact(scene.bashOutput.stdout, 2_000),
                  }
                : undefined,
            }
          : {}),
      };
      return toolResult("get_scene", `Read scene ${sceneIndex}`, payload, {
        citations: [sessionCitation(record, sceneIndex)],
        remoteData: isRemoteRecord(record),
      });
    },
  };

  const getSessionAnnotations: LocalAssistantTool = {
    name: "get_session_annotations",
    label: "Read replay annotations",
    description:
      "Read the comments/feedback attached to replay scenes, including selected text and resolved state. Use this when the user asks what was noted, coached, or left unresolved on a replay.",
    parameters: Type.Object({
      slug: Type.String({ description: "Generated replay slug" }),
      targetId: Type.Optional(
        Type.String({ description: "SSH source id when the session is remote" }),
      ),
      sceneIndex: Type.Optional(Type.Number({ description: "Only annotations for this scene" })),
      unresolvedOnly: Type.Optional(Type.Boolean({ description: "Only unresolved annotations" })),
      limit: Type.Optional(Type.Number({ description: "Maximum annotations, from 1 to 40" })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as AnnotationArgs;
      const record = findRecord(await buildSessionRecords(data), args);
      if (!record?.replay) throw new Error(`Generated replay not found: ${args.slug}`);
      assertRecordAccess(record, context);
      const session = await data.getSession(args.slug, args.targetId);
      const annotations = (session.annotations || [])
        .filter(
          (annotation) =>
            args.sceneIndex === undefined || annotation.sceneIndex === args.sceneIndex,
        )
        .filter((annotation) => !args.unresolvedOnly || !annotation.resolved)
        .sort((a, b) => a.sceneIndex - b.sceneIndex || a.createdAt.localeCompare(b.createdAt));
      const limit = Math.max(
        1,
        Math.min(MAX_ANNOTATIONS, Math.floor(args.limit || MAX_ANNOTATIONS)),
      );
      const selected = annotations.slice(0, limit);
      const sceneIndices = [...new Set(selected.map((annotation) => annotation.sceneIndex))];
      const actions: LocalAssistantAction[] = sceneIndices.slice(0, 8).map((sceneIndex) => ({
        type: "open_replay",
        label: `Open scene ${sceneIndex}`,
        slug: args.slug,
        ...(args.targetId ? { targetId: args.targetId } : {}),
        sceneIndex,
        permalink: replayPermalink(args.slug, args.targetId, sceneIndex),
      }));
      const payload = {
        title: session.meta.title || recordTitle(record),
        slug: session.meta.slug,
        permalink: recordPermalink(record),
        total: annotations.length,
        unresolved: session.annotations?.filter((annotation) => !annotation.resolved).length || 0,
        truncated: annotations.length > selected.length,
        annotations: selected.map((annotation) => ({
          ...annotationPayload(annotation),
          permalink: recordPermalink(record, annotation.sceneIndex),
        })),
      };
      return toolResult(
        "get_session_annotations",
        `Read ${selected.length} replay annotation${selected.length === 1 ? "" : "s"}`,
        payload,
        {
          citations: selected.map((annotation) => sessionCitation(record, annotation.sceneIndex)),
          actions,
          remoteData: isRemoteRecord(record),
        },
      );
    },
  };

  const getSessionOverlays: LocalAssistantTool = {
    name: "get_session_overlays",
    label: "Read replay AI edits",
    description:
      "Read non-destructive AI Studio edits (translations, tone adjustments, or manual overlays) applied to a replay. This is read-only and helps distinguish the original transcript from what the user currently sees.",
    parameters: Type.Object({
      slug: Type.String({ description: "Generated replay slug" }),
      targetId: Type.Optional(
        Type.String({ description: "SSH source id when the session is remote" }),
      ),
      sceneIndex: Type.Optional(Type.Number({ description: "Only overlays for this scene" })),
      source: Type.Optional(
        Type.Union([Type.Literal("translate"), Type.Literal("tone"), Type.Literal("manual")]),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum overlays, from 1 to 40" })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as OverlayArgs;
      const record = findRecord(await buildSessionRecords(data), args);
      if (!record?.replay) throw new Error(`Generated replay not found: ${args.slug}`);
      assertRecordAccess(record, context);
      const overlays = await data.getOverlays?.(args.slug, args.targetId);
      if (!overlays) throw new Error("Replay overlay data is unavailable for this server");
      const matching = overlays.overlays
        .filter(
          (overlay) => args.sceneIndex === undefined || overlay.sceneIndex === args.sceneIndex,
        )
        .filter((overlay) => !args.source || overlay.source.type === args.source)
        .sort((a, b) => a.sceneIndex - b.sceneIndex || a.updatedAt.localeCompare(b.updatedAt));
      const limit = Math.max(1, Math.min(MAX_OVERLAYS, Math.floor(args.limit || MAX_OVERLAYS)));
      const selected = matching.slice(0, limit);
      return toolResult(
        "get_session_overlays",
        `Read ${selected.length} replay overlay${selected.length === 1 ? "" : "s"}`,
        {
          title: recordTitle(record),
          slug: args.slug,
          permalink: recordPermalink(record),
          total: matching.length,
          truncated: matching.length > selected.length,
          overlays: selected.map((overlay) => ({
            ...overlayPayload(overlay),
            permalink: recordPermalink(record, overlay.sceneIndex),
          })),
        },
        {
          citations: selected.map((overlay) => sessionCitation(record, overlay.sceneIndex)),
          remoteData: isRemoteRecord(record),
        },
      );
    },
  };

  const getDataStatus: LocalAssistantTool = {
    name: "get_data_status",
    label: "Check local data status",
    description:
      "Explain whether the local session catalog, replay catalog, insights scan, and usage index are complete, cached, stale, or still refreshing. Use this before interpreting missing results as proof of absence.",
    parameters: Type.Object({
      includeRemote: Type.Optional(
        Type.Boolean({ description: "Include SSH-backed counts only when SSH consent is enabled" }),
      ),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as DataStatusArgs;
      if (args.includeRemote && !context.allowRemoteData) {
        throw new Error(
          "SSH data is disabled. Enable SSH session data in Ask Replay before including remote status.",
        );
      }
      const includeRemote = context.allowRemoteData === true && args.includeRemote !== false;
      const allRecords = await buildSessionRecords(data);
      const visibleRecords = allRecords.filter(
        (record) => includeRemote || !isRemoteRecord(record),
      );
      const visibleReplayCount = visibleRecords.filter((record) =>
        Boolean(recordRef(record)),
      ).length;
      const status = await data.getDataStatus?.(visibleReplayCount);
      const visibleScans = data
        .getScanResults()
        .filter((scan) => includeRemote || scan.location?.kind !== "ssh");
      return toolResult(
        "get_data_status",
        "Read local catalog and indexing status",
        {
          ...status,
          permalink: dashboardPermalink({ tab: "insights" }),
          visibleSessions: visibleRecords.length,
          visibleReplays: visibleReplayCount,
          visibleScanResults: visibleScans.length,
          remoteSessionsHidden: includeRemote
            ? undefined
            : allRecords.filter(isRemoteRecord).length || undefined,
          remoteDataIncluded: includeRemote,
        },
        { remoteData: includeRemote && allRecords.some(isRemoteRecord) },
      );
    },
  };

  const getInsights: LocalAssistantTool = {
    name: "get_insights",
    label: "Read local insights",
    description:
      "Read the same local analytics shown by the Insights and Projects pages: exact 7d/30d/90d/all-time totals, activity, projects, models, providers, token/cost data, session and per-turn distributions, Tools/MCP/skills usage, coverage, and project hot files/branches.",
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
      project: Type.Optional(Type.String({ description: "Project path for project scope" })),
      targetId: Type.Optional(Type.String({ description: "SSH source id for a remote project" })),
      range: Type.Optional(
        Type.Union([
          Type.Literal("7d"),
          Type.Literal("30d"),
          Type.Literal("90d"),
          Type.Literal("all"),
        ]),
      ),
      since: Type.Optional(Type.String({ description: "Custom ISO lower bound" })),
      until: Type.Optional(Type.String({ description: "Custom ISO upper bound" })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as InsightsArgs;
      if (args.targetId && !context.allowRemoteData) {
        throw new Error(
          "These insights belong to an SSH source. Enable SSH session data in Ask Replay first.",
        );
      }
      const allScans = data
        .getScanResults()
        .filter((scan) => context.allowRemoteData || scan.location?.kind !== "ssh")
        .filter((scan) => !args.targetId || targetIdFor(scan.location) === args.targetId);
      const rangedScans = filterScansByWindow(allScans, args);
      const rangeRequested =
        (args.range && args.range !== "all") ||
        args.since !== undefined ||
        args.until !== undefined;

      if (args.scope === "project") {
        const project = args.project || context.project;
        if (!project) throw new Error("project is required for project insights");
        const projectScans = rangedScans.filter(
          (scan) =>
            targetIdFor(scan.location) === args.targetId &&
            (scan.project === project || scan.projectIdentity?.key === project),
        );
        const insights = rangeRequested
          ? aggregateProjectInsights(
              project,
              projectScans,
              undefined,
              args.targetId
                ? (projectScans.find((scan) => targetIdFor(scan.location) === args.targetId)
                    ?.location ?? { kind: "ssh", id: args.targetId, label: args.targetId })
                : "local",
            )
          : await data.getProjectInsights(project, args.targetId);
        if (!insights || (rangeRequested && projectScans.length === 0)) {
          throw new Error(`No insights found for project: ${project}`);
        }
        const scopedScans = rangeRequested
          ? projectScans
          : allScans.filter(
              (scan) =>
                targetIdFor(scan.location) === args.targetId &&
                (scan.project === project || scan.projectIdentity?.key === project),
            );
        const usage = aggregateUsage(scopedScans);
        const tokenBreakdown = insights.tokenBreakdown;
        const insightPermalink = dashboardPermalink({
          tab: "insights",
          project,
          targetId: args.targetId,
          insightsRange: args.range,
        });
        const payload = {
          scope: "project",
          range: args.range || (args.since || args.until ? "custom" : "all"),
          permalink: insightPermalink,
          project: insights.project,
          location: insights.location,
          sessionCount: insights.sessionCount,
          totalDurationMs: insights.totalDurationMs,
          totalCost: insights.totalCost,
          totalPrompts: insights.totalPrompts,
          totalToolCalls: insights.totalToolCalls,
          totalEdits: insights.totalEdits,
          models: insights.models,
          branches: insights.branches.slice(0, 12),
          hotFiles: insights.hotFiles.slice(0, 12),
          subAgentTotal: insights.subAgentTotal,
          apiErrorTotal: insights.apiErrorTotal,
          timeRange: insights.timeRange,
          avgSessionDurationMs: insights.avgSessionDurationMs,
          medianTurnDurationMs: insights.medianTurnDurationMs,
          sessionsPerDay: insights.sessionsPerDay,
          tokenBreakdown,
          tokenMetrics: tokenBreakdown
            ? deriveTokenUsageMetrics({
                inputTokens: tokenBreakdown.input,
                outputTokens: tokenBreakdown.output,
                cacheReadTokens: tokenBreakdown.cacheRead,
                cacheCreationTokens: tokenBreakdown.cacheCreation,
              })
            : undefined,
          turnDurationHistogram: insights.turnDurationHistogram,
          usage: {
            sessions: usage.sessions,
            indexedSessions: usage.indexedSessions,
            tools: usageEntries(usage.tools),
            mcpServers: usageEntries(usage.mcpServers),
            mcpTools: usageEntries(usage.mcpTools),
            skills: usageEntries(usage.skills),
            successCount: usage.successCount,
            errorCount: usage.errorCount,
            unknownCount: usage.unknownCount,
            totalDurationMs: usage.totalDurationMs,
            durationCount: usage.durationCount,
            qualityNotes: usage.qualityNotes,
          },
          coverage: buildUsageCoverageReport(scopedScans),
          dataQuality: insights.dataQuality,
        };
        return toolResult("get_insights", `Read insights for ${project}`, payload, {
          citations: [
            {
              type: "insight",
              label: `Insights · ${project}`,
              permalink: insightPermalink,
              project,
              ...(args.targetId ? { targetId: args.targetId } : {}),
            },
          ],
          remoteData: scopedScans.some((scan) => targetIdFor(scan.location) !== undefined),
        });
      }

      const cachedInsights = await data.getUserInsights(context.allowRemoteData);
      if (allScans.length === 0 && !cachedInsights) {
        throw new Error("No local insights are available yet. Run a dashboard scan first.");
      }
      const insights = rangeRequested
        ? aggregateUserInsights(rangedScans)
        : cachedInsights || aggregateUserInsights(allScans);
      if (!insights)
        throw new Error("No local insights are available yet. Run a dashboard scan first.");
      const visibleRecords = (await buildSessionRecords(data)).filter(
        (record) => context.allowRemoteData || !isRemoteRecord(record),
      );
      const replays = visibleRecords.filter(
        (record) =>
          Boolean(recordRef(record)) &&
          inDateWindow(recordTimestamp(record), args.range, args.since, args.until),
      ).length;
      const usage = aggregateUsage(rangedScans);
      const tokenBreakdown = insights.tokenBreakdown;
      const activity = activitySummary(insights.sessionsPerDay || {});
      const insightPermalink = dashboardPermalink({
        tab: "insights",
        insightsRange: args.range,
      });
      const payload = {
        scope: "user",
        range: args.range || (args.since || args.until ? "custom" : "all"),
        permalink: insightPermalink,
        totalSessions: insights.totalSessions,
        totalReplays: replays,
        totalProjects: insights.totalProjects,
        totalDurationMs: insights.totalDurationMs,
        totalCost: insights.totalCost,
        totalPrompts: insights.totalPrompts,
        totalToolCalls: insights.totalToolCalls,
        totalEdits: insights.totalEdits,
        providers: insights.providers,
        models: insights.models,
        topProjects: insights.topProjects.slice(0, 12),
        timeRange: insights.timeRange,
        sessionsPerDay: insights.sessionsPerDay,
        activity,
        subAgentTotal: insights.subAgentTotal,
        apiErrorTotal: insights.apiErrorTotal,
        avgSessionDurationMs: insights.avgSessionDurationMs,
        medianTurnDurationMs: insights.medianTurnDurationMs,
        tokenBreakdown,
        tokenMetrics: tokenBreakdown
          ? deriveTokenUsageMetrics({
              inputTokens: tokenBreakdown.input,
              outputTokens: tokenBreakdown.output,
              cacheReadTokens: tokenBreakdown.cacheRead,
              cacheCreationTokens: tokenBreakdown.cacheCreation,
            })
          : undefined,
        turnDurationHistogram: insights.turnDurationHistogram,
        sessionMetricDistributions: buildSessionMetricDistributions(rangedScans),
        perTurnDistributions: buildPerTurnDistributions(rangedScans),
        usage: {
          sessions: usage.sessions,
          indexedSessions: usage.indexedSessions,
          tools: usageEntries(usage.tools),
          mcpServers: usageEntries(usage.mcpServers),
          mcpTools: usageEntries(usage.mcpTools),
          skills: usageEntries(usage.skills),
          successCount: usage.successCount,
          errorCount: usage.errorCount,
          unknownCount: usage.unknownCount,
          totalDurationMs: usage.totalDurationMs,
          durationCount: usage.durationCount,
          qualityNotes: usage.qualityNotes,
        },
        coverage: buildUsageCoverageReport(rangedScans),
        dataQuality: insights.dataQuality,
      };
      return toolResult("get_insights", "Read aggregate local insights", payload, {
        citations: [
          { type: "insight", label: "Personal local insights", permalink: insightPermalink },
        ],
        remoteData:
          context.allowRemoteData && rangedScans.some((scan) => targetIdFor(scan.location)),
      });
    },
  };

  const getUsageBreakdown: LocalAssistantTool = {
    name: "get_usage_breakdown",
    label: "Read usage breakdown",
    description:
      "Read the indexed Tools & MCP data used by the Insights and Sessions facets, optionally scoped to a session, project, provider, tool/MCP/skill, or 7d/30d/90d range. Invocation inputs and results are never exposed, but bounded metadata events can show timing and success/error status.",
    parameters: Type.Object({
      slug: Type.Optional(
        Type.String({ description: "Generated replay slug for a session-level breakdown" }),
      ),
      targetId: Type.Optional(
        Type.String({ description: "SSH source id when the session is remote" }),
      ),
      project: Type.Optional(
        Type.String({ description: "Project filter for an aggregate breakdown" }),
      ),
      provider: Type.Optional(Type.String({ description: "Provider filter" })),
      tool: Type.Optional(Type.String({ description: "Ordinary tool filter" })),
      mcpServer: Type.Optional(Type.String({ description: "MCP server filter" })),
      mcpTool: Type.Optional(Type.String({ description: "MCP server/tool filter" })),
      skill: Type.Optional(Type.String({ description: "Skill filter" })),
      range: Type.Optional(
        Type.Union([
          Type.Literal("7d"),
          Type.Literal("30d"),
          Type.Literal("90d"),
          Type.Literal("all"),
        ]),
      ),
      since: Type.Optional(Type.String({ description: "Custom ISO lower bound" })),
      until: Type.Optional(Type.String({ description: "Custom ISO upper bound" })),
      includeEvents: Type.Optional(
        Type.Boolean({ description: "Include bounded invocation metadata events" }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum session details, from 1 to 20" })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as UsageArgs;
      const allScans = data.getScanResults();
      const records = await buildSessionRecords(data);
      const requestedRecord = args.slug
        ? findRecord(records, { slug: args.slug, targetId: args.targetId }) ||
          records.find((record) => recordSlugs(record).includes(args.slug!))
        : undefined;
      if (args.slug && !requestedRecord) throw new Error(`Session not found: ${args.slug}`);
      if (requestedRecord) assertRecordAccess(requestedRecord, context);
      const scans = filterScansByWindow(allScans, args).filter((scan) => {
        if (!context.allowRemoteData && targetIdFor(scan.location)) return false;
        if (args.slug) {
          const sameSession =
            scan.slug === args.slug ||
            scan.sessionId === requestedRecord?.scan?.sessionId ||
            scan.sessionId === requestedRecord?.replay?.sessionId ||
            recordSlugs(requestedRecord || {}).includes(scan.slug);
          if (!sameSession) return false;
        }
        if (args.targetId !== targetIdFor(scan.location)) return false;
        if (args.provider && !scan.provider.toLowerCase().includes(args.provider.toLowerCase())) {
          return false;
        }
        if (
          args.project &&
          scan.project !== args.project &&
          scan.projectIdentity?.key !== args.project
        ) {
          return false;
        }
        const usage = scan.usageSummary;
        if (args.tool && !matchesStringFilters(Object.keys(usage?.tools || {}), args.tool)) {
          return false;
        }
        if (
          args.mcpServer &&
          !matchesStringFilters(
            [...new Set([...Object.keys(usage?.mcpServers || {}), ...(scan.mcpServersUsed || [])])],
            args.mcpServer,
          )
        ) {
          return false;
        }
        if (
          args.mcpTool &&
          !matchesStringFilters(Object.keys(usage?.mcpTools || {}), args.mcpTool)
        ) {
          return false;
        }
        if (args.skill && !matchesStringFilters(Object.keys(usage?.skills || {}), args.skill)) {
          return false;
        }
        return true;
      });
      if (scans.length === 0) throw new Error("No indexed usage data matched the request");
      const aggregate = aggregateUsage(scans);
      const detailsLimit = Math.max(1, Math.min(MAX_SESSION_LIST, Math.floor(args.limit || 12)));
      const detailRecords = records
        .filter((record) =>
          scans.some(
            (scan) =>
              scan.provider === recordProvider(record) &&
              scan.sessionId === recordSessionId(record) &&
              targetIdFor(scan.location) === recordTargetId(record),
          ),
        )
        .sort((a, b) => (recordTimestamp(b) || "").localeCompare(recordTimestamp(a) || ""))
        .slice(0, detailsLimit);
      const events =
        args.includeEvents || args.slug
          ? scans
              .flatMap((scan) =>
                (scan.usageEvents || []).map((event) => ({
                  provider: scan.provider,
                  sessionId: scan.sessionId,
                  slug: scan.slug,
                  project: scan.project,
                  ...(scan.location ? { location: scan.location } : {}),
                  ...event,
                })),
              )
              .slice(-100)
          : undefined;
      const usagePermalink = dashboardPermalink({
        tab: "sessions",
        project: args.project,
        targetId: args.targetId,
        tools: args.tool ? [args.tool] : undefined,
        mcpServers: args.mcpServer ? [args.mcpServer] : undefined,
        mcpTools: args.mcpTool ? [args.mcpTool] : undefined,
        skills: args.skill ? [args.skill] : undefined,
        insightsRange: args.range,
      });
      const payload = {
        range: args.range || (args.since || args.until ? "custom" : "all"),
        permalink: usagePermalink,
        sessions: aggregate.sessions,
        indexedSessions: aggregate.indexedSessions,
        tools: usageEntries(aggregate.tools),
        mcpServers: usageEntries(aggregate.mcpServers),
        mcpTools: usageEntries(aggregate.mcpTools),
        skills: usageEntries(aggregate.skills),
        successCount: aggregate.successCount,
        errorCount: aggregate.errorCount,
        unknownCount: aggregate.unknownCount,
        totalDurationMs: aggregate.totalDurationMs,
        durationCount: aggregate.durationCount,
        qualityNotes: aggregate.qualityNotes,
        sessionDetails: detailRecords.map((record) => resultRecord(record)),
        ...(events ? { events } : {}),
        coverage: buildUsageCoverageReport(scans),
      };
      return toolResult(
        "get_usage_breakdown",
        `Read usage for ${scans.length} session${scans.length === 1 ? "" : "s"}`,
        payload,
        {
          citations: requestedRecord
            ? [sessionCitation(requestedRecord)]
            : detailRecords.length > 0
              ? detailRecords.slice(0, 8).map((record) => sessionCitation(record))
              : [
                  {
                    type: "insight",
                    label: "Local usage index",
                    permalink: usagePermalink,
                    project: args.project,
                    ...(args.targetId ? { targetId: args.targetId } : {}),
                  },
                ],
          remoteData: scans.some((scan) => targetIdFor(scan.location) !== undefined),
        },
      );
    },
  };

  const getCompactionDiagnostics: LocalAssistantTool = {
    name: "get_compaction_diagnostics",
    label: "Diagnose compaction events",
    description:
      "Explain persisted compaction outcomes and ordinary assistant/API errors for one session or matching local sessions. Pi's JSONL format does not persist failed compaction lifecycle events, so absence of a failure is reported as inconclusive rather than treated as success.",
    parameters: Type.Object({
      slug: Type.Optional(Type.String({ description: "Generated replay or source session slug" })),
      targetId: Type.Optional(
        Type.String({ description: "SSH source id when the session is remote" }),
      ),
      provider: Type.Optional(
        Type.String({ description: "Provider filter; use pi for Pi session diagnostics" }),
      ),
      project: Type.Optional(Type.String({ description: "Project path filter" })),
      since: Type.Optional(
        Type.String({ description: "ISO date/time or relative form such as 7d" }),
      ),
      until: Type.Optional(Type.String({ description: "ISO date/time upper bound" })),
      limit: Type.Optional(Type.Number({ description: "Maximum sessions, from 1 to 20" })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as DiagnosticArgs;
      const allRecords = await buildSessionRecords(data);
      if (args.slug) {
        const record = findRecord(allRecords, { slug: args.slug, targetId: args.targetId });
        if (!record) throw new Error(`Session not found: ${args.slug}`);
        assertRecordAccess(record, context);
        const diagnostics = diagnosticRecord(record);
        return toolResult(
          "get_compaction_diagnostics",
          `Diagnosed ${recordTitle(record)}`,
          diagnostics,
          {
            citations: [sessionCitation(record)],
            remoteData: isRemoteRecord(record),
          },
        );
      }

      const records = allRecords
        .filter((record) => context.allowRemoteData || !isRemoteRecord(record))
        .filter((record) => !args.targetId || recordTargetId(record) === args.targetId)
        .filter((record) => searchMatches(record, args))
        .filter((record) => diagnosticsForRecord(record).events.length > 0)
        .sort((a, b) => (recordTimestamp(b) || "").localeCompare(recordTimestamp(a) || ""));
      const limit = Math.max(1, Math.min(20, Math.floor(args.limit || 12)));
      const selected = records.slice(0, limit);
      const totals = {
        sessions: records.length,
        ...records
          .map((record) => diagnosticCounts(diagnosticsForRecord(record).events))
          .reduce(
            (sum, counts) => ({
              successfulCompactions: sum.successfulCompactions + counts.successfulCompactions,
              automaticContextCompactions:
                sum.automaticContextCompactions + counts.automaticContextCompactions,
              unknownCompactions: sum.unknownCompactions + counts.unknownCompactions,
              compactionFailures: sum.compactionFailures + counts.compactionFailures,
              assistantApiErrors: sum.assistantApiErrors + counts.assistantApiErrors,
            }),
            {
              successfulCompactions: 0,
              automaticContextCompactions: 0,
              unknownCompactions: 0,
              compactionFailures: 0,
              assistantApiErrors: 0,
            },
          ),
      };
      const payload = {
        provider: args.provider || "all",
        project: args.project,
        totals,
        sessions: selected.map(diagnosticRecord),
        truncated: records.length > limit,
        remoteSessionsHidden: context.allowRemoteData
          ? undefined
          : allRecords.filter(isRemoteRecord).length || undefined,
      };
      return toolResult(
        "get_compaction_diagnostics",
        `Diagnosed ${selected.length} session${selected.length === 1 ? "" : "s"}`,
        payload,
        {
          citations: selected.map((record) => sessionCitation(record)),
          remoteData: context.allowRemoteData && selected.some(isRemoteRecord),
        },
      );
    },
  };

  const prepareUserAction: LocalAssistantTool = {
    name: "prepare_user_action",
    label: "Prepare user action link",
    description:
      "Prepare a safe user handoff for an operation that changes replay state or publishes data. This tool never performs the mutation; it returns a same-origin permalink and an explicit UI action for the user to review and click.",
    parameters: Type.Object({
      slug: Type.String({ description: "Source or generated replay slug" }),
      targetId: Type.Optional(
        Type.String({ description: "SSH source id when the session is remote" }),
      ),
      intent: Type.Union([
        Type.Literal("generate_replay"),
        Type.Literal("regenerate_replay"),
        Type.Literal("delete_replay"),
        Type.Literal("archive_replay"),
        Type.Literal("annotate_replay"),
        Type.Literal("ai_coach"),
        Type.Literal("translate_replay"),
        Type.Literal("soften_tone"),
        Type.Literal("export_replay"),
        Type.Literal("publish_replay"),
      ]),
      sceneIndex: Type.Optional(
        Type.Number({ description: "Scene to focus for scene-level work" }),
      ),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as UserActionArgs;
      const record = findRecord(await buildSessionRecords(data), args);
      if (!record) throw new Error(`Session not found: ${args.slug}`);
      assertRecordAccess(record, context);
      const replayRequired = new Set<UserActionIntent>([
        "annotate_replay",
        "ai_coach",
        "translate_replay",
        "soften_tone",
        "export_replay",
        "publish_replay",
      ]);
      if (args.intent === "delete_replay" && !record.replay) {
        throw new Error("This action requires a generated replay: delete_replay");
      }
      if (replayRequired.has(args.intent) && !record.replay) {
        throw new Error(`This action requires a generated replay: ${args.intent}`);
      }
      let sceneIndex: number | undefined;
      if (args.sceneIndex !== undefined) {
        sceneIndex = Math.max(0, Math.floor(args.sceneIndex));
        if (record.replay) {
          const session = await data.getSession(record.replay.slug, recordTargetId(record));
          if (sceneIndex >= session.scenes.length) {
            throw new Error(`Scene index out of range: ${args.sceneIndex}`);
          }
        }
      }

      const exportIntent = args.intent === "export_replay" || args.intent === "publish_replay";
      const action: LocalAssistantAction =
        record.replay && replayRequired.has(args.intent)
          ? {
              type: "open_replay",
              label: exportIntent
                ? `Review export for ${recordTitle(record)}`
                : `Review ${args.intent.replaceAll("_", " ")} for ${recordTitle(record)}`,
              slug: record.replay.slug,
              ...(recordTargetId(record) ? { targetId: recordTargetId(record) } : {}),
              ...(sceneIndex === undefined || exportIntent ? {} : { sceneIndex }),
              ...(exportIntent ? { view: "export" as const } : {}),
              ...(!exportIntent && args.intent === "annotate_replay"
                ? { drawer: "comments" as const }
                : {}),
              ...(!exportIntent && args.intent !== "annotate_replay"
                ? { drawer: "ai" as const }
                : {}),
              permalink: replayPermalink(
                record.replay.slug,
                recordTargetId(record),
                sceneIndex === undefined || exportIntent ? undefined : sceneIndex,
                exportIntent ? "export" : "replay",
                exportIntent ? undefined : args.intent === "annotate_replay" ? "comments" : "ai",
              ),
            }
          : {
              type: "open_dashboard",
              label: `Review ${args.intent.replaceAll("_", " ")} for ${recordTitle(record)}`,
              tab: "sessions",
              ...(recordProject(record) ? { project: recordProject(record) } : {}),
              ...(recordTargetId(record) ? { targetId: recordTargetId(record) } : {}),
              ...(sourceSlugFor(record) ? { selected: sourceSlugFor(record) } : {}),
              selectedProvider: recordProvider(record),
              ...(recordSessionId(record) ? { selectedSessionId: recordSessionId(record) } : {}),
              ...(recordTargetId(record) ? { selectedTargetId: recordTargetId(record) } : {}),
              permalink: sourcePermalink(record),
            };
      return toolResult(
        "prepare_user_action",
        "User action link ready; no mutation was performed",
        {
          intent: args.intent,
          mutation: true,
          requiresUserClick: true,
          confirmationRequired: true,
          resource: {
            title: recordTitle(record),
            provider: recordProvider(record),
            slug: record.replay?.slug || sourceSlugFor(record),
            targetId: recordTargetId(record),
          },
          permalink: action.permalink,
          action,
          instruction: "Review the linked UI and perform or cancel the operation there.",
        },
        {
          citations: [sessionCitation(record, record.replay ? sceneIndex : undefined)],
          actions: [action],
          remoteData: isRemoteRecord(record),
        },
      );
    },
  };

  const openReplay: LocalAssistantTool = {
    name: "open_replay",
    label: "Open replay",
    description:
      "Prepare a navigation action to open a generated local replay, summary, or export view, optionally at a specific scene. Use only when the user asks to open, inspect, or jump to a result.",
    parameters: Type.Object({
      slug: Type.String({ description: "Generated replay slug" }),
      targetId: Type.Optional(
        Type.String({ description: "SSH source id when the session is remote" }),
      ),
      sceneIndex: Type.Optional(Type.Number({ description: "Scene index to focus" })),
      view: Type.Optional(
        Type.Union([Type.Literal("replay"), Type.Literal("summary"), Type.Literal("export")]),
      ),
      drawer: Type.Optional(Type.Union([Type.Literal("comments"), Type.Literal("ai")])),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as OpenReplayArgs;
      const record = findRecord(await buildSessionRecords(data), args);
      if (!record?.replay) throw new Error(`Generated replay not found: ${args.slug}`);
      assertRecordAccess(record, context);
      const sceneIndex =
        args.sceneIndex === undefined ? undefined : Math.max(0, Math.floor(args.sceneIndex));
      if (sceneIndex !== undefined) {
        const session = await data.getSession(args.slug, args.targetId);
        if (sceneIndex >= session.scenes.length) {
          throw new Error(`Scene index out of range: ${args.sceneIndex}`);
        }
      }
      const action: LocalAssistantAction = {
        type: "open_replay",
        label:
          sceneIndex === undefined
            ? `Open ${recordTitle(record)}`
            : `Open ${recordTitle(record)} at scene ${sceneIndex}`,
        slug: args.slug,
        ...(args.targetId ? { targetId: args.targetId } : {}),
        ...(sceneIndex === undefined ? {} : { sceneIndex }),
        ...(args.view && args.view !== "replay" ? { view: args.view } : {}),
        ...(args.drawer ? { drawer: args.drawer } : {}),
        permalink: replayPermalink(
          args.slug,
          args.targetId,
          sceneIndex,
          args.view || "replay",
          args.drawer,
        ),
      };
      return toolResult(
        "open_replay",
        "Navigation action ready",
        { action },
        {
          citations: [sessionCitation(record, sceneIndex)],
          actions: [action],
          remoteData: isRemoteRecord(record),
        },
      );
    },
  };

  const openDashboard: LocalAssistantTool = {
    name: "open_dashboard",
    label: "Open dashboard view",
    description:
      "Prepare a navigation action to open a local Dashboard tab. This is read-only UI navigation and does not modify data.",
    parameters: Type.Object({
      tab: Type.Union([
        Type.Literal("home"),
        Type.Literal("sessions"),
        Type.Literal("replays"),
        Type.Literal("projects"),
        Type.Literal("insights"),
        Type.Literal("settings"),
      ]),
      project: Type.Optional(
        Type.String({ description: "Project filter for the projects or insights tab" }),
      ),
      targetId: Type.Optional(Type.String({ description: "SSH source id for a remote view" })),
      selected: Type.Optional(
        Type.String({ description: "Source session slug to open in the Sessions popup" }),
      ),
      selectedProvider: Type.Optional(
        Type.String({ description: "Provider for selected source session" }),
      ),
      selectedSessionId: Type.Optional(
        Type.String({ description: "Provider session id for selected source" }),
      ),
      selectedTargetId: Type.Optional(
        Type.String({ description: "SSH source id for selected source" }),
      ),
      settingsSection: Type.Optional(
        Type.Union([Type.Literal("ai"), Type.Literal("remote"), Type.Literal("more")]),
      ),
      projectView: Type.Optional(
        Type.Union([Type.Literal("timeline"), Type.Literal("overview"), Type.Literal("files")]),
      ),
      insightsSection: Type.Optional(
        Type.Union([
          Type.Literal("overview"),
          Type.Literal("activity"),
          Type.Literal("usage"),
          Type.Literal("coverage"),
          Type.Literal("workspace"),
        ]),
      ),
      query: Type.Optional(Type.String({ description: "Text search filter" })),
      providers: Type.Optional(
        Type.Array(Type.String(), { description: "Provider facet filters" }),
      ),
      repos: Type.Optional(Type.Array(Type.String(), { description: "Git repository facets" })),
      tools: Type.Optional(Type.Array(Type.String(), { description: "Tool facets" })),
      mcpServers: Type.Optional(Type.Array(Type.String(), { description: "MCP server facets" })),
      mcpTools: Type.Optional(Type.Array(Type.String(), { description: "MCP tool facets" })),
      skills: Type.Optional(Type.Array(Type.String(), { description: "Skill facets" })),
      compacted: Type.Optional(
        Type.Boolean({ description: "Show only compacted sessions/replays" }),
      ),
      archived: Type.Optional(Type.Boolean({ description: "Include archived sessions/replays" })),
      agentRuns: Type.Optional(
        Type.Boolean({ description: "Show automated agent-run workspaces" }),
      ),
      insightsRange: Type.Optional(
        Type.Union([
          Type.Literal("7d"),
          Type.Literal("30d"),
          Type.Literal("90d"),
          Type.Literal("all"),
        ]),
      ),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as OpenDashboardArgs;
      const action: LocalAssistantAction = {
        type: "open_dashboard",
        label: `Open ${args.tab}`,
        tab: args.tab,
        ...(args.project ? { project: args.project } : {}),
        ...(args.targetId ? { targetId: args.targetId } : {}),
        ...(args.selected ? { selected: args.selected } : {}),
        ...(args.selectedProvider ? { selectedProvider: args.selectedProvider } : {}),
        ...(args.selectedSessionId ? { selectedSessionId: args.selectedSessionId } : {}),
        ...(args.selectedTargetId ? { selectedTargetId: args.selectedTargetId } : {}),
        ...(args.settingsSection ? { settingsSection: args.settingsSection } : {}),
        ...(args.projectView ? { projectView: args.projectView } : {}),
        ...(args.insightsSection ? { insightsSection: args.insightsSection } : {}),
        ...(args.query ? { query: args.query } : {}),
        ...(args.providers?.length ? { providers: args.providers } : {}),
        ...(args.repos?.length ? { repos: args.repos } : {}),
        ...(args.tools?.length ? { tools: args.tools } : {}),
        ...(args.mcpServers?.length ? { mcpServers: args.mcpServers } : {}),
        ...(args.mcpTools?.length ? { mcpTools: args.mcpTools } : {}),
        ...(args.skills?.length ? { skills: args.skills } : {}),
        ...(args.compacted !== undefined ? { compacted: args.compacted } : {}),
        ...(args.archived !== undefined ? { archived: args.archived } : {}),
        ...(args.agentRuns !== undefined ? { agentRuns: args.agentRuns } : {}),
        ...(args.insightsRange ? { insightsRange: args.insightsRange } : {}),
        permalink: dashboardPermalink(args),
      };
      return toolResult(
        "open_dashboard",
        "Navigation action ready",
        { action },
        { actions: [action] },
      );
    },
  };

  return [
    searchSessions,
    getSessionSummary,
    getSessionContent,
    getScene,
    getSessionAnnotations,
    getSessionOverlays,
    getDataStatus,
    getInsights,
    getUsageBreakdown,
    getCompactionDiagnostics,
    prepareUserAction,
    openReplay,
    openDashboard,
  ];
}
