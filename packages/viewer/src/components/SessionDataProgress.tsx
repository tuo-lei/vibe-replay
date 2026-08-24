import type { SourceSession } from "../types";
import type { SourcesEnrichmentStatus } from "./dashboard-utils";

export type SessionDataLevel = "basic" | "details" | "counts" | "metrics";

export interface SessionDataState {
  level: SessionDataLevel;
  label: string;
  description: string;
  className: string;
}

interface SessionMetricSnapshot {
  promptCount?: number;
  toolCallCount?: number;
  editCount?: number;
  durationMs?: number;
  costEstimate?: number;
  tokenUsage?: unknown;
  apiErrorCount?: number;
  compactionCount?: number;
  subAgentCount?: number;
  filesModified?: Array<unknown>;
  prLinks?: Array<unknown>;
}

const STAGES: Array<{ level: SessionDataLevel; label: string }> = [
  { level: "basic", label: "discovered" },
  { level: "details", label: "enriched" },
  { level: "counts", label: "counted" },
  { level: "metrics", label: "scanned" },
];

export function hasEnrichedSourceDetails(session: SourceSession): boolean {
  return Boolean(
    session.title ||
    (session.prompts && session.prompts.length > 1) ||
    session.model ||
    session.gitBranch ||
    session.gitRepo ||
    session.promptCount != null ||
    session.toolCallCount != null ||
    session.durationMsEst != null ||
    session.editCountEst != null,
  );
}

export function hasPromptOrToolCounts(
  session: SourceSession,
  scanData: SessionMetricSnapshot | null | undefined,
): boolean {
  return Boolean(
    scanData?.promptCount != null ||
    scanData?.toolCallCount != null ||
    session.promptCount != null ||
    session.toolCallCount != null,
  );
}

export function hasRichScanMetrics(scanData: SessionMetricSnapshot | null | undefined): boolean {
  return Boolean(
    scanData &&
    ((scanData.filesModified && scanData.filesModified.length > 0) ||
      (scanData.editCount ?? 0) > 0 ||
      Boolean(scanData.durationMs) ||
      Boolean(scanData.costEstimate) ||
      (scanData.apiErrorCount ?? 0) > 0 ||
      (scanData.compactionCount ?? 0) > 0 ||
      (scanData.subAgentCount ?? 0) > 0 ||
      Boolean(scanData.tokenUsage) ||
      Boolean(scanData.prLinks?.length)),
  );
}

export function sessionDataState(
  session: SourceSession,
  scanData: SessionMetricSnapshot | null | undefined,
): SessionDataState {
  if (hasRichScanMetrics(scanData)) {
    return {
      level: "metrics",
      label: "Scanned",
      description:
        "Rich scan metrics are available: files, edits, duration, errors, cost, tokens, or PR links.",
      className: "bg-terminal-green-subtle text-terminal-green",
    };
  }
  if (scanData || hasPromptOrToolCounts(session, scanData)) {
    return {
      level: "counts",
      label: "Counted",
      description: "Prompt/tool counts are available; richer scan metrics may still be deferred.",
      className: "bg-terminal-green-subtle text-terminal-green",
    };
  }
  if (hasEnrichedSourceDetails(session)) {
    return {
      level: "details",
      label: "Enriched",
      description:
        "Discovery has title, prompt preview, model, repo, branch, or other enriched details for this session.",
      className: "bg-terminal-purple-subtle text-terminal-purple",
    };
  }
  return {
    level: "basic",
    label: "Discovered",
    description: "Only lightweight discovery data is available so far.",
    className: "bg-terminal-surface-2 text-terminal-dimmer",
  };
}

export function DataLevelBadge({
  state,
  compact = false,
  active = false,
}: {
  state: SessionDataState;
  compact?: boolean;
  active?: boolean;
}) {
  return (
    <span
      className={`ui-pill ${
        state.className
      } ${active ? "ring-1 ring-terminal-blue/25" : ""} ${compact ? "text-[11px] leading-4" : ""}`}
      title={state.description}
    >
      {active && <span className="w-1 h-1 rounded-full bg-current animate-pulse" />}
      {state.label}
    </span>
  );
}

/**
 * Icon-only data-level indicator with a tooltip — used on session cards so the
 * data-quality state reads as metadata next to the metrics it qualifies, rather
 * than as a chip competing with the action buttons.
 */
