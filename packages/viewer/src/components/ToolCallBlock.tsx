import { memo, useState } from "react";
import type { Scene, SubAgent } from "../types";
import { displayToolName } from "../utils/toolName";
import BashBlock from "./BashBlock";
import CodeDiffBlock from "./CodeDiffBlock";
import { formatToolDuration, formatTokens } from "./StatsPanel";

const CHEVRON = "▶";

function ToolDuration({ ms }: { ms?: number }) {
  const label = formatToolDuration(ms);
  if (!label) return null;
  return (
    <span
      className="text-[10px] text-terminal-dimmer font-mono shrink-0"
      title={`Tool execution: ${label}`}
    >
      {label}
    </span>
  );
}

function ToolTokens({ tokens }: { tokens?: number }) {
  const label = formatTokens(tokens);
  if (!label) return null;
  return (
    <span
      className="text-[10px] text-terminal-dimmer font-mono shrink-0"
      title={`~${label} tokens added to context (heuristic estimate)`}
    >
      ~{label} tok
    </span>
  );
}

function ErrorBadge() {
  return (
    <span
      className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30 shrink-0"
      title="This tool call returned an error"
    >
      ERROR
    </span>
  );
}

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
  let total = 0;
  for (const s of sa.scenes) {
    if (s.type === "tool-call" && s.durationMs) total += s.durationMs;
  }
  return total;
}

type ToolScene = Extract<Scene, { type: "tool-call" }>;

