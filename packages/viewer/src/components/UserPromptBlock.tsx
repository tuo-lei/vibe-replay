import { memo, useEffect, useMemo, useState } from "react";

interface Props {
  content: string;
  images?: string[];
  isActive: boolean;
}

const COLLAPSE_DESKTOP = { lines: 8, chars: 900 };
const COLLAPSE_MOBILE = { lines: 4, chars: 280 };

function getCollapseConfig() {
  if (typeof window !== "undefined" && window.innerWidth < 768) return COLLAPSE_MOBILE;
  return COLLAPSE_DESKTOP;
}

export default memo(function UserPromptBlock({ content, images, isActive }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [collapse] = useState(getCollapseConfig);

  useEffect(() => {
    const handler = (e: Event) => {
      if (!isActive) return;
      const detail = (e as CustomEvent).detail;
      if (detail.action === "expand") setExpanded(true);
      else if (detail.action === "collapse") setExpanded(false);
    };
    window.addEventListener("vibe:toggle-expand", handler);
    return () => window.removeEventListener("vibe:toggle-expand", handler);
  }, [isActive]);

  const lines = useMemo(() => content.split("\n"), [content]);
  const isLong = lines.length > collapse.lines || content.length > collapse.chars;

  const preview = useMemo(() => {
    if (!isLong || expanded) return content;
    const byLines = lines.slice(0, collapse.lines).join("\n");
    if (byLines.length > collapse.chars) return byLines.slice(0, collapse.chars);
    return byLines;
  }, [content, expanded, isLong, lines, collapse]);

  return (
    <div>
      <div
        className={`text-terminal-green font-mono text-sm whitespace-pre-wrap break-words ${
          isActive ? "typing-cursor" : ""
        }`}
      >
        {preview}
        {isLong && !expanded && <span className="text-terminal-dim">{`\n...`}</span>}
      </div>
      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs font-mono text-terminal-dim hover:text-terminal-green transition-colors duration-200 ease-material flex items-center gap-1.5"
        >
          {isActive && (
            <span className="text-secondary-text font-bold opacity-70">
              {expanded ? "[←]" : "[→]"}
            </span>
          )}
          <span>{expanded ? "Show less" : `Show more (${lines.length} lines)`}</span>
        </button>
      )}
      {images && images.length > 0 && (
        <div className="flex gap-2 mt-2 flex-wrap">
          {images.map((src, i) => (
            <img
              key={i}
              src={src}
              alt={`Attachment ${i + 1}`}
              className="max-w-[300px] max-h-[200px] rounded-md object-contain"
            />
          ))}
        </div>
      )}
    </div>
  );
});
