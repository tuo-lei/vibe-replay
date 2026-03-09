import { useMemo } from "react";
import type { ReplaySession } from "../types";
import { fmtNum, formatDuration, StatCard } from "./StatsPanel";

interface Props {
  session: ReplaySession;
}

export default function SummaryView({ session }: Props) {
  const { meta, scenes } = session;

  const stats = useMemo(() => {
    const toolCounts = new Map<string, number>();
    let thinkingChars = 0;
    let responseChars = 0;
    let promptChars = 0;
    const filesModified = new Set<string>();

    // Prompt timeline data
    const prompts: { index: number; text: string; sceneIndex: number; toolCount: number }[] = [];
    let currentPromptToolCount = 0;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      switch (scene.type) {
        case "user-prompt": {
          // Close previous prompt's tool count
          if (prompts.length > 0) {
            prompts[prompts.length - 1].toolCount = currentPromptToolCount;
          }
          currentPromptToolCount = 0;
          promptChars += scene.content.length;
          const firstLine = scene.content.split("\n").find((l) => l.trim()) || "";
          prompts.push({
            index: prompts.length + 1,
            text: firstLine.slice(0, 120),
            sceneIndex: i,
            toolCount: 0,
          });
          break;
        }
        case "thinking":
          thinkingChars += scene.content.length;
          break;
        case "text-response":
          responseChars += scene.content.length;
          break;
        case "tool-call": {
          currentPromptToolCount++;
          toolCounts.set(scene.toolName, (toolCounts.get(scene.toolName) || 0) + 1);
          if (scene.diff) {
            filesModified.add(scene.diff.filePath);
          }
          break;
        }
      }
    }
    // Close last prompt
    if (prompts.length > 0) {
      prompts[prompts.length - 1].toolCount = currentPromptToolCount;
    }

    const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

    return {
      totalScenes: scenes.length,
      userPrompts: meta.stats.userPrompts,
      toolCalls: meta.stats.toolCalls,
      thinkingChars,
      responseChars,
      promptChars,
      filesModified: filesModified.size,
      filesList: [...filesModified],
      topTools,
      durationMs: meta.stats.durationMs,
      tokenUsage: meta.stats.tokenUsage,
      costEstimate: meta.stats.costEstimate,
      prompts,
    };
  }, [scenes, meta]);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Key Metrics */}
      <div>
        <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-3">
          Overview
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Turns" value={stats.userPrompts} color="text-terminal-green" />
          <StatCard label="Tool Calls" value={stats.toolCalls} color="text-terminal-orange" />
          <StatCard label="Files Modified" value={stats.filesModified} color="text-terminal-blue" />
          <StatCard label="Scenes" value={stats.totalScenes} color="text-terminal-text" />
        </div>
      </div>

      {/* Duration & Cost */}
      {(stats.durationMs || stats.costEstimate !== undefined) && (
        <div className="flex gap-4 text-xs font-mono text-terminal-dim">
          {stats.durationMs && (
            <div>
              Duration:{" "}
              <span className="text-terminal-text">{formatDuration(stats.durationMs)}</span>
            </div>
          )}
          {stats.costEstimate !== undefined && (
            <div>
              Cost:{" "}
              <span className="text-terminal-green">
                $
                {stats.costEstimate < 0.01
                  ? stats.costEstimate.toFixed(4)
                  : stats.costEstimate.toFixed(2)}
              </span>
              <span className="text-terminal-dimmer"> (est.)</span>
            </div>
          )}
        </div>
      )}

      {/* Token Usage */}
      {stats.tokenUsage && (
        <div>
          <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
            Tokens
          </div>
          <div className="text-xs font-mono text-terminal-dim leading-relaxed space-y-0.5">
            <div>
              In: <span className="text-terminal-blue">{fmtNum(stats.tokenUsage.inputTokens)}</span>
              {" / "}
              Out:{" "}
              <span className="text-terminal-green">{fmtNum(stats.tokenUsage.outputTokens)}</span>
            </div>
            <div>
              Cache:{" "}
              <span className="text-terminal-purple">
                {fmtNum(stats.tokenUsage.cacheReadTokens)}
              </span>{" "}
              read
              {" / "}
              <span className="text-terminal-orange">
                {fmtNum(stats.tokenUsage.cacheCreationTokens)}
              </span>{" "}
              created
            </div>
          </div>
          <div className="text-xs font-mono text-terminal-dim mt-1">
            Chars: <span className="text-terminal-green">{fmtNum(stats.promptChars)}</span> prompt
            {" / "}
            <span className="text-terminal-purple">{fmtNum(stats.thinkingChars)}</span> thinking
            {" / "}
            <span className="text-terminal-blue">{fmtNum(stats.responseChars)}</span> response
          </div>
        </div>
      )}

      {/* Prompt Timeline */}
      {stats.prompts.length > 0 && (
        <div>
          <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
            Prompt Timeline
          </div>
          <div className="space-y-1.5">
            {stats.prompts.map((p) => (
              <div
                key={p.sceneIndex}
                className="flex items-start gap-2 text-xs font-mono py-1.5 px-2 rounded hover:bg-terminal-surface/50 transition-colors"
              >
                <span className="text-terminal-green shrink-0 w-6 text-right tabular-nums">
                  {String(p.index).padStart(2, "0")}
                </span>
                <span className="text-terminal-text flex-1 min-w-0 truncate">{p.text}</span>
                <span className="text-terminal-dim shrink-0 tabular-nums">
                  {p.toolCount} tool{p.toolCount !== 1 ? "s" : ""}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Files Changed */}
      {stats.filesList.length > 0 && (
        <div>
          <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
            Files Changed ({stats.filesModified})
          </div>
          <div className="space-y-0.5">
            {stats.filesList.map((file) => (
              <div
                key={file}
                className="text-xs font-mono text-terminal-text truncate px-2 py-1 hover:bg-terminal-surface/50 rounded transition-colors"
                title={file}
              >
                {file}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top Tools */}
      {stats.topTools.length > 0 && (
        <div>
          <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
            Top Tools
          </div>
          <div className="space-y-1.5">
            {stats.topTools.map(([name, count]) => (
              <div key={name} className="flex items-center gap-2 text-xs font-mono">
                <span className="text-terminal-text shrink-0 w-24 text-right truncate">{name}</span>
                <div className="flex-1 h-2 rounded-full bg-terminal-surface overflow-hidden">
                  <div
                    className="h-full rounded-full bg-terminal-orange"
                    style={{ width: `${(count / stats.topTools[0][1]) * 100}%` }}
                  />
                </div>
                <span className="text-terminal-dim shrink-0 w-6 text-right tabular-nums">
                  {count}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
