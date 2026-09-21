import type { ReactNode } from "react";
import { formatCost, formatDuration } from "../utils/format";
import { ProviderBadge } from "./dashboard/DashboardShared";

/**
 * Shared session-card building blocks, used by both the local dashboard
 * (`components/Dashboard.tsx`) and the E2E-encrypted live viewer
 * (`live/LiveApp.tsx`). One source of truth on purpose: when the card's
 * shell, header, place row, status row, or filter chips change here, both
 * surfaces change together and cannot drift apart.
 *
 * The components are purely presentational — they take already-computed
 * values. The dashboard merges scan data with discovery estimates before
 * passing them in; the live viewer passes the relay summary fields directly.
 */

/** Removable filter pill, e.g. "Provider: muse ×". */
export function ActiveFilterChip({
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

export interface SessionStatusValues {
  /** Active duration in ms. */
  durationMs?: number;
  /** True when the duration is a discovery estimate (rendered with a "~"). */
  durationEstimated?: boolean;
  promptCount?: number;
  toolCallCount?: number;
  /** File-editing tool calls. */
  editCount?: number;
  /** True when the edit count is a discovery estimate (rendered with a "~"). */
  editEstimated?: boolean;
  costEstimate?: number;
  /** Tooltip for the cost value (e.g. token breakdown). */
  costTitle?: string;
  compactionCount?: number;
  /** API errors during the session. */
  errorCount?: number;
  /** True when the session is known to have run with no API errors. */
  cleanRun?: boolean;
}

/**
 * The "activity" status row from the dashboard session card: duration,
 * prompts, tool calls, edits, cost, compactions, error state — exact values
 * in a hairline-framed mono row. The dashboard passes scan-merged values plus
 * its data-level icon as `leading`; the live viewer passes relay-summary
 * values and no leading icon.
 */
export function SessionStatusRow({
  leading,
  durationMs,
  durationEstimated,
  promptCount,
  toolCallCount,
  editCount,
  editEstimated,
  costEstimate,
  costTitle,
  compactionCount = 0,
  errorCount = 0,
  cleanRun = false,
}: SessionStatusValues & { leading?: ReactNode }) {
  return (
    <div className="flex items-center gap-x-3.5 gap-y-1 flex-wrap text-xs font-mono tabular-nums py-2 border-y border-terminal-border-subtle">
      {leading}
      {!!durationMs && (
        <span className="text-terminal-text" title="Active duration">
          {durationEstimated ? "~" : ""}
          {formatDuration(durationMs)}
        </span>
      )}
      {!!promptCount && (
        <span className="text-terminal-text">
          {promptCount}{" "}
          <span className="text-terminal-dimmer">prompt{promptCount !== 1 ? "s" : ""}</span>
        </span>
      )}
      {!!toolCallCount && (
        <span className="text-terminal-text">
          {toolCallCount} <span className="text-terminal-dimmer">tools</span>
        </span>
      )}
      {!!editCount && (
        <span className="text-terminal-text" title="File edits">
          {editEstimated ? "~" : ""}
          {editCount} <span className="text-terminal-dimmer">edits</span>
        </span>
      )}
      {!!costEstimate && (
        <span className="text-terminal-green" title={costTitle}>
          {formatCost(costEstimate)}
        </span>
      )}
      {compactionCount > 0 && (
        <span
          className="text-terminal-context"
          title={`${compactionCount} context compaction${compactionCount !== 1 ? "s" : ""}`}
        >
          {compactionCount} compact{compactionCount !== 1 ? "s" : ""}
        </span>
      )}
      {cleanRun ? (
        <span className="text-terminal-green" title="No API errors">
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
  );
}

/** The "place" row of the session card: project · branch · repo. */
export interface SessionCardPlace {
  /** Raw project path, used for the title tooltip. */
  project: string;
  /** Display label (may be shortened or a friendly name). */
  projectLabel: string;
  /** Non-default branch, when known. */
  branch?: string | null;
  /** When present the branch renders as a link (dashboard); otherwise plain text (live). */
  branchUrl?: string;
  /** Normalized git remote (e.g. "tuo-lei/vibe-replay"). */
  repo?: string | null;
  /** When present the repo renders as a link (dashboard); otherwise plain text (live). */
  repoUrl?: string;
  /** Extra badges after the repo: worktree / cowork-space / plugins (dashboard-only). */
  badges?: ReactNode;
}

export interface SessionCardProps {
  /** Card click / keyboard activation (dashboard navigates or selects; live opens the detail). */
  onOpen: () => void;
  /** Archived sessions render dimmed. */
  archived?: boolean;
  /** Priority enrichment in flight renders a highlight ring. */
  enriching?: boolean;
  // -- Row 1: provider icon + title | time + actions --
  provider: string;
  /** Tooltip override for the provider badge (dashboard passes model/entrypoint info). */
  providerTitle?: string;
  title: string;
  /** Extra badges between the provider icon and the title (location / transcript status). */
  titleLeading?: ReactNode;
  /** Right side of the header: dashboard passes "slug · time ago", live passes "time ago". */
  timeMeta: ReactNode;
  /** Card menu (dashboard-only). */
  headerActions?: ReactNode;
  // -- Row 2: user prompt previews (dashboard-only; needs scan data) --
  prompts?: string[];
  // -- Row 3: place --
  place: SessionCardPlace;
  // -- Row 4: activity status --
  /** Leading icon for the status row (dashboard's data-level icon). */
  statusLeading?: ReactNode;
  status: SessionStatusValues;
  /** Rendered between the status row and the footer (dashboard's usage details). */
  middle?: ReactNode;
  // -- Row 5: outcome facts (left) | CTAs (right), dashboard-only --
  facts?: ReactNode;
  actions?: ReactNode;
}

function FolderIcon() {
  return (
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
  );
}

function BranchIcon() {
  return (
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
  );
}

function GitHubIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="currentColor"
      className="text-terminal-dimmer"
    >
      <path d="M8 1a7 7 0 0 0-2.2 13.6c.35.06.48-.15.48-.34v-1.2c-1.95.42-2.36-.94-2.36-.94-.32-.8-.78-1.02-.78-1.02-.64-.44.05-.43.05-.43.7.05 1.07.72 1.07.72.63 1.08 1.65.77 2.05.59.06-.46.25-.77.45-.95-1.56-.18-3.2-.78-3.2-3.47 0-.77.27-1.4.72-1.89-.07-.18-.31-.9.07-1.87 0 0 .59-.19 1.93.72a6.7 6.7 0 0 1 3.5 0c1.34-.91 1.93-.72 1.93-.72.38.97.14 1.69.07 1.87.45.49.72 1.12.72 1.89 0 2.7-1.64 3.29-3.2 3.46.25.22.48.65.48 1.31v1.95c0 .19.13.4.49.33A7 7 0 0 0 8 1z" />
    </svg>
  );
}

/**
 * The full session card, shared verbatim by the local dashboard and the live
 * viewer. Same outer shell, same header, same prompt/place/activity rows —
 * only the data source and the dashboard-only slots (menu, usage details,
 * facts, CTAs) differ.
 */
export function SessionCard({
  onOpen,
  archived = false,
  enriching = false,
  provider,
  providerTitle,
  title,
  titleLeading,
  timeMeta,
  headerActions,
  prompts,
  place,
  statusLeading,
  status,
  middle,
  facts,
  actions,
}: SessionCardProps) {
  return (
    <div
      onClick={onOpen}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- card contains nested controls; cannot use a real <button>
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`bg-terminal-surface rounded-xl px-5 py-4 hover:bg-terminal-surface-hover transition-all duration-300 ease-material space-y-3 shadow-layer-sm cursor-pointer hover-lift ${
        enriching ? "ring-1 ring-terminal-blue/20" : ""
      } ${archived ? "opacity-50" : ""}`}
    >
      {/* Row 1: provider icon + title | time + menu */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          <span className="mt-0.5">
            <ProviderBadge provider={provider} title={providerTitle} />
          </span>
          {titleLeading}
          <span className="text-sm font-sans font-semibold text-terminal-text leading-snug line-clamp-2">
            {title}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {timeMeta}
          {headerActions}
        </div>
      </div>

      {/* Row 2: user prompt previews */}
      {prompts?.map((p, i) => (
        <div key={i} className="flex gap-2 items-start">
          <span className="text-xs text-terminal-green shrink-0 mt-px select-none">&gt;</span>
          <p className="text-sm text-terminal-dim line-clamp-2 leading-relaxed">{p}</p>
        </div>
      ))}

      {/* Row 3: place — project · branch · repo */}
      <div className="flex items-center gap-x-2.5 gap-y-1 flex-wrap text-xs font-mono text-terminal-dim">
        <span
          className="inline-flex items-center gap-1 max-w-[240px] truncate"
          title={place.project}
        >
          <FolderIcon />
          {place.projectLabel}
        </span>
        {place.branch &&
          (place.branchUrl ? (
            <a
              href={place.branchUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 hover:text-terminal-blue hover:underline shrink-0"
              title={`Open branch ${place.branch} on GitHub`}
            >
              <BranchIcon />
              {place.branch}
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 shrink-0">
              <BranchIcon />
              {place.branch}
            </span>
          ))}
        {place.repo &&
          (place.repoUrl ? (
            <a
              href={place.repoUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 hover:text-terminal-blue hover:underline shrink-0"
              title="Open repo on GitHub"
            >
              <GitHubIcon />
              {place.repo}
            </a>
          ) : (
            <span className="inline-flex items-center gap-1 shrink-0" title={place.repo}>
              <GitHubIcon />
              {place.repo}
            </span>
          ))}
        {place.badges}
      </div>

      {/* Row 4: activity status */}
      <SessionStatusRow leading={statusLeading} {...status} />

      {middle}

      {/* Row 5: outcome facts (left) | CTAs (right) */}
      {(facts || actions) && (
        <div className="flex items-end justify-between gap-3">
          <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs font-mono min-w-0">
            {facts}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">{actions}</div>
        </div>
      )}
    </div>
  );
}
