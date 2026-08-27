import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { estimateActiveDuration } from "@vibe-replay/provider-core/duration";
import type { ContentBlock, ParsedTurn, SessionInfo } from "@vibe-replay/provider-contract";
import type { Compaction, ProviderParseResult, TokenUsage } from "@vibe-replay/provider-contract";
import { addParseWarning } from "@vibe-replay/provider-contract/warnings";
import { codexStripTwoPass, contentText, isCodexToolCallType } from "./constants.js";

interface PendingTool {
  id: string;
  name: string;
  input: Record<string, any>;
  timestamp?: string;
}

interface ToolResult {
  result: string;
  isError?: boolean;
  timestamp?: string;
  durationMs?: number;
}

interface CodexTokenInfo {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

interface CodexTokenSnapshot {
  timestamp?: string;
  total?: CodexTokenInfo;
  last?: CodexTokenInfo;
  contextLimit?: number;
}

function asCodexTokenInfo(value: unknown): CodexTokenInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as CodexTokenInfo;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export async function parseCodexSession(
  filePaths: string | string[],
  sessionInfo?: SessionInfo,
): Promise<ProviderParseResult> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const lines: string[] = [];
  for (const fp of paths) {
    const content = await readFile(fp, "utf-8");
    lines.push(...content.split("\n"));
  }
  return parseCodexLines(lines, sessionInfo, paths);
}

