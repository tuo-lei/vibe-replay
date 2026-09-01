import type { Scene } from "../types";

/** Categories used to identify the local work represented by a tool call. */
export type ToolCategory = "test" | "lint" | "build" | "check" | "file" | "other";

export type ToolScope = "local" | "remote" | "unknown";

/**
 * A timed interval that can be represented without inventing a wall-clock
 * duration. Timestamp gaps have a real recorded length, but their activity
 * role is inferred from the surrounding replay events.
 */
export interface ActivityInterval {
  kind: "llm-wait" | "response" | "tool" | "unknown";
  durationMs: number;
  sceneIndex: number;
  source: "timestamp-gap" | "tool-duration";
  confidence: "inferred" | "measured";
  note?: "unmeasured-tool" | "context-boundary";
  toolName?: string;
  toolCategory?: ToolCategory;
  toolScope?: ToolScope;
}

export interface ContextBoundary {
  sceneIndex: number;
  elapsedMs: number;
  type: "compaction-summary" | "context-injection";
}

export interface ToolCategoryTotal {
  durationMs: number;
  count: number;
}

export interface ActivityTimingResult {
  intervals: ActivityInterval[];
  contextBoundaries: ContextBoundary[];
  thinkingCount: number;
  totalMs: number;
  timestampGapMs: number;
  /** User-away gaps are intentionally excluded from the activity timeline. */
  excludedIdleMs: number;
  toolDurationMs: number;
  toolCalls: number;
  recordedToolCalls: number;
  unmeasuredToolCalls: number;
  localToolMs: number;
  remoteToolMs: number;
  unknownToolMs: number;
  toolCategories: Record<ToolCategory, ToolCategoryTotal>;
}

type PreviousEvent = "user" | "assistant" | "tool" | "context";

interface ToolDescriptor {
  category: ToolCategory;
  scope: ToolScope;
  command?: string;
}

const EMPTY_TOOL_CATEGORIES: Record<ToolCategory, ToolCategoryTotal> = {
  test: { durationMs: 0, count: 0 },
  lint: { durationMs: 0, count: 0 },
  build: { durationMs: 0, count: 0 },
  check: { durationMs: 0, count: 0 },
  file: { durationMs: 0, count: 0 },
  other: { durationMs: 0, count: 0 },
};

const LOCAL_TOOL_NAMES = new Set([
  "apply_patch",
  "bash",
  "cat",
  "edit",
  "exec_command",
  "file",
  "find",
  "glob",
  "grep",
  "ls",
  "multiedit",
  "read",
  "run_in_terminal",
  "run_terminal_cmd",
  "shell",
  "terminal",
  "write",
]);

const REMOTE_TOOL_PREFIXES = ["browser", "fetch", "http", "mcp", "search", "web"];

const FILE_TOOL_NAMES = new Set([
  "apply_patch",
  "edit",
  "file",
  "glob",
  "grep",
  "ls",
  "read",
  "write",
]);

function emptyToolCategories(): Record<ToolCategory, ToolCategoryTotal> {
  return Object.fromEntries(
    Object.entries(EMPTY_TOOL_CATEGORIES).map(([category, total]) => [category, { ...total }]),
  ) as Record<ToolCategory, ToolCategoryTotal>;
}

