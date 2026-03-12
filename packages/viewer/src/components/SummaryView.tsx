import { useCallback, useMemo, useRef, useState } from "react";
import type { ReplaySession, TurnStat } from "../types";
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
  const [showReadOnly, setShowReadOnly] = useState(false);

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
              f.linesAdded += newL;
              f.linesRemoved += oldL;
            }
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
    };
  }, [scenes, meta]);

  const heatmapFiles = stats.editedFiles.slice(0, 8);
  const activeTurns = stats.turns.filter((t) => t.toolCount > 0);
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
        </div>

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
          {/* Duration / Cost / Model — inline below cards */}
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-xs font-mono text-terminal-dim">
            {meta.model && (
              <div>
                Model: <span className="text-terminal-text font-semibold">{meta.model}</span>
              </div>
            )}
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
            {stats.tokenUsage && (
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
            <ContextWindowChart
              turnStats={meta.stats.turnStats!}
              contextLimit={meta.contextLimit}
              turnLabels={turnLabels}
            />
            {meta.stats.turnStats!.some((t) => t.durationMs) && (
              <TurnDurationChart turnStats={meta.stats.turnStats!} turnLabels={turnLabels} />
            )}
          </div>
        )}

        {/* Per-Model Token Breakdown */}
        {meta.tokenUsageByModel && Object.keys(meta.tokenUsageByModel).length > 1 && (
          <ModelBreakdown tokenUsageByModel={meta.tokenUsageByModel} />
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

        {/* Prompt Timeline (Enhanced) */}
        {stats.turns.length > 0 && (
          <div>
            <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
              Prompt Timeline
            </div>
            <div className="space-y-1">
              {stats.turns.map((t) => {
                const maxTools = Math.max(...stats.turns.map((x) => x.toolCount), 1);
                const barW = (t.toolCount / maxTools) * 100;
                return (
                  <div
                    key={t.sceneIndex}
                    className="flex items-center gap-1.5 text-xs font-mono py-1 px-2 rounded hover:bg-terminal-surface-hover transition-colors"
                  >
                    <span className="text-terminal-green shrink-0 w-5 text-right tabular-nums">
                      {String(t.index).padStart(2, "0")}
                    </span>
                    <span className="text-terminal-text flex-1 min-w-0 truncate">{t.text}</span>
                    {/* Mini activity bar */}
                    <div className="shrink-0 w-14 h-1.5 rounded-full bg-terminal-surface overflow-hidden">
                      <div
                        className="h-full rounded-full bg-terminal-orange"
                        style={{ width: `${barW}%` }}
                      />
                    </div>
                    <span className="text-terminal-dim shrink-0 w-10 text-right tabular-nums">
                      {t.toolCount}
                    </span>
                    {t.errorCount > 0 && (
                      <span className="text-terminal-red shrink-0 text-[10px] tabular-nums">
                        {t.errorCount}err
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* File Impact */}
        {stats.editedFiles.length > 0 && (
          <div>
            <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
              File Impact
              <span className="normal-case tracking-normal ml-1.5">
                ({stats.editedFiles.length} modified
                {stats.readOnlyFiles.length > 0 && `, ${stats.readOnlyFiles.length} read-only`})
              </span>
            </div>
            <div className="space-y-1">
              {stats.editedFiles.map((f) => {
                const maxEdits = stats.editedFiles[0]?.editCount || 1;
                const barW = (f.editCount / maxEdits) * 100;
                const isHot = f.editCount >= 10;
                return (
                  <div
                    key={f.path}
                    className="flex items-center gap-2 text-xs font-mono px-2 py-1 rounded hover:bg-terminal-surface-hover transition-colors"
                  >
                    <span className="text-terminal-text flex-1 min-w-0 truncate" title={f.path}>
                      {f.path}
                    </span>
                    <div className="shrink-0 w-16 h-2 rounded-full bg-terminal-surface overflow-hidden">
                      <div
                        className={`h-full rounded-full ${isHot ? "bg-terminal-red" : "bg-terminal-orange"}`}
                        style={{ width: `${barW}%` }}
                      />
                    </div>
                    <span
                      className={`shrink-0 w-[52px] text-right tabular-nums ${isHot ? "text-terminal-red" : "text-terminal-dim"}`}
                    >
                      {f.editCount} edit{f.editCount !== 1 ? "s" : ""}
                    </span>
                    {f.readCount > 0 && (
                      <span className="shrink-0 w-[52px] text-right tabular-nums text-terminal-dimmer">
                        {f.readCount} read{f.readCount !== 1 ? "s" : ""}
                      </span>
                    )}
                    {isHot && (
                      <span
                        className="text-terminal-red shrink-0"
                        title="Hotspot: frequently edited"
                      >
                        ●
                      </span>
                    )}
                  </div>
                );
              })}
              {/* Read-only files toggle */}
              {stats.readOnlyFiles.length > 0 && (
                <div>
                  <button
                    type="button"
                    className="text-[10px] font-mono text-terminal-dimmer hover:text-terminal-dim mt-1 px-2"
                    onClick={() => setShowReadOnly(!showReadOnly)}
                  >
                    {showReadOnly ? "▾" : "▸"} {stats.readOnlyFiles.length} read-only file
                    {stats.readOnlyFiles.length !== 1 ? "s" : ""}
                  </button>
                  {showReadOnly && (
                    <div className="space-y-0.5 pl-2 border-l border-terminal-border-subtle ml-2 mt-1">
                      {stats.readOnlyFiles.slice(0, 20).map((f) => (
                        <div
                          key={f.path}
                          className="flex items-center gap-2 text-xs font-mono text-terminal-dimmer px-2 py-0.5"
                        >
                          <span className="flex-1 min-w-0 truncate" title={f.path}>
                            {f.path}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {f.readCount} read{f.readCount !== 1 ? "s" : ""}
                          </span>
                        </div>
                      ))}
                      {stats.readOnlyFiles.length > 20 && (
                        <div className="text-[10px] font-mono text-terminal-dimmer px-2">
                          ... and {stats.readOnlyFiles.length - 20} more
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* File × Turn Heatmap */}
        {heatmapFiles.length >= 2 && activeTurns.length >= 2 && (
          <FileHeatmap files={heatmapFiles} turns={activeTurns} />
        )}

        {/* Activity Distribution */}
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
                  <span className="text-terminal-text shrink-0 w-24 text-right truncate">
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
        <span className="text-[10px] font-mono text-terminal-dimmer">Cache Hit Rate</span>
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
  contextLimit,
  turnLabels,
}: {
  turnStats: TurnStat[];
  contextLimit?: number;
  turnLabels?: string[];
}) {
  const contextSizes = turnStats.map((t) => t.contextTokens || 0);
  const n = contextSizes.length;
  const { hovered, ref, onMouseMove, onMouseLeave } = useChartHover(n);

  if (!contextSizes.some((c) => c > 0)) return null;

  const peak = Math.max(...contextSizes);
  const max = contextLimit ? Math.max(peak, contextLimit) : peak;
  const h = 60;
  const w = 100;

  const points = contextSizes.map((v, i) => {
    const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
    const y = h - (v / max) * (h - 6) - 3;
    return `${x},${y}`;
  });

  const limitY = contextLimit ? h - (contextLimit / max) * (h - 6) - 3 : undefined;

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
          {/* Context limit reference line */}
          {limitY !== undefined && (
            <line
              x1="0"
              y1={limitY}
              x2={w}
              y2={limitY}
              style={{ stroke: "var(--red)" }}
              strokeWidth="0.5"
              strokeDasharray="2,2"
              vectorEffect="non-scaling-stroke"
              opacity="0.5"
            />
          )}
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
              <div className="text-terminal-cyan" style={{ color: "var(--cyan)" }}>
                Turn {hovered + 1}
              </div>
              {turnLabels?.[hovered] && (
                <div className="text-terminal-dim truncate max-w-[200px]">
                  {turnLabels[hovered]}
                </div>
              )}
              <div>{fmtNum(contextSizes[hovered])} tokens</div>
              {contextLimit && (
                <div className="text-terminal-dimmer">
                  {Math.round((contextSizes[hovered] / contextLimit) * 100)}% of limit
                </div>
              )}
            </>
          )}
        </ChartTooltip>
      </div>
      <div className="flex justify-between text-[10px] font-mono text-terminal-dimmer mt-0.5">
        <span>Turn 1</span>
        <span>
          peak {fmtNum(peak)}
          {contextLimit ? ` / ${fmtNum(contextLimit)} limit` : ""}
        </span>
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

function FileHeatmap({ files, turns }: { files: FileInfo[]; turns: TurnInfo[] }) {
  let maxEdits = 0;
  for (const f of files) {
    for (const [, count] of f.turnEdits) {
      if (count > maxEdits) maxEdits = count;
    }
  }
  if (maxEdits === 0) return null;

  return (
    <div>
      <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-2">
        File × Turn Heatmap
      </div>
      <div className="space-y-0.5">
        {/* Turn numbers header */}
        <div className="flex items-center gap-0.5">
          <span className="shrink-0 w-28" />
          <div className="flex-1 flex gap-0.5">
            {turns.map((t) => (
              <div
                key={t.index}
                className="flex-1 text-[7px] font-mono text-terminal-dimmer text-center tabular-nums leading-none"
                title={`Turn ${t.index}: ${t.text.slice(0, 60)}`}
              >
                {t.index}
              </div>
            ))}
          </div>
        </div>
        {/* File rows */}
        {files.map((f) => {
          const filename = f.path.split("/").pop() || f.path;
          return (
            <div key={f.path} className="flex items-center gap-0.5">
              <span
                className="shrink-0 w-28 text-[10px] font-mono text-terminal-dim text-right truncate pr-1"
                title={f.path}
              >
                {filename}
              </span>
              <div className="flex-1 flex gap-0.5">
                {turns.map((t) => {
                  const count = f.turnEdits.get(t.index) || 0;
                  const opacity = count > 0 ? 0.3 + (count / maxEdits) * 0.7 : 0;
                  return (
                    <div
                      key={t.index}
                      className="flex-1 h-3 rounded-[2px]"
                      style={{
                        backgroundColor: count > 0 ? `var(--orange)` : "var(--surface)",
                        opacity: count > 0 ? opacity : 0.3,
                      }}
                      title={
                        count > 0
                          ? `${filename}: ${count} edit${count !== 1 ? "s" : ""} in turn ${t.index}`
                          : undefined
                      }
                    />
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