export function parseCodexLines(
  lines: string[],
  sessionInfo?: SessionInfo,
  sourcePaths: string[] = [],
): ProviderParseResult {
  let sessionId = sessionInfo?.sessionId || "";
  let slug = sessionInfo?.slug || "";
  let title = sessionInfo?.title;
  let cwd = sessionInfo?.cwd || "";
  let model = sessionInfo?.model;
  let startTime: string | undefined;
  let endTime: string | undefined;
  let gitBranch = sessionInfo?.gitBranch;
  let entrypoint: string | undefined;
  let permissionMode: string | undefined;
  let approvalPolicy: string | undefined;
  let memoryMode: string | undefined;

  const turns: ParsedTurn[] = [];
  const allTimestamps: string[] = [];
  const compactions: Compaction[] = [];
  const tools = new Map<string, PendingTool>();
  const toolResults = new Map<string, ToolResult>();
  const tokenSnapshots: CodexTokenSnapshot[] = [];
  const taskDurations: number[] = [];
  const mcpServersUsed = new Set<string>();
  const gitBranches: string[] = [];
  const seenUserMessages = new Map<string, number[]>();
  const seenAssistantMessages = new Map<string, number[]>();
  const parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]> = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      addParseWarning(parseWarnings, {
        kind: "malformed-json",
        source: "codex JSONL",
        firstLine: lineIndex + 1,
        message: "Skipped malformed JSONL line",
        sample: line,
      });
      continue;
    }
    if (!obj || typeof obj !== "object") continue;

    if (obj.timestamp) {
      allTimestamps.push(obj.timestamp);
      endTime = obj.timestamp;
      if (!startTime) startTime = obj.timestamp;
    }

    if (obj.type === "session_meta") {
      const p = obj.payload || {};
      sessionId = sessionId || p.id || "";
      slug = slug || (sessionId ? sessionId.slice(0, 8) : "");
      cwd = cwd || p.cwd || "";
      if (p.timestamp) startTime = startTime || p.timestamp;
      gitBranch = gitBranch || p.git?.branch || p.git_branch;
      if (gitBranch) pushUnique(gitBranches, gitBranch);
      entrypoint = entrypoint || p.originator || p.source;
      memoryMode = memoryMode || asOptionalString(p.memory_mode);
      continue;
    }

    if (obj.type === "turn_context") {
      const p = obj.payload || {};
      model = model || p.model;
      permissionMode = permissionMode || p.permission_profile?.type || p.sandbox_policy?.type;
      approvalPolicy = approvalPolicy || p.approval_policy;
      continue;
    }

    if (obj.type === "event_msg") {
      const p = obj.payload || {};
      if (p.type === "thread_name_updated" && p.thread_name && !sessionInfo?.title?.trim()) {
        title = p.thread_name;
        continue;
      }
      if (p.type === "user_message") {
        const blocks = userMessageBlocks(p);
        const text = textFromBlocks(blocks);
        if (blocks.length > 0 && shouldRecordMessage(seenUserMessages, obj.timestamp, blocks)) {
          turns.push({
            role: "user",
            ...(isCompactionSummaryText(text) ? { subtype: "compaction-summary" as const } : {}),
            timestamp: obj.timestamp,
            blocks,
          });
        }
        continue;
      }
      if (
        p.type === "agent_message" &&
        typeof p.message === "string" &&
        p.message.trim().length > 0
      ) {
        const blocks: ContentBlock[] = [{ type: "text", text: p.message }];
        if (!shouldRecordMessage(seenAssistantMessages, obj.timestamp, blocks)) continue;
        turns.push({
          role: "assistant",
          timestamp: obj.timestamp,
          blocks,
        });
        continue;
      }
      if (p.type === "agent_reasoning" && typeof p.text === "string" && p.text.trim()) {
        turns.push({
          role: "assistant",
          timestamp: obj.timestamp,
          blocks: [{ type: "thinking", thinking: p.text }],
        });
        continue;
      }
      if (p.type === "exec_command_end" && p.call_id) {
        if (!tools.has(p.call_id)) {
          tools.set(p.call_id, {
            id: p.call_id,
            name: "exec_command",
            input: p.command || p.action || {},
            timestamp: obj.timestamp,
          });
        }
        mergeToolResult(toolResults, p.call_id, {
          result: formatExecResult(p),
          isError: typeof p.exit_code === "number" ? p.exit_code !== 0 : undefined,
          timestamp: obj.timestamp,
          durationMs: durationToMs(p.duration),
        });
        continue;
      }
      if (p.type === "token_count") {
        tokenSnapshots.push({
          timestamp: obj.timestamp,
          total: asCodexTokenInfo(p.info?.total_token_usage),
          last: asCodexTokenInfo(p.info?.last_token_usage),
          contextLimit:
            typeof p.info?.model_context_window === "number"
              ? p.info.model_context_window
              : undefined,
        });
        continue;
      }
      if (p.type === "task_complete" && typeof p.duration_ms === "number") {
        if (p.duration_ms > 0) taskDurations.push(p.duration_ms);
        continue;
      }
      if (p.type === "context_compacted") {
        recordCompaction(compactions, obj.timestamp || "", "codex-context");
        continue;
      }
      if (p.type === "patch_apply_end" && p.call_id) {
        const tool = tools.get(p.call_id);
        const changedFiles = patchApplyChangedFiles(p);
        if (!tool) {
          tools.set(p.call_id, {
            id: p.call_id,
            name: "apply_patch",
            input: {},
            timestamp: obj.timestamp,
          });
        }
        if (tool && changedFiles.length > 0) {
          tool.input = mergeToolFilePaths(tool.input, changedFiles);
        }
        mergeToolResult(toolResults, p.call_id, {
          result: formatPatchApplyResult(p),
          isError: typeof p.success === "boolean" ? !p.success : undefined,
          timestamp: obj.timestamp,
        });
        continue;
      }
      if (p.type === "web_search_end") {
        const callId =
          (p.call_id && tools.has(p.call_id) ? p.call_id : undefined) ||
          findWebSearchToolId(tools, toolResults, p, obj.timestamp) ||
          p.call_id ||
          `web_search:${obj.timestamp}`;
        if (!tools.has(callId)) {
          tools.set(callId, {
            id: callId,
            name: "web_search",
            input: p.action || { query: p.query },
            timestamp: obj.timestamp,
          });
        }
        mergeToolResult(toolResults, callId, {
          result: formatWebSearchResult(p),
          timestamp: obj.timestamp,
        });
      }
      if (p.type === "mcp_tool_call_end" && p.call_id) {
        const invocation = p.invocation || {};
        const server = typeof invocation.server === "string" ? invocation.server : "";
        const toolName = typeof invocation.tool === "string" ? invocation.tool : "";
        let tool = tools.get(p.call_id);
        if (server) {
          mcpServersUsed.add(server);
          if (!tool) {
            tool = {
              id: p.call_id,
              name: toolName ? `mcp__${server}__${toolName}` : "mcp",
              input: toolName
                ? invocation.arguments || {}
                : {
                    server,
                  },
              timestamp: obj.timestamp,
            };
            tools.set(p.call_id, tool);
          } else if (toolName) {
            tool.name = `mcp__${server}__${toolName}`;
          }
        } else if (!tool) {
          // The completion event itself proves that Codex attempted an MCP
          // invocation, even when the start payload omitted server metadata.
          tools.set(p.call_id, {
            id: p.call_id,
            name: "mcp",
            input: {},
            timestamp: obj.timestamp,
          });
        }
        mergeToolResult(toolResults, p.call_id, {
          result: formatMcpToolResult(p),
          isError: isMcpToolError(p),
          timestamp: obj.timestamp,
          durationMs: durationToMs(p.duration),
        });
      }
      continue;
    }

    if (obj.type === "compacted") {
      recordCompaction(compactions, obj.timestamp || "", "codex");
      const text = compactedSummaryText(obj.payload);
      if (text) {
        turns.push({
          role: "user",
          subtype: "compaction-summary",
          timestamp: obj.timestamp,
          blocks: [{ type: "text", text }],
        });
      }
      continue;
    }

    if (obj.type !== "response_item") continue;
    const p = obj.payload || {};

    if (p.type === "message" && p.role === "developer") {
      const text = contentText(p.content);
      if (text.trim()) {
        turns.push({
          role: "user",
          subtype: "context-injection",
          timestamp: obj.timestamp,
          blocks: [{ type: "text", text }],
        });
      }
      continue;
    }

    if (p.type === "message" && p.role === "user") {
      const blocks = userMessageBlocksFromContent(p.content);
      const text = textFromBlocks(blocks);
      if (blocks.length > 0 && shouldRecordMessage(seenUserMessages, obj.timestamp, blocks)) {
        turns.push({
          role: "user",
          ...(isCompactionSummaryText(text) ? { subtype: "compaction-summary" as const } : {}),
          timestamp: obj.timestamp,
          blocks,
        });
      }
      continue;
    }

    if (p.type === "message" && p.role === "assistant") {
      const text = contentText(p.content);
      if (text.trim()) {
        const blocks: ContentBlock[] = [{ type: "text", text }];
        if (!shouldRecordMessage(seenAssistantMessages, obj.timestamp, blocks)) continue;
        turns.push({
          role: "assistant",
          timestamp: obj.timestamp,
          blocks,
        });
      }
      continue;
    }

    if (p.type === "compaction") {
      recordCompaction(compactions, obj.timestamp || "", "codex");
      continue;
    }

    if (p.type === "reasoning") {
      const thinking = reasoningText(p);
      if (thinking.trim()) {
        turns.push({
          role: "assistant",
          timestamp: obj.timestamp,
          blocks: [{ type: "thinking", thinking }],
        });
      }
      continue;
    }

    if (isCodexToolCallType(p.type)) {
      const existingWebSearchId =
        p.type === "web_search_call" && !p.call_id && !p.id
          ? findWebSearchToolId(tools, toolResults, p, obj.timestamp, { includeResolved: true })
          : undefined;
      const callId =
        p.call_id || p.id || existingWebSearchId || `${p.type}:${obj.timestamp}:${tools.size}`;
      const name = p.name || normalizeCodexToolName(p.type);
      const input = inputForResponseItem(p);
      tools.set(callId, { id: callId, name, input, timestamp: obj.timestamp });
      if (name.startsWith("mcp__")) {
        const server = name.split("__")[1];
        if (server) mcpServersUsed.add(server);
      }
      continue;
    }

    if (
      p.type === "function_call_output" ||
      p.type === "custom_tool_call_output" ||
      p.type === "tool_search_output"
    ) {
      if (p.call_id) {
        if (!tools.has(p.call_id)) {
          // Preserve orphan completions as an unknown ordinary tool rather
          // than silently losing a concrete provider event.
          tools.set(p.call_id, {
            id: p.call_id,
            name: "Unknown",
            input: {},
            timestamp: obj.timestamp,
          });
        }
        mergeToolResult(
          toolResults,
          p.call_id,
          {
            result: formatOutputPayload(p),
            timestamp: obj.timestamp,
          },
          { preferExistingResult: true },
        );
      }
      continue;
    }
  }

  for (const tool of tools.values()) {
    const tr = toolResults.get(tool.id);
    turns.push({
      role: "assistant",
      timestamp: tool.timestamp,
      blocks: [
        {
          type: "tool_use",
          id: tool.id,
          name: normalizeToolName(tool.name),
          input: normalizeToolInput(tool.name, tool.input),
          _hasResult: toolResults.has(tool.id),
          _result: tr?.result || "",
          ...(tr?.isError ? { _isError: true } : {}),
          ...(tr?.durationMs ? { _durationMs: tr.durationMs } : {}),
        },
      ],
    });
  }

  turns.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));

  const tokenUsage = tokenUsageFromSnapshots(tokenSnapshots);
  const contextLimit = [...tokenSnapshots].toReversed().find((s) => s.contextLimit)?.contextLimit;
  const tokenUsageByModel =
    tokenUsage && model
      ? {
          [model]: tokenUsage,
        }
      : undefined;
  const turnStats = buildCodexTurnStats(turns, tokenSnapshots, taskDurations, model);
  const summedTaskDurationMs = taskDurations.reduce((sum, duration) => sum + duration, 0);
  const userPromptTurnCount = turns.filter((turn) => turn.role === "user" && !turn.subtype).length;
  const completeTaskDurationMs =
    userPromptTurnCount > 0 && taskDurations.length >= userPromptTurnCount
      ? summedTaskDurationMs
      : undefined;

  return {
    sessionId,
    slug: slug || sessionId.slice(0, 8),
    title,
    cwd,
    model,
    startTime,
    endTime,
    totalDurationMs: completeTaskDurationMs || estimateActiveDuration(allTimestamps),
    turns,
    tokenUsage,
    tokenUsageByModel,
    compactions: compactions.length > 0 ? compactions : undefined,
    turnStats: turnStats.length > 0 ? turnStats : undefined,
    contextLimit,
    gitBranch,
    gitBranches: gitBranches.length > 1 ? gitBranches : undefined,
    entrypoint,
    permissionMode: approvalPolicy || permissionMode,
    memoryMode,
    mcpServersUsed: mcpServersUsed.size > 0 ? [...mcpServersUsed].sort() : undefined,
    dataSource: "jsonl",
    dataSourceInfo: {
      primary: "jsonl",
      sources: ["~/.codex/state_5.sqlite", "~/.codex/sessions"],
      supplements: sourcePaths,
      notes: ["Discovered from Codex state and parsed from rollout JSONL (local beta)."],
    },
    parseWarnings: parseWarnings.length > 0 ? parseWarnings : undefined,
  };
}

