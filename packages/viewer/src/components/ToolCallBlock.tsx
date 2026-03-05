import { useState } from "react";
import type { Scene } from "../types";
import CodeDiffBlock from "./CodeDiffBlock";
import BashBlock from "./BashBlock";

type ToolScene = Extract<Scene, { type: "tool-call" }>;

interface Props {
  scene: ToolScene;
  isActive: boolean;
  forceCollapse?: boolean;
}

function toolIcon(name: string): string {
  switch (name) {
    case "Read": return "\uD83D\uDCC4";
    case "Write": return "\u270F\uFE0F";
    case "Edit": return "\u2702\uFE0F";
    case "Bash": return "$";
    case "Glob": return "\uD83D\uDD0D";
    case "Grep": return "\uD83D\uDD0E";
    case "Agent": return "\uD83E\uDD16";
    default: return "\u2699\uFE0F";
  }
}

export default function ToolCallBlock({ scene, isActive, forceCollapse }: Props) {
  const [expanded, setExpanded] = useState(false);

  // When force-collapsing, show a one-liner summary for all tool types
  if (forceCollapse) {
    return (
      <div className="flex items-center gap-2 px-3 py-1 text-xs font-mono text-terminal-dim">
        <span>{toolIcon(scene.toolName)}</span>
        <span className="text-terminal-orange font-bold">{scene.toolName}</span>
        <span className="truncate">{summarizeInput(scene.toolName, scene.input)}</span>
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

  // Generic tool call
  return (
    <div>
      <div
        className="border border-terminal-border rounded-lg overflow-hidden"
      >
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-2 px-3 py-2 bg-terminal-surface hover:bg-terminal-border/30 transition-colors text-left"
        >
          <span className="text-xs font-mono">{toolIcon(scene.toolName)}</span>
          <span className="text-xs font-mono font-bold text-terminal-orange">
            {scene.toolName}
          </span>
          <span className="text-xs text-terminal-dim font-mono truncate flex-1">
            {summarizeInput(scene.toolName, scene.input)}
          </span>
          <span
            className={`text-xs text-terminal-dim transition-transform ${expanded ? "rotate-90" : ""}`}
          >
            {"\u25B6"}
          </span>
        </button>
        {expanded && (
          <div className="border-t border-terminal-border">
            <div className="px-3 py-2">
              <div className="text-xs text-terminal-dim font-mono mb-1">Input:</div>
              <pre className="text-xs text-terminal-text font-mono whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
                {JSON.stringify(scene.input, null, 2)}
              </pre>
            </div>
            {scene.result && (
              <div className="px-3 py-2 border-t border-terminal-border">
                <div className="text-xs text-terminal-dim font-mono mb-1">Result:</div>
                <pre className="text-xs text-terminal-text font-mono whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
                  {scene.result}
                </pre>
              </div>
            )}
            {scene.images && scene.images.length > 0 && (
              <div className="px-3 py-2 border-t border-terminal-border">
                <div className="flex gap-2 flex-wrap">
                  {scene.images.map((src, i) => (
                    <img
                      key={i}
                      src={src}
                      alt={`Screenshot ${i + 1}`}
                      className="max-w-[400px] max-h-[300px] rounded border border-terminal-border object-contain"
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
}

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
      return Object.values(input).filter(v => typeof v === "string").join(" ").slice(0, 80);
  }
}
