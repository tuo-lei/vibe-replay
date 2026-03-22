import { useEffect, useMemo, useRef } from "react";
import type { ReplaySession } from "../types";
import { formatDuration } from "./StatsPanel";

interface Props {
  session: ReplaySession;
  onStart: (autoPlay?: boolean) => void;
  onViewInsights?: () => void;
}

function formatProviderLabel(provider: string): string {
  if (provider === "claude-code") return "Claude Code";
  if (provider === "cursor") return "Cursor";
  return provider;
}

export default function LandingHero({ session, onStart, onViewInsights }: Props) {
  const { meta, scenes } = session;

  // Extract first turn: user prompt + assistant stats/response
  const firstTurn = useMemo(() => {
    const firstPromptScene = scenes.find((s) => s.type === "user-prompt");
    if (!firstPromptScene || firstPromptScene.type !== "user-prompt") return null;

    const prompt = firstPromptScene.content;
    const toolBreakdown: Record<string, number> = {};
    let responses = 0;
    let totalTools = 0;
    let lastResponse = "";
    let seenPrompts = 0;

    for (const scene of scenes) {
      if (scene.type === "user-prompt") {
        seenPrompts++;
        if (seenPrompts > 1) break; // stop at second user prompt
        continue;
      }
      if (seenPrompts !== 1) continue;
      if (scene.type === "tool-call") {
        totalTools++;
        const name = scene.toolName.replace(/^mcp__.*__/, "");
        toolBreakdown[name] = (toolBreakdown[name] || 0) + 1;
      } else if (scene.type === "text-response") {
        responses++;
        lastResponse = scene.content;
      }
    }

    const toolEntries = Object.entries(toolBreakdown).sort((a, b) => b[1] - a[1]);

    return { prompt, responses, totalTools, toolEntries, lastResponse };
  }, [scenes]);

  const filesModified = useMemo(() => {
    const fileSet = new Set<string>();
    for (const scene of scenes) {
      if (scene.type === "tool-call" && scene.diff) {
        fileSet.add(scene.diff.filePath);
      }
    }
    return fileSet.size;
  }, [scenes]);

  const duration = formatDuration(meta.stats.durationMs);
  const title = meta.title || meta.project;
  const providerLabel = formatProviderLabel(meta.provider);

  // Build stat cards: pick the best 3–4 from available data
  const statCards = useMemo(() => {
    const cards: { value: string; label: string; color: string }[] = [];

    if (duration) {
      cards.push({ value: duration, label: "Duration", color: "text-terminal-text" });
    }

    cards.push({
      value: String(meta.stats.userPrompts),
      label: "Turns",
      color: "text-terminal-green",
    });

    if (filesModified > 0) {
      cards.push({
        value: String(filesModified),
        label: "Files",
        color: "text-terminal-blue",
      });
    }

    if (meta.stats.costEstimate !== undefined) {
      const c = meta.stats.costEstimate;
      cards.push({
        value: `$${c < 0.01 ? c.toFixed(4) : c.toFixed(2)}`,
        label: "Cost",
        color: "text-terminal-orange",
      });
    }

    if (cards.length < 3 && meta.stats.toolCalls > 0) {
      cards.push({
        value: String(meta.stats.toolCalls),
        label: "Tool Calls",
        color: "text-terminal-orange",
      });
    }

    return cards;
  }, [duration, filesModified, meta.stats]);

  // --- Interaction handlers (scroll / swipe / keyboard) ---
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
      {/* Background glow */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute inset-0 bg-gradient-to-b from-terminal-green-subtle via-transparent to-transparent" />
        <div className="absolute inset-0 bg-dot-grid" />
      </div>

      <div className="flex-1 min-h-4 md:min-h-0" />

      <div className="max-w-2xl w-full px-6 md:px-8 pt-4 md:pt-0 text-center space-y-5 md:space-y-7 z-10 shrink-0">
        {/* Title + context subtitle */}
        <div className="space-y-3">
          <h2 className="text-3xl sm:text-4xl md:text-5xl font-sans font-bold text-terminal-text leading-[1.15] tracking-tight">
            {title}
          </h2>
          <p className="text-sm font-sans text-terminal-dim">
            {"A "}
            {providerLabel}
            {" session replay by "}
            <a
              href="https://vibe-replay.com"
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold bg-gradient-to-r from-terminal-green to-terminal-blue bg-clip-text text-transparent hover:opacity-80 transition-opacity"
            >
              vibe-replay
            </a>
          </p>
          {/* Session context badges */}
          {(meta.gitBranch || meta.model) && (
            <div className="flex items-center gap-2 flex-wrap mt-2">
              {meta.gitBranch && (
                <span
                  className="text-[11px] font-mono text-terminal-purple px-2 py-0.5 rounded-full bg-terminal-purple/10 border border-terminal-purple/20"
                  title={meta.gitBranches ? meta.gitBranches.join(" → ") : meta.gitBranch}
                >
                  {meta.gitBranches && meta.gitBranches.length > 1
                    ? `${meta.gitBranches[0]} → ${meta.gitBranch}`
                    : meta.gitBranch}
                </span>
              )}
              {meta.model && (
                <span className="text-[11px] font-mono text-terminal-dim px-2 py-0.5 rounded-full bg-terminal-surface border border-terminal-border-subtle">
                  {meta.model}
                </span>
              )}
              {meta.permissionMode === "bypassPermissions" && (
                <span className="text-[11px] font-mono text-terminal-orange px-2 py-0.5 rounded-full bg-terminal-orange/10 border border-terminal-orange/20">
                  dangerous mode
                </span>
              )}
            </div>
          )}
        </div>

        {/* First turn preview — reuses actual replay card styles */}
        {firstTurn && (
          <button
            type="button"
            onClick={() => onStart()}
            className="w-full text-left appearance-none bg-transparent border-none p-0 cursor-pointer space-y-3"
          >
            {/* User prompt card */}
            <div className="rounded-2xl px-5 py-4 ml-4 md:ml-12 bg-terminal-green-subtle border border-terminal-green/30 shadow-layer-sm hover:bg-terminal-green-emphasis transition-all duration-200 ease-material">
              <div className="flex items-center gap-2 mb-2.5">
                <span className="text-[10px] font-sans font-semibold text-terminal-green uppercase tracking-widest">
                  You
                </span>
              </div>
              <div className="text-terminal-green font-mono text-sm whitespace-pre-wrap break-words line-clamp-3">
                {firstTurn.prompt}
              </div>
            </div>

            {/* Assistant compact card */}
            <div className="rounded-xl px-5 py-4 bg-terminal-surface shadow-layer-sm">
              <div className="flex items-center gap-2 mb-2.5">
                <span className="text-[10px] font-sans font-semibold text-secondary-text uppercase tracking-widest">
                  Assistant
                </span>
              </div>
              {/* Stats pills */}
              <div className="flex flex-wrap items-center gap-1.5 mb-3 text-[11px] font-mono">
                {firstTurn.responses > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-blue-subtle text-terminal-blue">
                    {firstTurn.responses} response
                    {firstTurn.responses > 1 ? "s" : ""}
                  </span>
                )}
                {firstTurn.totalTools > 0 && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-terminal-orange-subtle text-terminal-orange">
                    {firstTurn.totalTools} tool{firstTurn.totalTools > 1 ? "s" : ""}
                  </span>
                )}
                {firstTurn.toolEntries.length > 0 && (
                  <>
                    <span className="text-terminal-border mx-0.5">|</span>
                    {firstTurn.toolEntries.map(([name, count]) => (
                      <span
                        key={name}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-terminal-surface-hover text-terminal-dim"
                      >
                        <span className="text-terminal-orange">{name}</span>
                        <span>{count}</span>
                      </span>
                    ))}
                  </>
                )}
              </div>
              {/* Last text response preview */}
              {firstTurn.lastResponse && (
                <div className="text-sm font-mono text-terminal-dim whitespace-pre-wrap break-words line-clamp-2 leading-relaxed">
                  {firstTurn.lastResponse}
                </div>
              )}
            </div>

            {/* "and N more turns" hint */}
            {meta.stats.userPrompts > 1 && (
              <div className="text-center">
                <span className="text-[11px] font-sans text-terminal-dimmer">
                  and {meta.stats.userPrompts - 1} more turn
                  {meta.stats.userPrompts - 1 !== 1 ? "s" : ""} {"\u2192"}
                </span>
              </div>
            )}
          </button>
        )}

        {/* Stats grid — compact on mobile, spacious on desktop */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 max-w-lg mx-auto">
          {statCards.map((card) => (
            <div
              key={card.label}
              className="bg-terminal-surface rounded-lg sm:rounded-xl px-2.5 py-2 sm:px-3 sm:py-3 shadow-layer-sm"
            >
              <div
                className={`text-base sm:text-xl font-bold font-mono tabular-nums ${card.color}`}
              >
                {card.value}
              </div>
              <div className="text-[9px] sm:text-[10px] font-sans text-terminal-dimmer uppercase tracking-widest font-medium">
                {card.label}
              </div>
            </div>
          ))}
        </div>

        {/* CTA row — desktop only (mobile uses sticky bar below) */}
        <div className="hidden md:flex items-center justify-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => onStart()}
            className="group inline-flex items-center gap-3 px-10 py-4 rounded-xl bg-terminal-green-subtle hover:bg-terminal-green-emphasis transition-all duration-200 ease-material shadow-layer-md hover:shadow-layer-lg hover:-translate-y-0.5 landing-pulse"
          >
            <span className="text-xl text-terminal-green group-hover:scale-110 transition-transform duration-200">
              {"\u25B6"}
            </span>
            <span className="text-base font-sans font-semibold text-terminal-green tracking-wide">
              Watch Replay
            </span>
          </button>
          {onViewInsights && (
            <button
              type="button"
              onClick={onViewInsights}
              className="group inline-flex items-center gap-2 px-6 py-4 rounded-xl bg-terminal-surface hover:bg-terminal-surface-hover transition-all duration-200 ease-material shadow-layer-sm hover:shadow-layer-md border border-terminal-border/40 hover:border-terminal-border"
            >
              <svg
                aria-hidden="true"
                className="w-4 h-4 text-terminal-blue group-hover:scale-110 transition-transform duration-200"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" x2="18" y1="20" y2="10" />
                <line x1="12" x2="12" y1="20" y2="4" />
                <line x1="6" x2="6" y1="20" y2="14" />
              </svg>
              <span className="text-sm font-sans font-semibold text-terminal-dim group-hover:text-terminal-text tracking-wide">
                View Insights
              </span>
            </button>
          )}
        </div>

        {/* Bottom spacer for mobile sticky bar */}
        <div className="h-24 md:hidden" />
      </div>

      {/* Scroll indicator — desktop only */}
      <button
        type="button"
        onClick={() => onStart(false)}
        className="hidden md:flex mt-8 md:mt-10 mb-6 z-10 shrink-0 flex-col items-center gap-2 group cursor-pointer"
      >
        <span className="text-xs font-sans font-medium text-terminal-dim group-hover:text-terminal-text transition-colors">
          or scroll down
        </span>
        <svg
          aria-hidden="true"
          className="w-6 h-6 text-terminal-green animate-bounce group-hover:scale-110 transition-transform"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      <div className="flex-1 min-h-0" />

      {/* Mobile sticky CTA bar */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-50 bg-terminal-bg border-t border-terminal-border-subtle safe-bottom">
        <div className="flex items-center gap-3 mx-6 my-4">
          <button
            type="button"
            onClick={() => onStart()}
            className="flex-[2] inline-flex items-center justify-center gap-2.5 py-3.5 rounded-xl bg-terminal-green text-terminal-bg font-semibold shadow-lg shadow-terminal-green/20 transition-all"
          >
            <span className="text-base">{"\u25B6"}</span>
            <span className="text-sm font-sans">Watch Replay</span>
          </button>
          {onViewInsights && (
            <button
              type="button"
              onClick={onViewInsights}
              className="flex-1 inline-flex items-center justify-center gap-2 py-3.5 rounded-xl bg-terminal-surface border border-terminal-border-subtle hover:border-terminal-border transition-all"
            >
              <svg
                aria-hidden="true"
                className="w-3.5 h-3.5 text-terminal-blue"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" x2="18" y1="20" y2="10" />
                <line x1="12" x2="12" y1="20" y2="4" />
                <line x1="6" x2="6" y1="20" y2="14" />
              </svg>
              <span className="text-sm font-sans font-medium text-terminal-dim">Insights</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
