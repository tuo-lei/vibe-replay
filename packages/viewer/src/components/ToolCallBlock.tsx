import { memo, useState } from "react";
import type { Scene, SubAgent } from "../types";
import { displayToolName } from "../utils/toolName";
import { getToolDiffs } from "../utils/sceneDiffs";
import { ErrorBadge, ToolDuration, ToolTokens } from "./Badges";
import BashBlock from "./BashBlock";
import CodeDiffBlock from "./CodeDiffBlock";
import ReplayImage from "./ReplayImage";
import { formatTokens } from "./StatsPanel";

const CHEVRON = "▶";

function subAgentTotalTokens(sa: SubAgent): number {
  if (!sa.tokenUsage) return 0;
  return (
    sa.tokenUsage.inputTokens +
    sa.tokenUsage.outputTokens +
    sa.tokenUsage.cacheCreationTokens +
    sa.tokenUsage.cacheReadTokens
  );
}

function subAgentTotalDurationMs(sa: SubAgent): number {
  // Skip nested Agent calls: their `durationMs` is the inner subagent's whole
  // wall time, which already covers all of its own tool calls. Counting both
  // would double-count anything below depth 1.
  let total = 0;
  for (const s of sa.scenes) {
    if (s.type === "tool-call" && s.toolName !== "Agent" && s.durationMs) {
      total += s.durationMs;
    }
  }
  return total;
}

type ToolScene = Extract<Scene, { type: "tool-call" }>;

interface Props {
  scene: ToolScene;
  isActive: boolean;
  forceCollapse?: boolean;
}

function ToolResultBadge({ scene }: { scene: ToolScene }) {
  if (scene.hasResult === false) {
    const label = scene.isError ? "no result" : "pending";
    return (
      <span
        className="text-[10px] font-mono text-terminal-dimmer shrink-0"
        title={
          scene.isError
            ? "The tool failed before a result was recorded."
            : "No tool result was recorded."
        }
      >
        {label}
      </span>
    );
  }
  if (scene.hasResult === true && (scene.result || "").length === 0) {
    return (
      <span
        className="text-[10px] font-mono text-terminal-dimmer shrink-0"
        title="The provider recorded a successful empty result."
      >
        empty result
      </span>
    );
  }
  return null;
}

function toolIcon(name: string): string {
  if (name.startsWith("mcp__")) return "🔌"; // 🔌
  switch (name) {
    case "Read":
      return "📄";
    case "Write":
      return "✏️";
    case "Edit":
      return "✂️";
    case "Delete":
      return "🗑️";
    case "Bash":
      return "$";
    case "Glob":
      return "🔍";
    case "Grep":
      return "🔎";
    case "Agent":
      return "🤖";
    default:
      return "⚙️";
  }
}

/**
 * Map known agent types onto the design-system palette so subagent visuals
 * use the same theme tokens (`terminal-*-subtle` / `terminal-*-emphasis`)
 * that drive the Assistant section, Jump Target pill, etc. Falls back to
 * purple for unknown types — purple is the brand color for subagents.
 *
 * Class strings are spelled out (not interpolated) so the Tailwind JIT can
 * see them at build time.
 */
type AgentTheme = "blue" | "purple" | "green" | "orange";

const AGENT_TYPE_THEME: Record<string, AgentTheme> = {
  Explore: "blue",
  Plan: "purple",
  Shell: "blue",
  "general-purpose": "green",
  "claude-code-guide": "orange",
};

function agentTheme(type: string): AgentTheme {
  return AGENT_TYPE_THEME[type] || "purple";
}

