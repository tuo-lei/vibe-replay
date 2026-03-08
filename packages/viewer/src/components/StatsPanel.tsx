import { useMemo } from "react";
import type { ReplaySession } from "../types";

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
    const filesModified = new Set<string>();

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
          toolCounts.set(scene.toolName, (toolCounts.get(scene.toolName) || 0) + 1);
          if (scene.diff) {
            editCount++;
            filesModified.add(scene.diff.filePath);
          }
          break;
        }
      }
    }

    const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

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
    <div className="p-4 space-y-6 text-xs font-mono">
      {/* Session info */}
      <div>
        <div className="text-terminal-dimmer uppercase tracking-widest text-[10px] font-sans font-semibold mb-2">
          Session
        </div>
        {meta.title && (
          <div className="text-terminal-text text-xs mb-0.5 truncate" title={meta.title}>
            {meta.title}
          </div>
        )}
        <div className="text-terminal-dim truncate" title={meta.cwd}>
          {meta.project}
        </div>
        <div className="text-terminal-dim mt-0.5 flex items-center gap-1.5 flex-wrap">
          {meta.model && <span className="text-terminal-dim">{meta.model}</span>}
          {meta.provider && <span>{meta.provider}</span>}
        </div>
        {meta.generator?.version && (
          <div className="text-terminal-dim mt-0.5 truncate">
            replay:{" "}
            <span className="text-terminal-text">
              {meta.generator.name} v{meta.generator.version}
            </span>
          </div>
        )}
        {meta.generator?.generatedAt && (
          <div className="text-terminal-dim mt-0.5 truncate" title={meta.generator.generatedAt}>
            generated:{" "}
            <span className="text-terminal-text">
              {formatGeneratedAt(meta.generator.generatedAt)}
            </span>
          </div>
        )}
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
              <span className="text-terminal-dimmer"> (estimate)</span>
            </div>
          )}
        </div>
      )}

      {stats.tokenUsage && (
        <div>
          <div className="text-terminal-dimmer mb-2 text-[10px] font-sans font-semibold uppercase tracking-widest">
            Tokens
          </div>
          <div className="text-terminal-dim leading-relaxed space-y-0.5">
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
          <div className="text-terminal-dimmer mb-2 text-[10px] font-sans font-semibold uppercase tracking-widest">
            Context Compactions ({stats.compactions.length})
          </div>
          <div className="space-y-1">
            {stats.compactions.map((c, i) => (
              <div key={i} className="text-terminal-dim text-xs flex items-baseline gap-1.5">
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
          <div className="text-terminal-dimmer mb-2 text-[10px] font-sans font-semibold uppercase tracking-widest">
            Top Tools
          </div>
          <div className="space-y-1.5">
            {stats.topTools.map(([name, count]) => (
              <div key={name} className="flex items-center gap-2">
                <span className="text-terminal-text shrink-0 w-20 text-right">{name}</span>
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

      {(meta.dataSource || meta.dataSourceInfo) && (
        <div>
          <div className="text-terminal-dimmer mb-2 text-[10px] font-sans font-semibold uppercase tracking-widest">
            Data Source
          </div>
          <div className="text-terminal-dim">
            <span className="text-terminal-blue">
              {formatDataSourceLabel(meta.dataSourceInfo?.primary || meta.dataSource)}
            </span>
          </div>
          {meta.dataSourceInfo?.sources && meta.dataSourceInfo.sources.length > 0 && (
            <div className="mt-0.5 space-y-0.5">
              {meta.dataSourceInfo.sources.map((source) => (
                <div key={source} className="text-terminal-dim truncate" title={source}>
                  <span className="text-terminal-green">source:</span> {source}
                </div>
              ))}
            </div>
          )}
          {meta.dataSourceInfo?.supplements && meta.dataSourceInfo.supplements.length > 0 && (
            <div className="mt-0.5 space-y-0.5">
              {meta.dataSourceInfo.supplements.map((source) => (
                <div key={source} className="text-terminal-dim truncate" title={source}>
                  <span className="text-terminal-purple">supplement:</span> {source}
                </div>
              ))}
            </div>
          )}
          {meta.dataSourceInfo?.notes && meta.dataSourceInfo.notes.length > 0 && (
            <div className="mt-0.5 space-y-0.5">
              {meta.dataSourceInfo.notes.map((note) => (
                <div key={note} className="text-terminal-dim truncate" title={note}>
                  <span className="text-terminal-orange">note:</span> {note}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-terminal-surface rounded-xl px-3 py-3 shadow-layer-sm">
      <div className={`text-xl font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-terminal-dimmer text-[10px] font-sans font-medium uppercase tracking-widest mt-0.5">
        {label}
      </div>
    </div>
  );
}

function fmtNum(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
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

function formatDataSourceLabel(source?: string): string {
  if (!source) return "unknown";
  const labels: Record<string, string> = {
    sqlite: "SQLite (store.db)",
    "global-state": "SQLite (global state.vscdb)",
    jsonl: "JSONL transcript",
    "jsonl+tools": "JSONL + agent-tools",
  };
  return labels[source] || source;
}

function formatGeneratedAt(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