export function DataLevelIcon({
  state,
  active = false,
  scannedAtLabel,
}: {
  state: SessionDataState;
  active?: boolean;
  /** e.g. "3m" — appended to the tooltip when the scan time is known. */
  scannedAtLabel?: string | null;
}) {
  const color =
    state.level === "details"
      ? "text-terminal-purple"
      : state.level === "basic"
        ? "text-terminal-dimmer"
        : "text-terminal-green";
  const title = `${state.label}${scannedAtLabel ? ` · scanned ${scannedAtLabel} ago` : ""}\n${state.description}${active ? "\nEnriching…" : ""}`;
  return (
    <span
      title={title}
      aria-label={`Data level: ${state.label}`}
      className={`inline-flex items-center ${color} ${active ? "animate-pulse" : ""}`}
    >
      {/* stacked-layers glyph = data tiers */}
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      >
        <path d="M8 1.5 1.5 5 8 8.5 14.5 5 8 1.5Z" />
        <path d="M1.5 8 8 11.5 14.5 8" />
        <path d="M1.5 11 8 14.5 14.5 11" />
      </svg>
    </span>
  );
}

export function ReadinessRow({
  ready,
  label,
  pendingLabel,
}: {
  ready: boolean;
  label: string;
  pendingLabel: string;
}) {
  return (
    <div className="flex items-center gap-2 text-xs font-mono">
      <span className={ready ? "text-terminal-green" : "text-terminal-dimmer"}>
        {ready ? "✓" : "○"}
      </span>
      <span className={ready ? "text-terminal-dim" : "text-terminal-dimmer"}>
        {ready ? label : pendingLabel}
      </span>
    </div>
  );
}

export function SessionDataPipeline({
  state,
  active = false,
  compact = false,
  className = "",
}: {
  state: SessionDataState;
  active?: boolean;
  compact?: boolean;
  className?: string;
}) {
  const activeIndex = Math.max(
    0,
    STAGES.findIndex((stage) => stage.level === state.level),
  );
  const fillPct = Math.max(12, ((activeIndex + 1) / STAGES.length) * 100);

  return (
    <div className={className} title={state.description}>
      <div className="flex items-center gap-1.5">
        {STAGES.map((stage, index) => {
          const reached = index <= activeIndex;
          const current = index === activeIndex;
          return (
            <div key={stage.level} className="flex items-center gap-1 min-w-0">
              <span
                className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                  reached
                    ? active && current
                      ? "bg-terminal-blue animate-pulse"
                      : "bg-terminal-green"
                    : "bg-terminal-surface-2"
                }`}
              />
              {!compact && (
                <span
                  className={`text-[10px] font-mono uppercase tracking-wide ${
                    reached ? "text-terminal-dim" : "text-terminal-dimmer"
                  }`}
                >
                  {stage.label}
                </span>
              )}
              {index < STAGES.length - 1 && (
                <span
                  className={`h-px w-4 shrink-0 ${
                    index < activeIndex ? "bg-terminal-green/50" : "bg-terminal-surface-2"
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>
      <div
        className={`mt-1.5 h-1 overflow-hidden rounded-full bg-terminal-bg ${
          compact ? "max-w-32" : "w-full"
        }`}
      >
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            active ? "bg-terminal-blue animate-pulse" : "bg-terminal-green"
          }`}
          style={{ width: `${fillPct}%` }}
        />
      </div>
      {!compact && (
        <div className="mt-1 text-[10px] font-mono text-terminal-dimmer">
          {active ? "Fetching richer local session data..." : state.description}
        </div>
      )}
    </div>
  );
}

export function SessionLoadingRibbon({
  status,
  title,
  description,
}: {
  status?: SourcesEnrichmentStatus | null;
  title: string;
  description: string;
}) {
  const total = status?.total ?? 0;
  const processed = status?.processed ?? 0;
  const pct = total > 0 ? Math.max(4, Math.min(100, Math.round((processed / total) * 100))) : 35;

  return (
    <div className="rounded-lg border border-terminal-blue/20 bg-terminal-blue-subtle/95 px-3 py-2 text-terminal-blue shadow-layer-md backdrop-blur-sm">
      <div className="flex items-start gap-2.5">
        <div className="mt-1.5 h-1.5 w-1.5 rounded-full bg-terminal-blue animate-pulse shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs font-mono truncate">{title}</div>
            {total > 0 && (
              <div className="text-[10px] font-mono tabular-nums text-terminal-blue/75">
                {processed}/{total}
              </div>
            )}
          </div>
          <div className="mt-0.5 text-[10px] font-mono text-terminal-blue/70 leading-relaxed">
            {description}
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-terminal-bg/60">
            <div
              className="h-full rounded-full bg-terminal-blue transition-all duration-500 animate-pulse"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function SessionLoadingToast(props: {
  status?: SourcesEnrichmentStatus | null;
  title: string;
  description: string;
}) {
  return (
    <div className="fixed right-4 bottom-20 z-50 w-[calc(100vw-2rem)] max-w-sm pointer-events-none animate-in fade-in slide-in-from-bottom-2 duration-300">
      <SessionLoadingRibbon {...props} />
    </div>
  );
}