const THEME_CLASSES: Record<AgentTheme, { text: string; bgSubtle: string; pill: string }> = {
  blue: {
    text: "text-terminal-blue",
    bgSubtle: "bg-terminal-blue-subtle",
    pill: "bg-terminal-blue-emphasis text-terminal-blue",
  },
  purple: {
    text: "text-terminal-purple",
    bgSubtle: "bg-terminal-purple-subtle",
    pill: "bg-terminal-purple-emphasis text-terminal-purple",
  },
  green: {
    text: "text-terminal-green",
    bgSubtle: "bg-terminal-green-subtle",
    pill: "bg-terminal-green-emphasis text-terminal-green",
  },
  orange: {
    text: "text-terminal-tool",
    bgSubtle: "bg-terminal-tool-subtle",
    pill: "bg-terminal-tool-emphasis text-terminal-tool",
  },
};

/** Agent-type pill — matches the shared replay status treatment. */
function AgentTypeBadge({ type }: { type: string }) {
  const c = THEME_CLASSES[agentTheme(type)];
  return <span className={`ui-pill-compact px-2 ${c.pill}`}>{type}</span>;
}

/** Section label — matches the "Assistant" header treatment so a subagent
 * card reads as a sibling section, not a tool row. */
function SubagentLabel({ theme }: { theme: AgentTheme }) {
  return <span className={`ui-section-title ${THEME_CLASSES[theme].text}`}>Subagent</span>;
}

function SubAgentBody({ subAgent }: { subAgent: SubAgent }) {
  return (
    <div className="mt-3 space-y-3">
      {subAgent.prompt && (
        <div>
          <div className="ui-section-title mb-1.5">Prompt</div>
          <div className="text-[11px] text-terminal-text/85 font-mono whitespace-pre-wrap break-words max-h-[120px] overflow-y-auto rounded-md bg-terminal-surface-inset px-3 py-2">
            {subAgent.prompt}
          </div>
        </div>
      )}
      {subAgent.scenes.length > 0 && <SubAgentTrace scenes={subAgent.scenes} />}
    </div>
  );
}

/**
 * Trace section. For large subagents (e.g. an Explore that fired 80+ tools)
 * we show only a window plus an explicit "show all" toggle so the parent
 * agent expand doesn't dump hundreds of rows of DOM at once.
 */
const TRACE_INITIAL_LIMIT = 20;

function SubAgentTrace({ scenes }: { scenes: Scene[] }) {
  const [showAll, setShowAll] = useState(false);
  const isLong = scenes.length > TRACE_INITIAL_LIMIT;
  const visible = isLong && !showAll ? scenes.slice(0, TRACE_INITIAL_LIMIT) : scenes;
  const hidden = scenes.length - visible.length;
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="ui-section-title">
          Trace · {scenes.length} {scenes.length === 1 ? "scene" : "scenes"}
        </span>
        {isLong && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowAll((v) => !v);
            }}
            className="text-[10px] font-mono text-terminal-dim hover:text-terminal-text transition-colors"
          >
            {showAll ? "Show first 20" : `Show all (+${hidden})`}
          </button>
        )}
      </div>
      <div className="space-y-1 max-h-[500px] overflow-y-auto rounded-md bg-terminal-surface-inset px-3 py-2">
        {visible.map((s, i) => (
          <SubAgentSceneItem key={i} scene={s} />
        ))}
      </div>
    </div>
  );
}

