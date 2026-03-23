import { useEffect, useRef, useState } from "react";
import type { ReplaySession } from "../types";

export function getSessionDataQualityNotes(meta: ReplaySession["meta"]): string[] {
  const notes = [...(meta.dataSourceInfo?.notes || [])];

  if (
    meta.provider === "cursor" &&
    (meta.dataSource === "sqlite" || meta.dataSource === "global-state")
  ) {
    notes.unshift("Some Cursor metrics are best-effort estimates and may be incomplete.");
  }
  if (!meta.stats.tokenUsage) {
    notes.push("Token and cost metrics may be unavailable.");
  }

  return [...new Set(notes)];
}

export function getSessionMetricQuality(meta: ReplaySession["meta"]): {
  duration?: string;
  tokens?: string;
  turnStats?: string;
} {
  const notes = getSessionDataQualityNotes(meta);
  return {
    duration: notes.find((note) => /duration/i.test(note)),
    tokens: notes.find((note) => /token|cost|model attribution/i.test(note)),
    turnStats: notes.find((note) => /per-turn|turn stats|turn metrics/i.test(note)),
  };
}

export function DataQualityIndicator({
  title,
  className = "",
}: {
  title: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const lines = title
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const isVisible = open;

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <span ref={rootRef} className={`group relative inline-flex ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-terminal-orange/40 bg-terminal-orange/10 px-1 text-[10px] font-sans font-bold leading-none text-terminal-orange transition-colors hover:border-terminal-orange/70 hover:bg-terminal-orange/15 focus:outline-none focus:ring-2 focus:ring-terminal-orange/30"
        title={title}
        onClick={() => setOpen((value) => !value)}
      >
        !
      </button>
      <div
        className={`pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-xl border border-terminal-border-subtle bg-terminal-surface-2 px-3 py-2.5 text-left shadow-layer-xl transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 ${isVisible ? "opacity-100" : "opacity-0"}`}
      >
        <div className="mb-1 text-[10px] font-sans font-semibold uppercase tracking-widest text-terminal-orange">
          Data Quality
        </div>
        <div className="space-y-1">
          {lines.map((line) => (
            <div key={line} className="text-[11px] font-mono leading-relaxed text-terminal-dim">
              {line}
            </div>
          ))}
        </div>
      </div>
    </span>
  );
}
