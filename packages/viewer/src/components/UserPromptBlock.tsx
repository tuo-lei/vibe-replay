import { memo, useMemo, useState } from "react";

interface Props {
  content: string;
  images?: string[];
  isActive: boolean;
}

const COLLAPSE_LINES = 8;
const COLLAPSE_CHARS = 900;

export default memo(function UserPromptBlock({ content, images, isActive }: Props) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => content.split("\n"), [content]);
  const isLong = lines.length > COLLAPSE_LINES || content.length > COLLAPSE_CHARS;

  const preview = useMemo(() => {
    if (!isLong || expanded) return content;
    return lines.slice(0, COLLAPSE_LINES).join("\n");
  }, [content, expanded, isLong, lines]);

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
          className="mt-1 text-xs font-mono text-terminal-dim hover:text-terminal-green transition-colors duration-200 ease-material"
        >
          {expanded ? "Show less" : `Show more (${lines.length} lines)`}
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
