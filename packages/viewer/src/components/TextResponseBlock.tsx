import { marked } from "marked";
import { memo, useEffect, useMemo, useState } from "react";
import {
  handleMarkdownHighlightClick,
  hasHtmlTextHighlights,
  hasVisibleTextHighlights,
  injectHtmlTextHighlights,
  type TextHighlight,
} from "../utils/annotation-highlights";
import { sanitizeHtml } from "../utils/sanitize";

interface Props {
  content: string;
  isActive: boolean;
  highlights?: TextHighlight[];
  onHighlightClick?: (annotationId: string) => void;
}

const COLLAPSE_THRESHOLD = 600;

export default memo(function TextResponseBlock({
  content,
  isActive,
  highlights = [],
  onHighlightClick,
}: Props) {
  const isLong = content.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);

  const displayContent =
    isLong && !expanded ? `${content.slice(0, COLLAPSE_THRESHOLD)}...` : content;
  const fullHtml = useMemo(() => sanitizeHtml(marked.parse(content) as string), [content]);
  const displayHtml = useMemo(
    () => sanitizeHtml(marked.parse(displayContent) as string),
    [displayContent],
  );

  useEffect(() => {
    if (
      isLong &&
      !expanded &&
      (hasVisibleTextHighlights(content, highlights) ||
        hasHtmlTextHighlights(fullHtml, highlights)) &&
      !hasVisibleTextHighlights(displayContent, highlights) &&
      !hasHtmlTextHighlights(displayHtml, highlights)
    ) {
      setExpanded(true);
    }
  }, [content, displayContent, displayHtml, expanded, fullHtml, highlights, isLong]);

  const html = useMemo(() => {
    return injectHtmlTextHighlights(displayHtml, highlights);
  }, [displayHtml, highlights]);

  return (
    <div>
      <div
        className={`prose-terminal text-sm text-terminal-text ${
          isActive ? "typing-cursor" : ""
        } ${isLong && !expanded ? "max-h-[200px] overflow-hidden relative" : ""}`}
      >
        <div
          onClick={(event) => handleMarkdownHighlightClick(event, onHighlightClick)}
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {isLong && !expanded && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-terminal-bg to-transparent" />
        )}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs font-mono text-terminal-blue hover:text-terminal-text transition-colors"
        >
          {expanded ? "Show less" : `Show more (${content.length} chars)`}
        </button>
      )}
    </div>
  );
});
