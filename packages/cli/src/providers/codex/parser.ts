import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { estimateActiveDuration } from "../../duration.js";
import type { ContentBlock, ParsedTurn, SessionInfo } from "../../types.js";
import type { Compaction, ProviderParseResult, TokenUsage } from "../types.js";
import { USER_MESSAGE_BEGIN } from "./constants.js";

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
}

function asCodexTokenInfo(value: unknown): CodexTokenInfo | undefined {
  if (!value || typeof value !== "object") return undefined;
  return value as CodexTokenInfo;
}

export async function parseCodexSession(
  filePaths: string | string[],
  sessionInfo?: SessionInfo,
): Promise<ProviderParseResult> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const lines: string[] = [];
  for (const fp of paths) {
    const content = await readFile(fp, "utf-8");
    lines.push(...content.split("\n").filter((l) => l.trim()));
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

  const turns: ParsedTurn[] = [];
  const allTimestamps: string[] = [];
  const compactions: Compaction[] = [];
  const tools = new Map<string, PendingTool>();
  const toolResults = new Map<string, ToolResult>();
  const tokenSnapshots: CodexTokenSnapshot[] = [];
  const mcpServersUsed = new Set<string>();
  const skillsUsed = new Set<string>();
  const gitBranches: string[] = [];

  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

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
      if (p.type === "thread_name_updated" && p.thread_name) {
        title = p.thread_name;
        continue;
      }
      if (p.type === "user_message") {
        const blocks = userMessageBlocks(p);
        if (blocks.length > 0) {
          turns.push({ role: "user", timestamp: obj.timestamp, blocks });
        }
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
        toolResults.set(p.call_id, {
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
        });
        continue;
      }
      if (p.type === "web_search_end" && p.query) {
        const callId = p.call_id || `web_search:${obj.timestamp}`;
        if (!tools.has(callId)) {
          tools.set(callId, {
            id: callId,
            name: "web_search",
            input: p.action || { query: p.query },
            timestamp: obj.timestamp,
          });
        }
        toolResults.set(callId, {
          result: `[Search: ${typeof p.query === "string" ? p.query : JSON.stringify(p.query)}]`,
          timestamp: obj.timestamp,
        });
      }
      continue;
    }

    if (obj.type !== "response_item") continue;
    const p = obj.payload || {};

    if (p.type === "message" && p.role === "assistant") {
      const text = contentText(p.content);
      if (text.trim()) {
        turns.push({
          role: "assistant",
          timestamp: obj.timestamp,
          blocks: [{ type: "text", text }],
        });
      }
      continue;
    }

    if (p.type === "compaction") {
      compactions.push({
        timestamp: obj.timestamp || "",
        trigger: "codex",
      });
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

    if (
      p.type === "function_call" ||
      p.type === "local_shell_call" ||
      p.type === "custom_tool_call" ||
      p.type === "tool_search_call" ||
      p.type === "web_search_call" ||
      p.type === "image_generation_call"
    ) {
      const callId = p.call_id || p.id || `${p.type}:${obj.timestamp}:${tools.size}`;
      const name = p.name || normalizeCodexToolName(p.type);
      const input = inputForResponseItem(p);
      tools.set(callId, { id: callId, name, input, timestamp: obj.timestamp });
      if (name.startsWith("mcp__")) {
        const server = name.split("__")[1];
        if (server) mcpServersUsed.add(server);
      }
      if (name === "tool_search") skillsUsed.add("tool_search");
      continue;
    }

    if (
      p.type === "function_call_output" ||
      p.type === "custom_tool_call_output" ||
      p.type === "tool_search_output"
    ) {
      if (p.call_id) {
        toolResults.set(p.call_id, {
          result: formatOutputPayload(p),
          timestamp: obj.timestamp,
        });
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
          _result: tr?.result || "",
          ...(tr?.isError ? { _isError: true } : {}),
          ...(tr?.durationMs ? { _durationMs: tr.durationMs } : {}),
        },
      ],
    });
  }

  turns.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));

  const tokenUsage = tokenUsageFromSnapshots(tokenSnapshots);
  const tokenUsageByModel =
    tokenUsage && model
      ? {
          [model]: tokenUsage,
        }
      : undefined;
  const turnStats = buildCodexTurnStats(turns, tokenSnapshots, model);

  return {
    sessionId,
    slug: slug || sessionId.slice(0, 8),
    title,
    cwd,
    model,
    startTime,
    endTime,
    totalDurationMs: estimateActiveDuration(allTimestamps),
    turns,
    tokenUsage,
    tokenUsageByModel,
    compactions: compactions.length > 0 ? compactions : undefined,
    turnStats: turnStats.length > 0 ? turnStats : undefined,
    gitBranch,
    gitBranches: gitBranches.length > 1 ? gitBranches : undefined,
    entrypoint,
    permissionMode: approvalPolicy || permissionMode,
    skillsUsed: skillsUsed.size > 0 ? [...skillsUsed].sort() : undefined,
    mcpServersUsed: mcpServersUsed.size > 0 ? [...mcpServersUsed].sort() : undefined,
    dataSource: "jsonl",
    dataSourceInfo: {
      primary: "jsonl",
      sources: ["~/.codex/state_5.sqlite", "~/.codex/sessions"],
      supplements: sourcePaths,
      notes: ["Discovered from Codex state and parsed from rollout JSONL (local beta)."],
    },
  };
}

function userMessageBlocks(payload: any): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const text =
    typeof payload.message === "string" ? stripUserMessagePrefix(payload.message).trim() : "";
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

function contentText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "output_text" || part?.type === "input_text" || part?.type === "text") {
        return part.text || "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
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

function formatOutputPayload(payload: any): string {
  if (typeof payload.output === "string") return payload.output;
  if (Array.isArray(payload.output)) return formatContentItems(payload.output);
  if (payload.tools) return JSON.stringify(payload.tools, null, 2);
  if (payload.action) return JSON.stringify(payload.action, null, 2);
  return JSON.stringify(payload);
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

function buildCodexTurnStats(turns: ParsedTurn[], snapshots: CodexTokenSnapshot[], model?: string) {
  const userTurns = turns.filter((t) => t.role === "user");
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
    if (turn.timestamp) {
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

function stripUserMessagePrefix(text: string): string {
  const idx = text.indexOf(USER_MESSAGE_BEGIN);
  return idx === -1 ? text : text.slice(idx + USER_MESSAGE_BEGIN.length);
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
