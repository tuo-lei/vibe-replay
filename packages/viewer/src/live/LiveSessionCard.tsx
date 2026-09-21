import { SessionCard } from "../components/SessionCard";
import { formatSize, providerDisplayName, shortModelName } from "../components/dashboard-utils";
import { shortName, timeAgo } from "../utils/format";
import type { RelaySessionSummary } from "./protocol";

/**
 * Live viewer session card: a thin adapter that maps the relay summary onto
 * the shared `SessionCard` — the exact same card the local dashboard
 * renders. No card markup lives here on purpose; visual changes belong in
 * `components/SessionCard.tsx` so both surfaces stay identical.
 *
 * Slots the relay cannot feed (usage details, outcome facts, Share/Redo)
 * need scan data or local dashboard state, so the live card doesn't pass
 * them. Durations and edit counts are discovery estimates, hence the "~".
 * Cost is absent because discovery has no token-usage data for these
 * providers — the card hides it rather than fabricating a number.
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
      prompts={session.firstPrompts}
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
      middle={
        <div
          className="text-xs font-mono text-terminal-dimmer tabular-nums"
          title="Transcript size"
        >
          {formatSize(session.fileSize)}
        </div>
      }
      actions={
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen(session);
          }}
          aria-label={`Open ${title}`}
          className="h-7 px-2.5 text-xs font-sans font-semibold rounded-md bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis transition-all duration-200 ease-material flex items-center justify-center gap-1"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <polygon points="4 2 14 8 4 14" />
          </svg>
          View
        </button>
      }
    />
  );
}