function SubAgentSceneItem({ scene }: { scene: Scene }) {
  const [expanded, setExpanded] = useState(false);

  if (scene.type === "thinking") {
    const tokenLabel = formatTokens(scene.tokens);
    return (
      <div className="text-[10px] font-mono text-terminal-thinking/80 pl-2 py-0.5">
        <span className="text-terminal-thinking/70 font-bold mr-1">[thinking]</span>
        {tokenLabel && (
          <span className="text-terminal-thinking/70 mr-1" title="Approximate thinking tokens">
            ~{tokenLabel} tok
          </span>
        )}
        <span className="text-terminal-thinking/70">
          {(scene.content || "").slice(0, 120)}
          {(scene.content || "").length > 120 ? "..." : ""}
        </span>
      </div>
    );
  }

  if (scene.type === "text-response") {
    return (
      <div className="text-[10px] font-mono text-terminal-text/80 pl-2 py-0.5">
        {(scene.content || "").slice(0, 200)}
        {(scene.content || "").length > 200 ? "..." : ""}
      </div>
    );
  }

  if (scene.type === "tool-call") {
    const toolScene = scene as ToolScene;
    const errorAccent = toolScene.isError ? "bg-terminal-error/5" : "";
    return (
      <div className={`pl-2 py-0.5 rounded-md ${errorAccent}`}>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-[10px] font-mono w-full text-left hover:bg-terminal-surface-hover/30 rounded px-1"
        >
          <span
            className={`font-bold ${toolScene.isError ? "text-terminal-error" : "text-terminal-tool"}`}
          >
            {displayToolName(toolScene.toolName)}
          </span>
          <span className="text-terminal-dim truncate flex-1">
            {summarizeInput(toolScene.toolName, toolScene.input)}
          </span>
          {toolScene.isError && <ErrorBadge />}
          <ToolResultBadge scene={toolScene} />
          <ToolTokens tokens={toolScene.resultTokens} />
          <ToolDuration ms={toolScene.durationMs} />
        </button>
        {expanded && (
          <>
            {toolScene.hasResult === false ? (
              <div className="text-[9px] text-terminal-dimmer font-mono mt-0.5 px-1">
                Result not recorded.
              </div>
            ) : (
              (toolScene.result || toolScene.hasResult === true) && (
                <pre className="text-[9px] text-terminal-dim font-mono whitespace-pre-wrap break-words max-h-[100px] overflow-y-auto mt-0.5 px-1 bg-terminal-bg/50 rounded">
                  {toolScene.result ? toolScene.result.slice(0, 500) : "(empty result)"}
                </pre>
              )
            )}
          </>
        )}
      </div>
    );
  }

  return null;
}

