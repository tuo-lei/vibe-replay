import { memo, useState } from "react";
import { formatToolDuration, formatTokens } from "./StatsPanel";

interface Props {
  command: string;
  stdout: string;
  isActive: boolean;
  durationMs?: number;
  resultTokens?: number;
  isError?: boolean;
}

export default memo(function BashBlock({
  command,
  stdout,
  isActive: _isActive,
  durationMs,
  resultTokens,
  isError,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const hasOutput = stdout.trim().length > 0;
  const tokenLabel = formatTokens(resultTokens);
  const durationLabel = formatToolDuration(durationMs);

  return (
    <div
      className={`bg-terminal-surface rounded-xl overflow-hidden shadow-layer-sm ${isError ? "ring-1 ring-red-500/40 border-l-2 border-l-red-500" : ""}`}
    >
      <button
        onClick={() => hasOutput && setExpanded(!expanded)}
        className={`w-full flex items-center gap-2 px-3 py-2 hover:bg-terminal-surface-hover transition-colors duration-200 ease-material text-left ${isError ? "bg-red-500/5" : ""}`}
      >
        <span
          className={`text-xs font-mono font-bold ${isError ? "text-red-400" : "text-terminal-orange"}`}
        >
          $
        </span>
        <span className="text-xs font-mono text-terminal-text truncate flex-1">{command}</span>
        {isError && (
          <span
            className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30 shrink-0"
            title="This tool call returned an error"
          >
            ERROR
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
        {hasOutput && (
          <span
            className={`text-xs text-terminal-dim transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            {"\u25B6"}
          </span>
        )}
      </button>
      {expanded && hasOutput && (
        <div className="px-3 py-2 max-h-[300px] overflow-y-auto">
          <pre className="text-xs font-mono text-terminal-dim whitespace-pre-wrap break-words">
            {stdout}
          </pre>
        </div>
      )}
    </div>
  );
});
