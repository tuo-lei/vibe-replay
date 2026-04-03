import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionSummary, SourceSession } from "../types";
import DashboardHome from "./DashboardHome";
import {
  cleanPrompt,
  computeProjectLabels,
  formatCacheAge,
  formatCompactAge,
  formatCost,
  formatDataSourceLabel,
  formatDate,
  formatSize,
  getErrorMessage,
  isCacheFresh,
  navigateTo,
  normalizeTitleText,
  parseCachedList,
  projectName,
  providerBadgeClass,
  providerBadgeLabel,
  replaySuggestedTitle,
  type SourcesEnrichmentStatus,
  shortModelName,
  sourceDisplayTitle,
  sourceSuggestedTitle,
  TITLE_MAX_CHARS,
  timeAgo,
} from "./dashboard-utils";
import InsightsPage from "./InsightsPage";
import {
  ScanInsightsProvider,
  TitleInsightsHeader,
  TitleInsightsHeaderSkeleton,
  useScanInsightsContext,
} from "./InsightsPanel";
import ProjectsPanel from "./ProjectsPanel";
import { formatDuration } from "./StatsPanel";

type Tab = "home" | "sessions" | "replays" | "projects" | "insights";

// ─── URL state parsers (module-level for stable references) ─────────
function getProjectFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("project") || ALL_PROJECTS;
}
function getFilterFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("q") || "";
}
function getShowArchivedFromUrl(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get("archived") === "true";
}

const MoreDotsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="8" cy="3" r="1.5" />
    <circle cx="8" cy="8" r="1.5" />
    <circle cx="8" cy="13" r="1.5" />
  </svg>
);

function ProviderBadge({ provider }: { provider: string }) {
  return (
    <span
      className={`text-[10px] font-sans font-medium px-1.5 py-0.5 rounded-full uppercase tracking-wider ${providerBadgeClass(provider)}`}
    >
      {providerBadgeLabel(provider)}
    </span>
  );
}

function EditableTitle({
  slug,
  title,
  fallbackTitle,
  onSave,
}: {
  slug: string;
  title?: string;
  fallbackTitle?: string;
  onSave: (slug: string, title: string) => Promise<void>;
}) {
  const suggestedTitle = normalizeTitleText(title || fallbackTitle || slug);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(suggestedTitle);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setValue(suggestedTitle);
  }, [suggestedTitle]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onSave(slug, normalizeTitleText(value));
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <div className="min-w-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="flex items-center gap-1.5 min-w-0"
        >
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setValue(suggestedTitle);
                setEditing(false);
              }
            }}
            className="bg-terminal-surface-2 rounded px-2 py-0.5 text-sm font-sans text-terminal-text w-full outline-none ring-1 ring-terminal-border-subtle focus:ring-terminal-green/50 transition-shadow duration-200"
            placeholder={suggestedTitle}
            maxLength={TITLE_MAX_CHARS}
            disabled={saving}
          />
        </form>
        <div className="text-[11px] font-mono text-terminal-dimmer truncate mt-0.5">
          slug: <span className="text-terminal-dim">{slug}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0">
      <button
        onClick={() => setEditing(true)}
        className="group flex items-center gap-1 min-w-0 max-w-full text-left"
        title="Click to edit title"
      >
        <span className="text-sm font-sans font-medium text-terminal-text truncate">
          {suggestedTitle || slug}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="shrink-0 text-terminal-dim opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z" />
        </svg>
      </button>
      <div className="text-[11px] font-mono text-terminal-dimmer truncate mt-0.5">
        slug: <span className="text-terminal-dim">{slug}</span>
      </div>
    </div>
  );
}

/** "..." menu for session cards (archive only) */
function SessionMoreMenu({
  onArchive,
  isArchived,
}: {
  onArchive: () => void;
  isArchived: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="h-7 w-7 flex items-center justify-center rounded-md bg-terminal-surface-2 text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors duration-200"
        title="More actions"
      >
        <MoreDotsIcon />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg bg-terminal-surface-2 border border-terminal-border shadow-layer-md py-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-sans text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M2 4h12v2H2zM3 6v7h10V6M6.5 8h3" />
            </svg>
            {isArchived ? "Unarchive" : "Archive"}
          </button>
        </div>
      )}
    </div>
  );
}

// Module-level cache for scan results (avoids re-fetching on every popup open)
let scanResultsCache: SessionScanData[] | null = null;
let scanResultsFetchPromise: Promise<SessionScanData[] | null> | null = null;

function fetchScanResults(): Promise<SessionScanData[] | null> {
  if (scanResultsCache) return Promise.resolve(scanResultsCache);
  if (scanResultsFetchPromise) return scanResultsFetchPromise;
  scanResultsFetchPromise = fetch("/api/scan/results")
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const results = data?.results ?? null;
      scanResultsCache = results;
      // Invalidate after 30s so fresh data can come in
      setTimeout(() => {
        scanResultsCache = null;
        scanResultsFetchPromise = null;
      }, 30_000);
      return results;
    })
    .catch(() => null);
  return scanResultsFetchPromise;
}

/** Per-session scan result (from background scanner) */
export interface SessionScanData {
  title?: string;
  firstPrompt?: string;
  slug?: string;
  costEstimate?: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  subAgentCount: number;
  apiErrorCount: number;
  compactionCount: number;
  editCount: number;
  filesModified: Array<{ file: string; count: number }>;
  prLinks?: Array<{ prNumber: number; prUrl: string; prRepository: string }>;
  entrypoint?: string;
  permissionMode?: string;
  skillsUsed?: string[];
  mcpServersUsed?: string[];
  model?: string;
  gitBranch?: string;
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  promptCount: number;
  toolCallCount: number;
  gitBranches?: string[];
  dataSource?: string;
  dataQualityNotes?: string[];
}

function sessionPromptPreview(
  session: Pick<SourceSession, "prompts" | "firstPrompt">,
  scanData?: Pick<SessionScanData, "firstPrompt"> | null,
  displayTitle?: string,
): string[] {
  const prompts: string[] = [];
  const seen = new Set<string>();
  const candidates = [scanData?.firstPrompt, ...(session.prompts || [])];
  if (!scanData?.firstPrompt) candidates.push(session.firstPrompt);
  for (const candidate of candidates) {
    const cleaned = cleanPrompt(candidate || "");
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    prompts.push(cleaned);
  }
  const normalizedTitle = cleanPrompt(displayTitle || "");
  if (prompts.length > 1 && normalizedTitle && prompts[0] === normalizedTitle) {
    prompts.shift();
  }
  if (prompts.length > 1 && /^(?:and|but|or|so|then)\b/i.test(prompts[0] || "")) {
    prompts.shift();
  }
  return prompts;
}

function nonDefaultBranch(branch?: string): string | undefined {
  return branch && branch !== "main" && branch !== "master" ? branch : undefined;
}

function dataSourceBadgeClass(dataSource?: string, hasSqlite?: boolean): string {
  if (dataSource === "jsonl") return "bg-terminal-orange-subtle text-terminal-orange";
  if (dataSource === "global-state") return "bg-terminal-blue-subtle text-terminal-blue";
  if (dataSource === "sqlite" || hasSqlite) return "bg-terminal-green-subtle text-terminal-green";
  return "bg-terminal-surface-2 text-terminal-dimmer";
}

