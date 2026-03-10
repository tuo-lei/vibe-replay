import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Scene } from "../types";

interface Props {
  scenes: Scene[];
  open: boolean;
  onClose: () => void;
  onSeek: (index: number) => void;
}

interface SearchResult {
  sceneIndex: number;
  type: Scene["type"];
  snippet: string;
  toolName?: string;
}

function getSceneText(scene: Scene): string {
  switch (scene.type) {
    case "user-prompt":
      return scene.content;
    case "compaction-summary":
      return scene.content;
    case "thinking":
      return scene.content;
    case "text-response":
      return scene.content;
    case "tool-call":
      return [
        scene.toolName,
        JSON.stringify(scene.input),
        scene.result || "",
        scene.bashOutput?.command || "",
        scene.bashOutput?.stdout || "",
      ].join(" ");
    default:
      return "";
  }
}

function highlightMatch(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, 120);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + query.length + 60);
  const snippet =
    (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
  return snippet;
}

const TYPE_LABELS: Record<string, string> = {
  "user-prompt": "User",
  "compaction-summary": "Compaction",
  thinking: "Thinking",
  "text-response": "Response",
  "tool-call": "Tool",
};

const TYPE_COLORS: Record<string, string> = {
  "user-prompt": "text-terminal-green",
  "compaction-summary": "text-terminal-dim",
  thinking: "text-terminal-purple",
  "text-response": "text-terminal-blue",
  "tool-call": "text-terminal-orange",
};

export default function SearchOverlay({ scenes, open, onClose, onSeek }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Search results
  const results = useMemo((): SearchResult[] => {
    if (query.length < 2) return [];
    const q = query.toLowerCase();
    const matches: SearchResult[] = [];
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const text = getSceneText(scene);
      if (text.toLowerCase().includes(q)) {
        matches.push({
          sceneIndex: i,
          type: scene.type,
          snippet: highlightMatch(text, query),
          toolName:
            scene.type === "tool-call"
              ? (scene as Extract<Scene, { type: "tool-call" }>).toolName
              : undefined,
        });
      }
      if (matches.length >= 50) break;
    }
    return matches;
  }, [scenes, query]);

  // Reset selection when results change
  useEffect(() => setSelectedIdx(0), []);

  // Scroll selected into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.children[selectedIdx] as HTMLElement;
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  const selectResult = useCallback(
    (idx: number) => {
      const r = results[idx];
      if (r) {
        onSeek(r.sceneIndex);
        onClose();
      }
    },
    [results, onSeek, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        selectResult(selectedIdx);
      } else if (e.key === "Escape") {
        onClose();
      }
    },
    [results.length, selectedIdx, selectResult, onClose],
  );

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[8vh] sm:pt-[15vh]"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-xl mx-3 sm:mx-0 bg-terminal-bg border border-terminal-border-subtle rounded-2xl shadow-layer-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-5 py-3.5 border-b border-terminal-border-subtle">
          <span className="text-terminal-dim text-sm">{"\uD83D\uDD0D"}</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search scenes..."
            className="flex-1 bg-transparent text-sm font-sans font-medium text-terminal-text placeholder-terminal-dim outline-none"
          />
          <kbd className="text-[10px] font-mono text-terminal-dimmer bg-terminal-surface px-2 py-0.5 rounded-md">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
          {query.length < 2 ? (
            <div className="px-4 py-8 text-center text-xs font-sans font-medium text-terminal-dim">
              Type at least 2 characters to search
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs font-sans font-medium text-terminal-dim">
              No results for "{query}"
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={r.sceneIndex}
                onClick={() => selectResult(i)}
                className={`w-full text-left px-4 py-2.5 flex items-start gap-3 transition-colors ${
                  i === selectedIdx ? "bg-terminal-green/10" : "hover:bg-terminal-surface/50"
                }`}
              >
                <span
                  className={`text-[10px] font-sans font-bold uppercase shrink-0 mt-0.5 tracking-wider ${
                    TYPE_COLORS[r.type] || "text-terminal-dim"
                  }`}
                >
                  {r.toolName || TYPE_LABELS[r.type] || r.type}
                </span>
                <span className="text-xs font-mono text-terminal-text line-clamp-2 break-words">
                  {renderHighlighted(r.snippet, query)}
                </span>
                <span className="text-xs font-mono text-terminal-dimmer shrink-0 mt-0.5">
                  #{r.sceneIndex}
                </span>
              </button>
            ))
          )}
        </div>

        {/* Footer */}
        {results.length > 0 && (
          <div className="px-4 py-2 border-t border-terminal-border-subtle text-[10px] font-sans font-bold uppercase tracking-wider text-terminal-dimmer flex gap-4">
            <span>
              {results.length} result{results.length !== 1 ? "s" : ""}
            </span>
            <span>&uarr;&darr; navigate</span>
            <span>&crarr; select</span>
          </div>
        )}
      </div>
    </div>
  );
}

function renderHighlighted(snippet: string, query: string) {
  if (!query) return snippet;
  const parts: React.ReactNode[] = [];
  const lower = snippet.toLowerCase();
  const q = query.toLowerCase();
  let last = 0;
  let idx = lower.indexOf(q);
  while (idx !== -1) {
    if (idx > last) parts.push(snippet.slice(last, idx));
    parts.push(
      <mark key={idx} className="bg-terminal-green/30 text-terminal-green rounded-sm px-0.5">
        {snippet.slice(idx, idx + query.length)}
      </mark>,
    );
    last = idx + query.length;
    idx = lower.indexOf(q, last);
  }
  if (last < snippet.length) parts.push(snippet.slice(last));
  return parts;
}
