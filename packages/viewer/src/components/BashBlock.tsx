import { memo, useState } from "react";

interface Props {
  command: string;
  stdout: string;
  isActive: boolean;
  durationMs?: number;
}

function fmtDuration(ms: number): string {
  if (ms >= 60000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default memo(function BashBlock({
  command,
  stdout,
  isActive: _isActive,
  durationMs,
}: Props) {
  const [expanded, setExpanded] = useState(true);
  const hasOutput = stdout.trim().length > 0;

  return (
    <div className="bg-terminal-surface rounded-xl overflow-hidden shadow-layer-sm">
      <button
        onClick={() => hasOutput && setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 hover:bg-terminal-surface-hover transition-colors duration-200 ease-material text-left"
      >
        <span className="text-xs font-mono font-bold text-terminal-orange">$</span>
        <span className="text-xs font-mono text-terminal-text truncate flex-1">{command}</span>
        {durationMs && (
          <span
            className="text-[10px] text-terminal-dimmer font-mono shrink-0"
            title={`Execution: ${fmtDuration(durationMs)}`}
          >
            {fmtDuration(durationMs)}
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
