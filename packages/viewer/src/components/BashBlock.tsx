import { useState, memo } from "react";

interface Props {
  command: string;
  stdout: string;
  isActive: boolean;
}

export default memo(function BashBlock({ command, stdout, isActive }: Props) {
  const [expanded, setExpanded] = useState(true);
  const hasOutput = stdout.trim().length > 0;

  return (
    <div className="border border-terminal-border rounded-lg overflow-hidden bg-[#0a0e14]">
      <button
        onClick={() => hasOutput && setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-terminal-surface/50 hover:bg-terminal-border/20 transition-colors text-left border-b border-terminal-border"
      >
        <span className="text-xs font-mono font-bold text-terminal-orange">
          $
        </span>
        <span className="text-xs font-mono text-terminal-text truncate flex-1">
          {command}
        </span>
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
