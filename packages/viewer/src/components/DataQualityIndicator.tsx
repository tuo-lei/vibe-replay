import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const [hovered, setHovered] = useState(false);
  const [tooltipStyle, setTooltipStyle] = useState<{ left: number; top: number } | null>(null);
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const lines = title
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const isVisible = open || hovered;

  useEffect(() => {
    if (!isVisible) return;

    const updatePosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;

      const tooltipWidth = 288;
      const viewportPadding = 16;
      const estimatedHeight = 56 + lines.length * 20;
      const left = Math.min(
        Math.max(rect.left + rect.width / 2 - tooltipWidth / 2, viewportPadding),
        window.innerWidth - tooltipWidth - viewportPadding,
      );
      const preferredTop = rect.bottom + 8;
      const top =
        preferredTop + estimatedHeight > window.innerHeight - viewportPadding
          ? Math.max(viewportPadding, rect.top - estimatedHeight - 8)
          : preferredTop;

      setTooltipStyle({ left, top });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [isVisible, lines.length]);

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
    <span
      ref={rootRef}
      className={`inline-flex ${className}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-label="Show data quality details"
        className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-terminal-orange/40 bg-terminal-orange/10 px-1 text-[10px] font-sans font-bold leading-none text-terminal-orange transition-colors hover:border-terminal-orange/70 hover:bg-terminal-orange/15 focus:outline-none focus:ring-2 focus:ring-terminal-orange/30"
        onClick={() => setOpen((value) => !value)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        !
      </button>
      {isVisible && tooltipStyle
        ? createPortal(
            <div
              className="pointer-events-none fixed z-[120] w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-terminal-border-subtle bg-terminal-surface-2 px-3 py-2.5 text-left shadow-layer-xl"
              style={tooltipStyle}
            >
              <div className="mb-1 text-[10px] font-sans font-semibold uppercase tracking-widest text-terminal-orange">
                Data Quality
              </div>
              <div className="space-y-1">
                {lines.map((line) => (
                  <div
                    key={line}
                    className="text-[11px] font-mono leading-relaxed text-terminal-dim"
                  >
                    {line}
                  </div>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
