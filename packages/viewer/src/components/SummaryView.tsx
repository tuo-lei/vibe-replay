import { useCallback, useMemo, useRef, useState } from "react";
import type { ReplaySession, TurnStat } from "../types";
import {
  DataQualityIndicator,
  getSessionDataQualityNotes,
  getSessionMetricQuality,
} from "./DataQualityIndicator";
import { fmtNum, formatDuration, StatCard } from "./StatsPanel";

interface Props {
  session: ReplaySession;
}

// --- Types ---

interface TurnInfo {
  index: number;
  text: string;
  sceneIndex: number;
  toolCount: number;
  errorCount: number;
}

interface FileInfo {
  path: string;
  editCount: number;
  readCount: number;
  linesAdded: number;
  linesRemoved: number;
  turnEdits: Map<number, number>; // turnIndex -> edit count in that turn
}

// --- Helpers ---

function classifyBash(command: string): string {
  const cmd = command.toLowerCase();
  if (/\b(test|jest|vitest|pytest|cargo\s+test|mocha|spec)\b/.test(cmd)) return "test";
  if (/\b(build|compile|tsc|webpack|vite\s+build|rollup)\b/.test(cmd)) return "build";
  if (cmd.trimStart().startsWith("git ")) return "git";
  if (/\b(lint|biome|eslint|prettier|format)\b/.test(cmd)) return "lint";
  return "other";
}

/** Hook for chart hover: tracks which turn index the mouse is over */
function useChartHover(turnCount: number) {
  const [hovered, setHovered] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);

  const onMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const svg = ref.current;
      if (!svg || turnCount <= 1) return;
      const rect = svg.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const idx = Math.round(x * (turnCount - 1));
      setHovered(Math.max(0, Math.min(turnCount - 1, idx)));
    },
    [turnCount],
  );

  const onMouseLeave = useCallback(() => setHovered(null), []);

  return { hovered, ref, onMouseMove, onMouseLeave };
}

// --- Main component ---

