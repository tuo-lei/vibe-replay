import { cleanPromptText, previewPrompt } from "./clean-prompt.js";
import { scanSession, type ScanInput, type SessionScanResult } from "./scanner.js";
import type { SessionInfo } from "./types.js";
import { shortenPath } from "./utils.js";

export interface SessionQueryOptions {
  query?: string;
  project?: string;
  provider?: string;
  limit?: number;
  scan?: boolean;
}

export interface SessionQueryMatch {
  provider: string;
  sessionId: string;
  slug: string;
  title?: string;
  project: string;
  cwd: string;
  timestamp: string;
  gitBranch?: string;
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
  hasPR?: boolean;
  scan?: SessionQueryScanSummary;
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
  dataQualityNotes?: string[];
}

export async function queryLocalSessions(
  sessions: SessionInfo[],
  options: SessionQueryOptions = {},
): Promise<SessionQueryMatch[]> {
  const limit = normalizeLimit(options.limit);
  const filtered = filterSessionInfos(sessions, options).slice(0, limit);
  const matches = filtered.map(sessionInfoToMatch);

  if (!options.scan) return matches;

  const scanned = await Promise.all(
    filtered.map(async (session) => {
      try {
        return await scanSession(scanInputFromSession(session));
      } catch {
        return undefined;
      }
    }),
  );

  return matches.map((match, index) => {
    const scan = scanned[index];
    return scan ? { ...match, scan: scanSummary(scan) } : match;
  });
}

export function filterSessionInfos(
  sessions: SessionInfo[],
  options: Pick<SessionQueryOptions, "query" | "project" | "provider"> = {},
): SessionInfo[] {
  const terms = splitTerms(options.query);
  const projectTerm = normalizeSearch(options.project);
  const provider = normalizeSearch(options.provider);

  return [...sessions]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .filter((session) => {
      if (provider && normalizeSearch(session.provider) !== provider) return false;
      if (projectTerm && !sessionProjectHaystack(session).includes(projectTerm)) return false;
      if (terms.length > 0) {
        const haystack = sessionHaystack(session);
        if (!terms.every((term) => haystack.includes(term))) return false;
      }
      return true;
    });
}

export function scanInputFromSession(session: SessionInfo): ScanInput {
  return {
    sessionId: session.sessionId,
    provider: session.provider,
    project: shortenPath(session.project),
    slug: session.slug,
    filePaths: session.filePaths,
    toolPaths: session.toolPaths,
    sourceFilePath: session.filePath,
    sourceFileSize: session.fileSize,
    sourceLineCount: session.lineCount,
    workspacePath: session.workspacePath,
    hasSqlite: session.hasSqlite,
    timestamp: session.timestamp,
    title: session.title,
    firstPrompt: session.firstPrompt,
  };
}

export function formatSessionQueryText(matches: SessionQueryMatch[]): string {
  if (matches.length === 0) return "No matching sessions found.";

  return matches
    .map((match, index) => {
      const title = match.title || previewPrompt(match.firstPrompt) || match.slug;
      const lines = [
        `${index + 1}. ${title}`,
        `   ${match.provider} | ${match.timestamp} | ${match.project}`,
        `   session: ${match.sessionId}`,
        `   file: ${match.filePath}`,
      ];
      if (match.gitBranch) lines.push(`   branch: ${match.gitBranch}`);
      if (match.model) lines.push(`   model: ${match.model}`);
      if (match.firstPrompt) lines.push(`   first prompt: ${previewPrompt(match.firstPrompt)}`);
      if (match.scan) lines.push(`   efficiency: ${formatScanSummary(match.scan)}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function sessionInfoToMatch(session: SessionInfo): SessionQueryMatch {
  return {
    provider: session.provider,
    sessionId: session.sessionId,
    slug: session.slug,
    title: cleanPromptText(session.title || "") || undefined,
    project: shortenPath(session.project),
    cwd: shortenPath(session.cwd),
    timestamp: session.timestamp,
    gitBranch: session.gitBranch,
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
    hasPR: session.hasPR,
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
  return parts.join(", ");
}

function splitTerms(query: string | undefined): string[] {
  return normalizeSearch(query)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function sessionHaystack(session: SessionInfo): string {
  return normalizeSearch(
    [
      session.provider,
      session.sessionId,
      session.slug,
      session.title,
      session.project,
      session.cwd,
      session.gitBranch,
      session.model,
      session.firstPrompt,
      ...(session.prompts || []),
      ...(session.fsDetectedFiles || []),
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function sessionProjectHaystack(session: SessionInfo): string {
  return normalizeSearch(
    [session.project, session.cwd, session.workspacePath].filter(Boolean).join(" "),
  );
}

function normalizeSearch(value: string | undefined): string {
  return (value || "").toLowerCase().replace(/\s+/g, " ").trim();
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
