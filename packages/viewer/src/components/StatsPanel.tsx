import { useMemo } from "react";
import type { Scene, ReplaySession } from "../types";

interface Props {
  session: ReplaySession;
}

export default function StatsPanel({ session }: Props) {
  const stats = useMemo(() => {
    const { scenes, meta } = session;

    const toolCounts = new Map<string, number>();
    let thinkingChars = 0;
    let responseChars = 0;
    let promptChars = 0;
    let editCount = 0;
    let filesModified = new Set<string>();

    for (const scene of scenes) {
      switch (scene.type) {
        case "user-prompt":
          promptChars += scene.content.length;
          break;
        case "thinking":
          thinkingChars += scene.content.length;
          break;
        case "text-response":
          responseChars += scene.content.length;
          break;
        case "tool-call": {
          toolCounts.set(
            scene.toolName,
            (toolCounts.get(scene.toolName) || 0) + 1,
          );
          if (scene.diff) {
            editCount++;
            filesModified.add(scene.diff.filePath);
          }
          break;
        }
      }
    }

    const topTools = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    return {
      totalScenes: scenes.length,
      userPrompts: meta.stats.userPrompts,
      toolCalls: meta.stats.toolCalls,
      thinkingChars,
      responseChars,
      promptChars,
      editCount,
      filesModified: filesModified.size,
      topTools,
      durationMs: meta.stats.durationMs,
      tokenUsage: meta.stats.tokenUsage,
      costEstimate: meta.stats.costEstimate,
      compactions: meta.compactions,
    };
  }, [session]);

  const { meta } = session;

  return (
    <div className="p-3 space-y-4 text-xs font-mono">
      {/* Session info */}
      <div>
        <div className="text-terminal-dim uppercase tracking-wider text-[11px] font-semibold mb-1.5">
          Session
        </div>
        {meta.title && (
          <div className="text-terminal-text text-xs mb-0.5 truncate" title={meta.title}>{meta.title}</div>
        )}
        <div className="text-terminal-dim truncate" title={meta.cwd}>{meta.project}</div>
        <div className="text-terminal-dim mt-0.5 flex items-center gap-1.5 flex-wrap">
          {meta.model && <span className="text-terminal-text/60">{meta.model}</span>}
          {meta.provider && <span>{meta.provider}</span>}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <StatCard label="Turns" value={stats.userPrompts} color="text-terminal-green" />
        <StatCard label="Scenes" value={stats.totalScenes} color="text-terminal-text" />
        <StatCard label="Tool Calls" value={stats.toolCalls} color="text-terminal-orange" />
        <StatCard label="Files Modified" value={stats.filesModified} color="text-terminal-blue" />
      </div>

      {(stats.durationMs || stats.costEstimate !== undefined) && (
        <div className="text-terminal-dim space-y-0.5">
          {stats.durationMs && (
            <div>
              Duration: <span className="text-terminal-text">{formatDuration(stats.durationMs)}</span>
            </div>
          )}
          {stats.costEstimate !== undefined && (
            <div>
              Cost: <span className="text-terminal-green">${stats.costEstimate < 0.01 ? stats.costEstimate.toFixed(4) : stats.costEstimate.toFixed(2)}</span>
              <span className="text-terminal-dim/60"> (estimate)</span>
            </div>
          )}
        </div>
      )}

      {stats.tokenUsage && (
        <div>
          <div className="text-terminal-dim mb-1.5 text-[11px] font-semibold uppercase tracking-wider">Tokens</div>
          <div className="text-terminal-dim leading-relaxed space-y-0.5">
            <div>
              In: <span className="text-terminal-blue">{fmtNum(stats.tokenUsage.inputTokens)}</span>
              {" / "}
              Out: <span className="text-terminal-green">{fmtNum(stats.tokenUsage.outputTokens)}</span>
            </div>
            <div>
              Cache: <span className="text-terminal-purple">{fmtNum(stats.tokenUsage.cacheReadTokens)}</span> read
              {" / "}
              <span className="text-terminal-orange">{fmtNum(stats.tokenUsage.cacheCreationTokens)}</span> created
            </div>
          </div>
        </div>
      )}

      <div className="text-terminal-dim leading-relaxed">
        Chars: <span className="text-terminal-green">{fmtNum(stats.promptChars)}</span> prompt
        {" / "}
        <span className="text-terminal-purple">{fmtNum(stats.thinkingChars)}</span> thinking
        {" / "}
        <span className="text-terminal-blue">{fmtNum(stats.responseChars)}</span> response
      </div>

      {stats.compactions && stats.compactions.length > 0 && (
        <div>
          <div className="text-terminal-dim mb-1.5 text-[11px] font-semibold uppercase tracking-wider">
            Context Compactions ({stats.compactions.length})
          </div>
          <div className="space-y-1">
            {stats.compactions.map((c, i) => (
              <div key={i} className="text-terminal-dim text-[11px] flex items-baseline gap-1.5">
                <span className="text-terminal-orange">●</span>
                <span>{c.trigger}</span>
                {c.preTokens && (
                  <span className="text-terminal-text">{fmtNum(c.preTokens)} tokens</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {stats.topTools.length > 0 && (
        <div>
          <div className="text-terminal-dim mb-2 text-[11px] font-semibold uppercase tracking-wider">Top Tools</div>
          <div className="space-y-1.5">
            {stats.topTools.map(([name, count]) => (
              <div key={name} className="flex items-center gap-2">
                <span className="text-terminal-text shrink-0 w-20 text-right">{name}</span>
                <div className="flex-1 h-1.5 rounded-full bg-terminal-border/30 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-terminal-orange/60"
                    style={{ width: `${(count / stats.topTools[0][1]) * 100}%` }}
                  />
                </div>
                <span className="text-terminal-dim shrink-0 w-6 text-right tabular-nums">{count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className="bg-terminal-surface/80 rounded-md px-2.5 py-2 border border-terminal-border/40">
      <div className={`text-lg font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-terminal-dim text-[11px] uppercase tracking-wide">{label}</div>
    </div>
  );
}

function fmtNum(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "K";
  return n.toString();
}

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