function userMessageBlocks(payload: any): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const text = typeof payload.message === "string" ? normalizeUserMessageText(payload.message) : "";
  if (text) blocks.push({ type: "text", text });

  const imageUrls = [...(Array.isArray(payload.images) ? payload.images : [])].filter(
    (v) => typeof v === "string" && v.trim(),
  );
  const localImages = (Array.isArray(payload.local_images) ? payload.local_images : [])
    .filter((v: unknown): v is string => typeof v === "string" && !!v.trim())
    .map((v: string) => localImageToDataUrl(v))
    .filter((v: string | undefined): v is string => !!v);
  imageUrls.push(...localImages);
  if (imageUrls.length > 0) blocks.push({ type: "_user_images", images: imageUrls });
  return blocks;
}

function userMessageBlocksFromContent(content: any): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const text = normalizeUserMessageText(contentText(content));
  if (text) blocks.push({ type: "text", text });

  const images = contentImages(content);
  if (images.length > 0) blocks.push({ type: "_user_images", images });
  return blocks;
}

function textFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is ContentBlock & { type: "text" } => block.type === "text")
    .map((block) => block.text || "")
    .join("\n")
    .trim();
}

function shouldRecordMessage(
  seen: Map<string, number[]>,
  timestamp: string | undefined,
  blocks: ContentBlock[],
): boolean {
  const key = messageDedupeKey(blocks);
  const time = timestamp ? Date.parse(timestamp) : Number.NaN;
  const previous = seen.get(key) || [];
  const isDuplicate = Number.isNaN(time)
    ? previous.length > 0
    : previous.some((prev) => Math.abs(time - prev) <= 2_000);
  if (isDuplicate) return false;
  seen.set(key, [...previous, Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time]);
  return true;
}