interface Props {
  scene: ToolScene;
  isActive: boolean;
  forceCollapse?: boolean;
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

const AGENT_TYPE_COLORS: Record<string, string> = {
  Explore: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  Plan: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  Shell: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  "general-purpose": "bg-green-500/20 text-green-300 border-green-500/30",
  "claude-code-guide": "bg-amber-500/20 text-amber-300 border-amber-500/30",
};

/** Distinct accent color used for the subagent left border + faint background. */
const AGENT_TYPE_ACCENTS: Record<string, { border: string; bg: string }> = {
  Explore: { border: "border-l-blue-400", bg: "bg-blue-500/[0.04]" },
  Plan: { border: "border-l-purple-400", bg: "bg-purple-500/[0.04]" },
  Shell: { border: "border-l-cyan-400", bg: "bg-cyan-500/[0.04]" },
  "general-purpose": { border: "border-l-green-400", bg: "bg-green-500/[0.04]" },
  "claude-code-guide": { border: "border-l-amber-400", bg: "bg-amber-500/[0.04]" },
};

function agentAccent(type: string) {
  return AGENT_TYPE_ACCENTS[type] || { border: "border-l-gray-400", bg: "bg-gray-500/[0.04]" };
}

function AgentTypeBadge({ type }: { type: string }) {
  const colors = AGENT_TYPE_COLORS[type] || "bg-gray-500/20 text-gray-300 border-gray-500/30";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${colors}`}>{type}</span>
  );
}

/** Prominent "TASK" pill so subagents are immediately distinguishable from
 * regular tool calls — the Agent block is conceptually a sub-conversation,
 * not a leaf operation, and the eye should land on it first. */
function TaskBadge() {
  return (
    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-terminal-purple/20 text-terminal-purple border border-terminal-purple/40 tracking-wider">
      TASK
    </span>
  );
}

function SubAgentView({ subAgent }: { subAgent: SubAgent }) {
  const accent = agentAccent(subAgent.agentType);
  return (
    <div className={`border-t border-terminal-border-subtle ${accent.bg}`}>
      {subAgent.prompt && (
        <div className="px-3 py-2 border-b border-terminal-border-subtle/50">
          <div className="text-[10px] text-terminal-dim font-mono uppercase tracking-wide mb-1">
            Prompt
          </div>
          <div className="text-[11px] text-terminal-text/85 font-mono whitespace-pre-wrap break-words max-h-[120px] overflow-y-auto">
            {subAgent.prompt}
          </div>
        </div>
      )}
      {subAgent.scenes.length > 0 && (
        <div
          className={`pl-3 pr-2 py-2 border-l-2 ${accent.border} ml-2 my-2 space-y-1 max-h-[500px] overflow-y-auto`}
        >
          {subAgent.scenes.map((s, i) => (
            <SubAgentSceneItem key={i} scene={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function SubAgentSceneItem({ scene }: { scene: Scene }) {
  const [expanded, setExpanded] = useState(false);

  if (scene.type === "thinking") {
    const tokenLabel = formatTokens(scene.tokens);
    return (
      <div className="text-[10px] font-mono text-purple-400/80 pl-2 border-l-2 border-purple-500/30 py-0.5">
        <span className="text-purple-400/70 font-bold mr-1">[thinking]</span>
        {tokenLabel && (
          <span className="text-purple-400/70 mr-1" title="Approximate thinking tokens">
            ~{tokenLabel} tok
          </span>
        )}
        <span className="text-purple-400/70">
          {(scene.content || "").slice(0, 120)}
          {(scene.content || "").length > 120 ? "..." : ""}
        </span>
      </div>
    );
  }

  if (scene.type === "text-response") {
    return (
      <div className="text-[10px] font-mono text-terminal-text/80 pl-2 border-l-2 border-blue-500/30 py-0.5">
        {(scene.content || "").slice(0, 200)}
        {(scene.content || "").length > 200 ? "..." : ""}
      </div>
    );
  }

  if (scene.type === "tool-call") {
    const toolScene = scene as ToolScene;
    const errorAccent = toolScene.isError
      ? "border-l-red-500 bg-red-500/5"
      : "border-l-orange-500/30";
    return (
      <div className={`pl-2 border-l-2 py-0.5 ${errorAccent}`}>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-[10px] font-mono w-full text-left hover:bg-terminal-surface-hover/30 rounded px-1"
        >
          <span
            className={`font-bold ${toolScene.isError ? "text-red-400" : "text-terminal-orange"}`}
          >
            {displayToolName(toolScene.toolName)}
          </span>
          <span className="text-terminal-dim truncate flex-1">
            {summarizeInput(toolScene.toolName, toolScene.input)}
          </span>
          {toolScene.isError && <ErrorBadge />}
          <ToolTokens tokens={toolScene.resultTokens} />
          <ToolDuration ms={toolScene.durationMs} />
        </button>
        {expanded && toolScene.result && (
          <pre className="text-[9px] text-terminal-dim font-mono whitespace-pre-wrap break-words max-h-[100px] overflow-y-auto mt-0.5 px-1 bg-terminal-bg/50 rounded">
            {toolScene.result.slice(0, 500)}
          </pre>
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
        className={`flex items-center gap-2 px-3 py-1 text-xs font-mono text-terminal-dim ${scene.isError ? "border-l-2 border-l-red-500 bg-red-500/5" : ""}`}
      >
        <span>{toolIcon(scene.toolName)}</span>
        <span className={`font-bold ${scene.isError ? "text-red-400" : "text-terminal-orange"}`}>
          {displayToolName(scene.toolName)}
        </span>
        <span className="truncate flex-1">{summarizeInput(scene.toolName, scene.input)}</span>
        {scene.subAgent && <AgentTypeBadge type={scene.subAgent.agentType} />}
        {scene.isError && <ErrorBadge />}
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
      />
    );
  }

  // Special rendering for Edit/Write with diff
  if (scene.diff) {
    return (
      <CodeDiffBlock
        toolName={scene.toolName}
        filePath={scene.diff.filePath}
        oldContent={scene.diff.oldContent}
        newContent={scene.diff.newContent}
        isActive={isActive}
        isError={scene.isError}
      />
    );
  }

  // Agent tool call with subagent data — rendered with prominent TASK header,
  // agent-color left border, and inline scene rendering when expanded.
  if (scene.toolName === "Agent" && scene.subAgent) {
    const sa = scene.subAgent;
    const accent = agentAccent(sa.agentType);
    const totalTok = subAgentTotalTokens(sa);
    const totalDur = subAgentTotalDurationMs(sa);
    const description = sa.description || (scene.input.description as string) || "";
    return (
      <div>
        <div
          className={`bg-terminal-surface rounded-xl overflow-hidden shadow-layer-sm border-l-4 ${accent.border}`}
        >
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full flex flex-col gap-1.5 px-3 py-2.5 bg-terminal-surface hover:bg-terminal-surface-hover transition-colors duration-200 ease-material text-left"
          >
            <div className="flex items-center gap-2 flex-wrap">
              <TaskBadge />
              <AgentTypeBadge type={sa.agentType} />
              {sa.model && (
                <span className="text-[10px] text-terminal-dim font-mono">{sa.model}</span>
              )}
              <span className="text-[10px] text-terminal-dim font-mono">{sa.toolCalls} tools</span>
              {sa.thinkingBlocks > 0 && (
                <span className="text-[10px] text-terminal-dim font-mono">
                  {sa.thinkingBlocks} thinking
                </span>
              )}
              <span className="flex-1" />
              {totalTok > 0 && (
                <span
                  className="text-[10px] text-terminal-purple font-mono font-bold"
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
            </div>
            {description && (
              <div className="text-xs text-terminal-text/90 font-mono">{description}</div>
            )}
          </button>
          {expanded && <SubAgentView subAgent={sa} />}
        </div>
      </div>
    );
  }

  // Generic tool call
  const errorRing = scene.isError ? "ring-1 ring-red-500/40 border-l-2 border-l-red-500" : "";
  const errorBg = scene.isError ? "bg-red-500/5" : "";
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
            className={`text-xs font-mono font-bold ${scene.isError ? "text-red-400" : "text-terminal-orange"}`}
          >
            {displayToolName(scene.toolName)}
          </span>
          <span className="text-xs text-terminal-dim font-mono truncate flex-1">
            {summarizeInput(scene.toolName, scene.input)}
          </span>
          {scene.isError && <ErrorBadge />}
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
            {scene.result && (
              <div className="px-3 py-2 border-t border-terminal-border-subtle">
                <div className="text-xs text-terminal-dim font-mono mb-1">Result:</div>
                <pre className="text-xs text-terminal-text font-mono whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
                  {scene.result}
                </pre>
              </div>
            )}
            {scene.images && scene.images.length > 0 && (
              <div className="px-3 py-2 border-t border-terminal-border-subtle">
                <div className="flex gap-2 flex-wrap">
                  {scene.images.map((src, i) => (
                    <img
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

function summarizeInput(name: string, input: Record<string, any>): string {
  switch (name) {
    case "Read":
      return input.file_path || "";
    case "Glob":
      return input.pattern || "";
    case "Grep":
      return `/${input.pattern || ""}/ ${input.path || ""}`;
    case "Agent":
      return input.description || "";
    case "Write":
      return input.file_path || "";
    case "Edit":
      return input.file_path || "";
    case "WebSearch":
      return input.query || "";
    case "WebFetch":
      return input.url || "";
    default:
      return Object.values(input)
        .filter((v) => typeof v === "string")
        .join(" ")
        .slice(0, 80);
  }
}
