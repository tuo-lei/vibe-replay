import { cleanPromptText, previewPrompt } from "./clean-prompt.js";
import { scanSession, type ScanInput, type SessionScanResult } from "./scanner.js";
import { getRemoteHome } from "./remote.js";
import type { SessionInfo } from "./types.js";
import { shortenPath } from "./utils.js";
import { deriveTokenUsageMetrics } from "@vibe-replay/types";

export interface SessionQueryOptions {
  query?: string;
  project?: string;
  provider?: string;
  limit?: number;
  scan?: boolean;
  any?: boolean;
  brief?: boolean;
  dedupe?: boolean;
  compacted?: boolean;
}

export interface SessionQueryMatch {
  provider: string;
  location?: SessionInfo["location"];
  transcriptStatus?: SessionInfo["transcriptStatus"];
  sessionId: string;
  slug: string;
  title?: string;
  project: string;
  cwd: string;
  timestamp: string;
  gitBranch?: string;
  gitRepo?: string;
  model?: string;
  firstPrompt: string;
  prompts?: string[];
  filePath: string;
  filePaths: string[];
  toolPaths?: string[];
  promptCount?: number;
  toolCallCount?: number;
  editCount?: number;
  durationMs?: number;
  compactionCount?: number;
  hasPR?: boolean;
  score?: number;
  matchedTerms?: string[];
  unmatchedTerms?: string[];
  matchQuality?: "all-terms" | "strong" | "weak";
  whyMatched?: string[];
  scan?: SessionQueryScanSummary;
  brief?: SessionQueryBrief;
}

export interface SessionQueryScanSummary {
  promptCount: number;
  toolCallCount: number;
  editCount: number;
  filesModified: Array<{ file: string; count: number }>;
  durationMs?: number;
  costEstimate?: number;
  apiErrorCount: number;
  compactionCount: number;
  subAgentCount: number;
  toolCallsPerPrompt?: number;
  editsPerPrompt?: number;
  medianTurnDurationMs?: number;
  tokenUsage?: SessionScanResult["tokenUsage"];
  dataQualityNotes?: string[];
}

export interface SessionQueryBrief {
  taskType: string;
  summary: string;
  signals: string[];
  suggestedNextAction: string;
}

interface ScoredSessionInfo {
  session: SessionInfo;
  query: SessionQueryScore;
}

const HIGH_TOOL_DENSITY_THRESHOLD = 20;

export async function queryLocalSessions(
  sessions: SessionInfo[],
  options: SessionQueryOptions = {},
): Promise<SessionQueryMatch[]> {
  const limit = normalizeLimit(options.limit);
  const terms = splitTerms(options.query);
  const filtered = filterScoredSessionInfos(sessions, options).slice(0, limit);
  const matches = filtered.map(({ session, query }) => sessionInfoToMatch(session, terms, query));

  if (!options.scan && !options.brief) return matches;

  const scanned = await Promise.all(
    filtered.map(async ({ session }) => {
      try {
        return await scanSession(scanInputFromSession(session));
      } catch {
        return undefined;
      }
    }),
  );

  return matches.map((match, index) => {
    const scan = scanned[index];
    const summary = scan ? scanSummary(scan) : undefined;
    return {
      ...match,
      ...(summary ? { scan: summary } : {}),
      ...(options.brief ? { brief: buildSessionBrief(match, summary) } : {}),
    };
  });
}

export function filterSessionInfos(
  sessions: SessionInfo[],
  options: Pick<
    SessionQueryOptions,
    "query" | "project" | "provider" | "any" | "dedupe" | "compacted"
  > = {},
): SessionInfo[] {
  return filterScoredSessionInfos(sessions, options).map(({ session }) => session);
}

