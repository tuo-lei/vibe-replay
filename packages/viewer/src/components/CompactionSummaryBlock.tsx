import { memo, useEffect, useState } from "react";
import {
  hasVisibleTextHighlights,
  renderHighlightedPlainText,
  type TextHighlight,
} from "../utils/annotation-highlights";

interface Props {
  content: string;
  isActive: boolean;
  highlights?: TextHighlight[];
  onHighlightClick?: (annotationId: string) => void;
}

const PREVIEW_LINES = 3;

export default memo(function CompactionSummaryBlock({
  content,
  isActive,
  highlights = [],
  onHighlightClick,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const isLong = lines.length > PREVIEW_LINES;

  // Support arrow-key expand/collapse (← / →)
  useEffect(() => {
    if (!isActive) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail.action === "expand") setExpanded(true);
      else if (detail.action === "collapse") setExpanded(false);
    };
    window.addEventListener("vibe:toggle-expand", handler);
    return () => window.removeEventListener("vibe:toggle-expand", handler);
  }, [isActive]);

  const displayContent = isLong && !expanded ? lines.slice(0, PREVIEW_LINES).join("\n") : content;

  useEffect(() => {
    if (
      isLong &&
      !expanded &&
      hasVisibleTextHighlights(content, highlights) &&
      !hasVisibleTextHighlights(displayContent, highlights)
    ) {
      setExpanded(true);
    }
  }, [content, displayContent, expanded, highlights, isLong]);

  return (
    <div>
      <div
        className={`text-xs font-mono text-terminal-dimmer whitespace-pre-wrap leading-relaxed ${isLong && !expanded ? "max-h-[4.5em] overflow-hidden relative" : ""}`}
      >
        {renderHighlightedPlainText(displayContent, highlights, onHighlightClick)}
        {isLong && !expanded && (
          <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-terminal-surface to-transparent pointer-events-none" />
        )}
      </div>
      {isLong && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded(!expanded);
          }}
          className="mt-1 text-xs font-mono text-terminal-dim hover:text-terminal-text transition-colors cursor-pointer"
        >
          {expanded ? "Show less" : `Show full summary (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
});
