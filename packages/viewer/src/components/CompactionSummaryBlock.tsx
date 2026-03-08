import { memo, useState } from "react";

interface Props {
  content: string;
  isActive: boolean;
}

const PREVIEW_LINES = 3;

export default memo(function CompactionSummaryBlock({ content }: Props) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const isLong = lines.length > PREVIEW_LINES;

  const displayContent = isLong && !expanded ? lines.slice(0, PREVIEW_LINES).join("\n") : content;

  return (
    <div>
      <div
        className={`text-xs font-mono text-terminal-dimmer whitespace-pre-wrap leading-relaxed ${isLong && !expanded ? "max-h-[4.5em] overflow-hidden relative" : ""}`}
      >
        {displayContent}
        {isLong && !expanded && (
          <div className="absolute bottom-0 left-0 right-0 h-8 bg-gradient-to-t from-terminal-bg to-transparent" />
        )}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-xs font-mono text-terminal-dimmer hover:text-terminal-text transition-colors"
        >
          {expanded ? "Show less" : `Show full summary (${lines.length} lines)`}
        </button>
      )}
    </div>
  );
});
