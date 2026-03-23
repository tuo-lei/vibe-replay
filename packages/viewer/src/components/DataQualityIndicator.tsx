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
  const lines = title
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <span className={`group relative inline-flex ${className}`}>
      <button
        type="button"
        className="inline-flex h-4 min-w-4 items-center justify-center rounded-full border border-terminal-orange/40 bg-terminal-orange/10 px-1 text-[10px] font-sans font-bold leading-none text-terminal-orange transition-colors hover:border-terminal-orange/70 hover:bg-terminal-orange/15 focus:outline-none focus:ring-2 focus:ring-terminal-orange/30"
        title={title}
      >
        !
      </button>
      <div className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-lg border border-terminal-orange/30 bg-terminal-bg/95 px-3 py-2 text-left opacity-0 shadow-layer-lg transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
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
