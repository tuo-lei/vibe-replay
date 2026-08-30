/**
 * Read-only tools for the local Vibe Replay assistant.
 *
 * This module deliberately knows nothing about Hono or the browser. The
 * server supplies local data accessors, while the viewer consumes the
 * citations and navigation actions returned in tool details.
 */

import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { redactSensitiveText } from "./ai-runtime.js";
import type { CachedSourceRecord, ReplaySummary } from "./server-types.js";
import type { ProjectInsights, SessionScanResult, UserInsights } from "./scanner.js";
import type { ReplaySession, Scene, SessionDiagnostic, SessionLocation } from "./types.js";

const MAX_SEARCH_RESULTS = 20;
const MAX_CONTENT_CHARS = 18_000;
const MAX_SCENE_CHARS = 2_400;
const MAX_USAGE_ENTRIES = 12;
const MAX_DIAGNOSTIC_EVENTS = 50;

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
  getScanResults: () => readonly SessionScanResult[];
  getUserInsights: (allowRemoteData?: boolean) => Promise<UserInsights | null>;
  getProjectInsights: (project: string, targetId?: string) => Promise<ProjectInsights | null>;
}

export interface LocalAssistantCitation {
  type: "session" | "scene" | "insight";
  label: string;
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
    }
  | {
      type: "open_dashboard";
      label: string;
      tab: "home" | "sessions" | "replays" | "projects" | "insights";
      project?: string;
      targetId?: string;
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
}

interface UsageArgs {
  slug?: string;
  targetId?: string;
  project?: string;
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
}

interface OpenDashboardArgs {
  tab: "home" | "sessions" | "replays" | "projects" | "insights";
  project?: string;
  targetId?: string;
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

function locationFor(record: AssistantSessionRecord): SessionLocation | undefined {
  return record.replay?.location || record.source?.location || record.scan?.location;
}

function compact(value: string | undefined, max = 500): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
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
    prompts: stats?.userPrompts ?? scan?.promptCount ?? record.source?.promptCount ?? 0,
    toolCalls: stats?.toolCalls ?? scan?.toolCallCount ?? record.source?.toolCallCount ?? 0,
    edits: scan?.editCount ?? 0,
    durationMs: stats?.durationMs ?? scan?.durationMs ?? inferredDurationMs,
    cost: stats?.costEstimate ?? scan?.costEstimate,
    compactions:
      record.replay?.compactionCount ??
      record.scan?.compactionCount ??
      record.source?.compactionCount ??
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
    slug: recordRef(record)?.slug || record.source?.slug || record.scan?.slug,
    targetId: recordTargetId(record),
    startTime: recordTimestamp(record),
    model: record.replay?.model || record.source?.model || record.scan?.model,
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
    record.replay?.model,
    record.replay?.gitRepo,
    record.replay?.firstMessage,
    ...(record.replay?.messages || []),
    sourceString(source?.firstPrompt),
    ...sourceStrings(source?.prompts),
    ...(source?.filePaths || []),
    ...(source?.toolPaths || []),
    sourceString(source?.gitBranch),
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
  args: {
    query?: string;
    provider?: string;
    project?: string;
    since?: string;
    until?: string;
  },
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

  const timestamp = recordTimestamp(record);
  const time = timestamp ? new Date(timestamp).getTime() : Number.NaN;
  const since = parseDate(args.since)?.getTime();
  const until = parseDate(args.until)?.getTime();
  if (since !== undefined && (!Number.isFinite(time) || time < since)) return false;
  if (until !== undefined && (!Number.isFinite(time) || time > until)) return false;
  return true;
}

