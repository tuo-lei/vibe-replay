import { useEffect, useMemo, useRef } from "react";
import type { ReplaySession } from "../types";

interface Props {
  session: ReplaySession;
  onStart: (autoPlay?: boolean) => void;
}

function formatDuration(ms?: number): string {
  if (!ms) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

export default function LandingHero({ session, onStart }: Props) {
  const { meta, scenes } = session;

  const firstPrompt = useMemo(() => {
    const first = scenes.find((s) => s.type === "user-prompt");
    if (!first || first.type !== "user-prompt") return null;
    return first.content.length > 300 ? `${first.content.slice(0, 300)}...` : first.content;
  }, [scenes]);

  const stats = useMemo(() => {
    const toolCounts = new Map<string, number>();
    let filesModified = 0;
    const fileSet = new Set<string>();
    for (const scene of scenes) {
      if (scene.type === "tool-call") {
        toolCounts.set(scene.toolName, (toolCounts.get(scene.toolName) || 0) + 1);
        if (scene.diff && !fileSet.has(scene.diff.filePath)) {
          fileSet.add(scene.diff.filePath);
          filesModified++;
        }
      }
    }
    return { toolCounts, filesModified };
  }, [scenes]);

  const duration = formatDuration(meta.stats.durationMs);
  const title = meta.title || meta.project;

  // Scroll/swipe down triggers start
  const firedRef = useRef(false);
  const touchStartYRef = useRef(0);
  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (firedRef.current) return;
      if (e.deltaY > 0) {
        firedRef.current = true;
        onStart(false);
      }
    };
    const handleTouchStart = (e: TouchEvent) => {
      touchStartYRef.current = e.touches[0].clientY;
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (firedRef.current) return;
      const deltaY = touchStartYRef.current - e.touches[0].clientY;
      if (deltaY > 15) {
        firedRef.current = true;
        onStart(false);
      }
    };
    window.addEventListener("wheel", handleWheel, { passive: true });
    window.addEventListener("touchstart", handleTouchStart, { passive: true });
    window.addEventListener("touchmove", handleTouchMove, { passive: true });
    return () => {
      window.removeEventListener("wheel", handleWheel);
      window.removeEventListener("touchstart", handleTouchStart);
      window.removeEventListener("touchmove", handleTouchMove);
    };
  }, [onStart]);

  // Space/Enter also triggers start
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        onStart();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onStart]);

  return (
    <div className="flex-1 flex flex-col items-center overflow-y-auto relative">
      {/* Background glow — layered for depth */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-terminal-green-subtle via-transparent to-transparent" />
        <div className="absolute inset-0 bg-dot-grid" />
      </div>

      {/* Top spacer */}
      <div className="flex-1 min-h-0" />

      <div className="max-w-2xl w-full px-8 text-center space-y-6 md:space-y-10 z-10 shrink-0">
        {/* Title */}
        <div className="space-y-4 md:space-y-5">
          <a
            href="https://vibe-replay.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-sm font-sans font-semibold uppercase tracking-widest hover:opacity-80 transition-opacity bg-gradient-to-r from-[#3fb950] to-[#79b8ff] bg-clip-text text-transparent"
          >
            vibe-replay
          </a>
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-sans font-bold text-terminal-text leading-[1.15] tracking-tight">
            {title}
          </h2>
          {meta.title && meta.project !== meta.title && (
            <div className="text-sm font-mono text-terminal-dim">{meta.project}</div>
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-lg mx-auto">
          <StatPill label="Turns" value={meta.stats.userPrompts} color="text-terminal-green" />
          <StatPill label="Tool Calls" value={meta.stats.toolCalls} color="text-terminal-orange" />
          {duration ? (
            <StatPill label="Duration" value={duration} color="text-terminal-text" />
          ) : (
            <StatPill label="Files" value={stats.filesModified} color="text-terminal-blue" />
          )}
          {meta.stats.costEstimate !== undefined ? (
            <StatPill
              label="Cost"
              value={`$${meta.stats.costEstimate < 0.01 ? meta.stats.costEstimate.toFixed(4) : meta.stats.costEstimate.toFixed(2)}`}
              color="text-terminal-green"
            />
          ) : (
            <StatPill label="Scenes" value={meta.stats.sceneCount} color="text-terminal-text" />
          )}
        </div>

        {/* Model + provider */}
        <div className="flex items-center justify-center gap-3 text-xs font-mono text-terminal-dimmer">
          {meta.model && <span>{meta.model}</span>}
          {meta.model && <span className="text-terminal-border">|</span>}
          <span>{meta.provider}</span>
        </div>

        {/* Play button — primary CTA */}
        <button
          onClick={() => onStart()}
          className="group inline-flex items-center gap-3 px-10 py-4 rounded-xl bg-terminal-green-subtle hover:bg-terminal-green-emphasis transition-all duration-200 ease-material shadow-layer-md hover:shadow-layer-lg hover:-translate-y-0.5 landing-pulse"
        >
          <span className="text-xl text-terminal-green group-hover:scale-110 transition-transform duration-200">
            {"\u25B6"}
          </span>
          <span className="text-base font-sans font-semibold text-terminal-green tracking-wide">
            Start Replay
          </span>
        </button>
      </div>

      {/* First prompt teaser */}
      {firstPrompt && (
        <div className="w-full px-8 mt-8 md:mt-12 pb-6 z-10 shrink-0">
          <div onClick={() => onStart()} className="max-w-2xl mx-auto cursor-pointer group">
            <div className="text-xs font-sans text-terminal-dimmer uppercase tracking-widest mb-3 text-center font-medium">
              First message
            </div>
            <div className="rounded-xl bg-terminal-green-subtle px-5 py-4 group-hover:bg-terminal-green-emphasis transition-all duration-200 ease-material shadow-layer-sm hover-lift">
              <div className="text-xs font-sans font-semibold text-terminal-green uppercase tracking-widest mb-2">
                You
              </div>
              <div className="text-sm font-mono text-terminal-dim line-clamp-3 whitespace-pre-wrap leading-relaxed">
                {firstPrompt}
              </div>
            </div>
            <div className="text-center mt-4 text-terminal-dimmer text-xs font-mono animate-bounce uppercase tracking-wider">
              {"\u2193"} press down or scroll to explore
            </div>
          </div>
        </div>
      )}

      {/* Explore link — ghost style */}
      <div className="px-8 py-5 z-10 shrink-0">
        <a
          href="https://vibe-replay.com/explore"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 text-xs font-sans font-medium text-terminal-dim hover:text-terminal-text transition-colors"
        >
          Explore more replays
          <span className="text-terminal-green">{"\u2192"}</span>
        </a>
      </div>

      {/* Bottom spacer */}
      <div className="flex-1 min-h-0" />
    </div>
  );
}

function StatPill({
  label,
  value,
  color,
}: {
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <div className="bg-terminal-surface rounded-xl px-3 py-3 shadow-layer-sm">
      <div className={`text-xl font-bold font-mono tabular-nums ${color}`}>{value}</div>
      <div className="text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-medium mt-0.5">
        {label}
      </div>
    </div>
  );
}
