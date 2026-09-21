import { SessionCard } from "../components/SessionCard";
import {
  dataSourceBadgeClass,
  formatDataSourceLabel,
  formatSize,
  providerDisplayName,
  shortModelName,
} from "../components/dashboard-utils";
import { DataLevelIcon, sessionDataState } from "../components/SessionDataProgress";
import type { SourceSession } from "../types";
import { shortName, timeAgo } from "../utils/format";
import type { RelaySessionSummary } from "./protocol";

/**
 * Live viewer session card: a thin adapter that maps the relay summary onto
 * the shared `SessionCard` — the exact same card component the local
 * dashboard renders (`components/Dashboard.tsx` imports the same
 * `SessionCard`). No card markup lives here on purpose; visual changes belong
 * in `components/SessionCard.tsx` so both surfaces stay identical.
 *
 * Slots the relay cannot feed, and why (kept honest rather than faked):
 * - usage details (`middle`): needs the scan's token/model usage breakdown.
 * - error state: needs `scanData.apiErrorCount`; the dashboard itself only
 *   asserts `cleanRun` after a scan, so the live card leaves the slot empty
 *   instead of claiming "no errors" it cannot verify.
 * - cost: discovery has no token-usage data — the card hides it.
 * - Share / Redo / Generate / Live CTAs: they operate on local dashboard
 *   files and replays; meaningless in the remote viewer. View (open detail)
 *   is the only CTA that does something real here.
 * - "local" location badge: every live session is remote by definition; the
 *   badge would be wrong or redundant, so it is omitted.
 * - branch/repo links: no local git remote URLs exist for the viewer, so the
 *   dashboard's GitHub links render as plain text instead.
 *
 * Durations and edit counts are discovery estimates, hence the "~".
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
  // Same data-level computation the dashboard runs, with no scan data: the
  // relay only ever carries discovery-level fields, so the icon honestly
  // reads "Counted"/"Enriched"/"Discovered" instead of "Scanned".
  const dataState = sessionDataState(
    {
      ...session,
      slug: session.slug ?? "",
      firstPrompt: session.firstPrompts?.[0] ?? "",
      prompts: session.firstPrompts,
      filePaths: [],
      existingReplay: null,
    } satisfies SourceSession,
    null,
  );
  // Same label/class logic as the dashboard card. The scan's `dataSource`
  // never crosses the relay, so the relay infers it from discovery facts
  // (see relay.ts summarize()) — same function, same text, same classes.
  const dataSourceLabel = formatDataSourceLabel(
    session.hasSqlite,
    session.dataSource,
    session.hasSdk,
  );
  return (
    <SessionCard
      onOpen={() => onOpen(session)}
      provider={session.provider}
      providerTitle={providerTitle}
      title={title}
      timeMeta={
        <span
          className="text-[11px] font-mono text-terminal-dimmer whitespace-nowrap overflow-hidden text-ellipsis max-w-[140px]"
          title={session.slug}
        >
          {[session.slug, timeAgo(session.timestamp)].filter(Boolean).join(" · ")}
        </span>
      }
      prompts={session.firstPrompts}
      place={{
        project: session.project,
        projectLabel: shortName(session.project),
        branch: session.gitBranch,
        repo: session.gitRepo,
      }}
      statusLeading={<DataLevelIcon state={dataState} />}
      status={{
        durationMs: session.durationMsEst,
        durationEstimated: true,
        promptCount: session.promptCount,
        toolCallCount: session.toolCallCount,
        editCount: session.editCountEst,
        editEstimated: true,
        compactionCount: session.compactionCount,
      }}
      facts={
        <>
          <span className="text-terminal-dimmer tabular-nums" title="Transcript size">
            {formatSize(session.fileSize)}
          </span>
          <span
            className={`px-1.5 py-0.5 rounded-md ${dataSourceBadgeClass(
              session.dataSource,
              session.hasSqlite,
              session.hasSdk,
            )}`}
            title={dataSourceLabel}
          >
            {dataSourceLabel}
          </span>
        </>
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