/** Session detail popup — shows full metadata, editable title, Generate CTA */
export function SessionDetailPopup({
  session: s,
  scanData: initialScanData = null,
  onClose,
  onGenerate,
  onViewReplay,
  onArchive,
  onTitleSave,
  onDeleteReplay,
  isGenerating,
  isArchived,
}: {
  session: SourceSession;
  scanData?: SessionScanData | null;
  onClose: () => void;
  onGenerate: (session: SourceSession, title: string) => void;
  onViewReplay: (slug: string) => void;
  onArchive: (slug: string) => void;
  onTitleSave: (slug: string, title: string) => Promise<void>;
  onDeleteReplay: (slug: string) => void;
  isGenerating: boolean;
  isArchived: boolean;
}) {
  const [scanData, setScanData] = useState<SessionScanData | null>(initialScanData);
  const fallbackSuggested = sourceSuggestedTitle(s);
  const suggested = sourceDisplayTitle(s, scanData);
  const [titleValue, setTitleValue] = useState(s.replay?.title || suggested);
  const [savingTitle, setSavingTitle] = useState(false);
  const titleInputRef = useRef<HTMLTextAreaElement>(null);

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Focus title on open
  useEffect(() => {
    const el = titleInputRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  useEffect(() => {
    setScanData(initialScanData);
  }, [initialScanData]);

  // Fetch scan results for richer data (cached at module level)
  useEffect(() => {
    if (initialScanData) return;
    let cancelled = false;
    fetchScanResults().then((results) => {
      if (cancelled || !results) return;
      const match = results.find((r) => r.slug === s.slug);
      if (match) setScanData(match);
    });
    return () => {
      cancelled = true;
    };
  }, [initialScanData, s.slug]);

  useEffect(() => {
    setTitleValue((current) => {
      const normalizedCurrent = normalizeTitleText(current);
      const normalizedSuggested = normalizeTitleText(suggested);
      const normalizedReplay = normalizeTitleText(s.replay?.title);
      if (
        !normalizedCurrent ||
        normalizedCurrent === normalizedReplay ||
        normalizedCurrent === s.slug
      ) {
        return s.replay?.title || suggested;
      }
      if (normalizedSuggested && normalizedCurrent === normalizeTitleText(fallbackSuggested)) {
        return s.replay?.title || suggested;
      }
      return current;
    });
  }, [fallbackSuggested, suggested, s.replay?.title, s.slug]);

  const branch = nonDefaultBranch(scanData?.gitBranch || s.gitBranch);
  const model = scanData?.model || s.model;
  const prompts = sessionPromptPreview(s, scanData, suggested);
  const dataQualityNotes = scanData?.dataQualityNotes || [];

  // Use scan data when available, fall back to discovery estimates
  const promptCount = scanData?.promptCount ?? s.promptCount;
  const toolCallCount = scanData?.toolCallCount ?? s.toolCallCount;
  const editCount = scanData?.editCount ?? s.editCountEst;
  const durationMs = scanData?.durationMs ?? s.durationMsEst;
  const cost = scanData?.costEstimate ?? s.replay?.stats?.costEstimate;
  const totalTokens = scanData?.tokenUsage
    ? scanData.tokenUsage.inputTokens + scanData.tokenUsage.outputTokens
    : undefined;
  const startedAt = scanData?.startTime || s.timestamp;

  const handleSaveTitle = async () => {
    if (!s.replay || savingTitle) return;
    const normalized = normalizeTitleText(titleValue);
    if (normalized === normalizeTitleText(s.replay.title || suggested)) return;
    setSavingTitle(true);
    try {
      await onTitleSave(s.slug, normalized);
    } finally {
      setSavingTitle(false);
    }
  };

  const handleGenerate = () => {
    onGenerate(s, titleValue);
  };

  const EXPIRY_WARN_DAYS = 7;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-md animate-in fade-in duration-300"
        onClick={onClose}
      />
      <div
        className="relative max-w-4xl w-full bg-terminal-bg border border-terminal-border-subtle rounded-2xl shadow-layer-xl animate-in zoom-in-95 fade-in duration-200 flex flex-col max-h-[88vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-7 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <ProviderBadge provider={s.provider} />
            {model && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-terminal-surface-2 text-terminal-dimmer">
                {shortModelName(model)}
              </span>
            )}
            {scanData?.dataSource && (
              <span
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${dataSourceBadgeClass(scanData.dataSource, s.hasSqlite)}`}
              >
                {formatDataSourceLabel(s.hasSqlite, scanData.dataSource)}
              </span>
            )}
            {scanData?.entrypoint && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-terminal-surface-2 text-terminal-dimmer">
                {scanData.entrypoint}
              </span>
            )}
            {scanData?.permissionMode === "bypassPermissions" && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-terminal-orange-subtle text-terminal-orange">
                trust mode
              </span>
            )}
            {scanData?.skillsUsed?.map((skill) => (
              <span
                key={skill}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400"
              >
                {skill}
              </span>
            ))}
            {scanData?.mcpServersUsed?.map((server) => (
              <span
                key={server}
                className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-purple-500/10 text-purple-400"
              >
                {server}
              </span>
            ))}
            {s.replay?.replayOutdated && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-terminal-orange-subtle text-terminal-orange">
                outdated replay
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-md text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-7 space-y-5 pb-5">
          {/* Title section */}
          <div>
            <div className="flex items-center justify-between mb-2 px-1">
              <span className="text-xs font-sans uppercase tracking-widest text-terminal-dimmer">
                Title
              </span>
              <span className="text-xs font-mono text-terminal-dimmer">{s.slug}</span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (s.replay) handleSaveTitle();
                else handleGenerate();
              }}
            >
              <textarea
                ref={titleInputRef}
                value={titleValue}
                onChange={(e) => setTitleValue(e.target.value.replace(/\n/g, ""))}
                onBlur={() => {
                  if (s.replay) handleSaveTitle();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (s.replay) handleSaveTitle();
                    else handleGenerate();
                  }
                }}
                rows={2}
                className="w-full bg-terminal-surface rounded-xl px-5 py-4 text-lg font-mono text-terminal-text placeholder:text-terminal-dimmer outline-none ring-1 ring-terminal-border-subtle focus:ring-terminal-green/40 transition-shadow duration-200 resize-none leading-relaxed"
                placeholder={suggested}
                maxLength={TITLE_MAX_CHARS}
              />
            </form>
          </div>

          {/* Two-column layout: info + stats */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Left: info grid */}
            <div className="bg-terminal-surface rounded-xl px-5 py-4 space-y-2.5">
              <div className="text-[10px] font-sans uppercase tracking-widest text-terminal-dimmer mb-1">
                Session Info
              </div>
              <InfoRow label="Project" value={projectName(s.project)} title={s.project} />
              {branch && <InfoRow label="Branch" value={branch} />}
              {scanData?.gitBranches && scanData.gitBranches.length > 1 && (
                <InfoRow label="Branches" value={scanData.gitBranches.join(", ")} />
              )}
              {scanData?.skillsUsed && scanData.skillsUsed.length > 0 && (
                <InfoRow label="Skills" value={scanData.skillsUsed.join(", ")} />
              )}
              {scanData?.mcpServersUsed && scanData.mcpServersUsed.length > 0 && (
                <InfoRow label="MCP Servers" value={scanData.mcpServersUsed.join(", ")} />
              )}
              <InfoRow label="Started" value={`${formatDate(startedAt)} (${timeAgo(startedAt)})`} />
              {scanData?.endTime && <InfoRow label="Ended" value={formatDate(scanData.endTime)} />}
              {!!durationMs && (
                <InfoRow label="Duration" value={`~${formatDuration(durationMs)}`} />
              )}
              <InfoRow label="Size" value={formatSize(s.fileSize)} />
              <InfoRow label="Lines" value={s.lineCount.toLocaleString()} />
              {s.filePaths.length > 1 && (
                <InfoRow label="Parts" value={`${s.filePaths.length} files`} />
              )}
              <InfoRow
                label="Data"
                value={formatDataSourceLabel(s.hasSqlite, scanData?.dataSource)}
              />
            </div>

            {/* Right: stats */}
            <div className="bg-terminal-surface rounded-xl px-5 py-4 space-y-2.5">
              <div className="text-[10px] font-sans uppercase tracking-widest text-terminal-dimmer mb-1">
                Stats
              </div>
              {!!promptCount && <InfoRow label="Prompts" value={String(promptCount)} />}
              {!!toolCallCount && <InfoRow label="Tools" value={String(toolCallCount)} />}
              {!!editCount && (
                <InfoRow label="Edits" value={scanData ? String(editCount) : `~${editCount}`} />
              )}
              {cost != null && cost > 0 && <InfoRow label="Cost" value={formatCost(cost)} />}
              {totalTokens != null && (
                <InfoRow
                  label="Tokens"
                  value={totalTokens.toLocaleString()}
                  title={
                    scanData?.tokenUsage
                      ? `In: ${scanData.tokenUsage.inputTokens.toLocaleString()} / Out: ${scanData.tokenUsage.outputTokens.toLocaleString()} / Cache write: ${scanData.tokenUsage.cacheCreationTokens.toLocaleString()} / Cache read: ${scanData.tokenUsage.cacheReadTokens.toLocaleString()}`
                      : undefined
                  }
                />
              )}
              {scanData != null && scanData.subAgentCount > 0 && (
                <InfoRow label="Agents" value={`${scanData.subAgentCount} sub-agents`} />
              )}
              {scanData != null && scanData.compactionCount > 0 && (
                <InfoRow label="Compacts" value={String(scanData.compactionCount)} />
              )}
              {scanData != null && scanData.apiErrorCount > 0 && (
                <InfoRow label="Errors" value={`${scanData.apiErrorCount} API errors`} />
              )}
              {s.hasPR && !scanData?.prLinks?.length && <InfoRow label="PR" value="Yes" />}
              {scanData?.prLinks?.map((pr) => (
                <InfoRow
                  key={pr.prNumber}
                  label="PR"
                  value={`#${pr.prNumber} (${pr.prRepository})`}
                />
              ))}
            </div>
          </div>

          {dataQualityNotes.length > 0 && (
            <div>
              <div className="text-[10px] font-sans uppercase tracking-widest text-terminal-dimmer mb-2">
                Data Quality
              </div>
              <div className="bg-terminal-surface rounded-xl px-4 py-3 space-y-1.5">
                {dataQualityNotes.map((note) => (
                  <div
                    key={note}
                    className="flex gap-2 items-start text-xs font-mono text-terminal-dim"
                  >
                    <span className="text-terminal-orange shrink-0 mt-px">!</span>
                    <span>{note}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Files modified (from scan) */}
          {scanData?.filesModified && scanData.filesModified.length > 0 && (
            <div>
              <div className="text-[10px] font-sans uppercase tracking-widest text-terminal-dimmer mb-2">
                Files Modified ({scanData.filesModified.length})
              </div>
              <div className="max-h-[120px] overflow-y-auto bg-terminal-surface rounded-xl px-4 py-2.5 space-y-1">
                {scanData.filesModified.slice(0, 20).map((f) => (
                  <div
                    key={f.file}
                    className="flex items-center justify-between gap-3 text-xs font-mono"
                  >
                    <span className="text-terminal-dim truncate">{f.file}</span>
                    <span className="text-terminal-dimmer shrink-0 tabular-nums">{f.count}x</span>
                  </div>
                ))}
                {scanData.filesModified.length > 20 && (
                  <div className="text-xs font-mono text-terminal-dimmer">
                    +{scanData.filesModified.length - 20} more files
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Prompts */}
          {prompts.length > 0 && (
            <div>
              <div className="text-[10px] font-sans uppercase tracking-widest text-terminal-dimmer mb-2">
                Prompts
              </div>
              <div className="max-h-[180px] overflow-y-auto space-y-1.5 pr-1">
                {prompts.map((p, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <span className="text-xs text-terminal-green shrink-0 mt-px select-none">
                      &gt;
                    </span>
                    <p className="text-sm text-terminal-dim line-clamp-2 leading-relaxed">{p}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Replay info (if exists) */}
          {s.replay && (
            <div className="border-t border-terminal-border-subtle pt-4">
              <div className="text-[10px] font-sans uppercase tracking-widest text-terminal-dimmer mb-2">
                Replay
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {s.replay.replaySize != null && (
                  <span className="text-xs font-mono px-2 py-1 rounded-md bg-terminal-surface text-terminal-dim">
                    {formatSize(s.replay.replaySize)}
                  </span>
                )}
                {s.replay.generatorVersion && (
                  <span className="text-xs font-mono px-2 py-1 rounded-md bg-terminal-surface text-terminal-dimmer">
                    v{s.replay.generatorVersion}
                  </span>
                )}
                {!!s.replay.annotationCount && (
                  <span className="text-xs font-mono px-2 py-1 rounded-md bg-terminal-surface text-terminal-dim">
                    {s.replay.annotationCount} annotations
                  </span>
                )}
                {(s.replay.cloud || s.replay.gist) && (
                  <span className="text-xs font-mono px-2 py-1 rounded-md bg-terminal-green-subtle text-terminal-green">
                    {s.replay.cloud ? "Cloud" : "Gist"}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Expiry warning */}
          {s.expiresInDays != null && s.expiresInDays <= EXPIRY_WARN_DAYS && (
            <div
              className={`rounded-lg px-4 py-2.5 text-sm font-mono ${
                s.expiresInDays <= 2
                  ? "bg-terminal-red-subtle text-terminal-red"
                  : "bg-terminal-orange-subtle text-terminal-orange"
              }`}
            >
              {s.expiresInDays === 0
                ? "Transcript expires today"
                : `Transcript expires in ${s.expiresInDays} day${s.expiresInDays !== 1 ? "s" : ""}`}
              {" — generate a replay to preserve it."}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-7 py-4 border-t border-terminal-border-subtle">
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                onArchive(s.slug);
                onClose();
              }}
              className="h-9 px-3 text-xs font-sans rounded-lg text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors flex items-center gap-1.5"
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M2 4h12v2H2zM3 6v7h10V6M6.5 8h3" />
              </svg>
              {isArchived ? "Unarchive" : "Archive"}
            </button>
            {s.replay && (
              <button
                onClick={() => {
                  onDeleteReplay(s.slug);
                  onClose();
                }}
                className="h-9 px-3 text-xs font-sans rounded-lg text-terminal-red/70 hover:text-terminal-red hover:bg-terminal-red-subtle transition-colors flex items-center gap-1.5"
              >
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M3 4h10M5.5 4V3h5v1M6 7v4M10 7v4M4.5 4l.5 9h6l.5-9" />
                </svg>
                Delete replay
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {s.replay && (
              <>
                <button
                  onClick={() => onGenerate(s, titleValue)}
                  disabled={isGenerating}
                  className="h-11 px-5 text-sm font-sans font-semibold rounded-xl bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis transition-all duration-200 flex items-center gap-2 disabled:opacity-50"
                >
                  {isGenerating ? (
                    <span className="animate-pulse">Regenerating...</span>
                  ) : (
                    <>
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                        <path d="M21 3v5h-5" />
                        <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                        <path d="M8 16H3v5" />
                      </svg>
                      Regenerate
                    </>
                  )}
                </button>
                <button
                  onClick={() => onViewReplay(s.existingReplay!)}
                  className="h-11 px-6 text-sm font-sans font-bold rounded-xl bg-terminal-green text-terminal-bg hover:brightness-110 transition-all duration-200 flex items-center gap-2"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M5 3l8 5-8 5V3z" />
                  </svg>
                  View Replay
                </button>
              </>
            )}
            {!s.replay && (
              <button
                onClick={handleGenerate}
                disabled={isGenerating}
                className="h-12 px-8 text-sm font-sans font-bold rounded-xl bg-terminal-green text-terminal-bg hover:brightness-110 transition-all duration-200 flex items-center gap-2 shadow-lg shadow-terminal-green/20 disabled:opacity-50"
              >
                {isGenerating ? (
                  <span className="animate-pulse">Generating...</span>
                ) : (
                  <>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M8 2v12M2 8h12" />
                    </svg>
                    Generate Replay
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Info row for popup metadata grid */
export function InfoRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-[11px] font-sans text-terminal-dimmer uppercase tracking-wider shrink-0 w-[68px]">
        {label}
      </span>
      <span className="text-sm font-mono text-terminal-dim truncate" title={title || value}>
        {value}
      </span>
    </div>
  );
}

/** Shared card for displaying a replay — used by both Sessions and Replays tabs */
function ReplayCard({
  summary: s,
  onOpen,
  onShare,
  onTitleSave,
  onDelete,
  onRegenerate,
  onArchive,
  isDeleting: _isDeleting,
  isRegenerating,
  isArchived,
}: {
  summary: SessionSummary;
  onOpen: () => void;
  onShare?: () => void;
  onTitleSave?: (slug: string, title: string) => Promise<void>;
  onDelete?: () => void;
  onRegenerate?: () => void;
  onArchive?: () => void;
  isDeleting?: boolean;
  isRegenerating?: boolean;
  isArchived?: boolean;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
        setConfirmingDelete(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  return (
    <div
      onClick={onOpen}
      className={`bg-terminal-surface rounded-xl px-5 py-5 hover:bg-terminal-surface-hover transition-all duration-300 ease-material space-y-3.5 shadow-layer-sm cursor-pointer hover-lift ${isArchived ? "opacity-50" : ""}`}
    >
      {/* Row 1: title + badges + actions */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 flex items-center gap-2 min-w-0">
          {onTitleSave ? (
            <div className="flex-1 min-w-0" onClick={(e) => e.stopPropagation()}>
              <EditableTitle
                slug={s.slug}
                title={s.title}
                fallbackTitle={replaySuggestedTitle(s)}
                onSave={onTitleSave}
              />
            </div>
          ) : (
            <div className="flex-1 min-w-0">
              <span className="text-sm font-sans font-medium text-terminal-text truncate block">
                {replaySuggestedTitle(s)}
              </span>
              <div className="text-[11px] font-mono text-terminal-dimmer truncate mt-0.5">
                slug: <span className="text-terminal-dim">{s.slug}</span>
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {s.replayOutdated && (
            <span
              className="h-6 px-2 text-[10px] font-mono rounded-md bg-terminal-orange-subtle text-terminal-orange flex items-center gap-1"
              title={`Generated with v${s.generatorVersion || "?"} — regenerate to update`}
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M2.5 8a5.5 5.5 0 019.3-4M13.5 8a5.5 5.5 0 01-9.3 4" />
                <path d="M12.5 1v3h-3M3.5 15v-3h3" />
              </svg>
              outdated
            </span>
          )}
          {s.gist?.outdated && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onShare?.();
              }}
              className="h-7 w-7 flex items-center justify-center rounded-md bg-terminal-orange-subtle text-terminal-orange hover:bg-terminal-orange-emphasis transition-all duration-200 ease-material shrink-0"
              title="Gist out of sync — click to update"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 1a1 1 0 0 1 1 1v5.5a1 1 0 0 1-2 0V2a1 1 0 0 1 1-1zM8 11a1.25 1.25 0 1 1 0 2.5A1.25 1.25 0 0 1 8 11z" />
              </svg>
            </button>
          )}
          {onShare && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onShare();
              }}
              className={`h-7 px-2.5 text-xs font-sans font-semibold rounded-md transition-all duration-200 ease-material flex items-center justify-center gap-1.5 shrink-0 ${
                s.cloud || s.gist
                  ? "bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis"
                  : "bg-terminal-purple-subtle text-terminal-purple hover:bg-terminal-purple-emphasis"
              }`}
              title={s.cloud || s.gist ? "Already shared — view or update" : "Share & Export"}
            >
              {s.cloud || s.gist ? (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                </svg>
              ) : (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M8 2v8M5 5l3-3 3 3M3 11v2h10v-2" />
                </svg>
              )}
              {s.cloud || s.gist ? "Shared" : "Share"}
            </button>
          )}
          {onRegenerate && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRegenerate();
              }}
              disabled={isRegenerating}
              className="h-7 px-2.5 text-xs font-sans font-semibold rounded-md bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis transition-all duration-200 ease-material flex items-center justify-center gap-1.5 shrink-0 disabled:opacity-50"
              title="Redo"
            >
              {isRegenerating ? (
                <span className="animate-pulse">...</span>
              ) : (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                  <path d="M21 3v5h-5" />
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                  <path d="M8 16H3v5" />
                </svg>
              )}
              Redo
            </button>
          )}
          <button
            onClick={onOpen}
            className="h-7 px-2.5 text-xs font-sans font-semibold rounded-md bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis transition-all duration-200 ease-material flex items-center justify-center gap-1 shrink-0"
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <polygon points="4 2 14 8 4 14" />
            </svg>
            View
          </button>
          {(onDelete || onArchive) && (
            <div className="relative" ref={menuRef}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((v) => !v);
                  setConfirmingDelete(false);
                }}
                className="h-7 w-7 flex items-center justify-center rounded-md bg-terminal-surface-2 text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors duration-200"
                title="More actions"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <circle cx="8" cy="3" r="1.5" />
                  <circle cx="8" cy="8" r="1.5" />
                  <circle cx="8" cy="13" r="1.5" />
                </svg>
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg bg-terminal-surface-2 border border-terminal-border shadow-layer-md py-1">
                  {onArchive && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onArchive();
                        setMenuOpen(false);
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-sans text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
                    >
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path d="M2 4h12v2H2zM3 6v7h10V6M6.5 8h3" />
                      </svg>
                      {isArchived ? "Unarchive" : "Archive"}
                    </button>
                  )}
                  {onDelete && (
                    <>
                      {onArchive && <div className="mx-2 my-1 border-t border-terminal-border" />}
                      {confirmingDelete ? (
                        <div className="flex items-center gap-1 px-2 py-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              onDelete();
                              setConfirmingDelete(false);
                              setMenuOpen(false);
                            }}
                            className="h-6 px-2 text-xs font-sans rounded bg-terminal-red-subtle text-terminal-red hover:bg-terminal-red-emphasis transition-colors duration-200"
                          >
                            Confirm
                          </button>
                          <button
                            onClick={() => setConfirmingDelete(false)}
                            className="h-6 px-2 text-xs font-sans rounded text-terminal-dim hover:text-terminal-text transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmingDelete(true)}
                          className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-sans text-terminal-red hover:bg-terminal-red-subtle transition-colors"
                        >
                          <svg
                            width="13"
                            height="13"
                            viewBox="0 0 16 16"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.5"
                          >
                            <path d="M3 4h10M5.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1M6.5 7v4M9.5 7v4M4.5 4l.5 9a1 1 0 001 1h4a1 1 0 001-1l.5-9" />
                          </svg>
                          Delete
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Row 2: user messages */}
      {(s.messages || (s.firstMessage ? [s.firstMessage] : []))
        .map((msg) => cleanPrompt(msg || ""))
        .filter((msg) => msg.length > 0)
        .map((msg, i) => (
          <div key={i} className="flex gap-2 items-start">
            <span className="text-xs text-terminal-green shrink-0 mt-px select-none">&gt;</span>
            <p className="text-sm text-terminal-dim line-clamp-1 leading-relaxed">{msg}</p>
          </div>
        ))}
      {/* Row 3: stats bar */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dim">
          {s.stats.userPrompts} prompts
        </span>
        <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-orange-subtle text-terminal-orange">
          {s.stats.toolCalls} tools
        </span>
        {s.stats.durationMs && (
          <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dim">
            {formatDuration(s.stats.durationMs)}
          </span>
        )}
        {s.stats.costEstimate && (
          <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-green-subtle text-terminal-green">
            {formatCost(s.stats.costEstimate)}
          </span>
        )}
        {s.hasAnnotations && (
          <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-blue-subtle text-terminal-blue">
            {s.annotationCount} annotation{s.annotationCount !== 1 ? "s" : ""}
          </span>
        )}
        {s.replaySize != null && s.replaySize > 0 && (
          <span
            className={`inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md ${
              s.replaySize > 10 * 1024 * 1024
                ? "bg-terminal-red-subtle text-terminal-red"
                : "bg-terminal-surface-2 text-terminal-dimmer"
            }`}
            title={s.replaySize > 10 * 1024 * 1024 ? "Exceeds share limit (10MB)" : undefined}
          >
            {formatSize(s.replaySize)}
          </span>
        )}
      </div>
      {/* Row 4: identity */}
      <div className="flex items-center gap-2 text-xs font-mono text-terminal-dimmer flex-wrap">
        <ProviderBadge provider={s.provider} />
        <span>{s.project}</span>
        <span className="text-terminal-border">&middot;</span>
        <span>{formatDate(s.startTime)}</span>
        {s.model && (
          <>
            <span className="text-terminal-border">&middot;</span>
            <span>{s.model}</span>
          </>
        )}
      </div>
    </div>
  );
}

/** Regenerate all existing replays from source JSONL files */
function RegenerateAllButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ regenerated: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRegenerate = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/regenerate-all", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setResult({ regenerated: data.regenerated, total: data.total });
      // Reload after short delay to show updated replays
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to regenerate");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleRegenerate}
        disabled={loading}
        className="px-3 py-1.5 text-xs font-mono rounded-lg bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover border border-terminal-border-subtle transition-colors duration-200 disabled:opacity-40"
      >
        {loading ? "Regenerating..." : "Regenerate All"}
      </button>
      {result && (
        <span className="text-xs font-mono text-terminal-green">
          {result.regenerated}/{result.total} regenerated
        </span>
      )}
      {error && <span className="text-xs font-mono text-terminal-red">{error}</span>}
    </div>
  );
}

// ─── Sessions Tab (source sessions from providers) ─────────────────

/** "All projects" sentinel */
const ALL_PROJECTS = "__all__";

function SessionsPanel() {
  const [sources, setSources] = useState<SourceSession[]>([]);
  const [scanResultsBySlug, setScanResultsBySlug] = useState<Record<string, SessionScanData>>({});
  const [cleanupPeriodDays, setCleanupPeriodDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [staleCachedAt, setStaleCachedAt] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [refreshClockMs, setRefreshClockMs] = useState(() => Date.now());
  const [selectedProject, setSelectedProject] = useState<string>(getProjectFromUrl());
  const [filter, setFilter] = useState(getFilterFromUrl());
  const [showArchived, setShowArchived] = useState(getShowArchivedFromUrl());

  useEffect(() => {
    const handler = () => {
      setSelectedProject(getProjectFromUrl());
      setFilter(getFilterFromUrl());
      setShowArchived(getShowArchivedFromUrl());
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const handleProjectChange = (project: string) => {
    setSelectedProject(project);
    navigateTo({ project: project === ALL_PROJECTS ? null : project });
  };

  const handleFilterChange = (val: string) => {
    setFilter(val);
    navigateTo({ q: val || null }, { replace: true });
  };

  const handleToggleArchived = () => {
    const next = !showArchived;
    setShowArchived(next);
    navigateTo({ archived: next ? "true" : null });
  };

  // Background scan + insights (shared singleton context)
  const { scanStatus, userInsights, projectInsightsCache, fetchProjectInsights } =
    useScanInsightsContext();

  // Fetch project insights when selected project changes
  useEffect(() => {
    if (selectedProject !== ALL_PROJECTS) {
      fetchProjectInsights(selectedProject);
    }
  }, [selectedProject, fetchProjectInsights]);

  const projectInsights =
    selectedProject !== ALL_PROJECTS ? projectInsightsCache.get(selectedProject) : undefined;

  const [generatingSlug, setGeneratingSlug] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const wasEnrichingRef = useRef(false);
  const [archivedSlugs, setArchivedSlugs] = useState<Set<string>>(new Set());
  const [enrichmentStatus, setEnrichmentStatus] = useState<SourcesEnrichmentStatus | null>(null);
  const hasCursorSources = sources.some((source) => source.provider === "cursor");
  const selectedSession = selectedSlug
    ? (sources.find((s) => s.slug === selectedSlug) ?? null)
    : null;

  const loadSources = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    setLoading(true);
    setError(null);
    setRefreshError(null);
    setRefreshing(false);
    setStaleCachedAt(null);

    const archive = await fetch("/api/archived")
      .then((r) => (r.ok ? r.json() : { slugs: [] }))
      .catch(() => ({ slugs: [] as string[] }));
    setArchivedSlugs(new Set(archive.slugs));

    let servedFromCache = false;
    const cached = await fetch("/api/sources/cached")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const cachedData = parseCachedList<SourceSession>(cached);
    const shouldSkipRefresh = !opts?.forceRefresh && isCacheFresh(cachedData?.cachedAt);
    if (cachedData && cachedData.sessions.length > 0) {
      servedFromCache = true;
      setSources(cachedData.sessions);
      setLastRefreshedAt(cachedData.cachedAt ?? null);
      setStaleCachedAt(shouldSkipRefresh ? null : (cachedData.cachedAt ?? null));
      setLoading(false);
      setRefreshing(!shouldSkipRefresh);
    }

    if (shouldSkipRefresh) {
      setRefreshing(false);
      setLoading(false);
      return;
    }

    try {
      const freshResp = await fetch("/api/sources");
      if (!freshResp.ok) throw new Error("Failed to load sessions");
      const fresh = (await freshResp.json()) as {
        sessions: SourceSession[];
        cleanupPeriodDays?: number;
      };
      setSources(fresh.sessions);
      if (fresh.cleanupPeriodDays != null) setCleanupPeriodDays(fresh.cleanupPeriodDays);
      setLastRefreshedAt(new Date().toISOString());
      setStaleCachedAt(null);
    } catch (err) {
      if (!servedFromCache) {
        setError(getErrorMessage(err) || "Failed to load sessions");
      } else {
        setRefreshError("Failed to refresh latest sessions. Showing cached data.");
      }
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  const toggleArchive = async (slug: string) => {
    const isArchived = archivedSlugs.has(slug);
    setArchivedSlugs((prev) => {
      const next = new Set(prev);
      isArchived ? next.delete(slug) : next.add(slug);
      return next;
    });
    try {
      const resp = await fetch(`/api/archive/${slug}`, { method: isArchived ? "DELETE" : "POST" });
      if (!resp.ok) throw new Error("Archive toggle failed");
    } catch (err) {
      console.error("Archive toggle failed:", getErrorMessage(err));
      setArchivedSlugs((prev) => {
        const next = new Set(prev);
        isArchived ? next.add(slug) : next.delete(slug);
        return next;
      });
    }
  };

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (sources.length === 0) return;
    let cancelled = false;
    const loadScanResults = async () => {
      const results = await fetchScanResults();
      if (cancelled || !results) return;
      setScanResultsBySlug(
        Object.fromEntries(
          results.filter((result) => result.slug).map((result) => [result.slug!, result]),
        ),
      );
    };
    void loadScanResults();
    const timer = window.setInterval(
      () => {
        void loadScanResults();
      },
      scanStatus?.running ? 5000 : 30000,
    );
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [scanStatus?.running, sources.length]);

  useEffect(() => {
    if (!loading && !hasCursorSources && !wasEnrichingRef.current) return;

    let cancelled = false;
    let timer: number | undefined;
    const refreshSourcesFromCache = async () => {
      const payload = await fetch("/api/sources/cached")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const cached = parseCachedList<SourceSession>(payload);
      if (!cancelled && cached?.sessions.length) {
        setSources(cached.sessions);
      }
    };
    const poll = async () => {
      const status = await fetch("/api/sources/enrichment-status")
        .then((r) => (r.ok ? (r.json() as Promise<SourcesEnrichmentStatus>) : null))
        .catch(() => null);
      if (!status || cancelled) return;
      setEnrichmentStatus(status);
      if (status.running) {
        wasEnrichingRef.current = true;
        await refreshSourcesFromCache();
      } else if (wasEnrichingRef.current) {
        wasEnrichingRef.current = false;
        await refreshSourcesFromCache();
      }
    };
    void poll();
    timer = window.setInterval(() => {
      void poll();
    }, 2500);
    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
    };
  }, [hasCursorSources, loading]);

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshClockMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const handleTitleSave = async (slug: string, title: string) => {
    const resp = await fetch(`/api/sessions/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!resp.ok) throw new Error("Failed to update title");
    // Update the replay summary inside sources so the UI reflects the change
    setSources((prev) =>
      prev.map((s) =>
        s.slug === slug && s.replay
          ? { ...s, replay: { ...s.replay, title: title || undefined } }
          : s,
      ),
    );
  };

  const submitGenerate = async (source: SourceSession, title: string) => {
    setSelectedSlug(null);
    setGeneratingSlug(source.slug);
    setGenerateError(null);

    try {
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: source.provider,
          filePaths: source.filePaths,
          toolPaths: source.toolPaths,
          title: normalizeTitleText(title) || undefined,
          sessionSlug: source.slug,
          sessionProject: source.project,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Generation failed");
      navigateTo({ view: null, session: data.slug });
    } catch (err) {
      setGenerateError(getErrorMessage(err));
    } finally {
      setGeneratingSlug(null);
    }
  };

  const handleDeleteReplay = async (slug: string) => {
    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      });
      if (!resp.ok) return;
      // Remove the replay from the source so the card switches to "Generate"
      setSources((prev) =>
        prev.map((s) => (s.slug === slug ? { ...s, replay: undefined, existingReplay: null } : s)),
      );
    } catch {
      // ignore
    }
  };

  // Visible sessions (excluding archived unless toggled)
  const archivedCount = sources.filter((s) => archivedSlugs.has(s.slug)).length;
  const visibleSources = showArchived ? sources : sources.filter((s) => !archivedSlugs.has(s.slug));

  // Group by project, sorted by most recent timestamp
  const byProject = new Map<string, SourceSession[]>();
  for (const s of visibleSources) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project)?.push(s);
  }
  const projectEntries = [...byProject.entries()].sort((a, b) => {
    const aTime = a[1][0]?.timestamp || "";
    const bTime = b[1][0]?.timestamp || "";
    return bTime.localeCompare(aTime);
  });

  // Compute disambiguated labels for projects
  const projectLabels = computeProjectLabels(projectEntries.map(([p]) => p));

  // Filter sessions within selected project
  const projectSessions =
    selectedProject === ALL_PROJECTS ? visibleSources : byProject.get(selectedProject) || [];

  const filtered = filter
    ? projectSessions.filter(
        (s) =>
          s.slug.toLowerCase().includes(filter.toLowerCase()) ||
          s.firstPrompt.toLowerCase().includes(filter.toLowerCase()) ||
          (s.title || "").toLowerCase().includes(filter.toLowerCase()) ||
          (s.gitBranch || "").toLowerCase().includes(filter.toLowerCase()),
      )
    : projectSessions;
  const refreshAge = lastRefreshedAt ? formatCompactAge(lastRefreshedAt, refreshClockMs) : null;

  const showInitialLoading = loading && sources.length === 0;

  // Count sessions approaching Claude Code cleanup
  // Threshold mirrors WARNING_THRESHOLD_DAYS in packages/cli/src/cleanup-warning.ts
  const EXPIRY_WARN_DAYS = 7;
  const expiringSessions = sources.filter(
    (s) =>
      s.expiresInDays != null && s.expiresInDays <= EXPIRY_WARN_DAYS && !archivedSlugs.has(s.slug),
  );
  const soonestExpiry = expiringSessions.reduce(
    (min, s) => Math.min(min, s.expiresInDays ?? Infinity),
    Infinity,
  );

  if (error && sources.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="text-terminal-red font-mono text-sm">{error}</div>
          <button
            onClick={() => void loadSources({ forceRefresh: true })}
            className="px-3 py-1.5 text-xs font-mono rounded-md bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors duration-200"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (sources.length === 0 && !showInitialLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-2">
          <div className="text-terminal-dim font-mono text-sm">No AI sessions found</div>
          <div className="text-terminal-dimmer font-mono text-xs">
            Start a coding session with Claude Code or Cursor, then come back here
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* ─── Left sidebar: project navigation (hidden on mobile) ─── */}
      <div className="hidden md:flex w-60 shrink-0 flex-col border-r border-terminal-border-subtle bg-terminal-surface/20">
        <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border-subtle">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold">
              Projects
            </span>
            {refreshAge && (
              <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums">
                {refreshAge}
              </span>
            )}
          </div>
          <button
            onClick={() => {
              void loadSources({ forceRefresh: true });
            }}
            className="p-1.5 rounded-md text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors duration-200"
            title="Refresh"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M2.5 8a5.5 5.5 0 019.3-4M13.5 8a5.5 5.5 0 01-9.3 4" />
              <path d="M12.5 1v3h-3M3.5 15v-3h3" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {/* All projects */}
          <button
            onClick={() => handleProjectChange(ALL_PROJECTS)}
            className={`w-full text-left px-3 py-2.5 text-xs font-sans rounded-lg transition-all duration-200 ease-material flex items-center justify-between ${
              selectedProject === ALL_PROJECTS
                ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface"
            }`}
          >
            <span className="font-medium">All projects</span>
            <span
              className={`tabular-nums px-1.5 py-0.5 rounded-md text-xs ${
                selectedProject === ALL_PROJECTS
                  ? "bg-terminal-green-emphasis text-terminal-green"
                  : "bg-terminal-surface text-terminal-dimmer"
              }`}
            >
              {sources.length}
            </span>
          </button>

          <div className="h-px bg-terminal-border-subtle mx-2 my-1.5" />

          {/* Per-project items */}
          {projectEntries.map(([project, sessions]) => {
            const replayCount = sessions.filter((s) => s.existingReplay).length;
            const isActive = selectedProject === project;
            const label = projectLabels.get(project) || projectName(project);
            const exists = sessions[0]?.projectExists !== false;
            const isGit = sessions.some((s) => s.isGitRepo || s.gitBranch);
            return (
              <button
                key={project}
                onClick={() => handleProjectChange(project)}
                title={project}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200 ease-material group ${
                  isActive
                    ? "bg-terminal-green-subtle shadow-layer-sm"
                    : "hover:bg-terminal-surface"
                } ${!exists ? "opacity-50" : ""}`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span
                    className={`text-xs font-sans truncate flex items-center gap-1.5 ${
                      isActive
                        ? "text-terminal-green font-medium"
                        : !exists
                          ? "text-terminal-dim"
                          : "text-terminal-text group-hover:text-terminal-text"
                    }`}
                  >
                    {isGit && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className={`shrink-0 ${isActive ? "opacity-70" : "opacity-40"}`}
                      >
                        <path
                          fillRule="evenodd"
                          d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"
                        />
                      </svg>
                    )}
                    {label}
                  </span>
                  <span
                    className={`tabular-nums px-1.5 py-0.5 rounded-md text-xs shrink-0 ${
                      isActive
                        ? "bg-terminal-green-emphasis text-terminal-green"
                        : "bg-terminal-surface text-terminal-dimmer"
                    }`}
                  >
                    {sessions.length}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 ml-0.5">
                  <span
                    className={`text-xs font-mono truncate ${isActive ? "text-terminal-dim" : "text-terminal-dimmer"}`}
                  >
                    {timeAgo(sessions[0]?.timestamp || "")}
                  </span>
                  {replayCount > 0 && (
                    <span
                      className={`text-xs font-mono ${isActive ? "text-terminal-green" : "text-terminal-dimmer"}`}
                    >
                      {replayCount} {replayCount === 1 ? "replay" : "replays"}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Right: session list ─── */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Mobile project selector (shown instead of sidebar) */}
        <div className="md:hidden px-3 pt-3">
          <select
            value={selectedProject}
            onChange={(e) => handleProjectChange(e.target.value)}
            className="w-full bg-terminal-surface rounded-lg px-3 py-2.5 text-sm font-sans text-terminal-text outline-none shadow-layer-sm"
          >
            <option value={ALL_PROJECTS}>All projects ({sources.length})</option>
            {projectEntries.map(([project, sessions]) => (
              <option key={project} value={project}>
                {projectLabels.get(project) || projectName(project)} ({sessions.length})
              </option>
            ))}
          </select>
        </div>

        {/* Insights header + search */}
        <div className="px-4 pt-4 pb-2 space-y-3 shrink-0">
          {/* Insights summary card — replaces old project title */}
          <div className="hidden md:block">
            {projectInsights && selectedProject !== ALL_PROJECTS ? (
              <TitleInsightsHeader insights={projectInsights} variant="project" />
            ) : userInsights && selectedProject === ALL_PROJECTS ? (
              <TitleInsightsHeader insights={userInsights} variant="all" />
            ) : (
              <TitleInsightsHeaderSkeleton />
            )}
          </div>

          {/* Search + archive toggle */}
          <div className="flex gap-2 items-center">
            <div className="relative flex-1">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-dim"
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="7" cy="7" r="5" />
                <path d="M11 11l3.5 3.5" />
              </svg>
              <input
                value={filter}
                onChange={(e) => handleFilterChange(e.target.value)}
                placeholder="Filter by branch, title, prompt..."
                className="w-full bg-terminal-surface rounded-lg pl-9 pr-3 py-2.5 text-sm font-mono text-terminal-text placeholder:text-terminal-dimmer outline-none ring-1 ring-transparent focus:ring-terminal-green/40 transition-shadow duration-200 shadow-layer-sm"
              />
            </div>
            {archivedCount > 0 && (
              <button
                onClick={handleToggleArchived}
                className={`shrink-0 px-2.5 py-2 text-xs font-mono rounded-lg transition-colors duration-200 ${
                  showArchived
                    ? "bg-terminal-orange-subtle text-terminal-orange"
                    : "bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
                }`}
                title={showArchived ? "Hide archived" : `View all (${archivedCount} archived)`}
              >
                {showArchived ? "Active" : "View all"}
              </button>
            )}
          </div>
        </div>

        {(showInitialLoading || refreshing || staleCachedAt) && (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-mono bg-terminal-blue-subtle text-terminal-blue shrink-0 shadow-layer-sm">
            {showInitialLoading ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-terminal-blue animate-pulse" />
                <span>FETCHING SESSIONS...</span>
              </>
            ) : refreshing ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-terminal-blue animate-pulse" />
                <span>SCANNING LATEST SESSIONS...</span>
                {staleCachedAt && (
                  <span className="text-terminal-dim">
                    Showing stale cache ({formatCacheAge(staleCachedAt)})
                  </span>
                )}
              </>
            ) : staleCachedAt ? (
              <span>Showing stale cache ({formatCacheAge(staleCachedAt)})</span>
            ) : null}
          </div>
        )}

        {enrichmentStatus?.running && enrichmentStatus.total > 0 && (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-mono bg-terminal-blue-subtle text-terminal-blue shrink-0 shadow-layer-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-terminal-blue animate-pulse" />
            <span>
              BACKFILLING CURSOR STATS... {enrichmentStatus.processed}/{enrichmentStatus.total}
            </span>
          </div>
        )}

        {/* Error toast */}
        {refreshError && (
          <div className="mx-4 mb-2 flex items-center gap-2 bg-terminal-orange-subtle rounded-lg px-3 py-2.5 text-xs font-mono text-terminal-orange shrink-0 shadow-layer-sm">
            <span>{refreshError}</span>
            <button
              onClick={() => setRefreshError(null)}
              className="ml-auto text-terminal-orange/60 hover:text-terminal-orange transition-colors"
            >
              &times;
            </button>
          </div>
        )}

        {/* Error toast */}
        {generateError && (
          <div className="mx-4 mb-2 flex items-center gap-2 bg-terminal-red-subtle rounded-lg px-3 py-2.5 text-xs font-mono text-terminal-red shrink-0 shadow-layer-sm">
            <span>{generateError}</span>
            <button
              onClick={() => setGenerateError(null)}
              className="ml-auto text-terminal-red/60 hover:text-terminal-red transition-colors"
            >
              &times;
            </button>
          </div>
        )}
        {/* Cleanup expiry alert */}
        {expiringSessions.length > 0 && (
          <div className="mx-4 mb-2 flex items-start gap-2.5 bg-terminal-orange-subtle rounded-lg px-4 py-3 shrink-0 shadow-layer-sm">
            <span className="text-terminal-orange text-base leading-none mt-0.5">&#9888;</span>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-sans font-semibold text-terminal-orange">
                {expiringSessions.length} session{expiringSessions.length !== 1 ? "s" : ""} expiring
                {soonestExpiry === 0
                  ? " today"
                  : soonestExpiry === 1
                    ? " tomorrow"
                    : ` within ${soonestExpiry} days`}
              </div>
              <div className="text-[11px] font-mono text-terminal-orange/70 mt-0.5">
                Claude Code auto-deletes transcripts after{" "}
                {cleanupPeriodDays != null ? `${cleanupPeriodDays} days` : "the configured period"}.
                Generate replays to preserve them.
              </div>
            </div>
          </div>
        )}

        {/* Session list */}
        <div className="flex-1 overflow-y-auto">
          {showInitialLoading ? (
            <div className="text-center py-12 text-terminal-dim font-mono text-sm">
              Fetching sessions...
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-terminal-dim font-mono text-sm">
              {filter ? "No sessions match your filter" : "No sessions in this project"}
            </div>
          ) : (
            <div className="space-y-2.5 px-4 py-3">
              {filtered.map((s) => {
                const scanData = scanResultsBySlug[s.slug];
                // Sessions with replay: use the shared ReplayCard
                if (s.replay) {
                  const isArchived = archivedSlugs.has(s.slug);
                  const displayTitle = sourceDisplayTitle(s, scanData);
                  const promptPreview = sessionPromptPreview(s, scanData, displayTitle);
                  return (
                    <ReplayCard
                      key={`${s.provider}-${s.slug}`}
                      summary={{
                        ...s.replay,
                        title: displayTitle,
                        firstMessage:
                          promptPreview[0] || scanData?.firstPrompt || s.replay.firstMessage,
                        messages:
                          promptPreview.length > 0
                            ? promptPreview.slice(0, 2)
                            : scanData?.firstPrompt
                              ? [scanData.firstPrompt]
                              : s.replay.messages,
                        model: scanData?.model || s.replay.model,
                      }}
                      onOpen={() => navigateTo({ view: null, session: s.existingReplay! })}
                      onShare={() =>
                        navigateTo({ view: null, session: s.existingReplay!, v: "export" })
                      }
                      onTitleSave={handleTitleSave}
                      onRegenerate={() => setSelectedSlug(s.slug)}
                      isRegenerating={generatingSlug === s.slug}
                      onDelete={() => handleDeleteReplay(s.slug)}
                      onArchive={() => toggleArchive(s.slug)}
                      isArchived={isArchived}
                    />
                  );
                }
                // Sessions without replay: simpler card with Generate
                const sessionTitle = sourceDisplayTitle(s, scanData);
                const prompts = sessionPromptPreview(s, scanData, sessionTitle);
                const branch = nonDefaultBranch(scanData?.gitBranch || s.gitBranch);
                const displayPromptCount = scanData?.promptCount ?? s.promptCount;
                const displayToolCount = scanData?.toolCallCount ?? s.toolCallCount;
                const displayDurationMs = scanData?.durationMs ?? s.durationMsEst;
                const displayEditCount = scanData?.editCount ?? s.editCountEst;
                const displayModel = scanData?.model || s.model;
                const dataSourceLabel = formatDataSourceLabel(s.hasSqlite, scanData?.dataSource);
                const isArchived = archivedSlugs.has(s.slug);
                return (
                  <div
                    key={`${s.provider}-${s.slug}`}
                    onClick={() => setSelectedSlug(s.slug)}
                    className={`bg-terminal-surface rounded-xl px-5 py-4 hover:bg-terminal-surface-hover transition-all duration-300 ease-material space-y-2.5 shadow-layer-sm cursor-pointer hover-lift ${isArchived ? "opacity-50" : ""}`}
                  >
                    {/* Row 1: title + meta (left) / time + actions (right) */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <span className="text-sm font-mono text-terminal-text truncate block">
                          {sessionTitle}
                        </span>
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="text-[11px] font-mono text-terminal-dimmer truncate">
                            slug: <span className="text-terminal-dim">{s.slug}</span>
                          </div>
                          {branch && (
                            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded bg-terminal-surface-2 text-terminal-dim shrink-0 inline-flex items-center gap-0.5">
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 16 16"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.5"
                              >
                                <circle cx="5" cy="4" r="2" />
                                <circle cx="11" cy="12" r="2" />
                                <path d="M5 6v4c0 1.1.9 2 2 2h2" />
                              </svg>
                              {branch}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <span className="text-xs font-mono text-terminal-dimmer">
                          {timeAgo(s.timestamp)}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedSlug(s.slug);
                            }}
                            disabled={generatingSlug === s.slug}
                            className="h-7 px-2.5 text-xs font-sans font-semibold rounded-md bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis transition-all duration-200 ease-material flex items-center justify-center gap-1 disabled:opacity-50"
                          >
                            {generatingSlug === s.slug ? (
                              <span className="animate-pulse">Generating...</span>
                            ) : (
                              <>
                                <svg
                                  width="10"
                                  height="10"
                                  viewBox="0 0 16 16"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M8 2v12M2 8h12" />
                                </svg>
                                Generate
                              </>
                            )}
                          </button>
                          <SessionMoreMenu
                            onArchive={() => toggleArchive(s.slug)}
                            isArchived={isArchived}
                          />
                        </div>
                      </div>
                    </div>
                    {/* Row 2: user prompts */}
                    {prompts.map((p, i) => (
                      <div key={i} className="flex gap-2 items-start">
                        <span className="text-xs text-terminal-green shrink-0 mt-px select-none">
                          &gt;
                        </span>
                        <p className="text-sm text-terminal-dim line-clamp-1 leading-relaxed">
                          {p}
                        </p>
                      </div>
                    ))}
                    {/* Row 3: stats */}
                    {(s.promptCount ||
                      displayToolCount ||
                      displayDurationMs ||
                      displayEditCount ||
                      s.hasPR ||
                      (s.expiresInDays != null && s.expiresInDays <= EXPIRY_WARN_DAYS)) && (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {!!displayPromptCount && (
                          <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dim">
                            {displayPromptCount} prompts
                          </span>
                        )}
                        {!!displayToolCount && (
                          <span className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-orange-subtle text-terminal-orange">
                            {displayToolCount} tools
                          </span>
                        )}
                        {!!displayDurationMs && (
                          <span
                            className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dim"
                            title="Estimated active duration"
                          >
                            ~{formatDuration(displayDurationMs)}
                          </span>
                        )}
                        {!!displayEditCount && (
                          <span
                            className="inline-flex items-center gap-1 text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dim"
                            title="Estimated file edits"
                          >
                            ~{displayEditCount} edits
                          </span>
                        )}
                        {s.hasPR && (
                          <span
                            className="inline-flex items-center gap-1 text-xs font-mono px-1.5 py-0.5 rounded-md bg-terminal-purple-subtle text-terminal-purple"
                            title="Session produced a PR"
                          >
                            PR
                          </span>
                        )}
                        {s.expiresInDays != null && s.expiresInDays <= EXPIRY_WARN_DAYS && (
                          <span
                            className={`inline-flex items-center gap-1 text-xs font-mono px-1.5 py-0.5 rounded-md ${
                              s.expiresInDays <= 2
                                ? "bg-terminal-red-subtle text-terminal-red"
                                : "bg-terminal-orange-subtle text-terminal-orange"
                            }`}
                            title={`Session transcript will be cleaned up by Claude Code in ${s.expiresInDays === 0 ? "< 1 day" : `${s.expiresInDays} day${s.expiresInDays !== 1 ? "s" : ""}`}. Generate a replay to preserve it.`}
                          >
                            {s.expiresInDays === 0
                              ? "expires today"
                              : `expires in ${s.expiresInDays}d`}
                          </span>
                        )}
                      </div>
                    )}
                    {/* Row 4: identity */}
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <ProviderBadge provider={s.provider} />
                      {selectedProject === ALL_PROJECTS && (
                        <span
                          className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dim"
                          title={s.project}
                        >
                          {projectLabels.get(s.project) || projectName(s.project)}
                        </span>
                      )}
                      {displayModel && (
                        <span className="text-xs font-mono px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dimmer">
                          {shortModelName(displayModel)}
                        </span>
                      )}
                      <span className="text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dimmer">
                        {formatSize(s.fileSize)}
                      </span>
                      {s.filePaths.length > 1 && (
                        <span className="text-xs font-mono tabular-nums px-1.5 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dimmer">
                          {s.filePaths.length} parts
                        </span>
                      )}
                      {(s.hasSqlite || scanData?.dataSource) && (
                        <span
                          className={`text-xs font-mono px-1.5 py-0.5 rounded-md ${dataSourceBadgeClass(scanData?.dataSource, s.hasSqlite)}`}
                          title={dataSourceLabel}
                        >
                          {dataSourceLabel}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Session detail popup */}
        {selectedSession && (
          <SessionDetailPopup
            session={selectedSession}
            scanData={scanResultsBySlug[selectedSession.slug] || null}
            onClose={() => setSelectedSlug(null)}
            onGenerate={submitGenerate}
            onViewReplay={(slug) => navigateTo({ view: null, session: slug })}
            onArchive={(slug) => {
              toggleArchive(slug);
            }}
            onTitleSave={handleTitleSave}
            onDeleteReplay={handleDeleteReplay}
            isGenerating={generatingSlug === selectedSession.slug}
            isArchived={archivedSlugs.has(selectedSession.slug)}
          />
        )}
      </div>
    </div>
  );
}

// ─── Replays Tab (existing generated replays) ───────────────────────

function ReplaysPanel() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [serverAvailable, setServerAvailable] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [staleCachedAt, setStaleCachedAt] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [refreshClockMs, setRefreshClockMs] = useState(() => Date.now());
  const [archivedSlugs, setArchivedSlugs] = useState<Set<string>>(new Set());
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [regeneratingSlug, setRegeneratingSlug] = useState<string | null>(null);

  const [filter, setFilter] = useState(getFilterFromUrl());
  const [selectedProject, setSelectedProject] = useState<string>(getProjectFromUrl());
  const [showArchived, setShowArchived] = useState(getShowArchivedFromUrl());

  // Background scan + insights (shared singleton context)
  const { userInsights, projectInsightsCache, fetchProjectInsights } = useScanInsightsContext();

  // Fetch project insights when selected project changes
  useEffect(() => {
    if (selectedProject !== ALL_PROJECTS) {
      fetchProjectInsights(selectedProject);
    }
  }, [selectedProject, fetchProjectInsights]);

  const projectInsights =
    selectedProject !== ALL_PROJECTS ? projectInsightsCache.get(selectedProject) : undefined;

  useEffect(() => {
    const handler = () => {
      setSelectedProject(getProjectFromUrl());
      setFilter(getFilterFromUrl());
      setShowArchived(getShowArchivedFromUrl());
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const handleProjectChange = (project: string) => {
    setSelectedProject(project);
    navigateTo({ project: project === ALL_PROJECTS ? null : project });
  };

  const handleFilterChange = (val: string) => {
    setFilter(val);
    navigateTo({ q: val || null }, { replace: true });
  };

  const handleToggleArchived = () => {
    const next = !showArchived;
    setShowArchived(next);
    navigateTo({ archived: next ? "true" : null });
  };

  useEffect(() => {
    let mounted = true;
    const loadReplays = async () => {
      setLoading(true);
      setRefreshing(false);
      setStaleCachedAt(null);

      const archive = await fetch("/api/archived")
        .then((r) => (r.ok ? r.json() : { slugs: [] }))
        .catch(() => ({ slugs: [] as string[] }));
      if (mounted) {
        setArchivedSlugs(new Set(archive.slugs));
      }

      let servedFromCache = false;
      const cached = await fetch("/api/sessions/cached")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const cachedData = parseCachedList<SessionSummary>(cached);
      const shouldSkipRefresh = isCacheFresh(cachedData?.cachedAt);
      if (mounted && cachedData) {
        servedFromCache = true;
        setSessions(cachedData.sessions);
        setServerAvailable(true);
        setLastRefreshedAt(cachedData.cachedAt ?? null);
        if (cachedData.sessions.length > 0 || shouldSkipRefresh) {
          setStaleCachedAt(shouldSkipRefresh ? null : (cachedData.cachedAt ?? null));
          setLoading(false);
          setRefreshing(!shouldSkipRefresh);
        }
      }

      if (shouldSkipRefresh) {
        if (mounted) {
          setRefreshing(false);
          setLoading(false);
        }
        return;
      }

      try {
        const resp = await fetch("/api/sessions");
        if (!resp.ok) throw new Error("Failed to load sessions");
        const data = (await resp.json()) as SessionSummary[];
        if (!mounted) return;
        setSessions(data);
        setServerAvailable(true);
        setLastRefreshedAt(new Date().toISOString());
        setStaleCachedAt(null);
      } catch {
        if (!mounted) return;
        if (!servedFromCache) {
          setServerAvailable(false);
        }
      } finally {
        if (mounted) {
          setRefreshing(false);
          setLoading(false);
        }
      }
    };

    void loadReplays();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setRefreshClockMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const toggleArchive = async (slug: string) => {
    const isArchived = archivedSlugs.has(slug);
    setArchivedSlugs((prev) => {
      const next = new Set(prev);
      isArchived ? next.delete(slug) : next.add(slug);
      return next;
    });
    try {
      const resp = await fetch(`/api/archive/${slug}`, { method: isArchived ? "DELETE" : "POST" });
      if (!resp.ok) throw new Error("Archive toggle failed");
    } catch (err) {
      console.error("Archive toggle failed:", getErrorMessage(err));
      setArchivedSlugs((prev) => {
        const next = new Set(prev);
        isArchived ? next.add(slug) : next.delete(slug);
        return next;
      });
    }
  };

  const handleTitleSave = async (slug: string, title: string) => {
    const resp = await fetch(`/api/sessions/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!resp.ok) throw new Error("Failed to update title");
    setSessions((prev) =>
      prev.map((s) => (s.slug === slug ? { ...s, title: title || undefined } : s)),
    );
  };

  const handleOpen = (slug: string) => {
    navigateTo({ view: null, session: slug });
  };

  const confirmDelete = async (slug: string) => {
    setDeleteError(null);
    try {
      const resp = await fetch(`/api/sessions/${encodeURIComponent(slug)}`, {
        method: "DELETE",
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        setDeleteError(data.error || "Failed to delete session");
        return;
      }
      setSessions((prev) => prev.filter((s) => s.slug !== slug));
    } catch {
      setDeleteError("Failed to delete session");
    }
  };

  const handleRegenerate = async (s: SessionSummary) => {
    setRegeneratingSlug(s.slug);
    try {
      const resp = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: s.provider,
          sessionSlug: s.slug,
          sessionProject: s.project,
          sessionId: s.sessionId || undefined,
          title: s.title || undefined,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Regeneration failed");
      navigateTo({ view: null, session: data.slug });
    } catch (err) {
      console.error("Regenerate error:", getErrorMessage(err));
    } finally {
      setRegeneratingSlug(null);
    }
  };

  const archivedCount = sessions.filter((s) => archivedSlugs.has(s.slug)).length;
  const visibleSessions = showArchived
    ? sessions
    : sessions.filter((s) => !archivedSlugs.has(s.slug));

  // Group by project, sorted by most recent
  const byProject = new Map<string, SessionSummary[]>();
  for (const s of visibleSessions) {
    if (!byProject.has(s.project)) byProject.set(s.project, []);
    byProject.get(s.project)?.push(s);
  }
  const projectEntries = [...byProject.entries()].sort((a, b) => {
    const aTime = a[1][0]?.startTime || "";
    const bTime = b[1][0]?.startTime || "";
    return bTime.localeCompare(aTime);
  });

  const projectLabels = computeProjectLabels(projectEntries.map(([p]) => p));

  // Filter within selected project
  const projectSessions =
    selectedProject === ALL_PROJECTS ? visibleSessions : byProject.get(selectedProject) || [];

  const filtered = filter
    ? projectSessions.filter(
        (s) =>
          (s.title || "").toLowerCase().includes(filter.toLowerCase()) ||
          s.slug.toLowerCase().includes(filter.toLowerCase()) ||
          s.project.toLowerCase().includes(filter.toLowerCase()) ||
          s.provider.toLowerCase().includes(filter.toLowerCase()) ||
          (s.firstMessage || "").toLowerCase().includes(filter.toLowerCase()),
      )
    : projectSessions;
  const refreshAge = lastRefreshedAt ? formatCompactAge(lastRefreshedAt, refreshClockMs) : null;
  const showInitialLoading = loading && sessions.length === 0;

  // Non-server or empty: show simple centered layout
  if (!showInitialLoading && (!serverAvailable || sessions.length === 0)) {
    return (
      <div className="flex-1 overflow-auto">
        <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
          <RegenerateAllButton />
          {serverAvailable && sessions.length === 0 && (
            <div className="text-center py-12 space-y-2">
              <div className="text-terminal-dim font-mono text-sm">No replays yet</div>
              <div className="text-terminal-dimmer font-mono text-xs">
                Go to the Sessions tab to generate your first replay
              </div>
            </div>
          )}
          {!serverAvailable && (
            <div className="text-center py-8 space-y-2">
              <div className="text-terminal-dimmer font-mono text-xs">
                Or run <span className="text-terminal-green">npx vibe-replay</span> to create a
                replay from your AI coding sessions
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* ─── Left sidebar: project navigation (hidden on mobile) ─── */}
      <div className="hidden md:flex w-60 shrink-0 flex-col border-r border-terminal-border-subtle bg-terminal-surface/20">
        <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border-subtle">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold">
              Projects
            </span>
            {refreshAge && (
              <span className="text-[10px] font-mono text-terminal-dimmer tabular-nums">
                {refreshAge}
              </span>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {/* All projects */}
          <button
            onClick={() => handleProjectChange(ALL_PROJECTS)}
            className={`w-full text-left px-3 py-2.5 text-xs font-mono rounded-lg transition-all duration-200 ease-material flex items-center justify-between ${
              selectedProject === ALL_PROJECTS
                ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface"
            }`}
          >
            <span className="font-medium">All replays</span>
            <span
              className={`tabular-nums px-1.5 py-0.5 rounded-md text-xs ${
                selectedProject === ALL_PROJECTS
                  ? "bg-terminal-green-emphasis text-terminal-green"
                  : "bg-terminal-surface text-terminal-dimmer"
              }`}
            >
              {visibleSessions.length}
            </span>
          </button>

          <div className="h-px bg-terminal-border-subtle mx-2 my-1.5" />

          {/* Per-project items */}
          {projectEntries.map(([project, replays]) => {
            const isActive = selectedProject === project;
            const label = projectLabels.get(project) || projectName(project);
            const publishedCount = replays.filter((s) => s.gist?.gistId).length;
            return (
              <button
                key={project}
                onClick={() => handleProjectChange(project)}
                title={project}
                className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-200 ease-material group ${
                  isActive
                    ? "bg-terminal-green-subtle shadow-layer-sm"
                    : "hover:bg-terminal-surface"
                }`}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span
                    className={`text-xs font-mono truncate ${
                      isActive
                        ? "text-terminal-green font-medium"
                        : "text-terminal-text group-hover:text-terminal-text"
                    }`}
                  >
                    {label}
                  </span>
                  <span
                    className={`tabular-nums px-1.5 py-0.5 rounded-md text-xs shrink-0 ${
                      isActive
                        ? "bg-terminal-green-emphasis text-terminal-green"
                        : "bg-terminal-surface text-terminal-dimmer"
                    }`}
                  >
                    {replays.length}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-1 ml-0.5">
                  <span
                    className={`text-xs font-mono truncate ${isActive ? "text-terminal-dim" : "text-terminal-dimmer"}`}
                  >
                    {timeAgo(replays[0]?.startTime || "")}
                  </span>
                  {publishedCount > 0 && (
                    <span
                      className={`text-xs font-mono ${isActive ? "text-terminal-purple" : "text-terminal-dimmer"}`}
                    >
                      {publishedCount} published
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Right: replay list ─── */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Mobile project selector (shown instead of sidebar) */}
        <div className="md:hidden px-3 pt-3">
          <select
            value={selectedProject}
            onChange={(e) => handleProjectChange(e.target.value)}
            className="w-full bg-terminal-surface rounded-lg px-3 py-2.5 text-sm font-mono text-terminal-text outline-none shadow-layer-sm"
          >
            <option value={ALL_PROJECTS}>All replays ({visibleSessions.length})</option>
            {projectEntries.map(([project, replays]) => (
              <option key={project} value={project}>
                {projectLabels.get(project) || projectName(project)} ({replays.length})
              </option>
            ))}
          </select>
        </div>

        {/* Header + search */}
        <div className="px-4 pt-4 pb-2 space-y-3 shrink-0">
          {/* Insights summary card — replaces old project title (desktop) */}
          <div className="hidden md:block">
            {projectInsights && selectedProject !== ALL_PROJECTS ? (
              <TitleInsightsHeader insights={projectInsights} variant="project" />
            ) : userInsights && selectedProject === ALL_PROJECTS ? (
              <TitleInsightsHeader insights={userInsights} variant="all" />
            ) : (
              <TitleInsightsHeaderSkeleton />
            )}
          </div>

          {/* Search + actions (desktop) */}
          <div className="hidden md:flex items-center gap-2">
            <div className="relative flex-1">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-dim"
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="7" cy="7" r="5" />
                <path d="M11 11l3.5 3.5" />
              </svg>
              <input
                value={filter}
                onChange={(e) => handleFilterChange(e.target.value)}
                placeholder="Filter replays..."
                className="w-full bg-terminal-surface rounded-lg pl-9 pr-3 py-2.5 text-sm font-mono text-terminal-text placeholder:text-terminal-dimmer outline-none ring-1 ring-transparent focus:ring-terminal-green/40 transition-shadow duration-200 shadow-layer-sm"
              />
            </div>
            {archivedCount > 0 && (
              <button
                onClick={handleToggleArchived}
                className={`shrink-0 px-2.5 py-2 text-xs font-mono rounded-lg transition-colors duration-200 ${
                  showArchived
                    ? "bg-terminal-orange-subtle text-terminal-orange"
                    : "bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
                }`}
                title={showArchived ? "Hide archived" : `View all (${archivedCount} archived)`}
              >
                {showArchived ? "Active" : "View all"}
              </button>
            )}
            <RegenerateAllButton />
          </div>

          {/* Mobile search + archive toggle (kept stacked) */}
          <div className="md:hidden flex gap-2 items-center">
            <div className="relative flex-1">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-dim"
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="7" cy="7" r="5" />
                <path d="M11 11l3.5 3.5" />
              </svg>
              <input
                value={filter}
                onChange={(e) => handleFilterChange(e.target.value)}
                placeholder="Filter replays..."
                className="w-full bg-terminal-surface rounded-lg pl-9 pr-3 py-2.5 text-sm font-mono text-terminal-text placeholder:text-terminal-dimmer outline-none ring-1 ring-transparent focus:ring-terminal-green/40 transition-shadow duration-200 shadow-layer-sm"
              />
            </div>
            {archivedCount > 0 && (
              <button
                onClick={handleToggleArchived}
                className={`shrink-0 px-2.5 py-2 text-xs font-mono rounded-lg transition-colors duration-200 ${
                  showArchived
                    ? "bg-terminal-orange-subtle text-terminal-orange"
                    : "bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
                }`}
                title={showArchived ? "Hide archived" : `View all (${archivedCount} archived)`}
              >
                {showArchived ? "Active" : "View all"}
              </button>
            )}
          </div>
        </div>

        {(showInitialLoading || refreshing || staleCachedAt) && (
          <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg px-3 py-2.5 text-xs font-mono bg-terminal-blue-subtle text-terminal-blue shrink-0 shadow-layer-sm">
            {showInitialLoading ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-terminal-blue animate-pulse" />
                <span>FETCHING REPLAYS...</span>
              </>
            ) : refreshing ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-terminal-blue animate-pulse" />
                <span>SCANNING LATEST REPLAYS...</span>
                {staleCachedAt && (
                  <span className="text-terminal-dim">
                    Showing stale cache ({formatCacheAge(staleCachedAt)})
                  </span>
                )}
              </>
            ) : staleCachedAt ? (
              <span>Showing stale cache ({formatCacheAge(staleCachedAt)})</span>
            ) : null}
          </div>
        )}

        {/* Error toast */}
        {deleteError && (
          <div className="mx-4 mb-2 flex items-center gap-2 bg-terminal-red-subtle rounded-lg px-3 py-2.5 text-xs font-mono text-terminal-red shrink-0 shadow-layer-sm">
            <span>{deleteError}</span>
            <button
              onClick={() => setDeleteError(null)}
              className="ml-auto text-terminal-red/60 hover:text-terminal-red transition-colors"
            >
              &times;
            </button>
          </div>
        )}

        {/* Replay list */}
        <div className="flex-1 overflow-y-auto">
          {showInitialLoading ? (
            <div className="text-center py-12 text-terminal-dim font-mono text-sm">
              Fetching replays...
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-terminal-dim font-mono text-sm">
              {filter ? "No replays match your filter" : "No replays in this project"}
            </div>
          ) : (
            <div className="space-y-2.5 px-4 py-3">
              {filtered.map((s) => {
                const isArchived = archivedSlugs.has(s.slug);
                return (
                  <ReplayCard
                    key={s.slug}
                    summary={s}
                    onOpen={() => handleOpen(s.slug)}
                    onShare={() => navigateTo({ view: null, session: s.slug, v: "export" })}
                    onTitleSave={handleTitleSave}
                    onDelete={() => confirmDelete(s.slug)}
                    onRegenerate={() => handleRegenerate(s)}
                    onArchive={() => toggleArchive(s.slug)}
                    isRegenerating={regeneratingSlug === s.slug}
                    isArchived={isArchived}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Global scan toast (fixed bottom-right, no layout shift) ────────

function ScanToast() {
  const { scanStatus } = useScanInsightsContext();
  const isRunning = !!scanStatus?.running;
  const [visible, setVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const lastStatusRef = useRef(scanStatus);
  if (scanStatus) lastStatusRef.current = scanStatus;
  const displayStatus = lastStatusRef.current;

  useEffect(() => {
    if (isRunning) {
      setExiting(false);
      setVisible(true);
    } else if (visible) {
      setExiting(true);
      const timer = setTimeout(() => {
        setVisible(false);
        setExiting(false);
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isRunning, visible]);

  if (!visible || !displayStatus) return null;

  const label =
    displayStatus.phase === "discovering"
      ? "Discovering sessions..."
      : displayStatus.total > 0
        ? `Scanning ${displayStatus.scanned}/${displayStatus.total}`
        : "Preparing scan...";

  const pct =
    displayStatus.total > 0 ? Math.round((displayStatus.scanned / displayStatus.total) * 100) : 0;

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 flex items-center gap-2.5 rounded-lg px-3.5 py-2.5 text-xs font-mono bg-terminal-surface border border-terminal-border shadow-layer-md transition-all duration-300 ${
        exiting
          ? "opacity-0 translate-y-2"
          : "opacity-100 translate-y-0 animate-in fade-in slide-in-from-bottom-2 duration-300"
      }`}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-terminal-purple animate-pulse shrink-0" />
      <span className="text-terminal-dim">{label}</span>
      {displayStatus.total > 0 && (
        <div className="w-16 h-1 rounded-full bg-terminal-surface-2 overflow-hidden">
          <div
            className="h-full bg-terminal-purple rounded-full transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ─── Main Dashboard ─────────────────────────────────────────────────

export default function Dashboard({
  headerLeft,
  headerRight,
}: {
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
}) {
  const isEditor = !!window.__VIBE_REPLAY_EDITOR__;

  // Sync tab with URL query param
  const getTabFromUrl = useCallback((): Tab => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get("tab") as Tab;
    if (t === "home" || t === "sessions" || t === "replays" || t === "projects" || t === "insights")
      return t;
    return isEditor ? "home" : "replays";
  }, [isEditor]);

  const [tab, setTab] = useState<Tab>(getTabFromUrl());

  useEffect(() => {
    const handler = () => setTab(getTabFromUrl());
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, [getTabFromUrl]);

  const handleTabChange = (id: Tab) => {
    setTab(id);
    // Reset cross-tab list state to avoid landing on empty views due to stale project/filter params.
    navigateTo({ tab: id, project: null, q: null, archived: null });
  };

  const tabButton = (id: Tab, label: string) => (
    <button
      key={id}
      onClick={() => handleTabChange(id)}
      className={`px-3.5 py-1.5 text-xs font-sans font-semibold rounded-lg transition-all duration-200 ease-material ${
        tab === id
          ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
          : "text-terminal-dim hover:text-terminal-text"
      }`}
    >
      {label}
    </button>
  );

  return (
    <ScanInsightsProvider>
      <div className="flex-1 flex flex-col min-h-0">
        {/* Unified header: logo + tabs + actions in one row */}
        {isEditor && (
          <div className="shrink-0 px-5 py-2 border-b border-terminal-border-subtle glass-effect z-40 safe-top flex items-center gap-4">
            {headerLeft}
            <div className="inline-flex items-center rounded-xl bg-terminal-surface p-0.5 shadow-layer-sm shrink-0">
              {tabButton("home", "Home")}
              {tabButton("sessions", "Sessions")}
              {tabButton("replays", "Replays")}
              {tabButton("projects", "Projects")}
              {tabButton("insights", "Insights")}
            </div>
            <div className="flex-1" />
            {headerRight}
          </div>
        )}

        {/* Tab content */}
        {tab === "home" && isEditor ? (
          <DashboardHome onNavigate={handleTabChange} />
        ) : tab === "insights" && isEditor ? (
          <InsightsPage />
        ) : tab === "projects" && isEditor ? (
          <ProjectsPanel onNavigate={handleTabChange} />
        ) : tab === "sessions" && isEditor ? (
          <SessionsPanel />
        ) : (
          <ReplaysPanel />
        )}
      </div>
      <ScanToast />
    </ScanInsightsProvider>
  );
}
