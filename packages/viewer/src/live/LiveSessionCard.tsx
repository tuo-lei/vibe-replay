import { ProviderBadge } from "../components/dashboard/DashboardShared";
import { SessionStatusRow } from "../components/SessionCard";
import { providerDisplayName, shortModelName } from "../components/dashboard-utils";
import { shortName, timeAgo } from "../utils/format";
import type { RelaySessionSummary } from "./protocol";

/**
 * Live viewer session card. Same information architecture as the local
 * dashboard card (header / activity status / place), composed from the same
 * shared building blocks (`ProviderBadge`, `SessionStatusRow`, format
 * utils) — the dashboard card's extra rows (prompt preview, usage details,
 * archive/replay actions) need scan data and dashboard state, so they stay
 * dashboard-only. Values come straight from the relay summary; durations and
 * edit counts are discovery estimates, hence the "~".
 */
export function LiveSessionCard({
  session,
  onOpen,
}: {
  session: RelaySessionSummary;
  onOpen: (s: RelaySessionSummary) => void;
}) {
  const title = session.title || `${session.sessionId.slice(0, 12)}…`;
  return (
    <button
      type="button"
      onClick={() => onOpen(session)}
      className="block w-full rounded-xl border border-terminal-border-subtle bg-terminal-surface px-4 py-3 text-left transition-colors hover:border-terminal-border hover:bg-terminal-surface-hover"
    >
      <div className="flex items-center gap-2.5">
        <ProviderBadge
          provider={session.provider}
          compact
          title={providerDisplayName(session.provider)}
        />
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{title}</div>
        <div className="shrink-0 text-[11px] tabular-nums text-terminal-dimmer">
          {timeAgo(session.timestamp)}
        </div>
      </div>
      <div className="mt-2">
        <SessionStatusRow
          durationMs={session.durationMsEst}
          durationEstimated
          promptCount={session.promptCount}
          toolCallCount={session.toolCallCount}
          editCount={session.editCountEst}
          editEstimated
          compactionCount={session.compactionCount}
        />
      </div>
      <div className="mt-2 flex items-center gap-x-2 text-xs text-terminal-dim">
        <span className="min-w-0 truncate" title={session.project}>
          {shortName(session.project)}
        </span>
        {session.gitBranch && <span className="shrink-0">· {session.gitBranch}</span>}
        {session.gitRepo && (
          <span className="min-w-0 truncate" title={session.gitRepo}>
            · {session.gitRepo}
          </span>
        )}
        {session.model && (
          <span className="shrink-0" title={session.model}>
            · {shortModelName(session.model)}
          </span>
        )}
      </div>
    </button>
  );
}