export default function SummaryView({ session }: Props) {
  const { meta, scenes } = session;
  const dataQualityNotes = useMemo(() => getSessionDataQualityNotes(meta), [meta]);
  const metricQuality = useMemo(() => getSessionMetricQuality(meta), [meta]);
  // File table merges edited + read-only into one component

  const stats = useMemo(() => {
    // --- Per-turn tracking ---
    const turns: TurnInfo[] = [];
    let curToolCount = 0;
    let curErrors = 0;

    // --- Per-file tracking ---
    const fileMap = new Map<string, FileInfo>();
    const getFile = (path: string): FileInfo => {
      let f = fileMap.get(path);
      if (!f) {
        f = {
          path,
          editCount: 0,
          readCount: 0,
          linesAdded: 0,
          linesRemoved: 0,
          turnEdits: new Map(),
        };
        fileMap.set(path, f);
      }
      return f;
    };

    // --- Aggregates ---
    const toolCounts = new Map<string, number>();
    const bashCategories = new Map<string, number>();
    let thinkingChars = 0;
    let responseChars = 0;
    let promptChars = 0;
    let totalBashErrors = 0;

    // Subagent tracking
    let totalDelegatedTools = 0;
    let totalDelegatedTokens = 0;
    const subAgents: Array<{
      agentType: string;
      description?: string;
      toolCalls: number;
      thinkingBlocks: number;
      textResponses: number;
      totalTokens: number;
      model?: string;
      sceneCount: number;
    }> = [];

    const closeTurn = () => {
      if (turns.length > 0) {
        const t = turns[turns.length - 1];
        t.toolCount = curToolCount;
        t.errorCount = curErrors;
      }
    };

    // --- Single pass ---
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      switch (scene.type) {
        case "user-prompt": {
          closeTurn();
          curToolCount = 0;
          curErrors = 0;
          promptChars += scene.content.length;
          const firstLine = scene.content.split("\n").find((l) => l.trim()) || "";
          turns.push({
            index: turns.length + 1,
            text: firstLine.slice(0, 120),
            sceneIndex: i,
            toolCount: 0,
            errorCount: 0,
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
          curToolCount++;
          const tn = scene.toolName;
          toolCounts.set(tn, (toolCounts.get(tn) || 0) + 1);

          if (tn === "Read") {
            const fp = scene.input?.file_path as string | undefined;
            if (fp) getFile(fp).readCount++;
          } else if (tn === "Edit" || tn === "Write") {
            if (scene.diff) {
              const f = getFile(scene.diff.filePath);
              f.editCount++;
              const turnIdx = turns.length; // current turn (1-indexed)
              f.turnEdits.set(turnIdx, (f.turnEdits.get(turnIdx) || 0) + 1);
              const oldL = scene.diff.oldContent ? scene.diff.oldContent.split("\n").length : 0;
              const newL = scene.diff.newContent ? scene.diff.newContent.split("\n").length : 0;
              f.linesAdded += Math.max(0, newL - oldL);
              f.linesRemoved += Math.max(0, oldL - newL);
            }
          } else if (tn === "Agent" && scene.subAgent) {
            const sa = scene.subAgent;
            const tu = sa.tokenUsage;
            const tokens = tu
              ? tu.inputTokens + tu.outputTokens + tu.cacheCreationTokens + tu.cacheReadTokens
              : 0;
            totalDelegatedTools += sa.toolCalls;
            totalDelegatedTokens += tokens;
            subAgents.push({
              agentType: sa.agentType,
              description: sa.description,
              toolCalls: sa.toolCalls,
              thinkingBlocks: sa.thinkingBlocks,
              textResponses: sa.textResponses,
              totalTokens: tokens,
              model: sa.model,
              sceneCount: sa.scenes.length,
            });
          } else if (tn === "Bash") {
            if (scene.bashOutput) {
              const cat = classifyBash(scene.bashOutput.command);
              bashCategories.set(cat, (bashCategories.get(cat) || 0) + 1);
            }
            // Use isError flag when available, fall back to text heuristic
            if (scene.isError) {
              curErrors++;
              totalBashErrors++;
            } else if (!("isError" in scene)) {
              const snippet = scene.result?.slice(0, 500).toLowerCase() || "";
              if (/\b(error|fail|exception|errno)\b/.test(snippet)) {
                curErrors++;
                totalBashErrors++;
              }
            }
          }
          break;
        }
      }
    }
    closeTurn();

    // --- Derived ---
    const files = [...fileMap.values()];
    const editedFiles = files
      .filter((f) => f.editCount > 0)
      .sort((a, b) => b.editCount - a.editCount);
    const readOnlyFiles = files
      .filter((f) => f.editCount === 0 && f.readCount > 0)
      .sort((a, b) => b.readCount - a.readCount);
    const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const bashCats = [...bashCategories.entries()].sort((a, b) => b[1] - a[1]);
    const totalTools = [...toolCounts.values()].reduce((a, b) => a + b, 0);

    const readCount =
      (toolCounts.get("Read") || 0) + (toolCounts.get("Grep") || 0) + (toolCounts.get("Glob") || 0);
    const writeCount = (toolCounts.get("Edit") || 0) + (toolCounts.get("Write") || 0);
    const execCount = toolCounts.get("Bash") || 0;
    const activityDist = {
      read: readCount,
      write: writeCount,
      execute: execCount,
      other: totalTools - readCount - writeCount - execCount,
    };

    return {
      totalScenes: scenes.length,
      userPrompts: meta.stats.userPrompts,
      toolCalls: meta.stats.toolCalls,
      thinkingChars,
      responseChars,
      promptChars,
      durationMs: meta.stats.durationMs,
      tokenUsage: meta.stats.tokenUsage,
      costEstimate: meta.stats.costEstimate,
      turns,
      editedFiles,
      readOnlyFiles,
      topTools,
      bashCats,
      activityDist,
      totalTools,
      totalBashErrors,
      subAgents,
      totalDelegatedTools,
      totalDelegatedTokens,
    };
  }, [scenes, meta]);

  const hasTurnStats = meta.stats.turnStats && meta.stats.turnStats.length > 1;
  // Build turn labels (user prompt snippets) for chart tooltips
  const turnLabels = useMemo(
    () => stats.turns.map((t) => t.text.slice(0, 60) + (t.text.length > 60 ? "…" : "")),
    [stats.turns],
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 space-y-6 max-w-4xl mx-auto">
        {/* Session context */}
        <div className="flex items-center gap-2.5">
          <h2 className="text-sm font-mono font-semibold text-terminal-text truncate">
            {meta.title || meta.slug}
          </h2>
          {meta.provider && (
            <span className="shrink-0 text-[10px] font-mono text-terminal-dimmer px-1.5 py-0.5 rounded bg-terminal-surface border border-terminal-border-subtle">
              {meta.provider}
            </span>
          )}
          {dataQualityNotes.length > 0 && (
            <DataQualityIndicator title={dataQualityNotes.join("\n")} className="shrink-0" />
          )}
          {meta.gitBranch && (
            <span
              className="shrink-0 text-[10px] font-mono text-terminal-purple px-1.5 py-0.5 rounded bg-terminal-purple/10 border border-terminal-purple/20"
              title={meta.gitBranches ? meta.gitBranches.join(" → ") : undefined}
            >
              {meta.gitBranches && meta.gitBranches.length > 1
                ? `${meta.gitBranches[0]} → ${meta.gitBranch}`
                : meta.gitBranch}
            </span>
          )}
          {meta.permissionMode === "bypassPermissions" && (
            <span className="shrink-0 text-[10px] font-mono text-terminal-orange px-1.5 py-0.5 rounded bg-terminal-orange/10 border border-terminal-orange/20">
              dangerous mode
            </span>
          )}
        </div>

        {dataQualityNotes.length > 0 && (
          <div className="rounded border border-terminal-orange/40 bg-terminal-orange/10 px-3 py-2">
            <div className="text-[10px] font-sans font-semibold text-terminal-orange uppercase tracking-widest mb-1">
              Data Quality
            </div>
            <div className="space-y-0.5">
              {dataQualityNotes.slice(0, 4).map((note) => (
                <div key={note} className="text-xs font-mono text-terminal-dim">
                  {note}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Overview: Key Metrics + Duration/Cost + Tokens */}
        <div>
          <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-3">
            Overview
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Turns" value={stats.userPrompts} color="text-terminal-green" />
            <StatCard label="Tool Calls" value={stats.toolCalls} color="text-terminal-orange" />
            <StatCard
              label="Files Modified"
              value={stats.editedFiles.length}
              color="text-terminal-blue"
            />
            <StatCard label="Scenes" value={stats.totalScenes} color="text-terminal-text" />
          </div>
          {/* Delegated work callout */}
          {stats.totalDelegatedTools > 0 && (
            <div className="mt-3 flex items-center gap-2 text-xs font-mono text-terminal-dim bg-green-500/5 border border-green-500/15 rounded-lg px-3 py-2">
              <span className="text-green-300">+{stats.totalDelegatedTools} tools delegated</span>
              <span className="text-terminal-dimmer">
                to {stats.subAgents.length} sub-agent{stats.subAgents.length > 1 ? "s" : ""}
              </span>
              {stats.totalDelegatedTokens > 0 && (
                <span className="text-terminal-dimmer">
                  (
                  {stats.totalDelegatedTokens > 1000000
                    ? `${(stats.totalDelegatedTokens / 1000000).toFixed(1)}M`
                    : `${(stats.totalDelegatedTokens / 1000).toFixed(0)}K`}{" "}
                  tokens, context-free)
                </span>
              )}
            </div>
          )}
          {/* Duration / Cost / Model — inline below cards */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs font-mono text-terminal-dim">
            {meta.model && (
              <div>
                Model: <span className="text-terminal-text font-semibold">{meta.model}</span>
              </div>
            )}
            {(stats.durationMs || metricQuality.duration) && (
              <div>
                Duration:{" "}
                <span className="text-terminal-text">
                  {stats.durationMs ? formatDuration(stats.durationMs) : "unavailable"}
                </span>
                {metricQuality.duration && (
                  <DataQualityIndicator title={metricQuality.duration} className="ml-1" />
                )}
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
                {metricQuality.tokens && (
                  <DataQualityIndicator title={metricQuality.tokens} className="ml-1" />
                )}
              </div>
            )}
            {stats.tokenUsage ? (
              <>
                <div>
                  In:{" "}
                  <span className="text-terminal-blue">{fmtNum(stats.tokenUsage.inputTokens)}</span>
                  {" / "}Out:{" "}
                  <span className="text-terminal-green">
                    {fmtNum(stats.tokenUsage.outputTokens)}
                  </span>
                </div>
                <div>
                  Cache:{" "}
                  <span className="text-terminal-purple">
                    {fmtNum(stats.tokenUsage.cacheReadTokens)}
                  </span>{" "}
                  read /{" "}
                  <span className="text-terminal-orange">
                    {fmtNum(stats.tokenUsage.cacheCreationTokens)}
                  </span>{" "}
                  created
                </div>
              </>
            ) : (
              metricQuality.tokens && (
                <div>
                  Tokens: <span className="text-terminal-text">unavailable</span>
                  <DataQualityIndicator title={metricQuality.tokens} className="ml-1" />
                </div>
              )
            )}
            {!hasTurnStats && metricQuality.turnStats && (
              <div>
                Turn Stats: <span className="text-terminal-text">limited</span>
                <DataQualityIndicator title={metricQuality.turnStats} className="ml-1" />
              </div>
            )}
          </div>
        </div>

        {/* === Time Series Charts (grouped) === */}
        {hasTurnStats && (
          <div className="space-y-5">
            <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest">
              Per-Turn Metrics
            </div>
            <TokenBurnCurve
              turnStats={meta.stats.turnStats!}
              costEstimate={meta.stats.costEstimate}
              turnLabels={turnLabels}
            />
            <ContextWindowChart turnStats={meta.stats.turnStats!} turnLabels={turnLabels} />
            {stats.turns.length >= 2 && (
              <ToolActivityChart turns={stats.turns} turnLabels={turnLabels} />
            )}
            {meta.stats.turnStats!.some((t) => t.durationMs) && (
              <TurnDurationChart turnStats={meta.stats.turnStats!} turnLabels={turnLabels} />
            )}
          </div>
        )}

        {/* Per-Model Token Breakdown */}
        {meta.tokenUsageByModel && Object.keys(meta.tokenUsageByModel).length > 1 && (
          <ModelBreakdown tokenUsageByModel={meta.tokenUsageByModel} />
        )}

        {/* API Errors */}
        {meta.apiErrors && meta.apiErrors.length > 0 && (
          <div>
            <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
              API Issues
            </div>
            <div className="text-xs font-mono text-terminal-dim space-y-1">
              {(() => {
                const errs = meta.apiErrors;
                const maxRetry = Math.max(0, ...errs.map((e) => e.retryAttempt || 0));
                const hasOverloaded = errs.some(
                  (e) => e.errorType === "overloaded_error" || e.statusCode === 529,
                );
                const hasRateLimit = errs.some(
                  (e) => e.errorType === "rate_limit_error" || e.statusCode === 429,
                );
                const parts: string[] = [];
                if (hasOverloaded) parts.push("API was overloaded");
                if (hasRateLimit) parts.push("hit rate limits");
                if (parts.length === 0) parts.push("API errors occurred");
                return (
                  <>
                    <div className="text-terminal-text">
                      {parts.join(" and ")}{" "}
                      <span className="text-terminal-red">{errs.length} times</span> during this
                      session
                      {maxRetry > 1 && (
                        <>
                          , with up to{" "}
                          <span className="text-terminal-orange">{maxRetry} retries</span> in a row
                        </>
                      )}
                      .
                    </div>
                    <div className="text-terminal-dimmer">
                      All errors were automatically retried and resolved.
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* Tracked Files */}
        {meta.trackedFiles && meta.trackedFiles.length > 0 && (
          <div>
            <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
              Files Tracked ({meta.trackedFiles.length})
            </div>
            <div className="space-y-0.5 max-h-[200px] overflow-y-auto">
              {meta.trackedFiles.map((f) => (
                <div
                  key={f}
                  className="text-[10px] font-mono text-terminal-dim truncate px-2 py-0.5 rounded hover:bg-terminal-surface-hover"
                  title={f}
                >
                  {f}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* PR Links */}
        {meta.prLinks && meta.prLinks.length > 0 && (
          <div>
            <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
              Pull Requests
            </div>
            <div className="space-y-1">
              {meta.prLinks.map((pr) => (
                <a
                  key={pr.prUrl}
                  href={pr.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 text-xs font-mono text-terminal-blue hover:underline px-2 py-1 rounded hover:bg-terminal-surface-hover transition-colors"
                >
                  <span className="text-terminal-green">#{pr.prNumber}</span>
                  {pr.prRepository && (
                    <span className="text-terminal-dimmer truncate">{pr.prRepository}</span>
                  )}
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Per-Turn Breakdown Table */}
        {stats.turns.length > 0 && (
          <TurnTable turns={stats.turns} turnStats={meta.stats.turnStats} />
        )}

        {/* File Activity Heatmap */}
        <FileActivityHeatmap editedFiles={stats.editedFiles} turns={stats.turns} />

        {/* File Impact Table */}
        {(stats.editedFiles.length > 0 || stats.readOnlyFiles.length > 0) && (
          <FileTable editedFiles={stats.editedFiles} readOnlyFiles={stats.readOnlyFiles} />
        )}

        {/* Bash Breakdown */}
        {stats.bashCats.length > 1 && (
          <div>
            <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
              Bash Commands
              {stats.totalBashErrors > 0 && (
                <span className="text-terminal-red ml-2 normal-case tracking-normal">
                  {stats.totalBashErrors} error{stats.totalBashErrors !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {stats.bashCats.map(([cat, count]) => (
                <span
                  key={cat}
                  className="text-xs font-mono text-terminal-dim bg-terminal-surface rounded px-2 py-1"
                >
                  {cat} <span className="text-terminal-text tabular-nums">{count}</span>
                </span>
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
                  <span
                    className="text-terminal-text shrink-0 w-24 text-right truncate"
                    title={name}
                  >
                    {name}
                  </span>
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

        {/* Sub-Agent Summary */}
        {stats.subAgents.length > 0 && <SubAgentSummary subAgents={stats.subAgents} />}

        {/* Activity Distribution (heuristic — placed low as reference) */}
        {stats.totalTools > 0 && (
          <div>
            <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
              Activity Distribution
            </div>
            <div className="space-y-1.5">
              {(
                [
                  ["Read/Search", stats.activityDist.read, "--blue"],
                  ["Write/Edit", stats.activityDist.write, "--green"],
                  ["Execute", stats.activityDist.execute, "--purple"],
                  ["Other", stats.activityDist.other, "--dim"],
                ] as [string, number, string][]
              )
                .filter(([, count]) => count > 0)
                .map(([label, count, cssVar]) => (
                  <div key={label} className="flex items-center gap-2 text-xs font-mono">
                    <span className="text-terminal-text shrink-0 w-24 text-right">{label}</span>
                    <div className="flex-1 h-2 rounded-full bg-terminal-surface overflow-hidden">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${(count / stats.totalTools) * 100}%`,
                          backgroundColor: `var(${cssVar})`,
                        }}
                      />
                    </div>
                    <span className="text-terminal-dim shrink-0 w-16 text-right tabular-nums">
                      {count} ({Math.round((count / stats.totalTools) * 100)}%)
                    </span>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Sub-Agent Summary ---

const AGENT_TYPE_COLORS: Record<string, string> = {
  Explore: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  Plan: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  Shell: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  "general-purpose": "bg-green-500/20 text-green-300 border-green-500/30",
  "claude-code-guide": "bg-amber-500/20 text-amber-300 border-amber-500/30",
};

function SubAgentSummary({
  subAgents,
}: {
  subAgents: Array<{
    agentType: string;
    description?: string;
    toolCalls: number;
    thinkingBlocks: number;
    textResponses: number;
    totalTokens: number;
    model?: string;
    sceneCount: number;
  }>;
}) {
  // Aggregate by type
  const byType = new Map<string, { count: number; toolCalls: number; totalTokens: number }>();
  let totalDelegatedTools = 0;
  let totalDelegatedTokens = 0;
  for (const sa of subAgents) {
    const existing = byType.get(sa.agentType) || { count: 0, toolCalls: 0, totalTokens: 0 };
    existing.count++;
    existing.toolCalls += sa.toolCalls;
    existing.totalTokens += sa.totalTokens;
    byType.set(sa.agentType, existing);
    totalDelegatedTools += sa.toolCalls;
    totalDelegatedTokens += sa.totalTokens;
  }
  const types = [...byType.entries()].sort((a, b) => b[1].count - a[1].count);

  return (
    <div>
      <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
        Sub-Agents ({subAgents.length})
      </div>
      {/* Type breakdown */}
      <div className="flex flex-wrap gap-2 mb-3">
        {types.map(([type, data]) => {
          const colors =
            AGENT_TYPE_COLORS[type] || "bg-gray-500/20 text-gray-300 border-gray-500/30";
          return (
            <span key={type} className={`text-[11px] px-2 py-1 rounded border font-mono ${colors}`}>
              {type}{" "}
              <span className="opacity-70">
                x{data.count} ({data.toolCalls} tools)
              </span>
            </span>
          );
        })}
      </div>
      {/* Aggregate stats */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono text-terminal-dim">
        <div>
          Delegated tools: <span className="text-terminal-text">{totalDelegatedTools}</span>
        </div>
        {totalDelegatedTokens > 0 && (
          <div>
            Delegated tokens:{" "}
            <span className="text-terminal-text">
              {totalDelegatedTokens > 1000000
                ? `${(totalDelegatedTokens / 1000000).toFixed(1)}M`
                : totalDelegatedTokens > 1000
                  ? `${(totalDelegatedTokens / 1000).toFixed(0)}K`
                  : totalDelegatedTokens}
            </span>
            <span className="text-terminal-dimmer"> (context-free)</span>
          </div>
        )}
      </div>
      {/* Individual agents */}
      <div className="mt-2 space-y-1">
        {subAgents.slice(0, 20).map((sa, i) => (
          <div
            key={i}
            className="flex items-center gap-2 text-[10px] font-mono text-terminal-dim px-2 py-1 rounded bg-terminal-surface"
          >
            <span
              className={`px-1 py-0.5 rounded border text-[9px] ${AGENT_TYPE_COLORS[sa.agentType] || "bg-gray-500/20 text-gray-300 border-gray-500/30"}`}
            >
              {sa.agentType}
            </span>
            <span className="truncate flex-1 text-terminal-text/70">
              {sa.description || "(no description)"}
            </span>
            <span className="shrink-0">{sa.toolCalls} tools</span>
            {sa.totalTokens > 0 && (
              <span className="shrink-0 text-terminal-dimmer">
                {sa.totalTokens > 1000 ? `${(sa.totalTokens / 1000).toFixed(0)}K` : sa.totalTokens}{" "}
                tok
              </span>
            )}
          </div>
        ))}
        {subAgents.length > 20 && (
          <div className="text-[10px] text-terminal-dimmer font-mono px-2">
            ... and {subAgents.length - 20} more
          </div>
        )}
      </div>
    </div>
  );
}

// --- Chart tooltip ---

function ChartTooltip({
  children,
  visible,
  x,
}: {
  children: React.ReactNode;
  visible: boolean;
  x: number; // 0-1 normalized position
}) {
  if (!visible) return null;
  // Flip tooltip to left side when near right edge
  const alignRight = x > 0.7;
  return (
    <div
      className="absolute top-1 pointer-events-none z-10"
      style={{
        left: alignRight ? undefined : `${x * 100}%`,
        right: alignRight ? `${(1 - x) * 100}%` : undefined,
      }}
    >
      <div
        className={`bg-terminal-surface border border-terminal-border-subtle rounded px-2 py-1 text-[10px] font-mono text-terminal-text shadow-md whitespace-nowrap ${alignRight ? "text-right" : ""}`}
      >
        {children}
      </div>
    </div>
  );
}

// --- Sub-components ---

function TokenBurnCurve({
  turnStats,
  costEstimate,
  turnLabels,
}: {
  turnStats: TurnStat[];
  costEstimate?: number;
  turnLabels?: string[];
}) {
  const cumulative: number[] = [];
  let sum = 0;
  for (const ts of turnStats) {
    sum += ts.tokenUsage?.outputTokens || 0;
    cumulative.push(sum);
  }
  const n = cumulative.length;
  const { hovered, ref, onMouseMove, onMouseLeave } = useChartHover(n);

  if (sum === 0) return null;

  const max = cumulative[cumulative.length - 1];
  const h = 60;
  const w = 100;

  const points = cumulative.map((v, i) => {
    const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
    const y = h - (v / max) * (h - 6) - 3;
    return `${x},${y}`;
  });

  const hoveredX = hovered !== null ? (n === 1 ? 0.5 : hovered / (n - 1)) : 0;

  return (
    <div>
      <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-1">
        Token Burn{costEstimate ? " & Cost" : ""}
      </div>
      <div className="relative">
        <svg
          ref={ref}
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          className="w-full h-20"
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
        >
          <polygon
            points={`0,${h} ${points.join(" ")} ${w},${h}`}
            style={{ fill: "var(--green-subtle)" }}
          />
          <polyline
            points={points.join(" ")}
            fill="none"
            style={{ stroke: "var(--green)" }}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* Hover crosshair */}
          {hovered !== null && (
            <line
              x1={hoveredX * w}
              y1="0"
              x2={hoveredX * w}
              y2={h}
              stroke="var(--dim)"
              strokeWidth="0.5"
              vectorEffect="non-scaling-stroke"
              opacity="0.5"
            />
          )}
        </svg>
        <ChartTooltip visible={hovered !== null} x={hoveredX}>
          {hovered !== null && (
            <>
              <div className="text-terminal-green">Turn {hovered + 1}</div>
              {turnLabels?.[hovered] && (
                <div className="text-terminal-dim truncate max-w-[200px]">
                  {turnLabels[hovered]}
                </div>
              )}
              <div>cumulative: {fmtNum(cumulative[hovered])} tokens</div>
              {turnStats[hovered]?.tokenUsage && (
                <div className="text-terminal-dimmer">
                  this turn: +{fmtNum(turnStats[hovered].tokenUsage!.outputTokens)} out
                </div>
              )}
            </>
          )}
        </ChartTooltip>
      </div>
      <div className="flex justify-between text-[10px] font-mono text-terminal-dimmer mt-0.5">
        <span>Turn 1</span>
        <span>
          {fmtNum(max)} tokens
          {costEstimate
            ? ` ($${costEstimate < 1 ? costEstimate.toFixed(2) : costEstimate.toFixed(0)})`
            : ""}
        </span>
        <span>Turn {n}</span>
      </div>
      {/* Cache efficiency sparkline */}
      {turnStats.some((t) => t.tokenUsage?.cacheReadTokens) && (
        <CacheEfficiencyLine turnStats={turnStats} />
      )}
    </div>
  );
}

function CacheEfficiencyLine({ turnStats }: { turnStats: TurnStat[] }) {
  const ratios = turnStats.map((ts) => {
    const u = ts.tokenUsage;
    if (!u) return 0;
    const total = (u.cacheReadTokens || 0) + (u.inputTokens || 0);
    return total > 0 ? u.cacheReadTokens / total : 0;
  });

  const h = 24;
  const w = 100;
  const points = ratios.map((v, i) => {
    const x = ratios.length === 1 ? w / 2 : (i / (ratios.length - 1)) * w;
    const y = h - v * (h - 4) - 2;
    return `${x},${y}`;
  });

  const avgRatio = ratios.reduce((a, b) => a + b, 0) / ratios.length;

  return (
    <div className="mt-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest">
          Cache Hit Rate
        </span>
        <span className="text-[10px] font-mono text-terminal-purple">
          avg {Math.round(avgRatio * 100)}%
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-6">
        <polyline
          points={points.join(" ")}
          fill="none"
          style={{ stroke: "var(--purple)" }}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </div>
  );
}

function ContextWindowChart({
  turnStats,
  turnLabels,
}: {
  turnStats: TurnStat[];
  turnLabels?: string[];
}) {
  const contextSizes = turnStats.map((t) => t.contextTokens || 0);
  const n = contextSizes.length;
  const { hovered, ref, onMouseMove, onMouseLeave } = useChartHover(n);

  if (!contextSizes.some((c) => c > 0)) return null;

  const peak = Math.max(...contextSizes);
  const max = peak;
  const h = 60;
  const w = 100;

  const points = contextSizes.map((v, i) => {
    const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
    const y = h - (v / max) * (h - 6) - 3;
    return `${x},${y}`;
  });

  // Detect compaction points
  const compactionTurns: number[] = [];
  for (let i = 0; i < contextSizes.length - 1; i++) {
    const cur = contextSizes[i];
    const next = contextSizes[i + 1];
    if (cur > 0 && next > 0 && next < cur * 0.5) {
      compactionTurns.push(i);
    }
  }

  const hoveredX = hovered !== null ? (n === 1 ? 0.5 : hovered / (n - 1)) : 0;

  return (
    <div>
      <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-1">
        Context Window Usage
      </div>
      <div className="relative">
        <svg
          ref={ref}
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          className="w-full h-20"
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
        >
          <polygon
            points={`0,${h} ${points.join(" ")} ${w},${h}`}
            style={{ fill: "var(--cyan-subtle)" }}
          />
          <polyline
            points={points.join(" ")}
            fill="none"
            style={{ stroke: "var(--cyan)" }}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* Compaction markers */}
          {compactionTurns.map((ti) => {
            const x = n === 1 ? w / 2 : (ti / (n - 1)) * w;
            return (
              <line
                key={ti}
                x1={x}
                y1="0"
                x2={x}
                y2={h}
                style={{ stroke: "var(--red)" }}
                strokeWidth="1"
                strokeDasharray="2,1"
                vectorEffect="non-scaling-stroke"
                opacity="0.6"
              />
            );
          })}
          {/* Hover crosshair */}
          {hovered !== null && (
            <line
              x1={hoveredX * w}
              y1="0"
              x2={hoveredX * w}
              y2={h}
              stroke="var(--dim)"
              strokeWidth="0.5"
              vectorEffect="non-scaling-stroke"
              opacity="0.5"
            />
          )}
        </svg>
        <ChartTooltip visible={hovered !== null} x={hoveredX}>
          {hovered !== null && (
            <>
              <div className="text-terminal-cyan">Turn {hovered + 1}</div>
              {turnLabels?.[hovered] && (
                <div className="text-terminal-dim truncate max-w-[200px]">
                  {turnLabels[hovered]}
                </div>
              )}
              <div>{fmtNum(contextSizes[hovered])} tokens</div>
            </>
          )}
        </ChartTooltip>
      </div>
      <div className="flex justify-between text-[10px] font-mono text-terminal-dimmer mt-0.5">
        <span>Turn 1</span>
        <span>peak {fmtNum(peak)}</span>
        <span>Turn {n}</span>
      </div>
      {compactionTurns.length > 0 && (
        <div className="flex items-center gap-2 mt-1">
          <span
            className="inline-block w-3 border-t border-dashed"
            style={{ borderColor: "var(--red)" }}
          />
          <span className="text-[10px] font-mono text-terminal-dimmer">
            {compactionTurns.length} compaction{compactionTurns.length !== 1 ? "s" : ""}
          </span>
        </div>
      )}
    </div>
  );
}

function TurnDurationChart({
  turnStats,
  turnLabels,
}: {
  turnStats: TurnStat[];
  turnLabels?: string[];
}) {
  const durations = turnStats.map((t) => t.durationMs || 0);
  const max = Math.max(...durations, 1);
  const hasDurations = durations.some((d) => d > 0);
  const [hovered, setHovered] = useState<number | null>(null);

  if (!hasDurations) return null;

  return (
    <div>
      <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-1">
        Turn Duration
      </div>
      <div className="relative">
        <div className="flex items-end gap-px h-16" onMouseLeave={() => setHovered(null)}>
          {durations.map((d, i) => {
            const hPct = d > 0 ? Math.max((d / max) * 100, 4) : 0;
            return (
              <div
                key={i}
                className="flex-1 rounded-t-sm cursor-default"
                style={{
                  height: `${hPct}%`,
                  backgroundColor: d > 0 ? "var(--blue)" : "var(--surface)",
                  opacity: hovered === i ? 1 : d > 0 ? 0.5 + (d / max) * 0.5 : 0.2,
                }}
                onMouseEnter={() => setHovered(i)}
              />
            );
          })}
        </div>
        <ChartTooltip
          visible={hovered !== null}
          x={
            hovered !== null ? (durations.length === 1 ? 0.5 : hovered / (durations.length - 1)) : 0
          }
        >
          {hovered !== null && (
            <>
              <div className="text-terminal-blue">Turn {hovered + 1}</div>
              {turnLabels?.[hovered] && (
                <div className="text-terminal-dim truncate max-w-[200px]">
                  {turnLabels[hovered]}
                </div>
              )}
              <div>{durations[hovered] > 0 ? formatDuration(durations[hovered]) : "no data"}</div>
            </>
          )}
        </ChartTooltip>
      </div>
      <div className="flex justify-between text-[10px] font-mono text-terminal-dimmer mt-0.5">
        <span>Turn 1</span>
        <span>max {formatDuration(max)}</span>
        <span>Turn {durations.length}</span>
      </div>
    </div>
  );
}

function ModelBreakdown({
  tokenUsageByModel,
}: {
  tokenUsageByModel: Record<string, { inputTokens: number; outputTokens: number }>;
}) {
  const entries = Object.entries(tokenUsageByModel).sort(
    (a, b) => b[1].outputTokens - a[1].outputTokens,
  );
  const totalOutput = entries.reduce((a, [, v]) => a + v.outputTokens, 0);
  if (totalOutput === 0) return null;

  const colors = ["--green", "--blue", "--purple", "--orange", "--red"];

  return (
    <div>
      <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
        Model Breakdown
      </div>
      {/* Stacked bar */}
      <div className="flex h-3 rounded-full overflow-hidden gap-px">
        {entries.map(([model, usage], i) => {
          const pct = (usage.outputTokens / totalOutput) * 100;
          return (
            <div
              key={model}
              style={{
                width: `${pct}%`,
                minWidth: pct > 2 ? undefined : "3px",
                backgroundColor: `var(${colors[i % colors.length]})`,
                opacity: 0.7,
              }}
              title={`${model}: ${fmtNum(usage.outputTokens)} output tokens`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-3 mt-1.5">
        {entries.map(([model, usage], i) => (
          <div
            key={model}
            className="flex items-center gap-1 text-[10px] font-mono text-terminal-dimmer"
          >
            <div
              className="w-2 h-2 rounded-sm"
              style={{ backgroundColor: `var(${colors[i % colors.length]})`, opacity: 0.7 }}
            />
            <span>
              {model} {fmtNum(usage.outputTokens)} (
              {Math.round((usage.outputTokens / totalOutput) * 100)}
              %)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolActivityChart({ turns, turnLabels }: { turns: TurnInfo[]; turnLabels?: string[] }) {
  const counts = turns.map((t) => t.toolCount);
  const max = Math.max(...counts, 1);
  const [hovered, setHovered] = useState<number | null>(null);

  if (turns.length < 2) return null;

  return (
    <div>
      <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-1">
        Tool Calls per Turn
      </div>
      <div className="relative">
        <div className="flex items-end gap-px h-16" onMouseLeave={() => setHovered(null)}>
          {counts.map((c, i) => {
            const hPct = c > 0 ? Math.max((c / max) * 100, 4) : 0;
            return (
              <div
                key={i}
                className="flex-1 rounded-t-sm cursor-default"
                style={{
                  height: `${hPct}%`,
                  backgroundColor: c > 0 ? "var(--orange)" : "var(--surface)",
                  opacity: hovered === i ? 1 : c > 0 ? 0.5 + (c / max) * 0.5 : 0.2,
                }}
                onMouseEnter={() => setHovered(i)}
              />
            );
          })}
        </div>
        <ChartTooltip
          visible={hovered !== null}
          x={hovered !== null ? (counts.length === 1 ? 0.5 : hovered / (counts.length - 1)) : 0}
        >
          {hovered !== null && (
            <>
              <div className="text-terminal-orange">Turn {hovered + 1}</div>
              {turnLabels?.[hovered] && (
                <div className="text-terminal-dim truncate max-w-[200px]">
                  {turnLabels[hovered]}
                </div>
              )}
              <div>{counts[hovered]} tool calls</div>
            </>
          )}
        </ChartTooltip>
      </div>
      <div className="flex justify-between text-[10px] font-mono text-terminal-dimmer mt-0.5">
        <span>Turn 1</span>
        <span>max {max}</span>
        <span>Turn {counts.length}</span>
      </div>
    </div>
  );
}

function FileActivityHeatmap({
  editedFiles,
  turns,
}: {
  editedFiles: FileInfo[];
  turns: TurnInfo[];
}) {
  if (turns.length < 3 || editedFiles.length < 1) return null;

  const topFiles = editedFiles.slice(0, 8);

  // Cap columns to keep the grid readable
  const MAX_COLS = 60;
  const allTurnIndices = turns.map((t) => t.index);
  const capped = allTurnIndices.length > MAX_COLS;
  const turnIndices = capped ? allTurnIndices.slice(-MAX_COLS) : allTurnIndices;

  // Find max edits per cell for intensity scaling
  let maxEditsPerCell = 1;
  for (const f of topFiles) {
    for (const ti of turnIndices) {
      const c = f.turnEdits.get(ti) || 0;
      if (c > maxEditsPerCell) maxEditsPerCell = c;
    }
  }

  return (
    <div>
      <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
        File Activity Heatmap
        {capped && (
          <span className="normal-case tracking-normal font-normal ml-2">
            (last {MAX_COLS} of {allTurnIndices.length} turns)
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <div
          className="grid gap-px text-[10px] font-mono"
          style={{
            gridTemplateColumns: `minmax(80px, 120px) repeat(${turnIndices.length}, minmax(16px, 1fr))`,
          }}
        >
          {/* Header row */}
          <div className="text-terminal-dimmer px-1 py-0.5" />
          {turnIndices.map((ti) => (
            <div key={ti} className="text-terminal-dimmer text-center py-0.5 text-[9px]">
              {ti}
            </div>
          ))}
          {/* File rows */}
          {topFiles.map((f) => {
            const basename = f.path.split("/").pop() || f.path;
            return [
              <div
                key={`label-${f.path}`}
                className="text-terminal-dim truncate px-1 py-0.5"
                title={f.path}
              >
                {basename}
              </div>,
              ...turnIndices.map((ti) => {
                const count = f.turnEdits.get(ti) || 0;
                const intensity =
                  count === 0
                    ? 0
                    : Math.round(20 + (Math.log1p(count) / Math.log1p(maxEditsPerCell)) * 60);
                return (
                  <div
                    key={`${f.path}-${ti}`}
                    className="rounded-sm"
                    style={{
                      backgroundColor:
                        count === 0
                          ? "transparent"
                          : `color-mix(in srgb, var(--orange) ${intensity}%, transparent)`,
                      minHeight: 14,
                    }}
                    title={
                      count > 0
                        ? `${basename} — Turn ${ti}: ${count} edit${count !== 1 ? "s" : ""}`
                        : undefined
                    }
                  />
                );
              }),
            ];
          })}
        </div>
      </div>
    </div>
  );
}

const TURN_TABLE_COLLAPSE = 20;

function TurnTable({ turns, turnStats }: { turns: TurnInfo[]; turnStats?: TurnStat[] }) {
  const [expanded, setExpanded] = useState(false);

  // Merge turn info with turnStats by index
  const { rows, compactionAfter } = useMemo(() => {
    const maxTools = Math.max(...turns.map((t) => t.toolCount), 1);
    const maxDuration = Math.max(...(turnStats?.map((t) => t.durationMs || 0) || [0]), 1);
    const maxContext = Math.max(...(turnStats?.map((t) => t.contextTokens || 0) || [0]), 1);
    const maxOutput = Math.max(
      ...(turnStats?.map((t) => t.tokenUsage?.outputTokens || 0) || [0]),
      1,
    );

    // Detect compaction: context drops > 50% between consecutive turns
    const compSet = new Set<number>();
    if (turnStats) {
      for (let i = 0; i < turnStats.length - 1; i++) {
        const cur = turnStats[i]?.contextTokens || 0;
        const next = turnStats[i + 1]?.contextTokens || 0;
        if (cur > 0 && next > 0 && next < cur * 0.5) {
          compSet.add(i); // compaction happened after turn i
        }
      }
    }

    const mapped = turns.map((t, i) => {
      const ts = turnStats?.[i];
      return {
        ...t,
        durationMs: ts?.durationMs,
        contextTokens: ts?.contextTokens,
        outputTokens: ts?.tokenUsage?.outputTokens,
        toolRatio: t.toolCount / maxTools,
        durationRatio: (ts?.durationMs || 0) / maxDuration,
        contextRatio: (ts?.contextTokens || 0) / maxContext,
        outputRatio: (ts?.tokenUsage?.outputTokens || 0) / maxOutput,
      };
    });

    return { rows: mapped, compactionAfter: compSet };
  }, [turns, turnStats]);

  const hasStats = turnStats && turnStats.length > 0;
  const hasDuration = hasStats && turnStats.some((t) => t.durationMs);
  const hasContext = hasStats && turnStats.some((t) => t.contextTokens);
  const hasTokens = hasStats && turnStats.some((t) => t.tokenUsage);
  const colCount = 3 + (hasDuration ? 1 : 0) + (hasContext ? 1 : 0) + (hasTokens ? 1 : 0);

  const needsCollapse = rows.length > TURN_TABLE_COLLAPSE;
  const visibleRows = needsCollapse && !expanded ? rows.slice(0, TURN_TABLE_COLLAPSE) : rows;

  return (
    <div>
      <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
        Per-Turn Breakdown
      </div>
      <div className="overflow-x-auto rounded border border-terminal-border-subtle">
        <table className="w-full text-[11px] font-mono border-collapse">
          <thead>
            <tr className="text-terminal-dimmer text-left">
              <th className="px-2 py-1.5 font-semibold w-7">#</th>
              <th className="px-2 py-1.5 font-semibold">Prompt</th>
              <th className="px-2 py-1.5 font-semibold text-right w-14">Tools</th>
              {hasDuration && (
                <th className="px-2 py-1.5 font-semibold text-right w-16">Duration</th>
              )}
              {hasContext && <th className="px-2 py-1.5 font-semibold text-right w-16">Context</th>}
              {hasTokens && <th className="px-2 py-1.5 font-semibold text-right w-14">Output</th>}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r, i) => (
              <TurnRow
                key={r.sceneIndex}
                row={r}
                hasDuration={!!hasDuration}
                hasContext={!!hasContext}
                hasTokens={!!hasTokens}
                colCount={colCount}
                showCompaction={compactionAfter.has(i)}
              />
            ))}
          </tbody>
          {needsCollapse && (
            <tfoot>
              <tr>
                <td colSpan={colCount}>
                  <button
                    type="button"
                    className="w-full py-1.5 text-[11px] font-mono text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
                    onClick={() => setExpanded(!expanded)}
                  >
                    {expanded
                      ? "▴ Collapse"
                      : `▾ Show all ${rows.length} turns (${rows.length - TURN_TABLE_COLLAPSE} more)`}
                  </button>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function TurnRow({
  row: r,
  hasDuration,
  hasContext,
  hasTokens,
  colCount,
  showCompaction,
}: {
  row: {
    index: number;
    text: string;
    sceneIndex: number;
    toolCount: number;
    errorCount: number;
    durationMs?: number;
    contextTokens?: number;
    outputTokens?: number;
    toolRatio: number;
    durationRatio: number;
    contextRatio: number;
    outputRatio: number;
  };
  hasDuration: boolean;
  hasContext: boolean;
  hasTokens: boolean;
  colCount: number;
  showCompaction: boolean;
}) {
  return (
    <>
      <tr className="border-t border-terminal-border-subtle hover:bg-terminal-surface-hover transition-colors">
        <td className="px-2 py-1 text-terminal-green tabular-nums">
          {String(r.index).padStart(2, "0")}
        </td>
        <td className="px-2 py-1 text-terminal-text max-w-0">
          <div className="truncate" title={r.text}>
            {r.text}
            {r.errorCount > 0 && (
              <span className="text-terminal-red ml-1.5">{r.errorCount} err</span>
            )}
          </div>
        </td>
        <td className="px-2 py-1 text-right tabular-nums">
          <HeatCell value={r.toolCount} ratio={r.toolRatio} color="--orange" />
        </td>
        {hasDuration && (
          <td className="px-2 py-1 text-right tabular-nums">
            <HeatCell
              value={r.durationMs ? formatDuration(r.durationMs) : "—"}
              ratio={r.durationRatio}
              color="--blue"
            />
          </td>
        )}
        {hasContext && (
          <td className="px-2 py-1 text-right tabular-nums">
            <HeatCell
              value={r.contextTokens ? fmtNum(r.contextTokens) : "—"}
              ratio={r.contextRatio}
              color="--cyan"
            />
          </td>
        )}
        {hasTokens && (
          <td className="px-2 py-1 text-right tabular-nums">
            <HeatCell
              value={r.outputTokens ? fmtNum(r.outputTokens) : "—"}
              ratio={r.outputRatio}
              color="--green"
            />
          </td>
        )}
      </tr>
      {showCompaction && (
        <tr>
          <td colSpan={colCount} className="px-0 py-0">
            <div className="flex items-center gap-2 px-2 py-0.5 bg-terminal-red/5">
              <div className="flex-1 border-t border-dashed border-terminal-red/40" />
              <span className="text-[10px] font-mono text-terminal-red/70 shrink-0">
                context compacted
              </span>
              <div className="flex-1 border-t border-dashed border-terminal-red/40" />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/** Table cell with heatmap background fill proportional to ratio */
function HeatCell({
  value,
  ratio,
  color,
}: {
  value: string | number;
  ratio: number;
  color: string;
}) {
  return (
    <span
      className="inline-block w-full px-1 py-0.5 rounded-sm text-terminal-text"
      style={{
        backgroundColor:
          ratio > 0
            ? `color-mix(in srgb, var(${color}) ${Math.round(ratio * 40)}%, transparent)`
            : undefined,
      }}
    >
      {value}
    </span>
  );
}

const FILE_TABLE_COLLAPSE = 20;

function FileTable({
  editedFiles,
  readOnlyFiles,
}: {
  editedFiles: FileInfo[];
  readOnlyFiles: FileInfo[];
}) {
  const [expanded, setExpanded] = useState(false);

  // Merge edited + read-only, edited first (sorted by edits desc), then read-only (sorted by reads desc)
  const allFiles = useMemo(() => [...editedFiles, ...readOnlyFiles], [editedFiles, readOnlyFiles]);

  const maxEdits = useMemo(() => Math.max(...allFiles.map((f) => f.editCount), 1), [allFiles]);
  const maxReads = useMemo(() => Math.max(...allFiles.map((f) => f.readCount), 1), [allFiles]);
  const maxLines = useMemo(
    () => Math.max(...allFiles.map((f) => f.linesAdded + f.linesRemoved), 1),
    [allFiles],
  );
  const hasLines = allFiles.some((f) => f.linesAdded > 0 || f.linesRemoved > 0);
  const hasTurnSpread = allFiles.some((f) => f.turnEdits.size > 0);

  const needsCollapse = allFiles.length > FILE_TABLE_COLLAPSE;
  const visibleFiles =
    needsCollapse && !expanded ? allFiles.slice(0, FILE_TABLE_COLLAPSE) : allFiles;
  const colCount = 3 + (hasLines ? 1 : 0) + (hasTurnSpread ? 1 : 0);

  return (
    <div>
      <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
        File Impact
        <span className="normal-case tracking-normal ml-1.5">
          ({editedFiles.length} modified
          {readOnlyFiles.length > 0 && `, ${readOnlyFiles.length} read-only`})
        </span>
      </div>
      <div className="overflow-x-auto rounded border border-terminal-border-subtle">
        <table className="w-full text-[11px] font-mono border-collapse">
          <thead>
            <tr className="text-terminal-dimmer text-left">
              <th className="px-2 py-1.5 font-semibold">File</th>
              <th className="px-2 py-1.5 font-semibold text-right w-14">Edits</th>
              <th className="px-2 py-1.5 font-semibold text-right w-14">Reads</th>
              {hasLines && <th className="px-2 py-1.5 font-semibold text-right w-20">+/−</th>}
              {hasTurnSpread && (
                <th className="px-2 py-1.5 font-semibold text-right w-14">Turns</th>
              )}
            </tr>
          </thead>
          <tbody>
            {visibleFiles.map((f) => {
              const filename = f.path.split("/").pop() || f.path;
              const isEdited = f.editCount > 0;
              return (
                <tr
                  key={f.path}
                  className="border-t border-terminal-border-subtle hover:bg-terminal-surface-hover transition-colors"
                >
                  <td className="px-2 py-1 max-w-0">
                    <div
                      className={`truncate ${isEdited ? "text-terminal-text" : "text-terminal-dimmer"}`}
                      title={f.path}
                    >
                      {filename}
                      {f.editCount >= 10 && (
                        <span
                          className="text-terminal-red ml-1"
                          title={`${f.editCount} edits — high churn file`}
                        >
                          ⚠
                        </span>
                      )}
                      <span className="text-terminal-dimmer ml-1">
                        {f.path.slice(0, f.path.length - filename.length - 1)}
                      </span>
                    </div>
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {f.editCount > 0 ? (
                      <HeatCell
                        value={f.editCount}
                        ratio={f.editCount / maxEdits}
                        color="--orange"
                      />
                    ) : (
                      <span className="text-terminal-dimmer">—</span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums">
                    {f.readCount > 0 ? (
                      <HeatCell value={f.readCount} ratio={f.readCount / maxReads} color="--blue" />
                    ) : (
                      <span className="text-terminal-dimmer">—</span>
                    )}
                  </td>
                  {hasLines && (
                    <td className="px-2 py-1 text-right tabular-nums">
                      {f.linesAdded > 0 || f.linesRemoved > 0 ? (
                        <span
                          className="inline-block w-full px-1 py-0.5 rounded-sm"
                          style={{
                            backgroundColor: `color-mix(in srgb, var(--green) ${Math.round(((f.linesAdded + f.linesRemoved) / maxLines) * 30)}%, transparent)`,
                          }}
                        >
                          <span className="text-terminal-green">+{f.linesAdded}</span>
                          <span className="text-terminal-dimmer">/</span>
                          <span className="text-terminal-red">−{f.linesRemoved}</span>
                        </span>
                      ) : (
                        <span className="text-terminal-dimmer">—</span>
                      )}
                    </td>
                  )}
                  {hasTurnSpread && (
                    <td className="px-2 py-1 text-right tabular-nums">
                      {f.turnEdits.size > 0 ? (
                        <span className="text-terminal-dim">{f.turnEdits.size}</span>
                      ) : (
                        <span className="text-terminal-dimmer">—</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          {needsCollapse && (
            <tfoot>
              <tr>
                <td colSpan={colCount}>
                  <button
                    type="button"
                    className="w-full py-1.5 text-[11px] font-mono text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
                    onClick={() => setExpanded(!expanded)}
                  >
                    {expanded
                      ? "▴ Collapse"
                      : `▾ Show all ${allFiles.length} files (${allFiles.length - FILE_TABLE_COLLAPSE} more)`}
                  </button>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