function messageDedupeKey(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text") return `text:${block.text || ""}`;
      if (block.type === "_user_images") {
        return `images:${block.images.map(imageDedupeKey).join(",")}`;
      }
      return `block:${block.type}`;
    })
    .join("|");
}

function imageDedupeKey(image: string): string {
  return `${image.slice(0, 64)}:${image.length}:${image.slice(-32)}`;
}

function isCompactionSummaryText(text: string): boolean {
  // Codex-native compactions emit `response_item.compaction`; this keeps
  // compatibility with imported/bridged transcripts that use Claude's preamble.
  return text.startsWith("This session is being continued from a previous conversation");
}

function contentImages(content: any): string[] {
  if (!Array.isArray(content)) return [];
  const images: string[] = [];
  for (const part of content) {
    if (part?.type !== "input_image" && part?.type !== "image" && part?.type !== "local_image") {
      continue;
    }
    const imageUrl =
      typeof part.image_url === "string"
        ? part.image_url
        : typeof part.image_url?.url === "string"
          ? part.image_url.url
          : typeof part.source?.data === "string"
            ? `data:${part.source.media_type || "image/png"};base64,${part.source.data}`
            : typeof part.path === "string"
              ? localImageToDataUrl(part.path) || ""
              : "";
    if (imageUrl) images.push(imageUrl);
  }
  return images;
}

