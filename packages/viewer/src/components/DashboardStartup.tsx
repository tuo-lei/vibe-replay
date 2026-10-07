import { useEffect, useRef } from "react";
import type { SourceDiscoveryProgress, SourceProviderProgress } from "@vibe-replay/types";
import type { SourceSession } from "../types";
import { VibeReplayBrand } from "./VibeReplayBrand";
import { ProviderBadge } from "./dashboard/DashboardShared";
import { projectDisplayName, providerDisplayName, sourceDisplayTitle } from "./dashboard-utils";

interface DashboardStartupProps {
  progress: SourceDiscoveryProgress | null;
  loading: boolean;
  loadingSources: boolean;
  sources: SourceSession[];
  replayCount: number;
  error: string | null;
  failures: string[];
  onRetry: () => void;
  onContinue: () => void;
}

export function DashboardStartup({
  progress,
  loading,
  loadingSources,
  sources,
  replayCount,
  error,
  failures,
  onRetry,
  onContinue,
}: DashboardStartupProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return () => {
      if (typeof dialog.close === "function") dialog.close();
    };
  }, []);

  const failed = Boolean(error || failures.length);
  const providerStates: SourceProviderProgress[] =
    progress?.providerStates ??
    (progress?.providers ?? []).map((provider) => ({
      provider,
      detected: true,
      status: "ready" as const,
    }));
  const foundProviders = providerStates.filter((state) => state.detected);
  const shownProviders = providerStates.filter(
    (state) => state.detected || state.status === "failed",
  );
  const reading = providerStates.find((state) => state.status === "reading" && state.detected);
  const completed = foundProviders.filter((state) =>
    ["ready", "empty"].includes(state.status),
  ).length;
  const title = loading
    ? progress?.phase === "preparing" || !loadingSources
      ? "Your sessions, coming together"
      : foundProviders.length
        ? `Found ${foundProviders.length} session ${foundProviders.length === 1 ? "source" : "sources"}`
        : progress?.scanned
          ? "Reading your session history"
          : "Finding your coding tools…"
    : failed
      ? "Some sessions are unavailable"
      : "No sessions yet";
  const previews = sources.length ? sources.slice(0, 3) : (progress?.previews ?? []).slice(0, 3);
  const latest = previews[0];
  const total = progress?.total ?? 0;
  const prepared = Math.min(total, Math.max(0, progress?.prepared ?? 0));
  const determinate = loadingSources && progress?.phase === "preparing" && total > 0;
  const status = !loadingSources
    ? "Finishing your dashboard"
    : determinate
      ? `${prepared.toLocaleString()} of ${total.toLocaleString()} sessions prepared`
      : progress?.scanned
        ? `${progress.scanned.toLocaleString()} session ${progress.scanned === 1 ? "record" : "records"} found`
        : reading
          ? `Reading ${providerDisplayName(reading.provider)} sessions…`
          : "Checking local session storage…";

  return (
    <dialog
      ref={dialogRef}
      className="dashboard-startup"
      aria-labelledby="startup-title"
      onCancel={(event) => event.preventDefault()}
    >
      <div className="dashboard-startup-center">
        <div className="dashboard-startup-brand">
          <VibeReplayBrand />
        </div>
        <p className="dashboard-startup-tagline">Your AI coding history, brought to life.</p>
        <h1 id="startup-title">{title}</h1>
        {shownProviders.length > 0 && (
          <ul className="dashboard-startup-providers" aria-label="Session source discovery">
            {shownProviders.map((state) => (
              <li className={`dashboard-startup-provider is-${state.status}`} key={state.provider}>
                <div className="dashboard-startup-provider-icon" aria-hidden="true">
                  <ProviderBadge provider={state.provider} />
                  {state.status === "ready" || state.status === "empty" ? (
                    <span className="dashboard-startup-provider-check">✓</span>
                  ) : state.status === "failed" ? (
                    <span className="dashboard-startup-provider-check">!</span>
                  ) : null}
                </div>
                <span className="dashboard-startup-provider-name">
                  {providerDisplayName(state.provider)}
                </span>
                <span className="dashboard-startup-provider-state">
                  {state.status === "found"
                    ? "Found"
                    : state.status === "reading"
                      ? "Reading…"
                      : state.status === "failed"
                        ? "Unavailable"
                        : state.status === "empty"
                          ? "No sessions"
                          : state.sessionCount === undefined
                            ? "Read"
                            : `${state.sessionCount.toLocaleString()} records`}
                </span>
              </li>
            ))}
          </ul>
        )}
        {loading ? (
          <>
            <ol className="dashboard-startup-steps" aria-label="Library setup">
              <li className={foundProviders.length ? "is-done" : "is-active"}>Find sources</li>
              <li
                className={
                  progress?.phase === "preparing" || !loadingSources
                    ? "is-done"
                    : foundProviders.length
                      ? "is-active"
                      : ""
                }
              >
                Read sessions
              </li>
              <li className={progress?.phase === "preparing" || !loadingSources ? "is-active" : ""}>
                Build library
              </li>
            </ol>
            <progress
              className="sr-only"
              aria-label="Preparing your session library"
              max={determinate ? total : 1}
              value={determinate ? prepared : undefined}
              aria-valuetext={status}
            />
            <div className="dashboard-startup-track" aria-hidden="true">
              <span
                className={determinate && prepared > 0 ? "" : "is-indeterminate"}
                style={{
                  width: determinate && prepared > 0 ? `${(100 * prepared) / total}%` : undefined,
                }}
              />
            </div>
            <output className="dashboard-startup-status" aria-live="polite">
              <span>{status}</span>
              {loadingSources && progress?.phase === "discovering" && foundProviders.length > 0 && (
                <span>
                  {completed} / {foundProviders.length} sources read
                </span>
              )}
            </output>
            {reading && progress?.scanned ? (
              <p className="dashboard-startup-reading">
                Reading {providerDisplayName(reading.provider)} sessions…
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p className="dashboard-startup-description" role={failed ? "alert" : "status"}>
              {error ||
                (failed
                  ? `Could not read ${failures.join(", ")}.`
                  : "Start a session in your coding tool, then check again.")}
              {failed &&
                sources.length > 0 &&
                ` ${sources.length.toLocaleString()} sessions are available.`}
              {failed &&
                sources.length === 0 &&
                replayCount > 0 &&
                ` ${replayCount.toLocaleString()} saved ${replayCount === 1 ? "replay is" : "replays are"} available.`}
            </p>
            <div className="dashboard-startup-actions">
              {(!failed || sources.length > 0 || replayCount > 0) && (
                <button type="button" onClick={onContinue}>
                  {failed
                    ? sources.length > 0
                      ? "Continue with available sessions"
                      : "Continue with saved replays"
                    : "Open dashboard"}
                </button>
              )}
              <button type="button" onClick={onRetry}>
                {failed ? "Retry" : "Check again"}
              </button>
            </div>
          </>
        )}
        {latest && loading && (
          <div className="dashboard-startup-latest" aria-hidden="true">
            <ProviderBadge provider={latest.provider} compact />
            <div className="dashboard-startup-copy">
              <p className="dashboard-startup-latest-label">Latest session found</p>
              <p
                className="dashboard-startup-session truncate"
                key={`${latest.provider}:${latest.sessionId ?? latest.slug}:${latest.location?.id ?? "local"}`}
              >
                {sourceDisplayTitle({
                  ...latest,
                  fileSize: 0,
                  lineCount: 0,
                  filePaths: [],
                  existingReplay: null,
                })}
              </p>
              <p className="dashboard-startup-meta truncate">
                {projectDisplayName(latest.project)}
              </p>
            </div>
          </div>
        )}
        <div className="dashboard-startup-value">
          <p>Replay the work. Discover the patterns.</p>
          <span>
            Turn sessions into shareable replays. Find patterns with Insights. Get answers with Ask
            Replay.
          </span>
        </div>
        {loading && <p className="dashboard-startup-auto">Opens automatically when ready</p>}
      </div>
    </dialog>
  );
}
