import { SessionCard } from "../components/SessionCard";
import { providerDisplayName, shortModelName } from "../components/dashboard-utils";
import { shortName, timeAgo } from "../utils/format";
import type { RelaySessionSummary } from "./protocol";

/**
 * Live viewer session card: a thin adapter that maps the relay summary onto
 * the shared `SessionCard` — the exact same card the local dashboard
 * renders. No card markup lives here on purpose; visual changes belong in
 * `components/SessionCard.tsx` so both surfaces stay identical.
 *
 * Dashboard-only rows (prompt previews, usage details, outcome facts, CTAs)
 * need scan data and dashboard state, so the live card simply doesn't pass
 * them. Durations and edit counts are discovery estimates, hence the "~".
 */
export function LiveSessionCard({
  session,
  onOpen,
}: {
  session: RelaySessionSummary;
  onOpen: (s: RelaySessionSummary) => void;
}) {
  const title = session.title || `${session.sessionId.slice(0, 12)}…`;
  const providerTitle = [
    providerDisplayName(session.provider),
    session.model ? shortModelName(session.model) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <SessionCard
      onOpen={() => onOpen(session)}
      provider={session.provider}
      providerTitle={providerTitle}
      title={title}
      timeMeta={
        <span className="text-[11px] font-mono text-terminal-dimmer whitespace-nowrap">
          {timeAgo(session.timestamp)}
        </span>
      }
      place={{
        project: session.project,
        projectLabel: shortName(session.project),
        branch: session.gitBranch,
        repo: session.gitRepo,
      }}
      status={{
        durationMs: session.durationMsEst,
        durationEstimated: true,
        promptCount: session.promptCount,
        toolCallCount: session.toolCallCount,
        editCount: session.editCountEst,
        editEstimated: true,
        compactionCount: session.compactionCount,
      }}
    />
  );
}