function reasoningText(payload: any): string {
  if (typeof payload.content === "string") return payload.content;
  if (Array.isArray(payload.content)) return contentText(payload.content);
  if (Array.isArray(payload.summary)) return contentText(payload.summary);
  return "";
}

function parseArguments(value: any): Record<string, any> {
  if (!value) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return { value };
  if (!value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { value };
  }
}

function inputForResponseItem(payload: any): Record<string, any> {
  if (payload.type === "local_shell_call") {
    return localShellActionInput(payload.action);
  }
  if (payload.type === "custom_tool_call") {
    return parseArguments(payload.input);
  }
  if (payload.type === "image_generation_call") {
    return {
      status: payload.status,
      revised_prompt: payload.revised_prompt,
      result: payload.result,
    };
  }
  return parseArguments(payload.arguments ?? payload.action ?? {});
}

function patchApplyChangedFiles(payload: any): string[] {
  const changes = payload?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return [];
  return Object.keys(changes).filter((file) => file.trim().length > 0);
}

function mergeToolFilePaths(input: Record<string, any>, filePaths: string[]): Record<string, any> {
  const unique = [...new Set(filePaths)];
  if (unique.length === 0) return input;
  return {
    ...input,
    file_paths: unique,
    ...(input.file_path || unique.length !== 1 ? {} : { file_path: unique[0] }),
  };
}

function localShellActionInput(action: any): Record<string, any> {
  const command = Array.isArray(action?.command)
    ? action.command.map(String).join(" ")
    : typeof action?.command === "string"
      ? action.command
      : "";
  return {
    command,
    cmd: command,
    workdir: action?.working_directory || undefined,
    timeout_ms: action?.timeout_ms ?? undefined,
    env: action?.env ?? undefined,
    user: action?.user ?? undefined,
  };
}

function normalizeCodexToolName(type: string): string {
  if (type === "local_shell_call") return "Bash";
  if (type === "custom_tool_call") return "custom_tool";
  if (type === "tool_search_call") return "tool_search";
  if (type === "web_search_call") return "web_search";
  if (type === "image_generation_call") return "image_generation";
  return type;
}

function normalizeToolName(name: string): string {
  if (name === "exec_command") return "Bash";
  if (name === "apply_patch" || name === "edit") return "Edit";
  if (name === "write_file") return "Write";
  return name;
}

function normalizeToolInput(name: string, input: Record<string, any>): Record<string, any> {
  if (name === "exec_command" && typeof input.cmd === "string" && !input.command) {
    return { ...input, command: input.cmd };
  }
  return input;
}

