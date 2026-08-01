import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useOutsideClick } from "../hooks/useOutsideClick";
import { ALL_PROJECTS, usePanelFilters } from "../hooks/usePanelFilters";
import type { SessionSummary, SourceSession } from "../types";
import DashboardHome from "./DashboardHome";
import {
  applyDashboardFacetFilters,
  matchesProjectFacet,
  matchesProviderFacet,
  matchesRepoFacet,
  NO_REPO_FILTER,
  repoFilterValue,
} from "../engine/dashboard-filtering";
import {
  cleanPrompt,
  computeProjectLabels,
  dataSourceBadgeClass,
  formatCacheAge,
  formatCompactAge,
  formatCost,
  formatDataSourceLabel,
  formatDate,
  formatSize,
  formatTokens,
  fetchWithRetry,
  getErrorMessage,
  getFriendlyErrorMessage,
  isCacheFresh,
  navigateTo,
  navigateToLive,
  nonDefaultBranch,
  normalizeTitleText,
  parseCachedList,
  projectName,
  providerDisplayName,
  replaySuggestedTitle,
  rollupProject,
  sessionPromptPreview,
  shouldRefreshCachedList,
  type SourcesEnrichmentStatus,
  shortModelName,
  shortCoworkSpaceId,
  sourceDisplayTitle,
  sourceSuggestedTitle,
  TITLE_MAX_CHARS,
  timeAgo,
  toggleArchiveSlug,
} from "./dashboard-utils";
import {
  EditableTitle,
  InfoRow,
  ProviderBadge,
  RegenerateAllButton,
  SessionMoreMenu,
} from "./dashboard/DashboardShared";
import InsightsPage from "./InsightsPage";
import { ScanInsightsProvider, useScanInsightsContext } from "./InsightsPanel";
import ProjectsPanel from "./ProjectsPanel";
import {
  DataLevelBadge,
  DataLevelIcon,
  hasEnrichedSourceDetails,
  hasPromptOrToolCounts,
  hasRichScanMetrics,
  ReadinessRow,
  SessionDataPipeline,
  SessionLoadingToast,
  sessionDataState,
} from "./SessionDataProgress";
import { formatDuration } from "./StatsPanel";

export type Tab = "home" | "sessions" | "replays" | "projects" | "insights";

// Module-level cache for scan results (avoids re-fetching on every popup open)
interface ScanResultsPayload {
  results: SessionScanData[] | null;
  /** When the last full background scan finished (global, not per-session). */
  finishedAt?: string;
}
let scanResultsCache: ScanResultsPayload | null = null;
let scanResultsFetchPromise: Promise<ScanResultsPayload | null> | null = null;

