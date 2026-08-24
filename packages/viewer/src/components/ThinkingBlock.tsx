import { memo, useEffect, useState } from "react";
import {
  hasVisibleTextHighlights,
  renderHighlightedPlainText,
  type TextHighlight,
} from "../utils/annotation-highlights";
import { formatTokens } from "./StatsPanel";

// Hoisted so the default isn't re-created on every render (stable reference).
const NO_HIGHLIGHTS: TextHighlight[] = [];

interface Props {
  content: string;
  isActive: boolean;
  tokens?: number;
  highlights?: TextHighlight[];
  onHighlightClick?: (annotationId: string) => void;
}

export default memo(function ThinkingBlock({
  content,
  isActive,
  tokens,
  highlights = NO_HIGHLIGHTS,
  onHighlightClick,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const tokenLabel = formatTokens(tokens);

  useEffect(() => {
    if (!expanded && hasVisibleTextHighlights(content, highlights)) {
      setExpanded(true);
    }
  }, [content, expanded, highlights]);

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
        <div className="mt-2 rounded-lg bg-terminal-surface-inset px-3 py-2 text-xs text-terminal-dim font-mono whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
          {renderHighlightedPlainText(content, highlights, onHighlightClick)}
        </div>
      )}
    </div>
  );
});