function formatExecResult(payload: any): string {
  const output = payload.aggregated_output || payload.stdout || payload.stderr || "";
  const status = payload.status ? `Status: ${payload.status}` : "";
  const exit = typeof payload.exit_code === "number" ? `Exit code: ${payload.exit_code}` : "";
  return [output, status, exit].filter(Boolean).join("\n");
}

function formatPatchApplyResult(payload: any): string {
  const status = payload.status ? `Status: ${payload.status}` : "";
  const stdout = payload.stdout || "";
  const stderr = payload.stderr || "";
  const files = patchApplyChangedFiles(payload);
  const changed =
    files.length > 0 ? `Changed files:\n${files.map((file) => `- ${file}`).join("\n")}` : "";
  return [stdout, stderr, status, changed].filter(Boolean).join("\n");
}

function formatWebSearchResult(payload: any): string {
  if (typeof payload.query === "string" && payload.query.trim()) {
    return `[Search: ${payload.query}]`;
  }
  const action = payload.action || {};
  if (typeof action.url === "string" && action.url.trim()) return `[Open: ${action.url}]`;
  if (typeof action.pattern === "string" && action.pattern.trim())
    return `[Find: ${action.pattern}]`;
  if (typeof action.query === "string" && action.query.trim()) return `[Search: ${action.query}]`;
  if (typeof action.type === "string" && action.type.trim()) return `[Web search: ${action.type}]`;
  return "[Web search]";
}

function formatOutputPayload(payload: any): string {
  if (typeof payload.output === "string") return payload.output;
  if (Array.isArray(payload.output)) return formatContentItems(payload.output);
  if (payload.tools) return JSON.stringify(payload.tools, null, 2);
  if (payload.action) return JSON.stringify(payload.action, null, 2);
  return JSON.stringify(payload);
}

function mergeToolResult(
  toolResults: Map<string, ToolResult>,
  callId: string,
  next: ToolResult,
  options: { preferExistingResult?: boolean } = {},
): void {
  const previous = toolResults.get(callId);
  if (!previous) {
    toolResults.set(callId, next);
    return;
  }

  toolResults.set(callId, {
    result:
      options.preferExistingResult && previous.result
        ? previous.result
        : next.result || previous.result,
    isError: next.isError ?? previous.isError,
    timestamp: next.timestamp || previous.timestamp,
    durationMs: next.durationMs ?? previous.durationMs,
  });
}

function formatMcpToolResult(payload: any): string {
  const result = payload.result?.Ok ?? payload.result?.Err ?? payload.result;
  if (result?.content) return formatContentItems(result.content);
  if (typeof result === "string") return result;
  return result ? JSON.stringify(result, null, 2) : "";
}

function isMcpToolError(payload: any): boolean {
  return Boolean(
    payload.isError || payload.is_error || payload.result?.Err || payload.result?.isError,
  );
}

function findWebSearchToolId(
  tools: Map<string, PendingTool>,
  toolResults: Map<string, ToolResult>,
  payload: any,
  timestamp?: string,
  options: { includeResolved?: boolean } = {},
): string | undefined {
  for (const tool of tools.values()) {
    if (tool.name !== "web_search") continue;
    if (!options.includeResolved && toolResults.has(tool.id)) continue;
    if (!sameWebSearchAction(tool.input, payload.action || { query: payload.query })) continue;
    if (!timestamp || !tool.timestamp) return tool.id;
    const diff = Math.abs(Date.parse(timestamp) - Date.parse(tool.timestamp));
    if (!Number.isFinite(diff) || diff <= 5_000) return tool.id;
  }
  return undefined;
}

function sameWebSearchAction(a: any, b: any): boolean {
  try {
    return stableStringify(a || {}) === stableStringify(b || {});
  } catch {
    return false;
  }
}

function stableStringify(value: any): string {
  return JSON.stringify(stableNormalize(value));
}

function stableNormalize(value: any): any {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, stableNormalize(nested)]),
  );
}

function compactedSummaryText(payload: any): string {
  if (typeof payload?.message === "string" && payload.message.trim()) return payload.message.trim();
  return "";
}