function fetchScanResults(): Promise<ScanResultsPayload | null> {
  if (scanResultsCache) return Promise.resolve(scanResultsCache);
  if (scanResultsFetchPromise) return scanResultsFetchPromise;
  scanResultsFetchPromise = fetch("/api/scan/results")
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      const payload: ScanResultsPayload = {
        results: data?.results ?? null,
        finishedAt: data?.finishedAt,
      };
      scanResultsCache = payload;
      // Invalidate after 30s so fresh data can come in
      setTimeout(() => {
        scanResultsCache = null;
        scanResultsFetchPromise = null;
      }, 30_000);
      return payload;
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

interface RawJsonItem {
  id: string;
  label: string;
  description: string;
  data?: unknown;
  fetchReplaySlug?: string;
}

function sourceRawJsonItems(
  source: SourceSession,
  scanData: SessionScanData | null,
): RawJsonItem[] {
  const replaySlug = source.existingReplay || source.replay?.slug;
  return [
    {
      id: "source",
      label: "Session",
      description: "Source session discovery JSON, plus the latest scan/enrichment data.",
      data: {
        sourceSession: source,
        scanData,
        replaySummary: source.replay ?? null,
      },
    },
    ...(replaySlug
      ? [
          {
            id: "replay",
            label: "Replay",
            description: "Full generated replay.json for this source session.",
            fetchReplaySlug: replaySlug,
          },
        ]
      : []),
  ];
}

function replayRawJsonItems(summary: SessionSummary): RawJsonItem[] {
  return [
    {
      id: "summary",
      label: "Summary",
      description: "Dashboard replay summary JSON.",
      data: summary,
    },
    {
      id: "replay",
      label: "Replay",
      description: "Full generated replay.json including scenes, metadata, and annotations.",
      fetchReplaySlug: summary.slug,
    },
  ];
}

function formatRawJson(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch (err) {
    return `/* Failed to stringify JSON: ${getErrorMessage(err)} */`;
  }
}

function RawJsonModal({
  title,
  subtitle,
  items,
  initialItemId,
  onClose,
}: {
  title: string;
  subtitle?: string;
  items: RawJsonItem[];
  initialItemId?: string;
  onClose: () => void;
}) {
  const [activeId, setActiveId] = useState(initialItemId || items[0]?.id || "");
  const [remoteData, setRemoteData] = useState<Record<string, unknown>>({});
  const [remoteErrors, setRemoteErrors] = useState<Record<string, string>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [retryNonce, setRetryNonce] = useState(0);
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const activeItem = items.find((item) => item.id === activeId) || items[0];
  const activeData = activeItem?.fetchReplaySlug ? remoteData[activeItem.id] : activeItem?.data;
  const activeItemDataLoaded = activeItem ? remoteData[activeItem.id] !== undefined : true;
  const jsonText = useMemo(
    () => (activeData === undefined ? "" : formatRawJson(activeData)),
    [activeData],
  );

  useEffect(() => {
    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    return () => {
      previouslyFocusedRef.current?.focus();
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
        return;
      }

      if (e.key !== "Tab") return;
      const focusable = Array.from(
        modalRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) || [],
      ).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true");
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [onClose]);

  useEffect(() => {
    const itemId = activeItem?.id;
    const fetchReplaySlug = activeItem?.fetchReplaySlug;
    if (!itemId || !fetchReplaySlug || activeItemDataLoaded) return;
    let cancelled = false;
    setLoadingId(itemId);
    setRemoteErrors((prev) => ({ ...prev, [itemId]: "" }));
    fetch(`/api/session?slug=${encodeURIComponent(fetchReplaySlug)}`)
      .then(async (resp) => {
        const data = await resp.json().catch(() => null);
        if (!resp.ok) throw new Error(data?.error || "Failed to load replay JSON");
        return data as unknown;
      })
      .then((data) => {
        if (cancelled) return;
        setRemoteData((prev) => ({ ...prev, [itemId]: data }));
      })
      .catch((err) => {
        if (cancelled) return;
        setRemoteErrors((prev) => ({ ...prev, [itemId]: getFriendlyErrorMessage(err) }));
      })
      .finally(() => {
        if (!cancelled) setLoadingId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeItem?.id, activeItem?.fetchReplaySlug, activeItemDataLoaded, retryNonce]);

  const copyJson = async () => {
    if (!jsonText) return;
    try {
      await navigator.clipboard.writeText(jsonText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 1500);
  };

  return (
    // Native <dialog> would double-handle focus: this modal already implements a
    // full focus trap (Escape + Tab cycling below).
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom focus-trap modal; native dialog would conflict
      role="dialog"
      aria-modal="true"
      aria-labelledby="raw-json-modal-title"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-md animate-in fade-in duration-200"
        onClick={onClose}
      />
      <section
        ref={modalRef}
        aria-label="Raw JSON content"
        className="relative w-full max-w-6xl max-h-[88vh] bg-terminal-bg border border-terminal-border-subtle rounded-2xl shadow-layer-xl animate-in zoom-in-95 fade-in duration-200 flex flex-col overflow-hidden"
      >
        <div className="flex items-start justify-between gap-4 px-6 py-4 border-b border-terminal-border-subtle">
          <div className="min-w-0">
            <div className="text-[10px] font-sans uppercase tracking-widest text-terminal-dimmer mb-1">
              Raw JSON
            </div>
            <h2
              id="raw-json-modal-title"
              className="text-lg font-sans font-semibold text-terminal-text truncate"
            >
              {title}
            </h2>
            {subtitle && (
              <p className="mt-1 text-xs font-mono text-terminal-dimmer truncate">{subtitle}</p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={copyJson}
              disabled={!jsonText}
              className="h-8 px-3 text-xs font-sans font-semibold rounded-lg bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors disabled:opacity-40"
            >
              {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
            </button>
            <button
              ref={closeButtonRef}
              onClick={onClose}
              className="h-8 w-8 flex items-center justify-center rounded-lg text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
              aria-label="Close raw JSON modal"
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
        </div>

        {items.length > 1 && (
          <div className="flex items-center gap-2 px-6 py-3 border-b border-terminal-border-subtle bg-terminal-surface/30">
            {items.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  setActiveId(item.id);
                  setCopyState("idle");
                }}
                className={`h-8 px-3 text-xs font-sans font-semibold rounded-lg transition-colors ${
                  activeId === item.id
                    ? "bg-terminal-green-subtle text-terminal-green"
                    : "bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        <div className="px-6 py-3 border-b border-terminal-border-subtle">
          <p className="text-xs font-mono text-terminal-dimmer">
            {activeItem?.description || "Inspect the raw JSON backing this dashboard row."}
          </p>
        </div>

        <div className="flex-1 min-h-0 overflow-auto bg-[#050807]">
          {loadingId === activeItem?.id ? (
            <div className="p-6 text-sm font-mono text-terminal-dim animate-pulse">
              Loading JSON...
            </div>
          ) : activeItem && remoteErrors[activeItem.id] ? (
            <div className="p-6 flex items-center gap-3">
              <span className="text-sm font-mono text-terminal-red">
                {remoteErrors[activeItem.id]}
              </span>
              {activeItem.fetchReplaySlug && (
                <button
                  onClick={() => setRetryNonce((value) => value + 1)}
                  className="h-8 px-3 text-xs font-sans font-semibold rounded-lg bg-terminal-red-subtle text-terminal-red hover:bg-terminal-red-emphasis transition-colors"
                >
                  Retry
                </button>
              )}
            </div>
          ) : jsonText ? (
            <pre className="p-6 text-xs leading-relaxed font-mono text-terminal-dim whitespace-pre-wrap break-words">
              {jsonText}
            </pre>
          ) : (
            <div className="p-6 text-sm font-mono text-terminal-dimmer">No JSON available.</div>
          )}
        </div>
      </section>
    </div>
  );
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
  onRawData,
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
  onRawData?: (session: SourceSession, scanData: SessionScanData | null) => void;
  isGenerating: boolean;
  isArchived: boolean;
}) {
  const [scanData, setScanData] = useState<SessionScanData | null>(initialScanData);
  const [scanLoading, setScanLoading] = useState(!initialScanData);
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
    if (initialScanData) {
      setScanLoading(false);
      return;
    }
    let cancelled = false;
    setScanLoading(true);
    fetchScanResults().then((payload) => {
      if (cancelled) return;
      const match = payload?.results?.find((r) => r.slug === s.slug);
      if (match) setScanData(match);
      setScanLoading(false);
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
  const dataState = sessionDataState(s, scanData);
  const dataPipelineActive = scanLoading && !hasRichScanMetrics(scanData);

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
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-md animate-in fade-in duration-300"
        onClick={onClose}
      />
      <section
        aria-label="Session details"
        className="relative max-w-4xl w-full bg-terminal-bg border border-terminal-border-subtle rounded-2xl shadow-layer-xl animate-in zoom-in-95 fade-in duration-200 flex flex-col max-h-[88vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-7 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <ProviderBadge provider={s.provider} />
            <DataLevelBadge state={dataState} compact />
            {model && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-full bg-terminal-surface-2 text-terminal-dimmer">
                {shortModelName(model)}
              </span>
            )}
            {(scanData?.dataSource || s.hasSdk) && (
              <span
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${dataSourceBadgeClass(scanData?.dataSource, s.hasSqlite, s.hasSdk)}`}
              >
                {formatDataSourceLabel(s.hasSqlite, scanData?.dataSource, s.hasSdk)}
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
            aria-label="Close"
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
              {s.gitRepo && <InfoRow label="Repo" value={s.gitRepo} />}
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
                value={formatDataSourceLabel(s.hasSqlite, scanData?.dataSource, s.hasSdk)}
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

          <div className="bg-terminal-surface rounded-xl px-5 py-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <div className="text-[10px] font-sans uppercase tracking-widest text-terminal-dimmer">
                Data Readiness
              </div>
              <DataLevelBadge state={dataState} active={dataPipelineActive} />
            </div>
            <SessionDataPipeline state={dataState} active={dataPipelineActive} className="mb-3" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5 gap-y-2">
              <ReadinessRow
                ready
                label="Basic discovery loaded"
                pendingLabel="Waiting for discovery"
              />
              <ReadinessRow
                ready={hasEnrichedSourceDetails(s)}
                label="Title, prompt previews, or model enriched"
                pendingLabel="Title and prompt previews not enriched yet"
              />
              <ReadinessRow
                ready={hasPromptOrToolCounts(s, scanData)}
                label="Prompt/tool counts loaded"
                pendingLabel="Prompt/tool counts not loaded yet"
              />
              <ReadinessRow
                ready={hasRichScanMetrics(scanData)}
                label="Rich metrics loaded"
                pendingLabel="Rich metrics deferred for this source"
              />
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
            {onRawData && (
              <button
                onClick={() => onRawData(s, scanData)}
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
                  <path d="M5 3L2 8l3 5M11 3l3 5-3 5M7 12l2-8" />
                </svg>
                Raw JSON
              </button>
            )}
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
            {s.sessionId && (
              <button
                onClick={() => navigateToLive(s.provider, s.sessionId!)}
                title="Stream this source session as the provider writes new turns"
                className="h-11 px-5 text-sm font-sans font-semibold rounded-xl bg-terminal-red-subtle text-terminal-red hover:bg-terminal-red-emphasis transition-all duration-200 flex items-center gap-2"
              >
                <span className="relative flex w-2 h-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-terminal-red opacity-75 animate-ping" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-terminal-red" />
                </span>
                Watch live
              </button>
            )}
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
      </section>
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
  onRawData,
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
  onRawData?: () => void;
  isDeleting?: boolean;
  isRegenerating?: boolean;
  isArchived?: boolean;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setConfirmingDelete(false);
  }, []);
  useOutsideClick(menuRef, closeMenu, menuOpen);

  const displayProject = rollupProject(s.project);
  const isWorktreeReplay = displayProject !== s.project;

  // New-design derived values, mirroring the Sessions-tab source card.
  // replaySuggestedTitle already resolves the explicit title first, so it is the
  // single source of truth for the displayed title and the message dedup key.
  const displayTitle = replaySuggestedTitle(s);
  const messages = (s.messages || (s.firstMessage ? [s.firstMessage] : []))
    .map((msg) => cleanPrompt(msg || ""))
    .filter((msg) => msg.length > 0 && normalizeTitleText(msg) !== displayTitle);
  const repoUrl = s.gitRepo ? `https://github.com/${s.gitRepo}` : undefined;
  const providerTooltip = [
    providerDisplayName(s.provider),
    s.model ? shortModelName(s.model) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const shared = !!(s.cloud || s.gist);
  const tooBig = s.replaySize != null && s.replaySize > 10 * 1024 * 1024;
  const costTitle = s.stats.tokenUsage
    ? `${formatTokens(s.stats.tokenUsage.cacheReadTokens)} cache read · ${formatTokens(
        s.stats.tokenUsage.cacheCreationTokens,
      )} cache write · ${formatTokens(s.stats.tokenUsage.inputTokens)} in · ${formatTokens(
        s.stats.tokenUsage.outputTokens,
      )} out`
    : "Estimated cost";

  return (
    <div
      onClick={onOpen}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- card contains nested buttons (actions menu); a real <button> would be invalid nested HTML
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`bg-terminal-surface rounded-xl px-5 py-5 hover:bg-terminal-surface-hover transition-all duration-300 ease-material space-y-3 shadow-layer-sm cursor-pointer hover-lift ${isArchived ? "opacity-50" : ""}`}
    >
      {/* Row 1: provider icon + title | slug·time + menu */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <span className="mt-0.5">
            <ProviderBadge provider={s.provider} title={providerTooltip} />
          </span>
          {onTitleSave ? (
            <div
              className="min-w-0 flex-1"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              role="none"
            >
              <EditableTitle
                slug={s.slug}
                title={s.title}
                fallbackTitle={displayTitle}
                onSave={onTitleSave}
                hideSlug
              />
            </div>
          ) : (
            <span className="text-sm font-sans font-medium text-terminal-text leading-snug line-clamp-2">
              {displayTitle}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] font-mono text-terminal-dimmer whitespace-nowrap hidden sm:inline">
            {s.slug} · {formatDate(s.startTime)}
          </span>
          {(onDelete || onArchive || onRawData) && (
            <div className="relative" ref={menuRef}>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuOpen((v) => !v);
                  setConfirmingDelete(false);
                }}
                className="h-7 w-7 flex items-center justify-center rounded-md bg-terminal-surface-2 text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors duration-200"
                title="More actions"
                aria-label="More actions"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <circle cx="8" cy="3" r="1.5" />
                  <circle cx="8" cy="8" r="1.5" />
                  <circle cx="8" cy="13" r="1.5" />
                </svg>
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg bg-terminal-surface-2 border border-terminal-border shadow-layer-md py-1">
                  {onRawData && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onRawData();
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
                        <path d="M5 3L2 8l3 5M11 3l3 5-3 5M7 12l2-8" />
                      </svg>
                      Raw JSON
                    </button>
                  )}
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

      {/* Row 2: user messages (deduped against the title) */}
      {messages.map((msg, i) => (
        <div key={i} className="flex gap-2 items-start">
          <span className="text-xs text-terminal-green shrink-0 mt-px select-none">&gt;</span>
          <p className="text-sm text-terminal-dim line-clamp-1 leading-relaxed">{msg}</p>
        </div>
      ))}

      {/* Row 3: place — project · repo (clickable) */}
      <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap text-xs font-mono text-terminal-dim">
        <span className="inline-flex items-center gap-1 max-w-[240px] truncate" title={s.project}>
          <svg
            width="11"
            height="11"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            className="text-terminal-dimmer shrink-0"
          >
            <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z" />
          </svg>
          {displayProject}
        </span>
        {s.gitRepo && repoUrl && (
          <a
            href={repoUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 hover:text-terminal-blue hover:underline shrink-0"
            title="Open repo on GitHub"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="currentColor"
              className="text-terminal-dimmer"
            >
              <path d="M8 1a7 7 0 0 0-2.2 13.6c.35.06.48-.15.48-.34v-1.2c-1.95.42-2.36-.94-2.36-.94-.32-.8-.78-1.02-.78-1.02-.64-.44.05-.43.05-.43.7.05 1.07.72 1.07.72.63 1.08 1.65.77 2.05.59.06-.46.25-.77.45-.95-1.56-.18-3.2-.78-3.2-3.47 0-.77.27-1.4.72-1.89-.07-.18-.31-.9.07-1.87 0 0 .59-.19 1.93.72a6.7 6.7 0 0 1 3.5 0c1.34-.91 1.93-.72 1.93-.72.38.97.14 1.69.07 1.87.45.49.72 1.12.72 1.89 0 2.7-1.64 3.29-3.2 3.46.25.22.48.65.48 1.31v1.95c0 .19.13.4.49.33A7 7 0 0 0 8 1z" />
            </svg>
            {s.gitRepo}
          </a>
        )}
        {isWorktreeReplay && (
          <span
            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-terminal-purple-subtle text-terminal-purple uppercase tracking-wider shrink-0"
            title={`Agent worktree: ${s.project}`}
          >
            worktree
          </span>
        )}
      </div>

      {/* Row 4: activity — hairline-framed */}
      <div className="flex items-center gap-x-3.5 gap-y-1 flex-wrap text-xs font-mono tabular-nums py-2 border-y border-terminal-border-subtle">
        {!!s.stats.durationMs && (
          <span className="text-terminal-text">{formatDuration(s.stats.durationMs)}</span>
        )}
        <span className="text-terminal-text">
          {s.stats.userPrompts} <span className="text-terminal-dimmer">prompts</span>
        </span>
        <span className="text-terminal-text">
          {s.stats.toolCalls} <span className="text-terminal-dimmer">tools</span>
        </span>
        {!!s.stats.costEstimate && (
          <span className="text-terminal-green" title={costTitle}>
            {formatCost(s.stats.costEstimate)}
          </span>
        )}
        {s.hasAnnotations && (
          <span className="text-terminal-blue">
            {s.annotationCount} annotation{s.annotationCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Row 5: facts (left) | state + actions (right) */}
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs font-mono min-w-0">
          {s.replaySize != null && s.replaySize > 0 && (
            <span
              className={`tabular-nums ${tooBig ? "px-1.5 py-0.5 rounded-md bg-terminal-red-subtle text-terminal-red" : "text-terminal-dimmer"}`}
              title={tooBig ? "Exceeds share limit (10MB)" : "Replay size"}
            >
              {formatSize(s.replaySize)}
            </span>
          )}
          {s.replayOutdated && (
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-terminal-orange-subtle text-terminal-orange"
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
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={`text-[11px] font-mono px-1.5 py-0.5 rounded-md ${shared ? "bg-terminal-green-subtle text-terminal-green" : "bg-terminal-blue-subtle text-terminal-blue"}`}
            title={shared ? "Replay is shared (cloud/gist)" : "Local replay ready to view"}
          >
            {shared ? "Shared" : "Replay"}
          </span>
          {s.gist?.outdated && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onShare?.();
              }}
              className="h-7 w-7 flex items-center justify-center rounded-md bg-terminal-orange-subtle text-terminal-orange hover:bg-terminal-orange-emphasis transition-all duration-200 ease-material shrink-0"
              title="Gist out of sync — click to update"
              aria-label="Update gist"
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
                shared
                  ? "bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis"
                  : "bg-terminal-purple-subtle text-terminal-purple hover:bg-terminal-purple-emphasis"
              }`}
              title={shared ? "Already shared — view or update" : "Share & Export"}
            >
              {shared ? (
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
              {shared ? "Shared" : "Share"}
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
        </div>
      </div>
    </div>
  );
}

const SESSION_RENDER_BATCH_SIZE = 100;

/** Only surface the "Watch live" CTA for sessions newer than this (24h). */
const LIVE_RECENT_MS = 24 * 60 * 60 * 1000;

function repoFilterLabel(repo: string): string {
  return repo === NO_REPO_FILTER ? "No repo" : repo;
}

function projectFilterLabel(project: string, labels: Map<string, string>): string {
  return labels.get(project) || projectName(project) || "(unknown project)";
}

function facetSortLabel(value: string): string {
  return value.toLowerCase();
}

function facetCountMap<T>(items: T[], keyFor: (session: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyFor(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function sortedFacetEntries(counts: Map<string, number>) {
  return [...counts.entries()].sort((a, b) => {
    if (a[0] === NO_REPO_FILTER && b[0] !== NO_REPO_FILTER) return 1;
    if (b[0] === NO_REPO_FILTER && a[0] !== NO_REPO_FILTER) return -1;
    if (b[1] !== a[1]) return b[1] - a[1];
    return facetSortLabel(a[0]).localeCompare(facetSortLabel(b[0]));
  });
}

function ActiveFilterChip({
  label,
  value,
  onRemove,
}: {
  label: string;
  value: string;
  onRemove: () => void;
}) {
  return (
    <button
      onClick={onRemove}
      className="ui-pill rounded-full bg-terminal-surface text-terminal-dim ring-1 ring-terminal-border-subtle pl-2.5 pr-2 py-1 hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
      title={`Remove ${label}: ${value}`}
    >
      <span className="text-terminal-dimmer">{label}</span>
      <span className="max-w-[220px] truncate">{value}</span>
      <span className="text-terminal-dimmer">×</span>
    </button>
  );
}

function FacetHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="mb-2 px-3 pt-0.5">
      <div className="flex items-baseline gap-2 min-w-0">
        <span className="ui-section-title-strong truncate">{title}</span>
        {count != null && (
          <span className="text-[10px] font-mono tabular-nums text-terminal-dimmer shrink-0">
            {count}
          </span>
        )}
      </div>
    </div>
  );
}

function FacetSection({
  title,
  entries,
  selected,
  onToggle,
  labelFor,
  leadingFor,
  titleFor,
  max = 12,
}: {
  title: string;
  entries: Array<[string, number]>;
  selected: readonly string[];
  onToggle: (value: string) => void;
  labelFor: (value: string) => string;
  leadingFor?: (value: string) => ReactNode;
  titleFor?: (value: string) => string;
  max?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (entries.length <= max) setExpanded(false);
  }, [entries.length, max]);
  const visible = expanded ? entries : entries.slice(0, max);
  return (
    <div className="space-y-1 border-t border-terminal-border-subtle pt-4">
      <FacetHeader title={title} count={entries.length} />
      {visible.map(([value, count]) => {
        const active = selected.includes(value);
        return (
          <button
            key={value}
            aria-pressed={active}
            onClick={() => onToggle(value)}
            title={titleFor?.(value) || labelFor(value)}
            className={`w-full text-left px-3 py-2 rounded-lg transition-all duration-200 ease-material flex items-center justify-between gap-2 group ${
              active
                ? "bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface"
            }`}
          >
            <span className="min-w-0 flex items-center gap-2">
              {leadingFor && <span className="shrink-0">{leadingFor(value)}</span>}
              <span className="text-xs font-sans truncate font-medium">{labelFor(value)}</span>
            </span>
            <span
              className={`tabular-nums px-1.5 py-0.5 rounded-md text-xs shrink-0 ${
                active
                  ? "bg-terminal-green-emphasis text-terminal-green"
                  : "bg-terminal-surface text-terminal-dimmer group-hover:text-terminal-dim"
              }`}
            >
              {count}
            </span>
          </button>
        );
      })}
      {entries.length > max && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full rounded-md px-3 py-1.5 text-left ui-caption-muted hover:text-terminal-text hover:bg-terminal-surface transition-colors"
        >
          Show {entries.length - max} more
        </button>
      )}
      {entries.length > max && expanded && (
        <button
          onClick={() => setExpanded(false)}
          className="w-full rounded-md px-3 py-1.5 text-left ui-caption-muted hover:text-terminal-text hover:bg-terminal-surface transition-colors"
        >
          Show fewer
        </button>
      )}
    </div>
  );
}

// ─── Sessions Tab (source sessions from providers) ─────────────────

// Render-prop for FacetList leading icons. Hoisted to module scope so it isn't
// re-created on every render (avoids remount churn + no-unstable-nested-components).
const facetProviderLeading = (provider: string) => <ProviderBadge provider={provider} compact />;

function SessionsPanel() {
  const [sources, setSources] = useState<SourceSession[]>([]);
  const [scanResultsBySlug, setScanResultsBySlug] = useState<Record<string, SessionScanData>>({});
  const [scanFinishedAt, setScanFinishedAt] = useState<string | null>(null);
  const [cleanupPeriodDays, setCleanupPeriodDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [staleCachedAt, setStaleCachedAt] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [refreshClockMs, setRefreshClockMs] = useState(() => Date.now());
  const {
    selectedProject,
    filter,
    showArchived,
    selectedProviders,
    selectedRepos,
    handleProjectChange,
    handleFilterChange,
    handleProviderSet,
    handleProviderToggle,
    handleRepoSet,
    handleRepoToggle,
    handleToggleArchived,
    handleClearAllFilters,
  } = usePanelFilters();

  // Background scan + insights (shared singleton context)
  const { scanStatus } = useScanInsightsContext();

  // Roll worktree paths up to the parent project so URL navigation to a
  // (possibly cleaned-up) worktree path still hits the parent's data.
  const selectedProjectKey = rollupProject(selectedProject);

  const [generatingSlug, setGeneratingSlug] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [rawSourceTarget, setRawSourceTarget] = useState<{
    source: SourceSession;
    scanData: SessionScanData | null;
  } | null>(null);
  // When another panel (Projects → Timeline / Hot Files) opens a session via
  // the `vibe-open-session` event, route the slug into the popup. Two paths:
  //   1. If SessionsPanel just mounted (e.g. tab switched from Projects),
  //      Dashboard already pushed `?selected=<slug>` to the URL — read it.
  //   2. If SessionsPanel is already mounted (user on Sessions tab clicked
  //      from a still-rendered Projects view, or back-button), the URL push
  //      doesn't trigger a re-mount, so listen for the event live.
  // Strip `?selected` afterward so a refresh doesn't keep re-opening it.
  useEffect(() => {
    const consumeUrl = () => {
      const params = new URLSearchParams(window.location.search);
      const selected = params.get("selected");
      if (!selected) return;
      setSelectedSlug(selected);
      const url = new URL(window.location.href);
      url.searchParams.delete("selected");
      window.history.replaceState(null, "", url);
    };
    consumeUrl();
    const handler = (e: Event) => {
      const slug = (e as CustomEvent<{ slug: string }>).detail?.slug;
      if (!slug) return;
      setSelectedSlug(slug);
      // Dashboard's root handler also writes `?selected=slug` for the
      // cold-mount path. Strip it here so a tab round-trip after dismissing
      // the popup doesn't reopen it on remount.
      const url = new URL(window.location.href);
      url.searchParams.delete("selected");
      window.history.replaceState(null, "", url);
    };
    window.addEventListener("vibe-open-session", handler);
    return () => window.removeEventListener("vibe-open-session", handler);
  }, []);
  const wasEnrichingRef = useRef(false);
  const requestedEnrichmentSignatureRef = useRef("");
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
    const shouldSkipRefresh = !opts?.forceRefresh && !shouldRefreshCachedList(cachedData);
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
      const freshResp = await fetchWithRetry("/api/sources");
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
        setError(getFriendlyErrorMessage(err) || "Failed to load sessions");
      } else {
        setRefreshError("Failed to refresh latest sessions. Showing cached data.");
      }
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  const toggleArchive = (slug: string) => toggleArchiveSlug(slug, archivedSlugs, setArchivedSlugs);

  const openRawSourceJson = (source: SourceSession, scanData?: SessionScanData | null) => {
    setRawSourceTarget({ source, scanData: scanData ?? scanResultsBySlug[source.slug] ?? null });
  };

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  useEffect(() => {
    if (sources.length === 0) return;
    let cancelled = false;
    const loadScanResults = async () => {
      const payload = await fetchScanResults();
      if (cancelled || !payload?.results) return;
      setScanFinishedAt(payload.finishedAt ?? null);
      setScanResultsBySlug(
        Object.fromEntries(
          payload.results.filter((result) => result.slug).map((result) => [result.slug!, result]),
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
        if (timer) {
          window.clearInterval(timer);
          timer = undefined;
        }
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
      // Retry transient network drops (the local server may be mid-restart):
      // generation is keyed by session slug/project and overwrites in place, so
      // re-issuing the request is safe.
      const resp = await fetchWithRetry("/api/generate", {
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
      setGenerateError(getFriendlyErrorMessage(err));
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

  const selectedProviderSet = new Set(selectedProviders);
  const selectedRepoSet = new Set(selectedRepos);
  const query = filter.trim().toLowerCase();

  const matchesProviderFilter = (s: SourceSession) => matchesProviderFacet(s, selectedProviderSet);
  const matchesRepoFilter = (s: SourceSession) => matchesRepoFacet(s, selectedRepoSet);
  const matchesProjectFilter = (s: SourceSession) =>
    matchesProjectFacet(s, selectedProjectKey, ALL_PROJECTS, rollupProject);
  const matchesSearchFilter = (s: SourceSession) => {
    if (!query) return true;
    const scanData = scanResultsBySlug[s.slug];
    const displayTitle = sourceDisplayTitle(s, scanData);
    const prompts = sessionPromptPreview(s, scanData, displayTitle).join(" ");
    return [
      s.slug,
      s.title,
      displayTitle,
      s.firstPrompt,
      prompts,
      s.gitBranch,
      s.gitRepo,
      s.project,
      s.provider,
      providerDisplayName(s.provider),
      s.model,
      scanData?.model,
      scanData?.gitBranch,
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  };

  const searchMatchedSources = visibleSources.filter(matchesSearchFilter);
  const providerFacetSources = searchMatchedSources.filter(
    (s) => matchesRepoFilter(s) && matchesProjectFilter(s),
  );
  const repoFacetSources = searchMatchedSources.filter(
    (s) => matchesProviderFilter(s) && matchesProjectFilter(s),
  );
  const projectFacetSources = searchMatchedSources.filter(
    (s) => matchesProviderFilter(s) && matchesRepoFilter(s),
  );

  const providerEntries = sortedFacetEntries(
    facetCountMap(providerFacetSources, (s) => s.provider),
  );
  const repoEntries = sortedFacetEntries(facetCountMap(repoFacetSources, repoFilterValue));

  // Group by project, rolling up auto-created Claude agent worktrees under
  // their parent project so the sidebar isn't drowned by sandbox dirs. The
  // per-session WORKTREE pill in the right pane already conveys which sessions
  // ran in a sandbox, so we don't surface a parent-level count here.
  const byProject = new Map<string, SourceSession[]>();
  for (const s of projectFacetSources) {
    const key = rollupProject(s.project);
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)?.push(s);
  }
  const projectEntries = [...byProject.entries()].sort((a, b) => {
    const aTime = a[1][0]?.timestamp || "";
    const bTime = b[1][0]?.timestamp || "";
    return bTime.localeCompare(aTime);
  });

  // Compute disambiguated labels for projects
  const projectLabels = computeProjectLabels(projectEntries.map(([p]) => p));

  // Final list applies every selected facet directly. The facet-specific
  // intermediate arrays above are only for sidebar counts.
  const filtered = applyDashboardFacetFilters(searchMatchedSources, {
    selectedProviders,
    selectedRepos,
    selectedProjectKey,
    allProjectsKey: ALL_PROJECTS,
    rollupProject,
  });
  const refreshAge = lastRefreshedAt ? formatCompactAge(lastRefreshedAt, refreshClockMs) : null;
  const priorityEnrichmentSlugs = new Set(filtered.slice(0, 25).map((session) => session.slug));
  const hasActiveFilters =
    Boolean(filter) ||
    selectedProviders.length > 0 ||
    selectedRepos.length > 0 ||
    selectedProjectKey !== ALL_PROJECTS;
  const [renderLimit, setRenderLimit] = useState(SESSION_RENDER_BATCH_SIZE);
  const providerFilterKey = selectedProviders.join("\0");
  const repoFilterKey = selectedRepos.join("\0");
  const listFilterKey = [
    filter,
    providerFilterKey,
    repoFilterKey,
    selectedProjectKey,
    showArchived ? "archived" : "active",
  ].join("\0");
  useEffect(() => {
    setRenderLimit(SESSION_RENDER_BATCH_SIZE);
  }, [filter, providerFilterKey, repoFilterKey, selectedProjectKey, showArchived]);
  const renderedSessions = filtered.slice(0, renderLimit);
  const remainingRenderCount = Math.max(0, filtered.length - renderedSessions.length);

  useEffect(() => {
    if (loading || filtered.length === 0) return;
    const prioritySessions = filtered.slice(0, 25);
    const slugs = prioritySessions.map((session) => session.slug);
    const sessionIds = prioritySessions
      .map((session) => session.sessionId)
      .filter(
        (sessionId): sessionId is string => typeof sessionId === "string" && sessionId.length > 0,
      );
    const projects = selectedProjectKey === ALL_PROJECTS ? [] : [selectedProjectKey];
    const signature = JSON.stringify({ slugs, selectedProjectKey });
    if (requestedEnrichmentSignatureRef.current === signature) return;
    requestedEnrichmentSignatureRef.current = signature;

    fetch("/api/sources/enrich", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slugs,
        sessionIds,
        projects,
        limit: Math.max(30, prioritySessions.length),
      }),
    }).catch(() => {});
  }, [filtered, loading, selectedProjectKey]);

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
            Start Claude, Cursor, or Codex, then come back here
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0">
      {/* ─── Left sidebar: faceted session explorer (hidden on mobile) ─── */}
      <div className="hidden md:flex w-72 shrink-0 flex-col border-r border-terminal-border-subtle bg-terminal-surface/20">
        <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border-subtle">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold">
              Explorer
            </span>
          </div>
          <button
            onClick={() => {
              void loadSources({ forceRefresh: true });
            }}
            className="p-1.5 rounded-md text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors duration-200"
            title="Refresh"
            aria-label="Refresh"
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
        <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable] p-3 space-y-3">
          <button
            onClick={() => handleProjectChange(ALL_PROJECTS)}
            className={`w-full text-left px-3 py-3 text-xs font-sans rounded-xl transition-all duration-200 ease-material flex items-center justify-between border ${
              selectedProjectKey === ALL_PROJECTS
                ? "border-terminal-green/25 bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                : "border-terminal-border-subtle bg-terminal-bg/25 text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface"
            }`}
          >
            <span className="font-medium">All sessions</span>
            <span
              className={`tabular-nums px-1.5 py-0.5 rounded-md text-xs ${
                selectedProjectKey === ALL_PROJECTS
                  ? "bg-terminal-green-emphasis text-terminal-green"
                  : "bg-terminal-surface text-terminal-dimmer"
              }`}
            >
              {projectFacetSources.length}
            </span>
          </button>

          <FacetSection
            title="Provider"
            entries={providerEntries}
            selected={selectedProviders}
            onToggle={handleProviderToggle}
            labelFor={providerDisplayName}
            leadingFor={facetProviderLeading}
            max={providerEntries.length}
          />

          <FacetSection
            title="Git repo"
            entries={repoEntries}
            selected={selectedRepos}
            onToggle={handleRepoToggle}
            labelFor={repoFilterLabel}
            max={8}
          />

          <div className="space-y-1 border-t border-terminal-border-subtle pt-4">
            <FacetHeader title="Project path" count={projectEntries.length} />

            {projectEntries.map(([project, sessions]) => {
              const replayCount = sessions.filter((s) => s.existingReplay).length;
              const isActive = selectedProjectKey === project;
              const label = projectFilterLabel(project, projectLabels);
              // After worktree rollup, sessions[0] may be from a deleted worktree;
              // treat the parent as existing if any session reports it exists.
              const exists = sessions.some((s) => s.projectExists !== false);
              const isGit = sessions.some((s) => s.isGitRepo || s.gitBranch || s.gitRepo);
              return (
                <button
                  key={project}
                  onClick={() => handleProjectChange(isActive ? ALL_PROJECTS : project)}
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
      </div>

      {/* ─── Right: session list ─── */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Mobile facet selectors (shown instead of sidebar) */}
        <div className="md:hidden px-3 pt-3 grid grid-cols-1 gap-2">
          <select
            // Single-select controls cannot represent desktop multi-select directly;
            // use a disabled sentinel so mobile still communicates active multi-filter state.
            value={
              selectedProviders.length === 1
                ? selectedProviders[0]
                : selectedProviders.length > 1
                  ? "__multiple__"
                  : ""
            }
            onChange={(e) => handleProviderSet(e.target.value ? [e.target.value] : [])}
            className="w-full bg-terminal-surface rounded-lg px-3 py-2.5 text-sm font-sans text-terminal-text outline-none shadow-layer-sm"
          >
            {selectedProviders.length > 1 && (
              <option value="__multiple__" disabled>
                {selectedProviders.length} providers selected
              </option>
            )}
            <option value="">All providers ({providerFacetSources.length})</option>
            {providerEntries.map(([provider, count]) => (
              <option key={provider} value={provider}>
                {providerDisplayName(provider)} ({count})
              </option>
            ))}
          </select>
          <select
            // Single-select controls cannot represent desktop multi-select directly;
            // use a disabled sentinel so mobile still communicates active multi-filter state.
            value={
              selectedRepos.length === 1
                ? selectedRepos[0]
                : selectedRepos.length > 1
                  ? "__multiple__"
                  : ""
            }
            onChange={(e) => handleRepoSet(e.target.value ? [e.target.value] : [])}
            className="w-full bg-terminal-surface rounded-lg px-3 py-2.5 text-sm font-sans text-terminal-text outline-none shadow-layer-sm"
          >
            {selectedRepos.length > 1 && (
              <option value="__multiple__" disabled>
                {selectedRepos.length} repos selected
              </option>
            )}
            <option value="">All repos ({repoFacetSources.length})</option>
            {repoEntries.map(([repo, count]) => (
              <option key={repo} value={repo}>
                {repoFilterLabel(repo)} ({count})
              </option>
            ))}
          </select>
          <select
            value={selectedProject}
            onChange={(e) => handleProjectChange(e.target.value)}
            className="w-full bg-terminal-surface rounded-lg px-3 py-2.5 text-sm font-sans text-terminal-text outline-none shadow-layer-sm"
          >
            <option value={ALL_PROJECTS}>All projects ({projectFacetSources.length})</option>
            {projectEntries.map(([project, sessions]) => (
              <option key={project} value={project}>
                {projectFilterLabel(project, projectLabels)} ({sessions.length})
              </option>
            ))}
          </select>
        </div>

        {/* Insights header + search */}
        <div className="px-4 pt-4 pb-2 space-y-3 shrink-0">
          {/* Result-focused header: shows the current explorer state instead of global stats. */}
          <div className="hidden md:block border-b border-terminal-border-subtle pb-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 min-w-0">
                  <h2 className="text-base font-sans font-semibold text-terminal-text truncate">
                    Sessions
                  </h2>
                  <span className="text-xs font-mono text-terminal-dimmer shrink-0">
                    {hasActiveFilters
                      ? `${filtered.length.toLocaleString()} matching`
                      : `${visibleSources.length.toLocaleString()} local sessions`}
                  </span>
                </div>
                <div className="mt-0.5 text-xs font-mono text-terminal-dimmer">
                  {hasActiveFilters
                    ? `Filtered from ${visibleSources.length.toLocaleString()} local sessions`
                    : "Use sidebar facets or search to narrow the list"}
                  {showArchived && " · including archived"}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] font-sans uppercase tracking-widest text-terminal-dimmer">
                  Last updated
                </div>
                <div className="mt-0.5 text-xs font-mono text-terminal-dim">
                  {refreshing
                    ? "Refreshing…"
                    : refreshAge
                      ? `Updated ${refreshAge} ago`
                      : "Local cache"}
                </div>
              </div>
            </div>

            {hasActiveFilters && (
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                {filter && (
                  <ActiveFilterChip
                    label="Search"
                    value={filter}
                    onRemove={() => handleFilterChange("")}
                  />
                )}
                {selectedProviders.map((provider) => (
                  <ActiveFilterChip
                    key={provider}
                    label="Provider"
                    value={providerDisplayName(provider)}
                    onRemove={() => handleProviderToggle(provider)}
                  />
                ))}
                {selectedRepos.map((repo) => (
                  <ActiveFilterChip
                    key={repo}
                    label="Repo"
                    value={repoFilterLabel(repo)}
                    onRemove={() => handleRepoToggle(repo)}
                  />
                ))}
                {selectedProjectKey !== ALL_PROJECTS && (
                  <ActiveFilterChip
                    label="Project"
                    value={projectFilterLabel(selectedProjectKey, projectLabels)}
                    onRemove={() => handleProjectChange(ALL_PROJECTS)}
                  />
                )}
                <button
                  onClick={handleClearAllFilters}
                  className="text-xs font-mono text-terminal-dimmer hover:text-terminal-text transition-colors"
                >
                  Clear all
                </button>
              </div>
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
                placeholder="Search title, prompt, slug, repo, project..."
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

          {hasActiveFilters && (
            <div className="md:hidden flex items-center gap-2 flex-wrap">
              {filter && (
                <ActiveFilterChip
                  label="Search"
                  value={filter}
                  onRemove={() => handleFilterChange("")}
                />
              )}
              {selectedProviders.map((provider) => (
                <ActiveFilterChip
                  key={provider}
                  label="Provider"
                  value={providerDisplayName(provider)}
                  onRemove={() => handleProviderToggle(provider)}
                />
              ))}
              {selectedRepos.map((repo) => (
                <ActiveFilterChip
                  key={repo}
                  label="Repo"
                  value={repoFilterLabel(repo)}
                  onRemove={() => handleRepoToggle(repo)}
                />
              ))}
              {selectedProjectKey !== ALL_PROJECTS && (
                <ActiveFilterChip
                  label="Project"
                  value={projectFilterLabel(selectedProjectKey, projectLabels)}
                  onRemove={() => handleProjectChange(ALL_PROJECTS)}
                />
              )}
              <button
                onClick={handleClearAllFilters}
                className="text-xs font-mono text-terminal-dimmer hover:text-terminal-text transition-colors"
              >
                Clear all
              </button>
            </div>
          )}
        </div>

        {showInitialLoading ? (
          <SessionLoadingToast
            title="Fetching local sessions"
            description="Reading cached session lists first, then refreshing local providers in the background."
          />
        ) : refreshing ? (
          <SessionLoadingToast
            title="Scanning latest sessions"
            description={
              staleCachedAt
                ? `Showing stale cache (${formatCacheAge(staleCachedAt)}) while refreshing.`
                : "Refreshing provider session lists and lightweight metadata."
            }
          />
        ) : enrichmentStatus?.running && enrichmentStatus.total > 0 ? (
          <SessionLoadingToast
            status={enrichmentStatus}
            title="Loading richer details for visible sessions"
            description="Visible cards update in place as local data is enriched."
          />
        ) : null}

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
        <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {showInitialLoading ? (
            <div className="text-center py-12 text-terminal-dim font-mono text-sm">
              Fetching sessions...
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-terminal-dim font-mono text-sm">
              {hasActiveFilters
                ? "No sessions match the current filters"
                : "No local sessions found"}
            </div>
          ) : (
            <div key={listFilterKey} className="space-y-2.5 px-4 py-3">
              {renderedSessions.map((s) => {
                const scanData = scanResultsBySlug[s.slug];
                const sessionTitle = sourceDisplayTitle(s, scanData);
                const prompts = sessionPromptPreview(s, scanData, sessionTitle).slice(0, 2);
                const branch = nonDefaultBranch(scanData?.gitBranch || s.gitBranch);
                const rolledProject = rollupProject(s.project);
                // True when the display project is a rolled-up agent worktree path.
                const isWorktree = rolledProject !== s.project;
                const displayPromptCount =
                  scanData?.promptCount ?? s.promptCount ?? s.replay?.stats.userPrompts;
                const displayToolCount =
                  scanData?.toolCallCount ?? s.toolCallCount ?? s.replay?.stats.toolCalls;
                const displayDurationMs =
                  scanData?.durationMs ?? s.durationMsEst ?? s.replay?.stats.durationMs;
                const displayEditCount = scanData?.editCount ?? s.editCountEst;
                const displayModel = scanData?.model || s.model;
                const displayCost = scanData?.costEstimate ?? s.replay?.stats.costEstimate;
                const dataSourceLabel = formatDataSourceLabel(
                  s.hasSqlite,
                  scanData?.dataSource,
                  s.hasSdk,
                );
                const isPriorityEnriching =
                  Boolean(enrichmentStatus?.running) &&
                  priorityEnrichmentSlugs.has(s.slug) &&
                  !hasRichScanMetrics(scanData);
                const dataState = sessionDataState(s, scanData);
                const scannedAtLabel =
                  scanData && scanFinishedAt ? formatCompactAge(scanFinishedAt) : null;
                const isArchived = archivedSlugs.has(s.slug);
                const replaySlug = s.existingReplay || s.replay?.slug;
                const projectLabel =
                  projectLabels.get(rolledProject) ||
                  projectLabels.get(s.project) ||
                  projectName(rolledProject);
                // New-design derived values (see design/session-card-comparison.html)
                const prLink = scanData?.prLinks?.[0];
                const repoUrl = s.gitRepo ? `https://github.com/${s.gitRepo}` : undefined;
                // Encode each path segment so branch names with "/" (e.g.
                // "feature/foo") don't 404 — GitHub /tree/ uses literal slashes.
                const branchUrl =
                  s.gitRepo && branch
                    ? `https://github.com/${s.gitRepo}/tree/${branch
                        .split("/")
                        .map(encodeURIComponent)
                        .join("/")}`
                    : undefined;
                // Live stream is only meaningful for recent sessions (the provider
                // may still be writing); older sessions just render and end.
                const isRecentSession =
                  Date.now() - new Date(s.timestamp).getTime() < LIVE_RECENT_MS;
                const errorCount = scanData?.apiErrorCount ?? 0;
                const compactionCount = scanData?.compactionCount ?? 0;
                // "clean" is only meaningful once scanned (scanData present).
                const cleanRun = !!scanData && errorCount === 0;
                const providerTooltip = [
                  providerDisplayName(s.provider),
                  displayModel ? shortModelName(displayModel) : null,
                  scanData?.permissionMode ? `${scanData.permissionMode} mode` : null,
                  scanData?.entrypoint ? `via ${scanData.entrypoint}` : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                const costTitle = scanData?.tokenUsage
                  ? `${formatTokens(scanData.tokenUsage.cacheReadTokens)} cache read · ${formatTokens(
                      scanData.tokenUsage.cacheCreationTokens,
                    )} cache write · ${formatTokens(scanData.tokenUsage.inputTokens)} in · ${formatTokens(
                      scanData.tokenUsage.outputTokens,
                    )} out`
                  : "Estimated cost";
                return (
                  <div
                    key={`${s.provider}-${s.slug}`}
                    onClick={() => {
                      if (replaySlug) navigateTo({ view: null, session: replaySlug });
                      else setSelectedSlug(s.slug);
                    }}
                    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- card contains nested controls; cannot use a real <button>
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (replaySlug) navigateTo({ view: null, session: replaySlug });
                        else setSelectedSlug(s.slug);
                      }
                    }}
                    className={`bg-terminal-surface rounded-xl px-5 py-4 hover:bg-terminal-surface-hover transition-all duration-300 ease-material space-y-3 shadow-layer-sm cursor-pointer hover-lift ${
                      isPriorityEnriching ? "ring-1 ring-terminal-blue/20" : ""
                    } ${isArchived ? "opacity-50" : ""}`}
                  >
                    {/* Row 1: provider icon + title | slug·time + menu */}
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <span className="mt-0.5">
                          <ProviderBadge provider={s.provider} title={providerTooltip} />
                        </span>
                        <span className="text-sm font-sans font-semibold text-terminal-text leading-snug line-clamp-2">
                          {sessionTitle}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[11px] font-mono text-terminal-dimmer whitespace-nowrap hidden sm:inline">
                          {s.slug} · {timeAgo(s.timestamp)}
                        </span>
                        <SessionMoreMenu
                          onArchive={() => toggleArchive(s.slug)}
                          onDelete={replaySlug ? () => handleDeleteReplay(s.slug) : undefined}
                          onRawData={() => openRawSourceJson(s, scanData || null)}
                          isArchived={isArchived}
                        />
                      </div>
                    </div>

                    {/* Row 2: user prompts (deduped against the title, which may be a
                        normalized/truncated form of the first prompt) */}
                    {prompts
                      .filter((p) => normalizeTitleText(p) !== sessionTitle)
                      .map((p, i) => (
                        <div key={i} className="flex gap-2 items-start">
                          <span className="text-xs text-terminal-green shrink-0 mt-px select-none">
                            &gt;
                          </span>
                          <p className="text-sm text-terminal-dim line-clamp-2 leading-relaxed">
                            {p}
                          </p>
                        </div>
                      ))}

                    {/* Row 3: place — project · branch · repo (clickable) */}
                    <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap text-xs font-mono text-terminal-dim">
                      <span
                        className="inline-flex items-center gap-1 max-w-[240px] truncate"
                        title={s.project}
                      >
                        <svg
                          width="11"
                          height="11"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.3"
                          className="text-terminal-dimmer shrink-0"
                        >
                          <path d="M1.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1z" />
                        </svg>
                        {projectLabel}
                      </span>
                      {branch &&
                        (branchUrl ? (
                          <a
                            href={branchUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 hover:text-terminal-blue hover:underline shrink-0"
                            title={`Open branch ${branch} on GitHub`}
                          >
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
                          </a>
                        ) : (
                          <span className="inline-flex items-center gap-1 shrink-0">
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
                        ))}
                      {s.gitRepo && repoUrl && (
                        <a
                          href={repoUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 hover:text-terminal-blue hover:underline shrink-0"
                          title="Open repo on GitHub"
                        >
                          <svg
                            width="10"
                            height="10"
                            viewBox="0 0 16 16"
                            fill="currentColor"
                            className="text-terminal-dimmer"
                          >
                            <path d="M8 1a7 7 0 0 0-2.2 13.6c.35.06.48-.15.48-.34v-1.2c-1.95.42-2.36-.94-2.36-.94-.32-.8-.78-1.02-.78-1.02-.64-.44.05-.43.05-.43.7.05 1.07.72 1.07.72.63 1.08 1.65.77 2.05.59.06-.46.25-.77.45-.95-1.56-.18-3.2-.78-3.2-3.47 0-.77.27-1.4.72-1.89-.07-.18-.31-.9.07-1.87 0 0 .59-.19 1.93.72a6.7 6.7 0 0 1 3.5 0c1.34-.91 1.93-.72 1.93-.72.38.97.14 1.69.07 1.87.45.49.72 1.12.72 1.89 0 2.7-1.64 3.29-3.2 3.46.25.22.48.65.48 1.31v1.95c0 .19.13.4.49.33A7 7 0 0 0 8 1z" />
                          </svg>
                          {s.gitRepo}
                        </a>
                      )}
                      {isWorktree && (
                        <span
                          className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-terminal-purple-subtle text-terminal-purple shrink-0 uppercase tracking-wider"
                          title={`Agent worktree: ${s.project}`}
                        >
                          worktree
                        </span>
                      )}
                      {s.spaceId && (
                        <span
                          className="text-terminal-dimmer shrink-0"
                          title={
                            s.spaceIdSetBy
                              ? `Cowork space ${s.spaceId} (${s.spaceIdSetBy})`
                              : `Cowork space ${s.spaceId}`
                          }
                        >
                          space-{shortCoworkSpaceId(s.spaceId)}
                        </span>
                      )}
                      {s.pluginsEnabled && (
                        <span
                          className="text-terminal-dimmer shrink-0"
                          title="Claude Cowork plugins enabled"
                        >
                          plugins
                        </span>
                      )}
                      {s.skillsEnabled && (
                        <span
                          className="text-terminal-dimmer shrink-0"
                          title="Claude Cowork skills enabled"
                        >
                          skills
                        </span>
                      )}
                    </div>

                    {/* Row 4: activity — exact values, hairline-framed. Leads with the
                        data-level icon (replaces the old "Scanned" chip next to the CTAs). */}
                    <div className="flex items-center gap-x-3.5 gap-y-1 flex-wrap text-xs font-mono tabular-nums py-2 border-y border-terminal-border-subtle">
                      <DataLevelIcon
                        state={dataState}
                        active={isPriorityEnriching}
                        scannedAtLabel={scannedAtLabel}
                      />
                      {!!displayDurationMs && (
                        <span className="text-terminal-text" title="Active duration">
                          {scanData?.durationMs == null ? "~" : ""}
                          {formatDuration(displayDurationMs)}
                        </span>
                      )}
                      {!!displayPromptCount && (
                        <span className="text-terminal-text">
                          {displayPromptCount}{" "}
                          <span className="text-terminal-dimmer">
                            prompt{displayPromptCount !== 1 ? "s" : ""}
                          </span>
                        </span>
                      )}
                      {!!displayToolCount && (
                        <span className="text-terminal-text">
                          {displayToolCount} <span className="text-terminal-dimmer">tools</span>
                        </span>
                      )}
                      {!!displayEditCount && (
                        <span className="text-terminal-text" title="File edits">
                          {scanData?.editCount == null ? "~" : ""}
                          {displayEditCount} <span className="text-terminal-dimmer">edits</span>
                        </span>
                      )}
                      {!!displayCost && (
                        <span className="text-terminal-green" title={costTitle}>
                          {formatCost(displayCost)}
                        </span>
                      )}
                      {cleanRun ? (
                        <span
                          className="text-terminal-green"
                          title={`No API errors${compactionCount === 0 ? " · no compactions" : ` · ${compactionCount} compaction(s)`}`}
                        >
                          ✓ no errors
                        </span>
                      ) : (
                        errorCount > 0 && (
                          <span
                            className="text-terminal-red"
                            title={`${errorCount} API error(s) during this session`}
                          >
                            {errorCount} error{errorCount !== 1 ? "s" : ""}
                          </span>
                        )
                      )}
                    </div>

                    {/* Row 5: outcome facts (left) | state + CTAs (right) */}
                    <div className="flex items-end justify-between gap-3">
                      <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs font-mono min-w-0">
                        {prLink ? (
                          <a
                            href={prLink.prUrl}
                            target="_blank"
                            rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-terminal-purple-subtle text-terminal-purple hover:bg-terminal-purple-emphasis transition-colors"
                            title={`Open PR #${prLink.prNumber} on GitHub`}
                          >
                            <svg
                              width="10"
                              height="10"
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                            >
                              <circle cx="4" cy="4" r="1.5" />
                              <circle cx="4" cy="12" r="1.5" />
                              <circle cx="12" cy="12" r="1.5" />
                              <path d="M4 5.5v5M12 5.5v5M12 5.5a3 3 0 0 0-3-3H7" />
                            </svg>
                            PR #{prLink.prNumber}
                          </a>
                        ) : (
                          s.hasPR && (
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-terminal-purple-subtle text-terminal-purple"
                              title="Session produced a PR"
                            >
                              PR
                            </span>
                          )
                        )}
                        <span className="text-terminal-dimmer tabular-nums" title="Transcript size">
                          {formatSize(s.fileSize)}
                        </span>
                        {s.filePaths.length > 1 && (
                          <span className="text-terminal-dimmer tabular-nums">
                            {s.filePaths.length} parts
                          </span>
                        )}
                        {(s.hasSqlite || s.hasSdk || scanData?.dataSource) && (
                          <span
                            className={`px-1.5 py-0.5 rounded-md ${dataSourceBadgeClass(scanData?.dataSource, s.hasSqlite, s.hasSdk)}`}
                            title={dataSourceLabel}
                          >
                            {dataSourceLabel}
                          </span>
                        )}
                        {s.isStarred && (
                          <span className="text-terminal-orange" title="Starred in Claude Cowork">
                            ★
                          </span>
                        )}
                        {s.fsDetectedFiles && s.fsDetectedFiles.length > 0 && (
                          <span
                            className="text-terminal-dimmer tabular-nums"
                            title={s.fsDetectedFiles.join("\n")}
                          >
                            {s.fsDetectedFiles.length} files
                          </span>
                        )}
                        {s.expiresInDays != null && s.expiresInDays <= EXPIRY_WARN_DAYS && (
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md ${
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
                      <div className="flex items-center gap-1.5 shrink-0">
                        {s.sessionId && isRecentSession && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              navigateToLive(s.provider, s.sessionId!);
                            }}
                            title="Stream this session live as the provider writes new turns"
                            className="h-7 px-2.5 text-xs font-sans font-semibold rounded-md bg-terminal-red-subtle text-terminal-red hover:bg-terminal-red-emphasis transition-all duration-200 ease-material flex items-center gap-1.5"
                          >
                            <span className="relative flex w-1.5 h-1.5">
                              <span className="absolute inline-flex h-full w-full rounded-full bg-terminal-red opacity-75 animate-ping" />
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-terminal-red" />
                            </span>
                            Live
                          </button>
                        )}
                        {replaySlug ? (
                          <>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                navigateTo({ view: null, session: replaySlug, v: "export" });
                              }}
                              className="h-7 px-2.5 text-xs font-sans font-semibold rounded-md bg-terminal-purple-subtle text-terminal-purple hover:bg-terminal-purple-emphasis transition-all duration-200 ease-material"
                            >
                              Share
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedSlug(s.slug);
                              }}
                              disabled={generatingSlug === s.slug}
                              className="h-7 px-2.5 text-xs font-sans font-semibold rounded-md bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis transition-all duration-200 ease-material disabled:opacity-50"
                            >
                              {generatingSlug === s.slug ? "..." : "Redo"}
                            </button>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                navigateTo({ view: null, session: replaySlug });
                              }}
                              className="h-7 px-2.5 text-xs font-sans font-semibold rounded-md bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis transition-all duration-200 ease-material flex items-center justify-center gap-1"
                            >
                              <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                                <polygon points="4 2 14 8 4 14" />
                              </svg>
                              View
                            </button>
                          </>
                        ) : (
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
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {remainingRenderCount > 0 && (
                <div className="flex items-center justify-center py-3">
                  <button
                    onClick={() => setRenderLimit((limit) => limit + SESSION_RENDER_BATCH_SIZE)}
                    className="rounded-lg bg-terminal-surface px-4 py-2 text-xs font-mono text-terminal-dim shadow-layer-sm ring-1 ring-terminal-border-subtle hover:bg-terminal-surface-hover hover:text-terminal-text transition-colors"
                  >
                    Showing {renderedSessions.length.toLocaleString()} of{" "}
                    {filtered.length.toLocaleString()} · Show next{" "}
                    {Math.min(SESSION_RENDER_BATCH_SIZE, remainingRenderCount).toLocaleString()}
                  </button>
                </div>
              )}
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
            onRawData={openRawSourceJson}
            isGenerating={generatingSlug === selectedSession.slug}
            isArchived={archivedSlugs.has(selectedSession.slug)}
          />
        )}
        {rawSourceTarget && (
          <RawJsonModal
            title={sourceDisplayTitle(rawSourceTarget.source, rawSourceTarget.scanData)}
            subtitle={`${rawSourceTarget.source.provider} · slug: ${rawSourceTarget.source.slug}`}
            items={sourceRawJsonItems(rawSourceTarget.source, rawSourceTarget.scanData)}
            onClose={() => setRawSourceTarget(null)}
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
  const [rawReplayTarget, setRawReplayTarget] = useState<SessionSummary | null>(null);

  const {
    selectedProject,
    filter,
    showArchived,
    selectedProviders,
    selectedRepos,
    handleProjectChange,
    handleFilterChange,
    handleProviderSet,
    handleProviderToggle,
    handleRepoSet,
    handleRepoToggle,
    handleToggleArchived,
    handleClearAllFilters,
  } = usePanelFilters();

  // Roll worktree paths up to the parent project so URL navigation to a
  // (possibly cleaned-up) worktree path still hits the parent's data.
  const selectedProjectKey = rollupProject(selectedProject);

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
        const resp = await fetchWithRetry("/api/sessions");
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

  const toggleArchive = (slug: string) => toggleArchiveSlug(slug, archivedSlugs, setArchivedSlugs);

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
      const resp = await fetchWithRetry("/api/generate", {
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

  const selectedProviderSet = new Set(selectedProviders);
  const selectedRepoSet = new Set(selectedRepos);
  const query = filter.trim().toLowerCase();

  const matchesProviderFilter = (s: SessionSummary) => matchesProviderFacet(s, selectedProviderSet);
  const matchesRepoFilter = (s: SessionSummary) => matchesRepoFacet(s, selectedRepoSet);
  const matchesProjectFilter = (s: SessionSummary) =>
    matchesProjectFacet(s, selectedProjectKey, ALL_PROJECTS, rollupProject);
  const matchesSearchFilter = (s: SessionSummary) => {
    if (!query) return true;
    return [
      s.title,
      replaySuggestedTitle(s),
      s.slug,
      s.project,
      s.gitRepo,
      s.provider,
      providerDisplayName(s.provider),
      s.model,
      s.firstMessage,
      ...(s.messages || []),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  };

  const searchMatchedSessions = visibleSessions.filter(matchesSearchFilter);
  const providerFacetSessions = searchMatchedSessions.filter(
    (s) => matchesRepoFilter(s) && matchesProjectFilter(s),
  );
  const repoFacetSessions = searchMatchedSessions.filter(
    (s) => matchesProviderFilter(s) && matchesProjectFilter(s),
  );
  const projectFacetSessions = searchMatchedSessions.filter(
    (s) => matchesProviderFilter(s) && matchesRepoFilter(s),
  );

  const providerEntries = sortedFacetEntries(
    facetCountMap(providerFacetSessions, (s) => s.provider),
  );
  const repoEntries = sortedFacetEntries(facetCountMap(repoFacetSessions, repoFilterValue));

  // Group by project, rolling up Claude agent worktrees under their parent.
  const byProject = new Map<string, SessionSummary[]>();
  for (const s of projectFacetSessions) {
    const key = rollupProject(s.project);
    if (!byProject.has(key)) byProject.set(key, []);
    byProject.get(key)?.push(s);
  }
  const projectEntries = [...byProject.entries()].sort((a, b) => {
    const aTime = a[1][0]?.startTime || "";
    const bTime = b[1][0]?.startTime || "";
    return bTime.localeCompare(aTime);
  });

  const projectLabels = computeProjectLabels(projectEntries.map(([p]) => p));

  // Final list applies every selected facet directly. The facet-specific
  // intermediate arrays above are only for sidebar counts.
  const filtered = applyDashboardFacetFilters(searchMatchedSessions, {
    selectedProviders,
    selectedRepos,
    selectedProjectKey,
    allProjectsKey: ALL_PROJECTS,
    rollupProject,
  });
  const refreshAge = lastRefreshedAt ? formatCompactAge(lastRefreshedAt, refreshClockMs) : null;
  const hasActiveFilters =
    Boolean(filter) ||
    selectedProviders.length > 0 ||
    selectedRepos.length > 0 ||
    selectedProjectKey !== ALL_PROJECTS;
  const [renderLimit, setRenderLimit] = useState(SESSION_RENDER_BATCH_SIZE);
  const providerFilterKey = selectedProviders.join("\0");
  const repoFilterKey = selectedRepos.join("\0");
  const listFilterKey = [
    filter,
    providerFilterKey,
    repoFilterKey,
    selectedProjectKey,
    showArchived ? "archived" : "active",
  ].join("\0");
  useEffect(() => {
    setRenderLimit(SESSION_RENDER_BATCH_SIZE);
  }, [filter, providerFilterKey, repoFilterKey, selectedProjectKey, showArchived]);
  const renderedReplays = filtered.slice(0, renderLimit);
  const remainingRenderCount = Math.max(0, filtered.length - renderedReplays.length);
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
      {/* ─── Left sidebar: faceted replay explorer (hidden on mobile) ─── */}
      <div className="hidden md:flex w-72 shrink-0 flex-col border-r border-terminal-border-subtle bg-terminal-surface/20">
        <div className="flex items-center justify-between px-4 py-3 border-b border-terminal-border-subtle">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-semibold">
              Replays
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable] p-3 space-y-3">
          <button
            onClick={() => handleProjectChange(ALL_PROJECTS)}
            className={`w-full text-left px-3 py-3 text-xs font-sans rounded-xl transition-all duration-200 ease-material flex items-center justify-between border ${
              selectedProjectKey === ALL_PROJECTS
                ? "border-terminal-green/25 bg-terminal-green-subtle text-terminal-green shadow-layer-sm"
                : "border-terminal-border-subtle bg-terminal-bg/25 text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface"
            }`}
          >
            <span className="font-medium">All replays</span>
            <span
              className={`tabular-nums px-1.5 py-0.5 rounded-md text-xs ${
                selectedProjectKey === ALL_PROJECTS
                  ? "bg-terminal-green-emphasis text-terminal-green"
                  : "bg-terminal-surface text-terminal-dimmer"
              }`}
            >
              {projectFacetSessions.length}
            </span>
          </button>

          <FacetSection
            title="Provider"
            entries={providerEntries}
            selected={selectedProviders}
            onToggle={handleProviderToggle}
            labelFor={providerDisplayName}
            leadingFor={facetProviderLeading}
            max={providerEntries.length}
          />

          <FacetSection
            title="Git repo"
            entries={repoEntries}
            selected={selectedRepos}
            onToggle={handleRepoToggle}
            labelFor={repoFilterLabel}
            max={8}
          />

          <div className="space-y-1 border-t border-terminal-border-subtle pt-4">
            <FacetHeader title="Project path" count={projectEntries.length} />
            {projectEntries.map(([project, replays]) => {
              const isActive = selectedProjectKey === project;
              const label = projectFilterLabel(project, projectLabels);
              const publishedCount = replays.filter((s) => s.gist?.gistId).length;
              return (
                <button
                  key={project}
                  onClick={() => handleProjectChange(isActive ? ALL_PROJECTS : project)}
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
      </div>

      {/* ─── Right: replay list ─── */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {/* Mobile facet selectors (shown instead of sidebar) */}
        <div className="md:hidden px-3 pt-3 grid grid-cols-1 gap-2">
          <select
            // Single-select controls cannot represent desktop multi-select directly;
            // use a disabled sentinel so mobile still communicates active multi-filter state.
            value={
              selectedProviders.length === 1
                ? selectedProviders[0]
                : selectedProviders.length > 1
                  ? "__multiple__"
                  : ""
            }
            onChange={(e) => handleProviderSet(e.target.value ? [e.target.value] : [])}
            className="w-full bg-terminal-surface rounded-lg px-3 py-2.5 text-sm font-sans text-terminal-text outline-none shadow-layer-sm"
          >
            {selectedProviders.length > 1 && (
              <option value="__multiple__" disabled>
                {selectedProviders.length} providers selected
              </option>
            )}
            <option value="">All providers ({providerFacetSessions.length})</option>
            {providerEntries.map(([provider, count]) => (
              <option key={provider} value={provider}>
                {providerDisplayName(provider)} ({count})
              </option>
            ))}
          </select>
          <select
            // Single-select controls cannot represent desktop multi-select directly;
            // use a disabled sentinel so mobile still communicates active multi-filter state.
            value={
              selectedRepos.length === 1
                ? selectedRepos[0]
                : selectedRepos.length > 1
                  ? "__multiple__"
                  : ""
            }
            onChange={(e) => handleRepoSet(e.target.value ? [e.target.value] : [])}
            className="w-full bg-terminal-surface rounded-lg px-3 py-2.5 text-sm font-sans text-terminal-text outline-none shadow-layer-sm"
          >
            {selectedRepos.length > 1 && (
              <option value="__multiple__" disabled>
                {selectedRepos.length} repos selected
              </option>
            )}
            <option value="">All repos ({repoFacetSessions.length})</option>
            {repoEntries.map(([repo, count]) => (
              <option key={repo} value={repo}>
                {repoFilterLabel(repo)} ({count})
              </option>
            ))}
          </select>
          <select
            value={selectedProject}
            onChange={(e) => handleProjectChange(e.target.value)}
            className="w-full bg-terminal-surface rounded-lg px-3 py-2.5 text-sm font-sans text-terminal-text outline-none shadow-layer-sm"
          >
            <option value={ALL_PROJECTS}>All projects ({projectFacetSessions.length})</option>
            {projectEntries.map(([project, replays]) => (
              <option key={project} value={project}>
                {projectFilterLabel(project, projectLabels)} ({replays.length})
              </option>
            ))}
          </select>
        </div>

        {/* Header + search */}
        <div className="px-4 pt-4 pb-2 space-y-3 shrink-0">
          <div className="hidden md:block border-b border-terminal-border-subtle pb-3">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2 min-w-0">
                  <h2 className="text-base font-sans font-semibold text-terminal-text truncate">
                    Replays
                  </h2>
                  <span className="text-xs font-mono text-terminal-dimmer shrink-0">
                    {hasActiveFilters
                      ? `${filtered.length.toLocaleString()} matching`
                      : `${visibleSessions.length.toLocaleString()} local replays`}
                  </span>
                </div>
                <div className="mt-0.5 text-xs font-mono text-terminal-dimmer">
                  {hasActiveFilters
                    ? `Filtered from ${visibleSessions.length.toLocaleString()} local replays`
                    : "Use sidebar facets or search to narrow the list"}
                  {showArchived && " · including archived"}
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[10px] font-sans uppercase tracking-widest text-terminal-dimmer">
                  Last updated
                </div>
                <div className="mt-0.5 text-xs font-mono text-terminal-dim">
                  {refreshing
                    ? "Refreshing…"
                    : refreshAge
                      ? `Updated ${refreshAge} ago`
                      : "Local cache"}
                </div>
              </div>
            </div>

            {hasActiveFilters && (
              <div className="mt-3 flex items-center gap-2 flex-wrap">
                {filter && (
                  <ActiveFilterChip
                    label="Search"
                    value={filter}
                    onRemove={() => handleFilterChange("")}
                  />
                )}
                {selectedProviders.map((provider) => (
                  <ActiveFilterChip
                    key={provider}
                    label="Provider"
                    value={providerDisplayName(provider)}
                    onRemove={() => handleProviderToggle(provider)}
                  />
                ))}
                {selectedRepos.map((repo) => (
                  <ActiveFilterChip
                    key={repo}
                    label="Repo"
                    value={repoFilterLabel(repo)}
                    onRemove={() => handleRepoToggle(repo)}
                  />
                ))}
                {selectedProjectKey !== ALL_PROJECTS && (
                  <ActiveFilterChip
                    label="Project"
                    value={projectFilterLabel(selectedProjectKey, projectLabels)}
                    onRemove={() => handleProjectChange(ALL_PROJECTS)}
                  />
                )}
                <button
                  onClick={handleClearAllFilters}
                  className="text-xs font-mono text-terminal-dimmer hover:text-terminal-text transition-colors"
                >
                  Clear all
                </button>
              </div>
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
                placeholder="Search title, prompt, slug, provider, repo, project..."
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
                placeholder="Search replays..."
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
          {hasActiveFilters && (
            <div className="md:hidden flex items-center gap-2 flex-wrap">
              {filter && (
                <ActiveFilterChip
                  label="Search"
                  value={filter}
                  onRemove={() => handleFilterChange("")}
                />
              )}
              {selectedProviders.map((provider) => (
                <ActiveFilterChip
                  key={provider}
                  label="Provider"
                  value={providerDisplayName(provider)}
                  onRemove={() => handleProviderToggle(provider)}
                />
              ))}
              {selectedRepos.map((repo) => (
                <ActiveFilterChip
                  key={repo}
                  label="Repo"
                  value={repoFilterLabel(repo)}
                  onRemove={() => handleRepoToggle(repo)}
                />
              ))}
              {selectedProjectKey !== ALL_PROJECTS && (
                <ActiveFilterChip
                  label="Project"
                  value={projectFilterLabel(selectedProjectKey, projectLabels)}
                  onRemove={() => handleProjectChange(ALL_PROJECTS)}
                />
              )}
              <button
                onClick={handleClearAllFilters}
                className="text-xs font-mono text-terminal-dimmer hover:text-terminal-text transition-colors"
              >
                Clear all
              </button>
            </div>
          )}
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
        <div className="flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {showInitialLoading ? (
            <div className="text-center py-12 text-terminal-dim font-mono text-sm">
              Fetching replays...
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-terminal-dim font-mono text-sm">
              {hasActiveFilters ? "No replays match the current filters" : "No local replays found"}
            </div>
          ) : (
            <div key={listFilterKey} className="space-y-2.5 px-4 py-3">
              {renderedReplays.map((s) => {
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
                    onRawData={() => setRawReplayTarget(s)}
                    isRegenerating={regeneratingSlug === s.slug}
                    isArchived={isArchived}
                  />
                );
              })}
              {remainingRenderCount > 0 && (
                <div className="flex items-center justify-center py-3">
                  <button
                    onClick={() => setRenderLimit((limit) => limit + SESSION_RENDER_BATCH_SIZE)}
                    className="rounded-lg bg-terminal-surface px-4 py-2 text-xs font-mono text-terminal-dim shadow-layer-sm ring-1 ring-terminal-border-subtle hover:bg-terminal-surface-hover hover:text-terminal-text transition-colors"
                  >
                    Showing {renderedReplays.length.toLocaleString()} of{" "}
                    {filtered.length.toLocaleString()} · Show next{" "}
                    {Math.min(SESSION_RENDER_BATCH_SIZE, remainingRenderCount).toLocaleString()}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        {rawReplayTarget && (
          <RawJsonModal
            title={replaySuggestedTitle(rawReplayTarget)}
            subtitle={`${rawReplayTarget.provider} · slug: ${rawReplayTarget.slug}`}
            items={replayRawJsonItems(rawReplayTarget)}
            initialItemId="replay"
            onClose={() => setRawReplayTarget(null)}
          />
        )}
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

  // Cross-panel "open this session in the Sessions popup" channel. Dispatched
  // from Projects → Timeline / Hot Files when the user clicks a session that
  // may or may not have a generated replay yet. We switch to Sessions tab and
  // pass the slug via URL — SessionsPanel's mount effect picks it up and opens
  // SessionDetailPopup, which handles both the "open replay" and "generate
  // replay" cases uniformly.
  useEffect(() => {
    const handler = (e: Event) => {
      const slug = (e as CustomEvent<{ slug: string }>).detail?.slug;
      if (!slug) return;
      setTab("sessions");
      navigateTo({
        tab: "sessions",
        selected: slug,
        project: null,
        q: null,
        archived: null,
        provider: null,
        repo: null,
        replay: null,
      });
    };
    window.addEventListener("vibe-open-session", handler);
    return () => window.removeEventListener("vibe-open-session", handler);
  }, []);

  const handleTabChange = (id: Tab) => {
    setTab(id);
    // Reset cross-tab list state to avoid landing on empty views due to stale project/filter params.
    navigateTo({
      tab: id,
      project: null,
      q: null,
      archived: null,
      provider: null,
      repo: null,
      replay: null,
    });
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
