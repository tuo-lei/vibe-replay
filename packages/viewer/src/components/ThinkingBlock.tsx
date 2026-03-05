import { useState, memo } from "react";

interface Props {
  content: string;
  isActive: boolean;
}

export default memo(function ThinkingBlock({ content, isActive }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="ml-6">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-terminal-dim hover:text-terminal-text transition-colors font-mono"
      >
        <span
          className={`transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          {"\u25B6"}
        </span>
        <span className={isActive ? "animate-pulse" : ""}>
          Thinking...
        </span>
        <span className="text-terminal-purple">
          ({content.length} chars)
        </span>
      </button>
      {expanded && (
        <div className="mt-2 pl-5 text-xs text-terminal-dim font-mono whitespace-pre-wrap break-words border-l-2 border-terminal-purple/30 max-h-[300px] overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  );
});