function filterScoredSessionInfos(
  sessions: SessionInfo[],
  options: Pick<
    SessionQueryOptions,
    "query" | "project" | "provider" | "any" | "dedupe" | "compacted"
  > = {},
): ScoredSessionInfo[] {
  const terms = splitTerms(options.query);
  const projectTerm = normalizeSearch(options.project);
  const provider = normalizeSearch(options.provider);
  const wideMatch = Boolean(options.any);

  const filtered = [...sessions]
    .map((session) => ({
      session,
      query: scoreSession(session, terms),
    }))
    .filter(({ session, query }) => {
      if (provider && normalizeSearch(session.provider) !== provider) return false;
      if (projectTerm && !sessionProjectHaystack(session).includes(projectTerm)) return false;
      if (options.compacted && (session.compactionCount || 0) <= 0) return false;
      if (terms.length > 0) {
        if (wideMatch) return query.matchedTerms.length > 0;
        if (query.matchedTerms.length !== terms.length) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (wideMatch || terms.length > 0) {
        const scoreDelta = b.query.score - a.query.score;
        if (scoreDelta) return scoreDelta;
      }
      return b.session.timestamp.localeCompare(a.session.timestamp);
    });

  return options.dedupe ? dedupeSimilarScoredSessions(filtered) : filtered;
}

export function scanInputFromSession(session: SessionInfo): ScanInput {
  return {
    sessionId: session.sessionId,
    provider: session.provider,
    ...(session.location ? { location: session.location } : {}),
    ...(session.transcriptStatus ? { transcriptStatus: session.transcriptStatus } : {}),
    project: shortenPath(session.project),
    slug: session.slug,
    filePaths: session.filePaths,
    toolPaths: session.toolPaths,
    sourceFilePath: session.filePath,
    sourceFileSize: session.fileSize,
    sourceLineCount: session.lineCount,
    workspacePath: session.workspacePath,
    hasSqlite: session.hasSqlite,
    hasSdk: session.hasSdk,
    sourceFingerprint: session.sourceFingerprint,
    timestamp: session.timestamp,
    title: session.title,
    firstPrompt: session.firstPrompt,
    discoveryPromptCount: session.promptCount,
    discoveryToolCallCount: session.toolCallCount,
    discoveryEditCount: session.editCountEst,
    discoveryCompactionCount: session.compactionCount,
    discoveryModel: session.model,
    discoveryDurationMs: session.durationMsEst,
    remoteHome: getRemoteHome(session.location?.kind === "ssh" ? session.location.id : undefined),
  };
}

export function formatSessionQueryText(matches: SessionQueryMatch[]): string {
  if (matches.length === 0) return "No matching sessions found.";

  return matches
    .map((match, index) => {
      const title = match.title || previewPrompt(match.firstPrompt) || match.slug;
      const lines = [
        `${index + 1}. ${title}`,
        `   ${match.provider} | ${match.location?.kind === "ssh" ? match.location.label : "local"} | ${match.timestamp} | ${match.project}`,
        `   session: ${match.sessionId}`,
        `   file: ${match.filePath}`,
      ];
      if (match.gitBranch) lines.push(`   branch: ${match.gitBranch}`);
      if (match.model) lines.push(`   model: ${match.model}`);
      if (match.matchedTerms?.length) {
        const quality = match.matchQuality ? `${match.matchQuality}, ` : "";
        lines.push(
          `   matched: ${quality}${match.matchedTerms.length}/${(match.matchedTerms.length || 0) + (match.unmatchedTerms?.length || 0)} terms (${match.matchedTerms.join(", ")})`,
        );
      }
      if (match.unmatchedTerms?.length) {
        lines.push(`   unmatched: ${match.unmatchedTerms.join(", ")}`);
      }
      if (match.whyMatched?.length) lines.push(`   why: ${match.whyMatched.join("; ")}`);
      if (match.firstPrompt) lines.push(`   first prompt: ${previewPrompt(match.firstPrompt)}`);
      if ((match.compactionCount || 0) > 0) {
        lines.push(`   compactions: ${match.compactionCount}`);
      }
      if (match.scan) lines.push(`   efficiency: ${formatScanSummary(match.scan)}`);
      if (match.brief) {
        lines.push(`   brief: ${match.brief.summary}`);
        if (match.brief.signals.length > 0) {
          lines.push(`   signals: ${match.brief.signals.join("; ")}`);
        }
        lines.push(`   next: ${match.brief.suggestedNextAction}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

function sessionInfoToMatch(
  session: SessionInfo,
  terms: string[] = [],
  precomputedScore?: SessionQueryScore,
): SessionQueryMatch {
  const query = precomputedScore || scoreSession(session, terms);
  return {
    provider: session.provider,
    location: session.location,
    transcriptStatus: session.transcriptStatus,
    sessionId: session.sessionId,
    slug: session.slug,
    title: cleanPromptText(session.title || "") || undefined,
    project: shortenPath(session.project),
    cwd: shortenPath(session.cwd),
    timestamp: session.timestamp,
    gitBranch: session.gitBranch,
    gitRepo: session.gitRepo,
    model: session.model,
    firstPrompt: cleanPromptText(session.firstPrompt),
    prompts: session.prompts?.map(cleanPromptText).filter(Boolean),
    filePath: session.filePath,
    filePaths: session.filePaths,
    toolPaths: session.toolPaths,
    promptCount: session.promptCount,
    toolCallCount: session.toolCallCount,
    editCount: session.editCountEst,
    durationMs: session.durationMsEst,
    compactionCount: session.compactionCount,
    hasPR: session.hasPR,
    score: query.score,
    matchedTerms: query.matchedTerms,
    unmatchedTerms: query.unmatchedTerms,
    matchQuality: query.matchQuality,
    whyMatched: query.whyMatched,
  };
}

function scanSummary(scan: SessionScanResult): SessionQueryScanSummary {
  const promptCount = scan.promptCount;
  return {
    promptCount,
    toolCallCount: scan.toolCallCount,
    editCount: scan.editCount,
    filesModified: scan.filesModified.slice(0, 20),
    durationMs: scan.durationMs,
    costEstimate: scan.costEstimate,
    apiErrorCount: scan.apiErrorCount,
    compactionCount: scan.compactionCount,
    subAgentCount: scan.subAgentCount,
    toolCallsPerPrompt: ratio(scan.toolCallCount, promptCount),
    editsPerPrompt: ratio(scan.editCount, promptCount),
    medianTurnDurationMs: median(scan.turnDurations),
    tokenUsage: scan.tokenUsage,
    dataQualityNotes: scan.dataQualityNotes,
  };
}

function formatScanSummary(scan: SessionQueryScanSummary): string {
  const parts = [
    `${scan.promptCount} prompts`,
    `${scan.toolCallCount} tools`,
    `${scan.editCount} edits`,
  ];
  if (scan.durationMs) parts.push(formatDuration(scan.durationMs));
  if (scan.costEstimate) parts.push(`$${scan.costEstimate.toFixed(2)}`);
  if (scan.toolCallsPerPrompt !== undefined) {
    parts.push(`${scan.toolCallsPerPrompt.toFixed(1)} tools/prompt`);
  }
  if (scan.apiErrorCount > 0) parts.push(`${scan.apiErrorCount} API errors`);
  if (scan.compactionCount > 0) parts.push(`${scan.compactionCount} compactions`);
  if (scan.tokenUsage) {
    const tokenMetrics = deriveTokenUsageMetrics(scan.tokenUsage);
    parts.push(`${formatTokenCount(tokenMetrics.promptTokens)} prompt tokens`);
    parts.push(`${formatTokenCount(tokenMetrics.cacheMissTokens)} uncached/miss`);
    if (tokenMetrics.cacheReadShare !== undefined) {
      parts.push(`${Math.round(tokenMetrics.cacheReadShare * 1000) / 10}% cache read`);
    }
  }
  return parts.join(", ");
}

interface SessionQueryScore {
  score: number;
  matchedTerms: string[];
  unmatchedTerms: string[];
  matchQuality?: "all-terms" | "strong" | "weak";
  whyMatched: string[];
}

function scoreSession(session: SessionInfo, terms: string[]): SessionQueryScore {
  if (terms.length === 0) {
    return { score: 0, matchedTerms: [], unmatchedTerms: [], whyMatched: [] };
  }

  const fields = [
    { name: "title", value: session.title, weight: 8 },
    { name: "first prompt", value: session.firstPrompt, weight: 7 },
    { name: "prompts", value: (session.prompts || []).join(" "), weight: 5 },
    { name: "project", value: session.project, weight: 4 },
    { name: "branch", value: session.gitBranch, weight: 4 },
    { name: "model", value: session.model, weight: 2 },
    { name: "provider", value: session.provider, weight: 2 },
    { name: "slug", value: session.slug, weight: 2 },
    { name: "files", value: (session.fsDetectedFiles || []).join(" "), weight: 3 },
    {
      name: "signals",
      value: session.compactionCount ? "compaction compacted" : undefined,
      weight: 3,
    },
  ].map((field) => ({ ...field, normalized: normalizeSearch(field.value) }));

  const matchedTerms: string[] = [];
  const unmatchedTerms: string[] = [];
  const whyMatched: string[] = [];
  let score = 0;

  for (const term of terms) {
    const hits = fields.filter((field) => textMatchesTerm(field.normalized, term));
    if (hits.length === 0) {
      unmatchedTerms.push(term);
      continue;
    }
    matchedTerms.push(term);
    const best = hits.sort((a, b) => b.weight - a.weight)[0];
    score += best.weight;
    whyMatched.push(`${term} in ${best.name}`);
  }

  if (matchedTerms.length === terms.length && terms.length > 1) score += 5;
  if (session.hasPR && terms.some((term) => ["pr", "review", "pull", "merge"].includes(term))) {
    score += 2;
  }
  if (session.promptCount && session.promptCount > 10) score += 1;

  return {
    score,
    matchedTerms,
    unmatchedTerms,
    matchQuality: matchQuality(matchedTerms.length, terms.length),
    whyMatched,
  };
}

function matchQuality(
  matchedTermCount: number,
  queryTermCount: number,
): SessionQueryScore["matchQuality"] {
  if (queryTermCount === 0 || matchedTermCount === 0) return undefined;
  if (matchedTermCount === queryTermCount) return "all-terms";
  if (matchedTermCount >= 2) return "strong";
  return "weak";
}

function buildSessionBrief(
  match: SessionQueryMatch,
  scan: SessionQueryScanSummary | undefined,
): SessionQueryBrief {
  const text = normalizeSearch(
    [match.title, match.firstPrompt, match.project, match.gitBranch].filter(Boolean).join(" "),
  );
  const taskType = classifyTaskType(text, match, scan);
  const signals = sessionSignals(match, scan);
  return {
    taskType,
    summary: briefSummary(taskType, match, scan),
    signals,
    suggestedNextAction: suggestedNextAction(taskType, signals, scan),
  };
}

function classifyTaskType(
  text: string,
  match: SessionQueryMatch,
  scan: SessionQueryScanSummary | undefined,
): string {
  if (/(review|pr|pull request|merge|ai review)/i.test(text) || match.hasPR) return "PR/review";
  if (/(latest main|branch|current feature|what.*working)/i.test(text)) {
    return "context recovery";
  }
  if (/skill/i.test(text)) return "skill workflow";
  if (/(ssh|remote source|remote host)/i.test(text)) return "remote/SSH";
  if (/(auth|oauth|login)/i.test(text)) return "auth/debugging";
  if (/(ci|test|lint|build|e2e)/i.test(text)) return "CI/test";
  if ((scan?.editCount || 0) > 0 || (match.editCount || 0) > 0) return "implementation";
  return "research";
}

function sessionSignals(
  match: SessionQueryMatch,
  scan: SessionQueryScanSummary | undefined,
): string[] {
  const signals: string[] = [];
  const promptCount = scan?.promptCount ?? match.promptCount ?? 0;
  const toolCount = scan?.toolCallCount ?? match.toolCallCount ?? 0;
  const toolsPerPrompt = scan?.toolCallsPerPrompt ?? ratio(toolCount, promptCount);

  if (toolsPerPrompt !== undefined && toolsPerPrompt >= HIGH_TOOL_DENSITY_THRESHOLD) {
    signals.push(`high tool density (${toolsPerPrompt.toFixed(1)} tools/prompt)`);
  }
  if (promptCount >= 40) signals.push(`long conversation (${promptCount} prompts)`);
  if ((scan?.editCount ?? match.editCount ?? 0) >= 50) {
    signals.push(`heavy editing (${scan?.editCount ?? match.editCount} edits)`);
  }
  if ((scan?.filesModified?.length || 0) >= 10) {
    signals.push(`broad file surface (${scan?.filesModified.length} files in scan summary)`);
  }
  if ((scan?.apiErrorCount || 0) > 0) signals.push(`${scan?.apiErrorCount} API errors`);
  if ((scan?.compactionCount || 0) > 0) signals.push(`${scan?.compactionCount} compactions`);
  if ((scan?.subAgentCount || 0) > 0) signals.push(`${scan?.subAgentCount} sub-agents`);
  if (match.matchedTerms?.length) {
    const quality = match.matchQuality ? `${match.matchQuality} match` : "matched";
    signals.push(`${quality}: ${match.matchedTerms.join(", ")}`);
  }
  if (match.unmatchedTerms?.length) {
    signals.push(`unmatched: ${match.unmatchedTerms.join(", ")}`);
  }
  return signals;
}

function briefSummary(
  taskType: string,
  match: SessionQueryMatch,
  scan: SessionQueryScanSummary | undefined,
): string {
  const title = previewPrompt(match.title || match.firstPrompt || match.slug);
  if (!scan) return `${taskType} session: ${title}`;
  return `${taskType} session with ${plural(scan.promptCount, "prompt")}, ${plural(scan.toolCallCount, "tool")}, and ${plural(scan.editCount, "edit")}: ${title}`;
}

function suggestedNextAction(
  taskType: string,
  signals: string[],
  scan: SessionQueryScanSummary | undefined,
): string {
  if (!scan) return "Run again with --scan or --brief before doing a retro.";
  if (signals.some((signal) => signal.includes("high tool density") || signal.includes("long"))) {
    return "Generate a replay or inspect chapters; raw metrics suggest a dense session.";
  }
  if (taskType === "PR/review")
    return "Inspect PR links/review comments or generate a PR-focused replay.";
  if (taskType === "context recovery")
    return "Use this as evidence for a session-start snapshot feature.";
  return "Use filePaths for deeper transcript/replay inspection if this is the right candidate.";
}

function splitTerms(query: string | undefined): string[] {
  return normalizeSearch(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function textMatchesTerm(text: string, term: string): boolean {
  if (!term) return false;
  if (/^[a-z0-9]{1,3}$/.test(term)) {
    return text
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .includes(term);
  }
  return text.includes(term);
}

function dedupeSimilarScoredSessions(scoredSessions: ScoredSessionInfo[]): ScoredSessionInfo[] {
  const seen = new Set<string>();
  const deduped: ScoredSessionInfo[] = [];
  for (const scored of scoredSessions) {
    const { session } = scored;
    const key = duplicateSessionKey(session);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    deduped.push(scored);
  }
  return deduped;
}

function duplicateSessionKey(session: SessionInfo): string | undefined {
  const prompt = normalizeSearch(cleanPromptText(session.firstPrompt));
  if (prompt.length >= 60) return `prompt:${prompt.slice(0, 240)}`;
  const title = normalizeSearch(cleanPromptText(session.title || ""));
  if (title.length >= 60) return `title:${title.slice(0, 240)}`;
  // Short prompts/titles are too ambiguous to dedupe safely.
  return undefined;
}

function sessionProjectHaystack(session: SessionInfo): string {
  return normalizeSearch(
    [session.project, session.cwd, session.workspacePath].filter(Boolean).join(" "),
  );
}

function normalizeSearch(value: string | undefined): string {
  return (value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function plural(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function normalizeLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return 10;
  return Math.min(Math.floor(limit), 100);
}

function ratio(value: number, denominator: number): number | undefined {
  if (denominator <= 0) return undefined;
  return Math.round((value / denominator) * 10) / 10;
}

function median(values: number[] | undefined): number | undefined {
  if (!values?.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}
