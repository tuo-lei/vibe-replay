import { useMemo, useEffect, useRef } from "react";
import type { ReplaySession } from "../types";

interface Props {
  session: ReplaySession;
  onStart: () => void;
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
    return first.content.length > 300
      ? first.content.slice(0, 300) + "..."
      : first.content;
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
  useEffect(() => {
    const handler = (e: WheelEvent | TouchEvent) => {
      if (firedRef.current) return;
      // Only trigger on downward scroll
      if (e instanceof WheelEvent && e.deltaY <= 0) return;
      firedRef.current = true;
      onStart();
    };
    window.addEventListener("wheel", handler, { passive: true });
    window.addEventListener("touchmove", handler, { passive: true });
    return () => {
      window.removeEventListener("wheel", handler);
      window.removeEventListener("touchmove", handler);
    };
  }, [onStart]);

  // Space/Enter also triggers start
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        onStart();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onStart]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center relative overflow-hidden">
      {/* Background glow */}
      <div className="absolute inset-0 bg-gradient-to-b from-terminal-green/[0.03] via-transparent to-transparent pointer-events-none" />

      <div className="max-w-2xl w-full px-6 text-center space-y-8 z-10">
        {/* Title */}
        <div className="space-y-3">
          <h2 className="text-2xl sm:text-3xl font-mono font-bold text-terminal-text leading-tight">
            {title}
          </h2>
          {meta.title && meta.project !== meta.title && (
            <div className="text-sm font-mono text-terminal-dim">
              {meta.project}
            </div>
          )}
        </div>

        {/* Stats grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-lg mx-auto">
          <StatPill label="Turns" value={meta.stats.userPrompts} color="text-terminal-green" />
          <StatPill label="Tool Calls" value={meta.stats.toolCalls} color="text-terminal-orange" />
          <StatPill label="Files" value={stats.filesModified} color="text-terminal-blue" />
          {duration ? (
            <StatPill label="Duration" value={duration} color="text-terminal-text" />
          ) : (
            <StatPill label="Scenes" value={meta.stats.sceneCount} color="text-terminal-text" />
          )}
        </div>

        {/* Model + provider */}
        <div className="flex items-center justify-center gap-3 text-xs font-mono text-terminal-dim">
          {meta.model && <span>{meta.model}</span>}
          {meta.model && <span className="text-terminal-border">|</span>}
          <span>{meta.provider}</span>
        </div>

        {/* Play button */}
        <button
          onClick={onStart}
          className="group inline-flex items-center gap-3 px-8 py-3 rounded-xl bg-terminal-green/10 border border-terminal-green/30 hover:bg-terminal-green/20 hover:border-terminal-green/50 transition-all duration-200"
        >
          <span className="text-xl text-terminal-green group-hover:scale-110 transition-transform">
            {"\u25B6"}
          </span>
          <span className="text-sm font-mono font-semibold text-terminal-green">
            Start Replay
          </span>
        </button>
      </div>

      {/* First prompt teaser at the bottom */}
      {firstPrompt && (
        <div className="absolute bottom-0 left-0 right-0 px-6 pb-6">
          <div
            onClick={onStart}
            className="max-w-2xl mx-auto cursor-pointer group"
          >
            <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wider mb-2 text-center">
              First message
            </div>
            <div className="rounded-lg bg-terminal-green/5 border border-terminal-green/15 px-4 py-3 group-hover:border-terminal-green/30 transition-colors">
              <div className="text-[11px] font-mono font-semibold text-terminal-green uppercase tracking-wider mb-1.5">
                You
              </div>
              <div className="text-sm font-mono text-terminal-text/70 line-clamp-3 whitespace-pre-wrap">
                {firstPrompt}
              </div>
            </div>
            <div className="text-center mt-3 text-terminal-dim/50 text-xs font-mono animate-bounce">
              {"\u2193"} scroll to explore
            </div>
          </div>
        </div>
      )}
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
    <div className="bg-terminal-surface/80 rounded-lg px-3 py-2.5 border border-terminal-border/40">
      <div className={`text-lg font-bold font-mono tabular-nums ${color}`}>
        {value}
      </div>
      <div className="text-[11px] font-mono text-terminal-dim uppercase tracking-wide">
        {label}
      </div>
    </div>
  );
}
