import { memo, useState } from "react";
import { ErrorBadge } from "./Badges";
import { formatToolDuration, formatTokens } from "./StatsPanel";

interface Props {
  command: string;
  stdout: string;
  isActive: boolean;
  durationMs?: number;
  resultTokens?: number;
  isError?: boolean;
  hasResult?: boolean;
}

export default memo(function BashBlock({
  command,
  stdout,
  isActive: _isActive,
  durationMs,
  resultTokens,
  isError,
  hasResult,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const hasOutput = stdout.trim().length > 0;
  const resultRecorded = hasResult !== false && (hasResult === true || hasOutput);
  const tokenLabel = formatTokens(resultTokens);
  const durationLabel = formatToolDuration(durationMs);

  return (
    <div
      className={`bg-terminal-surface rounded-xl overflow-hidden shadow-layer-sm ${isError ? "ring-1 ring-red-500/40" : ""}`}
    >
      <button
        onClick={() => resultRecorded && setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-3 py-2 hover:bg-terminal-surface-hover transition-colors duration-200 ease-material text-left ${isError ? "bg-red-500/5" : ""}`}
      >
        <span
          className={`text-xs font-mono font-bold ${isError ? "text-red-400" : "text-terminal-orange"}`}
        >
          $
        </span>
        <span className="text-xs font-mono text-terminal-text truncate flex-1">{command}</span>
        {isError && <ErrorBadge />}
        {hasResult === false && (
          <span
            className="text-[10px] text-terminal-dimmer font-mono shrink-0"
            title={
              isError
                ? "The command failed before a result was recorded."
                : "No command result was recorded."
            }
          >
            {isError ? "no result" : "pending"}
          </span>
        )}
        {hasResult === true && !hasOutput && (
          <span
            className="text-[10px] text-terminal-dimmer font-mono shrink-0"
            title="The provider recorded a successful empty result."
          >
            empty result
          </span>
        )}
        {tokenLabel && (
          <span
            className="text-[10px] text-terminal-dimmer font-mono shrink-0"
            title={`~${tokenLabel} tokens added to context`}
          >
            ~{tokenLabel} tok
          </span>
        )}
        {durationLabel && (
          <span
            className="text-[10px] text-terminal-dimmer font-mono shrink-0"
            title={`Execution: ${durationLabel}`}
          >
            {durationLabel}
          </span>
        )}
        {resultRecorded && (
          <span
            className={`text-xs text-terminal-dim transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            {"\u25B6"}
          </span>
        )}
      </button>
      {expanded && (
        <>
          {hasResult === false ? (
            <div className="px-3 py-2 text-xs font-mono text-terminal-dimmer">
              Result not recorded.
            </div>
          ) : (
            resultRecorded && (
              <div className="px-3 py-2 max-h-[300px] overflow-y-auto">
                <pre className="text-xs font-mono text-terminal-dim whitespace-pre-wrap break-words">
                  {stdout || "(empty result)"}
                </pre>
              </div>
            )
          )}
        </>
      )}
    </div>
  );
});