function resultRecord(record: AssistantSessionRecord) {
  const ref = recordRef(record);
  const stats = resultStats(record);
  return {
    title: recordTitle(record),
    provider: recordProvider(record),
    project: recordProject(record),
    location: locationFor(record),
    sessionId: recordSessionId(record),
    slug: ref?.slug,
    targetId: ref?.targetId,
    sourceSlug: record.source?.slug || record.replay?.sourceSlug,
    startTime: recordTimestamp(record),
    model: record.replay?.model || record.source?.model || record.scan?.model,
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
  switch (scene.type) {
    case "user-prompt":
      return `[scene ${index}] USER\n${scene.content}`;
    case "thinking":
      return `[scene ${index}] THINKING\n${scene.content}`;
    case "text-response":
      return `[scene ${index}] ASSISTANT\n${scene.content}`;
    case "compaction-summary":
      return `[scene ${index}] CONTEXT COMPACTION\n${scene.content}`;
    case "context-injection":
      return `[scene ${index}] CONTEXT (${scene.injectionType || "other"})\n${scene.content}`;
    case "tool-call": {
      const lines = [`[scene ${index}] TOOL ${scene.toolName}`];
      const input = compact(JSON.stringify(scene.input), 1_200);
      if (input) lines.push(`input: ${input}`);
      const result = compact(scene.result, 1_000);
      if (result) lines.push(`result: ${result}`);
      if (scene.diff?.filePath) lines.push(`file: ${scene.diff.filePath}`);
      if (scene.isError) lines.push("status: error");
      return lines.join("\n");
    }
  }
}

function sessionSummary(session: ReplaySession, record: AssistantSessionRecord) {
  const promptScenes = session.scenes
    .map((scene, index) =>
      scene.type === "user-prompt" ? { index, prompt: compact(scene.content, 500) } : null,
    )
    .filter((value): value is { index: number; prompt: string | undefined } => Boolean(value))
    .slice(0, 12);
  const toolCounts: Record<string, number> = {};
  for (const scene of session.scenes) {
    if (scene.type === "tool-call")
      toolCounts[scene.toolName] = (toolCounts[scene.toolName] || 0) + 1;
  }
  return {
    title: session.meta.title || recordTitle(record),
    provider: session.meta.provider,
    project: session.meta.project,
    location: session.meta.location,
    sessionId: session.meta.sessionId,
    slug: session.meta.slug,
    model: session.meta.model,
    transcriptStatus: session.meta.transcriptStatus,
    dataSource: session.meta.dataSource,
    dataSourceInfo: session.meta.dataSourceInfo,
    startTime: session.meta.startTime,
    endTime: session.meta.endTime,
    stats: session.meta.stats,
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
    prLinks: session.meta.prLinks,
  };
}

function usageEntries(counts: Record<string, number> | undefined) {
  return Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_USAGE_ENTRIES)
    .map(([name, calls]) => ({ name, calls }));
}

