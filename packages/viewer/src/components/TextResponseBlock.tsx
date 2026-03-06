import { useState, memo, useMemo } from "react";
import { marked } from "marked";

interface Props {
  content: string;
  isActive: boolean;
}

const COLLAPSE_THRESHOLD = 600;

export default memo(function TextResponseBlock({ content, isActive }: Props) {
  const isLong = content.length > COLLAPSE_THRESHOLD;
  const [expanded, setExpanded] = useState(false);

  const displayContent =
    isLong && !expanded ? content.slice(0, COLLAPSE_THRESHOLD) + "..." : content;

  const html = useMemo(() => marked.parse(displayContent) as string, [displayContent]);

  return (
    <div>
      <div
        className={`prose-terminal text-sm text-terminal-text ${
          isActive ? "typing-cursor" : ""
        } ${isLong && !expanded ? "max-h-[200px] overflow-hidden relative" : ""}`}
      >
        <div dangerouslySetInnerHTML={{ __html: html }} />
        {isLong && !expanded && (
          <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-terminal-bg to-transparent" />
        )}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[11px] font-mono text-terminal-blue hover:text-terminal-text transition-colors"
        >
          {expanded ? "Show less" : `Show more (${content.length} chars)`}
        </button>
      )}
    </div>
  );
});
