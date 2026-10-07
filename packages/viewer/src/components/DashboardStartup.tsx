import { useEffect, useRef } from "react";
import type { SourceDiscoveryProgress } from "@vibe-replay/types";
import type { SourceSession } from "../types";
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
  const title = loading
    ? "Bringing your sessions together"
    : failed
      ? "Some sessions are unavailable"
      : "No sessions yet";
  const previews = sources.length ? sources.slice(0, 3) : (progress?.previews ?? []).slice(0, 3);
  // Put the first real session in the clear middle row; surrounding rows fade into the background.
  const rows = [previews[1], previews[0], previews[2]];
  const total = progress?.total ?? 0;
  const prepared = Math.min(total, Math.max(0, progress?.prepared ?? 0));
  const determinate = loadingSources && progress?.phase === "preparing" && total > 0;
  const status = !loadingSources
    ? "Finishing your dashboard"
    : determinate
      ? `${prepared.toLocaleString()} of ${total.toLocaleString()} sessions prepared`
      : progress?.scanned
        ? `${progress.scanned.toLocaleString()} session ${progress.scanned === 1 ? "record" : "records"} found`
        : "Finding your recent work";

  return (
    <dialog
      ref={dialogRef}
      className="dashboard-startup"
      aria-labelledby="startup-title"
      onCancel={(event) => event.preventDefault()}
    >
      <div className="dashboard-startup-center">
        <div className="dashboard-startup-brand">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="m7 9 3 3-3 3m6 0h4" />
          </svg>
          <span>vibe-replay</span>
        </div>
        <h1 id="startup-title" tabIndex={-1}>
          {title}
        </h1>
        {(loading || previews.length > 0) && (
          <div className="dashboard-startup-sessions" aria-hidden="true">
            {rows.map((preview, index) => (
              <div
                key={index}
                className={`dashboard-startup-row ${index === 1 ? "is-current" : ""}`}
              >
                {preview ? (
                  <ProviderBadge provider={preview.provider} />
                ) : (
                  <span className="dashboard-startup-placeholder-icon skeleton" />
                )}
                <div className="dashboard-startup-copy">
                  {preview ? (
                    <div
                      className="dashboard-startup-session"
                      key={`${preview.provider}:${preview.sessionId ?? preview.slug}:${preview.location?.id ?? "local"}`}
                    >
                      <div className="truncate">
                        {sourceDisplayTitle({
                          ...preview,
                          fileSize: 0,
                          lineCount: 0,
                          filePaths: [],
                          existingReplay: null,
                        })}
                      </div>
                      <div className="dashboard-startup-meta truncate">
                        {providerDisplayName(preview.provider)} ·{" "}
                        {projectDisplayName(preview.project)}
                      </div>
                    </div>
                  ) : (
                    <>
                      <span className="dashboard-startup-placeholder-title skeleton" />
                      <span className="dashboard-startup-placeholder-meta skeleton" />
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {loading ? (
          <>
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
              {status}
            </output>
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
      </div>
      {loading && <p className="dashboard-startup-auto">Opens automatically when ready</p>}
    </dialog>
  );
}
