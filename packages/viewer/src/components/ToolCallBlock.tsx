import { memo, useState } from "react";
import type { Scene, SubAgent } from "../types";
import { displayToolName } from "../utils/toolName";
import BashBlock from "./BashBlock";
import CodeDiffBlock from "./CodeDiffBlock";
import { formatDuration } from "./StatsPanel";

function ToolDuration({ ms }: { ms?: number }) {
  if (!ms) return null;
  const label = formatDuration(ms);
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

type ToolScene = Extract<Scene, { type: "tool-call" }>;

interface Props {
  scene: ToolScene;
  isActive: boolean;
  forceCollapse?: boolean;
}

function toolIcon(name: string): string {
  if (name.startsWith("mcp__")) return "\uD83D\uDD0C"; // 🔌
  switch (name) {
    case "Read":
      return "\uD83D\uDCC4";
    case "Write":
      return "\u270F\uFE0F";
    case "Edit":
      return "\u2702\uFE0F";
    case "Delete":
      return "\uD83D\uDDD1\uFE0F";
    case "Bash":
      return "$";
    case "Glob":
      return "\uD83D\uDD0D";
    case "Grep":
      return "\uD83D\uDD0E";
    case "Agent":
      return "\uD83E\uDD16";
    default:
      return "\u2699\uFE0F";
  }
}

const AGENT_TYPE_COLORS: Record<string, string> = {
  Explore: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  Plan: "bg-purple-500/20 text-purple-300 border-purple-500/30",
  Shell: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  "general-purpose": "bg-green-500/20 text-green-300 border-green-500/30",
  "claude-code-guide": "bg-amber-500/20 text-amber-300 border-amber-500/30",
};

function AgentTypeBadge({ type }: { type: string }) {
  const colors = AGENT_TYPE_COLORS[type] || "bg-gray-500/20 text-gray-300 border-gray-500/30";
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${colors}`}>{type}</span>
  );
}

function SubAgentView({ subAgent }: { subAgent: SubAgent }) {
  const [showScenes, setShowScenes] = useState(false);
  const totalTokens = subAgent.tokenUsage
    ? subAgent.tokenUsage.inputTokens +
      subAgent.tokenUsage.outputTokens +
      subAgent.tokenUsage.cacheCreationTokens +
      subAgent.tokenUsage.cacheReadTokens
    : 0;

  return (
    <div className="border-t border-terminal-border-subtle">
      {/* Summary bar */}
      <div className="px-3 py-2 bg-terminal-surface-hover/50">
        <div className="flex items-center gap-2 flex-wrap">
          <AgentTypeBadge type={subAgent.agentType} />
          {subAgent.model && (
            <span className="text-[10px] text-terminal-dim font-mono">{subAgent.model}</span>
          )}
          <span className="text-[10px] text-terminal-dim">|</span>
          <span className="text-[10px] text-terminal-dim font-mono">
            {subAgent.toolCalls} tools
          </span>
          {subAgent.thinkingBlocks > 0 && (
            <span className="text-[10px] text-terminal-dim font-mono">
              {subAgent.thinkingBlocks} thinking
            </span>
          )}
          {subAgent.textResponses > 0 && (
            <span className="text-[10px] text-terminal-dim font-mono">
              {subAgent.textResponses} responses
            </span>
          )}
          {totalTokens > 0 && (
            <>
              <span className="text-[10px] text-terminal-dim">|</span>
              <span className="text-[10px] text-terminal-dim font-mono">
                {totalTokens > 1000000
                  ? `${(totalTokens / 1000000).toFixed(1)}M`
                  : totalTokens > 1000
                    ? `${(totalTokens / 1000).toFixed(0)}K`
                    : totalTokens}{" "}
                tokens
              </span>
            </>
          )}
        </div>
        {subAgent.description && (
          <div className="text-[11px] text-terminal-text/70 mt-1 italic">
            {subAgent.description}
          </div>
        )}
      </div>

      {/* Expandable scenes */}
      {subAgent.scenes.length > 0 && (
        <div className="border-t border-terminal-border-subtle">
          <button
            onClick={() => setShowScenes(!showScenes)}
            className="w-full px-3 py-1.5 text-left text-[11px] text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
          >
            <span
              className={`inline-block transition-transform mr-1 ${showScenes ? "rotate-90" : ""}`}
            >
              {"\u25B6"}
            </span>
            {showScenes ? "Hide" : "Show"} agent conversation ({subAgent.scenes.length} scenes)
          </button>
          {showScenes && (
            <div className="px-3 pb-2 space-y-1 max-h-[400px] overflow-y-auto">
              {subAgent.scenes.map((s, i) => (
                <SubAgentSceneItem key={i} scene={s} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SubAgentSceneItem({ scene }: { scene: Scene }) {
  const [expanded, setExpanded] = useState(false);

  if (scene.type === "thinking") {
    return (
      <div className="text-[10px] font-mono text-purple-400/60 pl-2 border-l-2 border-purple-500/20 py-0.5">
        <span className="text-purple-400/40 mr-1">[thinking]</span>
        {(scene.content || "").slice(0, 120)}
        {(scene.content || "").length > 120 ? "..." : ""}
      </div>
    );
  }

  if (scene.type === "text-response") {
    return (
      <div className="text-[10px] font-mono text-terminal-text/80 pl-2 border-l-2 border-blue-500/20 py-0.5">
        {(scene.content || "").slice(0, 200)}
        {(scene.content || "").length > 200 ? "..." : ""}
      </div>
    );
  }

  if (scene.type === "tool-call") {
    const toolScene = scene as Extract<Scene, { type: "tool-call" }>;
    return (
      <div className="pl-2 border-l-2 border-orange-500/20 py-0.5">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-[10px] font-mono w-full text-left hover:bg-terminal-surface-hover/30 rounded px-1"
        >
          <span className="text-terminal-orange font-bold">
            {displayToolName(toolScene.toolName)}
          </span>
          <span className="text-terminal-dim truncate flex-1">
            {summarizeInput(toolScene.toolName, toolScene.input)}
          </span>
          {toolScene.isError && <span className="text-red-400 text-[9px]">ERR</span>}
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

  // When force-collapsing, show a one-liner summary for all tool types
  if (forceCollapse) {
    return (
      <div className="flex items-center gap-2 px-3 py-1 text-xs font-mono text-terminal-dim">
        <span>{toolIcon(scene.toolName)}</span>
        <span className="text-terminal-orange font-bold">{displayToolName(scene.toolName)}</span>
        <span className="truncate">{summarizeInput(scene.toolName, scene.input)}</span>
        {scene.subAgent && <AgentTypeBadge type={scene.subAgent.agentType} />}
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
      />
    );
  }

  // Agent tool call with subagent data — special rendering
  if (scene.toolName === "Agent" && scene.subAgent) {
    return (
      <div>
        <div className="bg-terminal-surface rounded-xl overflow-hidden shadow-layer-sm">
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-full flex items-center gap-2 px-3 py-2 bg-terminal-surface hover:bg-terminal-surface-hover transition-colors duration-200 ease-material text-left"
          >
            <span className="text-xs font-mono">{toolIcon("Agent")}</span>
            <span className="text-xs font-mono font-bold text-terminal-orange">Agent</span>
            <AgentTypeBadge type={scene.subAgent.agentType} />
            <span className="text-xs text-terminal-dim font-mono truncate flex-1">
              {scene.subAgent.description || scene.input.description || ""}
            </span>
            <span className="text-[10px] text-terminal-dim font-mono">
              {scene.subAgent.toolCalls} tools
            </span>
            <ToolDuration ms={scene.durationMs} />
            <span
              className={`text-xs text-terminal-dim transition-transform ${expanded ? "rotate-90" : ""}`}
            >
              {"\u25B6"}
            </span>
          </button>
          {expanded && <SubAgentView subAgent={scene.subAgent} />}
        </div>
      </div>
    );
  }

  // Generic tool call
  return (
    <div>
      <div className="bg-terminal-surface rounded-xl overflow-hidden shadow-layer-sm">
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3 py-2 bg-terminal-surface hover:bg-terminal-surface-hover transition-colors duration-200 ease-material text-left"
        >
          <span className="text-xs font-mono">{toolIcon(scene.toolName)}</span>
          <span className="text-xs font-mono font-bold text-terminal-orange">
            {displayToolName(scene.toolName)}
          </span>
          <span className="text-xs text-terminal-dim font-mono truncate flex-1">
            {summarizeInput(scene.toolName, scene.input)}
          </span>
          <ToolDuration ms={scene.durationMs} />
          <span
            className={`text-xs text-terminal-dim transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            {"\u25B6"}
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