function timestampMs(scene: Scene): number | undefined {
  if (!scene.timestamp) return undefined;
  const parsed = Date.parse(scene.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizedToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function inputString(input: Record<string, any>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function commandCategory(toolName: string, input: Record<string, any>): ToolCategory {
  const name = normalizedToolName(toolName);
  const command = inputString(input, ["command", "cmd", "script", "action"]);
  const text = `${name} ${command || ""}`.toLowerCase();

  if (/\b(test|tests|jest|vitest|pytest|unittest|spec)\b/.test(text)) return "test";
  if (/\b(lint|linting|format|fmt|prettier|oxlint|eslint)\b/.test(text)) return "lint";
  if (/\b(build|compile|bundle|webpack|vite|tsc)\b/.test(text)) return "build";
  if (/\b(typecheck|check|verify)\b/.test(text)) return "check";
  if (FILE_TOOL_NAMES.has(name)) return "file";
  return "other";
}

function toolDescriptor(toolName: string, input: Record<string, any>): ToolDescriptor {
  const name = normalizedToolName(toolName);
  const command = inputString(input, ["command", "cmd", "script", "action"]);
  if (LOCAL_TOOL_NAMES.has(name)) {
    return {
      category: commandCategory(toolName, input),
      scope: "local",
      ...(command ? { command } : {}),
    };
  }
  if (REMOTE_TOOL_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}_`))) {
    return {
      category: commandCategory(toolName, input),
      scope: "remote",
      ...(command ? { command } : {}),
    };
  }
  return {
    category: commandCategory(toolName, input),
    scope: "unknown",
    ...(command ? { command } : {}),
  };
}

function addToolCategory(
  categories: Record<ToolCategory, ToolCategoryTotal>,
  category: ToolCategory,
  durationMs: number,
): void {
  categories[category].durationMs += durationMs;
  categories[category].count++;
}

function gapKind(
  scene: Scene,
  previous: PreviousEvent | undefined,
  hasUnmeasuredTool: boolean,
): { kind: ActivityInterval["kind"] | "user-idle"; note?: ActivityInterval["note"] } {
  if (scene.type === "compaction-summary" || scene.type === "context-injection") {
    // The boundary timestamp proves that context changed, not how long the
    // compaction itself took. Keep the preceding gap unattributed.
    return { kind: "unknown", note: "context-boundary" };
  }
  if (hasUnmeasuredTool) {
    // A gap after a tool without a provider duration may contain both tool
    // execution and the following model request. Do not call all of it LLM
    // latency or all of it local execution.
    return { kind: "unknown", note: "unmeasured-tool" };
  }
  if (scene.type === "user-prompt") return { kind: "user-idle" };
  if (previous === "assistant") return { kind: "response" };
  return { kind: "llm-wait" };
}

/**
 * Build non-overlapping, confidence-labeled activity intervals from replay
 * scenes. The function intentionally does not use playback heuristics for
 * response or user time: missing timestamps remain unassigned.
 */
export function buildActivityTiming(scenes: readonly Scene[]): ActivityTimingResult {
  const intervals: ActivityInterval[] = [];
  const contextBoundaries: ContextBoundary[] = [];
  const toolCategories = emptyToolCategories();
  let cursorMs: number | undefined;
  let elapsedMs = 0;
  let timestampGapMs = 0;
  let excludedIdleMs = 0;
  let toolDurationMs = 0;
  let thinkingCount = 0;
  let toolCalls = 0;
  let recordedToolCalls = 0;
  let unmeasuredToolCalls = 0;
  let localToolMs = 0;
  let remoteToolMs = 0;
  let unknownToolMs = 0;
  let previous: PreviousEvent | undefined;
  let hasUnmeasuredTool = false;

  const addInterval = (
    interval: Omit<ActivityInterval, "durationMs"> & { durationMs: number },
  ): void => {
    if (interval.durationMs <= 0) return;
    intervals.push(interval);
    elapsedMs += interval.durationMs;
    if (interval.source === "timestamp-gap") timestampGapMs += interval.durationMs;
    else toolDurationMs += interval.durationMs;
  };

  for (const [sceneIndex, scene] of scenes.entries()) {
    const atMs = timestampMs(scene);

    if (atMs !== undefined && cursorMs !== undefined && atMs > cursorMs) {
      const durationMs = atMs - cursorMs;
      const gap = gapKind(scene, previous, hasUnmeasuredTool);
      if (gap.kind === "user-idle") {
        // Time between turns mostly measures how long the user was away from
        // the computer, not how the agent spent the session. Keep the cursor
        // moving but leave this interval out of the activity visualization.
        excludedIdleMs += durationMs;
      } else {
        addInterval({
          kind: gap.kind,
          durationMs,
          sceneIndex,
          source: "timestamp-gap",
          confidence: "inferred",
          ...(gap.note ? { note: gap.note } : {}),
        });
      }
      cursorMs = atMs;
      hasUnmeasuredTool = false;
    }

    if (scene.type === "compaction-summary" || scene.type === "context-injection") {
      contextBoundaries.push({ sceneIndex, elapsedMs, type: scene.type });
      if (atMs !== undefined) cursorMs = Math.max(cursorMs ?? atMs, atMs);
      previous = "context";
    } else if (scene.type === "tool-call") {
      toolCalls++;
      const descriptor = toolDescriptor(scene.toolName, scene.input);
      const hasDuration = scene.durationMs !== undefined && scene.durationMs > 0;

      if (hasDuration) {
        const durationMs = scene.durationMs!;
        const startMs = atMs !== undefined ? Math.max(cursorMs ?? atMs, atMs) : cursorMs;
        addInterval({
          kind: "tool",
          durationMs,
          sceneIndex,
          source: "tool-duration",
          confidence: "measured",
          toolName: scene.toolName,
          toolCategory: descriptor.category,
          toolScope: descriptor.scope,
        });
        recordedToolCalls++;
        addToolCategory(toolCategories, descriptor.category, durationMs);
        if (descriptor.scope === "local") localToolMs += durationMs;
        else if (descriptor.scope === "remote") remoteToolMs += durationMs;
        else unknownToolMs += durationMs;
        if (startMs !== undefined) cursorMs = startMs + durationMs;
      } else {
        unmeasuredToolCalls++;
        hasUnmeasuredTool = true;
      }
      if (atMs !== undefined) cursorMs = Math.max(cursorMs ?? atMs, atMs);
      previous = "tool";
    } else {
      if (scene.type === "thinking") thinkingCount++;
      if (atMs !== undefined) cursorMs = Math.max(cursorMs ?? atMs, atMs);
      previous = scene.type === "user-prompt" ? "user" : "assistant";
    }
  }

  return {
    intervals,
    contextBoundaries,
    thinkingCount,
    totalMs: elapsedMs,
    timestampGapMs,
    excludedIdleMs,
    toolDurationMs,
    toolCalls,
    recordedToolCalls,
    unmeasuredToolCalls,
    localToolMs,
    remoteToolMs,
    unknownToolMs,
    toolCategories,
  };
}