function recordCompaction(compactions: Compaction[], timestamp: string, trigger: string): void {
  const time = Date.parse(timestamp);
  const duplicateIndex = compactions.findIndex((compaction) => {
    const previous = Date.parse(compaction.timestamp);
    return Number.isFinite(time) && Number.isFinite(previous)
      ? Math.abs(time - previous) <= 2_000
      : compaction.timestamp === timestamp;
  });
  if (duplicateIndex >= 0) {
    if (compactionPriority(trigger) > compactionPriority(compactions[duplicateIndex].trigger)) {
      compactions[duplicateIndex] = { ...compactions[duplicateIndex], trigger };
    }
    return;
  }
  compactions.push({ timestamp, trigger });
}

function compactionPriority(trigger: string): number {
  if (trigger === "codex-context") return 2;
  if (trigger === "codex") return 1;
  return 0;
}

function formatContentItems(items: any[]): string {
  return items
    .map((item) => {
      if (item?.type === "input_text" || item?.type === "output_text" || item?.type === "text") {
        return item.text || "";
      }
      if (item?.type === "input_image") return item.image_url || "[image]";
      return JSON.stringify(item);
    })
    .filter(Boolean)
    .join("\n");
}

function durationToMs(duration: any): number | undefined {
  if (!duration || typeof duration !== "object") return undefined;
  const secs = typeof duration.secs === "number" ? duration.secs : 0;
  const nanos = typeof duration.nanos === "number" ? duration.nanos : 0;
  const ms = secs * 1000 + Math.round(nanos / 1_000_000);
  return ms > 0 ? ms : undefined;
}

function tokenUsageFromSnapshots(snapshots: CodexTokenSnapshot[]): TokenUsage | undefined {
  const latest = [...snapshots].toReversed().find((s) => s.total)?.total;
  if (!latest) return undefined;
  const input = latest.input_tokens || 0;
  const cached = latest.cached_input_tokens || 0;
  return {
    inputTokens: Math.max(0, input - cached),
    outputTokens: latest.output_tokens || 0,
    cacheCreationTokens: 0,
    cacheReadTokens: cached,
  };
}

function buildCodexTurnStats(
  turns: ParsedTurn[],
  snapshots: CodexTokenSnapshot[],
  taskDurations: number[],
  model?: string,
) {
  const userTurns = turns.filter((t) => t.role === "user" && !t.subtype);
  const usable = snapshots.filter((s) => s.last);
  return userTurns.map((turn, i) => {
    const usage = usable[i]?.last;
    const stat: {
      turnIndex: number;
      model?: string;
      tokenUsage?: TokenUsage;
      contextTokens?: number;
      durationMs?: number;
    } = { turnIndex: i };
    if (model) stat.model = model;
    if (usage) {
      const input = usage.input_tokens || 0;
      const cached = usage.cached_input_tokens || 0;
      stat.tokenUsage = {
        inputTokens: Math.max(0, input - cached),
        outputTokens: usage.output_tokens || 0,
        cacheCreationTokens: 0,
        cacheReadTokens: cached,
      };
      stat.contextTokens = input;
    }
    const nextUser = userTurns[i + 1]?.timestamp;
    const taskDuration = taskDurations[i];
    if (typeof taskDuration === "number" && taskDuration > 0) {
      stat.durationMs = taskDuration;
    } else if (turn.timestamp) {
      const end = nextUser || usable[i]?.timestamp;
      if (end) {
        const diff = Date.parse(end) - Date.parse(turn.timestamp);
        if (diff > 0 && diff < 12 * 60 * 60 * 1000) stat.durationMs = diff;
      }
    }
    return stat;
  });
}

function pushUnique(items: string[], value: string): void {
  if (items.length === 0 || items[items.length - 1] !== value) items.push(value);
}

function normalizeUserMessageText(text: string): string {
  return codexStripTwoPass(text);
}

function localImageToDataUrl(path: string): string | undefined {
  try {
    const data = readFileSync(path);
    return `data:${mimeTypeForPath(path)};base64,${data.toString("base64")}`;
  } catch {
    return undefined;
  }
}

function mimeTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".png":
    default:
      return "image/png";
  }
}