export function createLocalAssistantTools(
  data: LocalAssistantData,
  context: LocalAssistantContext,
): LocalAssistantTool[] {
  const searchSessions: LocalAssistantTool = {
    name: "search_sessions",
    label: "Search local sessions",
    description:
      "Search local AI coding sessions and generated replays by prompt, title, project, provider, model, file, tool, branch, or MCP server. Use this before making factual claims about the user's sessions.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Words to find in session metadata or prompts" }),
      ),
      provider: Type.Optional(
        Type.String({ description: "Provider filter such as claude-code, cursor, codex, or pi" }),
      ),
      project: Type.Optional(Type.String({ description: "Project path or repository filter" })),
      since: Type.Optional(
        Type.String({ description: "ISO date/time or relative form such as 7d" }),
      ),
      until: Type.Optional(Type.String({ description: "ISO date/time upper bound" })),
      limit: Type.Optional(Type.Number({ description: "Maximum results, from 1 to 20" })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as SearchArgs;
      const allRecords = await buildSessionRecords(data);
      const records = allRecords.filter(
        (record) => context.allowRemoteData || !isRemoteRecord(record),
      );
      const limit = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(args.limit || 8)));
      const matches = records
        .filter((record) => searchMatches(record, args))
        .sort((a, b) => (recordTimestamp(b) || "").localeCompare(recordTimestamp(a) || ""));
      const results = matches.slice(0, limit).map(resultRecord);
      const citations = matches.slice(0, limit).map((record) => sessionCitation(record));
      return toolResult(
        "search_sessions",
        `Found ${matches.length} matching local session${matches.length === 1 ? "" : "s"}${!context.allowRemoteData && allRecords.some(isRemoteRecord) ? " (SSH sessions are hidden until enabled)" : ""}`,
        {
          total: matches.length,
          results,
          truncated: matches.length > limit,
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
      const payload = sessionSummary(session, record);
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
      const requestedQuery = args.query?.trim().toLowerCase();
      let indices: number[];
      if (requestedQuery) {
        indices = session.scenes
          .map((scene, index) =>
            sceneText(scene, index).toLowerCase().includes(requestedQuery) ? index : -1,
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
      const scenes: Array<{ index: number; text: string }> = [];
      for (const index of indices) {
        const text = sceneText(session.scenes[index]!, index);
        const bounded = text.length > MAX_SCENE_CHARS ? `${text.slice(0, MAX_SCENE_CHARS)}…` : text;
        if (chars + bounded.length > MAX_CONTENT_CHARS) break;
        chars += bounded.length;
        scenes.push({ index, text: bounded });
      }

      const payload = {
        title: session.meta.title || recordTitle(record),
        slug: session.meta.slug,
        sceneCount: session.scenes.length,
        query: requestedQuery || undefined,
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
      const sceneIndex = Math.floor(args.sceneIndex);
      if (sceneIndex < 0 || sceneIndex >= session.scenes.length) {
        throw new Error(`Scene index out of range: ${args.sceneIndex}`);
      }
      const payload = {
        slug: session.meta.slug,
        sceneIndex,
        scene: sceneText(session.scenes[sceneIndex]!, sceneIndex),
      };
      return toolResult("get_scene", `Read scene ${sceneIndex}`, payload, {
        citations: [sessionCitation(record, sceneIndex)],
        remoteData: isRemoteRecord(record),
      });
    },
  };

  const getInsights: LocalAssistantTool = {
    name: "get_insights",
    label: "Read local insights",
    description:
      "Read aggregated local usage insights for the whole account or one project. Use scope=project with a project path for project-specific metrics.",
    parameters: Type.Object({
      scope: Type.Union([Type.Literal("user"), Type.Literal("project")]),
      project: Type.Optional(Type.String({ description: "Project path for project scope" })),
      targetId: Type.Optional(Type.String({ description: "SSH source id for a remote project" })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as InsightsArgs;
      if (args.targetId && !context.allowRemoteData) {
        throw new Error(
          "These insights belong to an SSH source. Enable SSH session data in Ask Replay first.",
        );
      }
      if (args.scope === "project") {
        const project = args.project || context.project;
        if (!project) throw new Error("project is required for project insights");
        const insights = await data.getProjectInsights(project, args.targetId);
        if (!insights) throw new Error(`No insights found for project: ${project}`);
        const payload = {
          scope: "project",
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
          tokenBreakdown: insights.tokenBreakdown,
          dataQuality: insights.dataQuality,
        };
        return toolResult("get_insights", `Read insights for ${project}`, payload, {
          citations: [
            {
              type: "insight",
              label: `Insights · ${project}`,
              project,
              ...(args.targetId ? { targetId: args.targetId } : {}),
            },
          ],
          remoteData: Boolean(args.targetId),
        });
      }

      const insights = await data.getUserInsights(context.allowRemoteData);
      if (!insights)
        throw new Error("No local insights are available yet. Run a dashboard scan first.");
      const payload = {
        scope: "user",
        totalSessions: insights.totalSessions,
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
        subAgentTotal: insights.subAgentTotal,
        apiErrorTotal: insights.apiErrorTotal,
        avgSessionDurationMs: insights.avgSessionDurationMs,
        medianTurnDurationMs: insights.medianTurnDurationMs,
        tokenBreakdown: insights.tokenBreakdown,
        dataQuality: insights.dataQuality,
      };
      return toolResult("get_insights", "Read aggregate local insights", payload, {
        citations: [{ type: "insight", label: "Personal local insights" }],
        remoteData: context.allowRemoteData,
      });
    },
  };

  const getUsageBreakdown: LocalAssistantTool = {
    name: "get_usage_breakdown",
    label: "Read usage breakdown",
    description:
      "Read indexed tool, MCP server, MCP tool, skill, success/error, and duration usage for one session or a project. Inputs and results are not exposed by this tool.",
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
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as UsageArgs;
      const allScans = data.getScanResults();
      if (
        !context.allowRemoteData &&
        args.slug &&
        allScans.some((scan) => scan.slug === args.slug && targetIdFor(scan.location))
      ) {
        throw new Error(
          "This usage data belongs to an SSH source. Enable SSH session data in Ask Replay first.",
        );
      }
      const scans = allScans.filter((scan) => {
        if (!context.allowRemoteData && targetIdFor(scan.location)) return false;
        if (args.slug && scan.slug !== args.slug) return false;
        if (args.targetId !== targetIdFor(scan.location)) return false;
        if (args.project && scan.project !== args.project) return false;
        return true;
      });
      if (scans.length === 0) throw new Error("No indexed usage data matched the request");

      const aggregate = {
        sessions: scans.length,
        tools: {} as Record<string, number>,
        mcpServers: {} as Record<string, number>,
        mcpTools: {} as Record<string, number>,
        skills: {} as Record<string, number>,
        successCount: 0,
        errorCount: 0,
        totalDurationMs: 0,
        durationCount: 0,
        qualityNotes: [] as string[],
      };
      for (const scan of scans) {
        const usage = scan.usageSummary;
        if (!usage) {
          aggregate.qualityNotes.push(`${scan.provider}/${scan.slug}: usage summary unavailable`);
          continue;
        }
        for (const [name, count] of Object.entries(usage.tools || {})) {
          aggregate.tools[name] = (aggregate.tools[name] || 0) + count;
        }
        for (const [name, count] of Object.entries(usage.mcpServers || {})) {
          aggregate.mcpServers[name] = (aggregate.mcpServers[name] || 0) + count;
        }
        for (const [name, count] of Object.entries(usage.mcpTools || {})) {
          aggregate.mcpTools[name] = (aggregate.mcpTools[name] || 0) + count;
        }
        for (const [name, count] of Object.entries(usage.skills || {})) {
          aggregate.skills[name] = (aggregate.skills[name] || 0) + count;
        }
        aggregate.successCount += usage.successCount;
        aggregate.errorCount += usage.errorCount;
        aggregate.totalDurationMs += usage.totalDurationMs;
        aggregate.durationCount += usage.durationCount;
        for (const note of scan.dataQualityNotes || []) aggregate.qualityNotes.push(note);
      }

      const payload = {
        sessions: aggregate.sessions,
        tools: usageEntries(aggregate.tools),
        mcpServers: usageEntries(aggregate.mcpServers),
        mcpTools: usageEntries(aggregate.mcpTools),
        skills: usageEntries(aggregate.skills),
        successCount: aggregate.successCount,
        errorCount: aggregate.errorCount,
        totalDurationMs: aggregate.totalDurationMs,
        durationCount: aggregate.durationCount,
        qualityNotes: [...new Set(aggregate.qualityNotes)].slice(0, 12),
      };
      const record = args.slug
        ? findRecord(await buildSessionRecords(data), { slug: args.slug, targetId: args.targetId })
        : undefined;
      return toolResult(
        "get_usage_breakdown",
        `Read usage for ${scans.length} session${scans.length === 1 ? "" : "s"}`,
        payload,
        {
          citations: record
            ? [sessionCitation(record)]
            : [
                {
                  type: "insight",
                  label: "Local usage index",
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

  const openReplay: LocalAssistantTool = {
    name: "open_replay",
    label: "Open replay",
    description:
      "Prepare a navigation action to open a generated local replay, optionally at a specific scene. Use only when the user asks to open, inspect, or jump to a result.",
    parameters: Type.Object({
      slug: Type.String({ description: "Generated replay slug" }),
      targetId: Type.Optional(
        Type.String({ description: "SSH source id when the session is remote" }),
      ),
      sceneIndex: Type.Optional(Type.Number({ description: "Scene index to focus" })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as OpenReplayArgs;
      const record = findRecord(await buildSessionRecords(data), args);
      if (!record?.replay) throw new Error(`Generated replay not found: ${args.slug}`);
      assertRecordAccess(record, context);
      const sceneIndex =
        args.sceneIndex === undefined ? undefined : Math.max(0, Math.floor(args.sceneIndex));
      const action: LocalAssistantAction = {
        type: "open_replay",
        label:
          sceneIndex === undefined
            ? `Open ${recordTitle(record)}`
            : `Open ${recordTitle(record)} at scene ${sceneIndex}`,
        slug: args.slug,
        ...(args.targetId ? { targetId: args.targetId } : {}),
        ...(sceneIndex === undefined ? {} : { sceneIndex }),
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
      ]),
      project: Type.Optional(
        Type.String({ description: "Project filter for the projects or insights tab" }),
      ),
      targetId: Type.Optional(Type.String({ description: "SSH source id for a remote view" })),
    }),
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as OpenDashboardArgs;
      const action: LocalAssistantAction = {
        type: "open_dashboard",
        label: `Open ${args.tab}`,
        tab: args.tab,
        ...(args.project ? { project: args.project } : {}),
        ...(args.targetId ? { targetId: args.targetId } : {}),
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
    getInsights,
    getUsageBreakdown,
    getCompactionDiagnostics,
    openReplay,
    openDashboard,
  ];
}
