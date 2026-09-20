import type { ReactNode } from "react";
import { formatCost, formatDuration } from "../utils/format";

/**
 * Shared session-card building blocks, used by both the local dashboard
 * (`components/Dashboard.tsx`) and the E2E-encrypted live viewer
 * (`live/LiveApp.tsx`). One source of truth on purpose: when the card's
 * status row or filter chips change here, both surfaces change together and
 * cannot drift apart.
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
