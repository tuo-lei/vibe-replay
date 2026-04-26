import { memo, useState } from "react";
import { formatTokens } from "./StatsPanel";

interface Props {
  content: string;
  isActive: boolean;
  tokens?: number;
}

export default memo(function ThinkingBlock({ content, isActive, tokens }: Props) {
  const [expanded, setExpanded] = useState(false);
  const tokenLabel = formatTokens(tokens);

  return (
    <div className="ml-6">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-terminal-dim hover:text-terminal-text transition-colors duration-200 ease-material font-mono"
      >
        <span className={`transition-transform ${expanded ? "rotate-90" : ""}`}>{"▶"}</span>
        <span className={`text-terminal-purple ${isActive ? "animate-pulse" : ""}`}>Thinking</span>
        {tokenLabel ? (
          <span
            className="text-terminal-purple/70 text-[10px]"
            title="Approximate thinking tokens (chars/4)"
          >
            ~{tokenLabel} tok
          </span>
        ) : (
          <span className="text-terminal-purple/70 text-[10px]">{content.length} chars</span>
        )}
      </button>
      {expanded && (
        <div className="mt-2 pl-5 text-xs text-terminal-dim font-mono whitespace-pre-wrap break-words border-l-2 border-terminal-purple/30 max-h-[300px] overflow-y-auto">
          {content}
        </div>
      )}
    </div>
  );
});