export default memo(function ToolCallBlock({ scene, isActive, forceCollapse }: Props) {
  const [expanded, setExpanded] = useState(false);

  // When force-collapsing, show a one-liner summary for all tool types.
  if (forceCollapse) {
    return (
      <div
        className={`flex items-center gap-2 px-3 py-1 text-xs font-mono text-terminal-dim ${scene.isError ? "bg-terminal-error/5 ring-1 ring-terminal-error/30 rounded-md" : ""}`}
      >
        <span>{toolIcon(scene.toolName)}</span>
        <span
          className={`font-bold ${scene.isError ? "text-terminal-error" : "text-terminal-tool"}`}
        >
          {displayToolName(scene.toolName)}
        </span>
        <span className="truncate flex-1">{summarizeInput(scene.toolName, scene.input)}</span>
        {scene.subAgent && <AgentTypeBadge type={scene.subAgent.agentType} />}
        {scene.isError && <ErrorBadge />}
        <ToolResultBadge scene={scene} />
        <ToolTokens tokens={scene.resultTokens} />
        <ToolDuration ms={scene.durationMs} />
      </div>
    );
  }

  // Special rendering for Bash
  if (scene.bashOutput) {
    return (
      <BashBlock
        command={scene.bashOutput.command}
        stdout={scene.bashOutput.stdout}
        isActive={isActive}
        durationMs={scene.durationMs}
        resultTokens={scene.resultTokens}
        isError={scene.isError}
        hasResult={scene.hasResult}
      />
    );
  }

  // Special rendering for Edit/Write with one or more file diffs
  const diffs = getToolDiffs(scene);
  if (diffs.length === 1) {
    return (
      <CodeDiffBlock
        toolName={scene.toolName}
        filePath={diffs[0].filePath}
        oldContent={diffs[0].oldContent}
        newContent={diffs[0].newContent}
        isActive={isActive}
        isError={scene.isError}
        durationMs={scene.durationMs}
        resultTokens={scene.resultTokens}
        hasResult={scene.hasResult}
        resultEmpty={(scene.result || "").length === 0}
      />
    );
  }
  if (diffs.length > 1) {
    return (
      <div className="space-y-3">
        {diffs.map((diff, index) => (
          <CodeDiffBlock
            key={`${diff.filePath}-${index}`}
            toolName={scene.toolName}
            filePath={diff.filePath}
            oldContent={diff.oldContent}
            newContent={diff.newContent}
            isActive={isActive}
            isError={scene.isError}
            durationMs={index === 0 ? scene.durationMs : undefined}
            resultTokens={index === 0 ? scene.resultTokens : undefined}
            hasResult={index === 0 ? scene.hasResult : undefined}
            resultEmpty={index === 0 ? (scene.result || "").length === 0 : undefined}
          />
        ))}
      </div>
    );
  }

  // Agent tool call with subagent data — rendered as a design-system section
  // card (matching the Assistant group) so subagents read as "delegated
  // sub-conversations" rather than just another tool row.
  if (scene.toolName === "Agent" && scene.subAgent) {
    const sa = scene.subAgent;
    const theme = agentTheme(sa.agentType);
    const c = THEME_CLASSES[theme];
    const totalTok = subAgentTotalTokens(sa);
    const totalDur = subAgentTotalDurationMs(sa);
    const description = sa.description || (scene.input.description as string) || "";
    return (
      <div
        className={`rounded-xl px-5 py-4 ${c.bgSubtle} shadow-layer-sm transition-all duration-200 ease-material`}
      >
        <button onClick={() => setExpanded(!expanded)} className="w-full text-left">
          {/* Header row — mirrors the Assistant group header */}
          <div className="flex items-center gap-2 flex-wrap mb-1.5">
            <SubagentLabel theme={theme} />
            <AgentTypeBadge type={sa.agentType} />
            {sa.model && (
              <span className="text-[10px] text-terminal-dimmer font-mono">{sa.model}</span>
            )}
            <span className="flex-1" />
            <span className="text-[10px] text-terminal-dim font-mono">{sa.toolCalls} tools</span>
            {sa.thinkingBlocks > 0 && (
              <span className="text-[10px] text-terminal-dim font-mono">
                {sa.thinkingBlocks} thinking
              </span>
            )}
            {totalTok > 0 && (
              <span
                className={`text-[10px] font-mono font-semibold ${c.text}`}
                title="Total tokens billed for this subagent (input + output + cache)"
              >
                {formatTokens(totalTok)} tok
              </span>
            )}
            {totalDur > 0 && <ToolDuration ms={totalDur} />}
            <span
              className={`text-xs text-terminal-dim transition-transform ${expanded ? "rotate-90" : ""}`}
            >
              {CHEVRON}
            </span>
            <ToolResultBadge scene={scene} />
          </div>
          {/* Description — large, like a section title */}
          {description && (
            <div className="text-sm text-terminal-text font-sans font-medium leading-snug">
              {description}
            </div>
          )}
        </button>
        {expanded && <SubAgentBody subAgent={sa} />}
      </div>
    );
  }

  // Generic tool call
  const errorRing = scene.isError ? "ring-1 ring-terminal-error/40" : "";
  const errorBg = scene.isError ? "bg-terminal-error/5" : "";
  return (
    <div>
      <div
        className={`bg-terminal-surface rounded-xl overflow-hidden shadow-layer-sm ${errorRing}`}
      >
        <button
          onClick={() => setExpanded(!expanded)}
          className={`w-full flex items-center gap-2 px-3 py-2 hover:bg-terminal-surface-hover transition-colors duration-200 ease-material text-left ${errorBg || "bg-terminal-surface"}`}
        >
          <span className="text-xs font-mono">{toolIcon(scene.toolName)}</span>
          <span
            className={`text-xs font-mono font-bold ${scene.isError ? "text-terminal-error" : "text-terminal-tool"}`}
          >
            {displayToolName(scene.toolName)}
          </span>
          <span className="text-xs text-terminal-dim font-mono truncate flex-1">
            {summarizeInput(scene.toolName, scene.input)}
          </span>
          {scene.isError && <ErrorBadge />}
          <ToolResultBadge scene={scene} />
          <ToolTokens tokens={scene.resultTokens} />
          <ToolDuration ms={scene.durationMs} />
          <span
            className={`text-xs text-terminal-dim transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            {CHEVRON}
          </span>
        </button>
        {expanded && (
          <div className="border-t border-terminal-border-subtle">
            <div className="px-3 py-2">
              <div className="text-xs text-terminal-dim font-mono mb-1">Input:</div>
              <pre className="text-xs text-terminal-text font-mono whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
                {JSON.stringify(scene.input, null, 2)}
              </pre>
            </div>
            {scene.hasResult === false ? (
              <div className="px-3 py-2 border-t border-terminal-border-subtle">
                <div className="text-xs text-terminal-dimmer font-mono">Result not recorded.</div>
              </div>
            ) : (
              (scene.result || scene.hasResult === true) && (
                <div className="px-3 py-2 border-t border-terminal-border-subtle">
                  <div className="text-xs text-terminal-dim font-mono mb-1">Result:</div>
                  <pre className="text-xs text-terminal-text font-mono whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
                    {scene.result || "(empty result)"}
                  </pre>
                </div>
              )
            )}
            {scene.images && scene.images.length > 0 && (
              <div className="px-3 py-2 border-t border-terminal-border-subtle">
                <div className="flex gap-2 flex-wrap">
                  {scene.images.map((src, i) => (
                    <ReplayImage
                      key={i}
                      src={src}
                      alt={`Screenshot ${i + 1}`}
                      className="max-w-[400px] max-h-[300px] rounded-md object-contain"
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

// Multi-line / very long Bash pipelines would overflow the one-line summary.
// 200 chars is enough to identify a command without breaking layout.
const BASH_SUMMARY_MAX = 200;

export function summarizeInput(name: string, input: Record<string, any>): string {
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return input.file_path || "";
    case "NotebookEdit":
      return input.notebook_path || "";
    case "Glob":
      return input.pattern || "";
    case "Grep":
      return `/${input.pattern || ""}/ ${input.path || ""}`.trim();
    case "Bash": {
      // Prefer command (more identifying); fall back to description.
      // Collapse newlines so multi-line commands stay one-line in the summary.
      const raw = (input.command || input.description || "") as string;
      const oneLine = raw.replace(/\s+/g, " ").trim();
      return oneLine.length > BASH_SUMMARY_MAX ? `${oneLine.slice(0, BASH_SUMMARY_MAX)}…` : oneLine;
    }
    case "BashOutput":
      return input.bash_id || "";
    case "Agent":
    case "Task": {
      const desc = input.description || "";
      const subtype = input.subagent_type;
      return subtype ? `${subtype} — ${desc}` : desc;
    }
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? input.todos : [];
      if (todos.length === 0) return "";
      const inProgress = todos.find((t: any) => t?.status === "in_progress");
      return inProgress?.content
        ? `${todos.length} todos · ${inProgress.content}`
        : `${todos.length} todos`;
    }
    case "WebSearch":
      return input.query || "";
    case "WebFetch":
      return input.url || "";
    case "SlashCommand":
      return input.command || "";
    case "ExitPlanMode":
      return (input.plan || "").slice(0, 80);
    default:
      // mcp__server__tool — surface the most likely identifying value, or
      // fall back to a short joined string of scalar args.
      return shortenScalarSummary(input);
  }
}

export function shortenScalarSummary(input: Record<string, any>): string {
  // Prefer commonly meaningful keys before falling back to all string values.
  const preferred = ["url", "path", "file_path", "query", "name", "id"];
  for (const k of preferred) {
    const v = input[k];
    if (typeof v === "string" && v) return v.slice(0, 80);
  }
  return Object.values(input)
    .filter((v) => typeof v === "string")
    .join(" ")
    .slice(0, 80);
}
