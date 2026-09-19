import { isSandSubagentSessionId } from "./subagent.js";

/**
 * Grok Bot (Cursor Sand) stores tools under lowercase implementation names
 * (`read`, `write`, `shell`). The viewer's transform layer keys off canonical
 * names like `Read`, `Write`, `Bash` to build diffs and shell scenes.
 *
 * `send_message` is promoted to assistant text in the parser.
 * `communicate_update` is a status/memory side-effect and stays a
 * `CommunicateUpdate` tool scene (success and failure); its update text is
 * flattened onto `update` so tool cards have a one-line summary. Live calls
 * send `{ currentStep }` — sometimes a JSON string wrapping `__sand_tool__`.
 * `get_mcp_tools` is discovery noise and is omitted from replay scenes.
 * `mcp` and dynamic short names (`pull_request_read`) both become
 * `mcp__<server>__<tool>` cards when server+tool are known so Insights and
 * the 🔌 viewer label stay consistent. Unrecognized non-MCP tools pass through.
 * Nested `args` / `arguments` is the tool payload only — identifiers found
 * only there (including after flatten) do not attribute a call as MCP.
 */

const GROK_BOT_TOOL_NAME_MAP: Record<string, string> = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  strreplace: "Edit",
  search_replace: "Edit",
  multiedit: "MultiEdit",
  delete: "Delete",
  grep: "Grep",
  glob: "Glob",
  glob_file_search: "Glob",
  ls: "LS",
  find: "Find",
  shell: "Bash",
  bash: "Bash",
  exec: "Bash",
  web_search: "WebSearch",
  websearch: "WebSearch",
  web_fetch: "WebFetch",
  webfetch: "WebFetch",
  todo: "TodoWrite",
  todowrite: "TodoWrite",
  update_todos: "TodoWrite",
  task: "Agent",
  delegate_task: "Agent",
  await: "Await",
  computer_use: "ComputerUse",
  generate_image: "GenerateImage",
  get_mcp_tools: "GetMcpTools",
  communicate_update: "CommunicateUpdate",
};

const GROK_BOT_BUILTIN_TOOLS = new Set([
  ...Object.keys(GROK_BOT_TOOL_NAME_MAP),
  "send_message",
  "mcp",
]);

export function mapGrokBotToolName(name: string): string {
  return GROK_BOT_TOOL_NAME_MAP[name.toLowerCase()] || name;
}

export function isGrokBotEditTool(name: string): boolean {
  const mapped = mapGrokBotToolName(name);
  return mapped === "Edit" || mapped === "Write" || mapped === "MultiEdit" || mapped === "Delete";
}

/** Discovery/list_tools noise — consume the result, do not emit a scene. */
export function isGrokBotHiddenTool(name: string): boolean {
  return name.toLowerCase() === "get_mcp_tools";
}

export function isGrokBotBuiltinTool(name: string): boolean {
  return GROK_BOT_BUILTIN_TOOLS.has(name.toLowerCase());
}

/**
 * Normalize Grok Bot tool input into the field names the transform expects.
 * File tools use `path`; the transform wants `file_path`. Edit replacements
 * map onto `old_string` / `new_string`. Dynamic MCP calls flatten `args` and
 * copy top-level `serverIdentifier` / `toolName` onto `server` / `tool`.
 * Nested payload may be `args` or `arguments`.
 */
export function mapGrokBotToolArgs(toolName: string, input: unknown): Record<string, unknown> {
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>) }
      : {};
  const normalized = toolName.toLowerCase();
  const mcpIdentifiers = topLevelMcpIdentifiers(obj);

  flattenToolArgs(obj);

  if (
    normalized === "read" ||
    normalized === "write" ||
    normalized === "edit" ||
    normalized === "strreplace" ||
    normalized === "search_replace" ||
    normalized === "multiedit" ||
    normalized === "delete"
  ) {
    const filePath = firstString(obj.file_path, obj.path);
    if (filePath) obj.file_path = filePath;
  }

  if (normalized === "edit" || normalized === "strreplace" || normalized === "search_replace") {
    const oldString = firstString(obj.old_string, obj.oldText, obj.old_text);
    const newString = firstString(obj.new_string, obj.newText, obj.new_text);
    if (oldString) obj.old_string = oldString;
    if (newString) obj.new_string = newString;
  }

  if (normalized === "write") {
    const content = firstString(obj.content, obj.contents);
    if (content) obj.content = content;
  }

  if (normalized === "shell" || normalized === "bash" || normalized === "exec") {
    const command = firstString(obj.command, obj.cmd, obj.command_line);
    if (command) obj.command = command;
  }

  if (normalized === "web_search" || normalized === "websearch") {
    const query = firstString(obj.query, obj.search_term, obj.q);
    if (query) obj.query = query;
  }

  if (normalized === "web_fetch" || normalized === "webfetch") {
    const url = firstString(obj.url, obj.uri);
    if (url) obj.url = url;
  }

  if (normalized === "todo" || normalized === "todowrite" || normalized === "update_todos") {
    if (!Array.isArray(obj.todos)) {
      if (Array.isArray(obj.items)) obj.todos = obj.items;
      else if (Array.isArray(obj.updates)) obj.todos = obj.updates;
    }
  }

  if (normalized === "task" || normalized === "delegate_task") {
    const description = firstString(obj.description, obj.goal, obj.title);
    const prompt = firstString(obj.prompt, obj.context, obj.task, obj.instruction);
    const subagentType =
      nestedTypeName(obj.subagent_type) ||
      nestedTypeName(obj.subagentType) ||
      firstString(obj.role, obj.type);
    const sessionId = sandSubagentSessionId(obj);
    if (description) obj.description = description;
    if (prompt) obj.prompt = prompt;
    if (subagentType) obj.subagent_type = subagentType;
    if (sessionId) obj.sessionId = sessionId;
  }

  if (normalized === "generate_image") {
    const prompt = firstString(obj.prompt, obj.text, obj.description);
    if (prompt) obj.prompt = prompt;
    const filePath = firstString(obj.file_path, obj.filePath, obj.path);
    if (filePath) obj.file_path = filePath;
  }

  if (normalized === "computer_use") {
    if (!firstString(obj.description, obj.action, obj.summary)) {
      const fromActions = summarizeComputerUseActions(obj.actions);
      if (fromActions) obj.description = fromActions;
    }
  }

  if (normalized === "communicate_update") {
    const update =
      flattenGrokBotStatusText(obj.update) ||
      flattenGrokBotStatusText(obj.status) ||
      flattenGrokBotStatusText(obj.currentStep) ||
      flattenGrokBotStatusText(obj.text);
    if (update) obj.update = update;
  }

  if (normalized === "mcp" || !isGrokBotBuiltinTool(toolName)) {
    const mcp = grokBotMcpFields(mcpIdentifiers);
    if (mcp.server) obj.server = mcp.server;
    if (mcp.tool) {
      obj.tool = mcp.tool;
      if (!firstString(obj.tool_name)) obj.tool_name = mcp.tool;
    }
    omitMcpBookkeeping(obj, mcp);
  }

  return obj;
}

export function grokBotMcpAttribution(
  toolName: string,
  input: Record<string, unknown>,
): { server?: string; tool?: string } | undefined {
  const identifiers = topLevelMcpIdentifiers(input);
  const fields = grokBotMcpFields(identifiers);
  if (toolName.toLowerCase() === "mcp") {
    if (!fields.server && !fields.tool) return undefined;
    return fields;
  }
  if (isGrokBotBuiltinTool(toolName)) return undefined;
  if (!hasDynamicMcpIdentifiers(identifiers)) return undefined;
  if (!fields.server && !fields.tool) return undefined;
  return {
    ...(fields.server ? { server: fields.server } : {}),
    ...(fields.tool ? { tool: fields.tool } : { tool: toolName }),
  };
}

/** Viewer MCP cards use `mcp__server__tool` so the 🔌 label parses. */
export function grokBotReplayToolName(rawName: string, input: Record<string, unknown>): string {
  const mcp = grokBotMcpAttribution(rawName, input);
  if (mcp?.server && mcp.tool) return `mcp__${mcp.server}__${mcp.tool}`;
  return mapGrokBotToolName(rawName);
}

function grokBotMcpFields(input: Record<string, unknown>): { server?: string; tool?: string } {
  const server = firstString(
    input.server,
    input.serverIdentifier,
    input.serverName,
    input.server_name,
    input.providerIdentifier,
  );
  const tool = firstString(input.tool, input.toolName, input.tool_name);
  return {
    ...(server ? { server } : {}),
    ...(tool ? { tool } : {}),
  };
}

function hasDynamicMcpIdentifiers(input: Record<string, unknown>): boolean {
  return !!(
    firstString(input.serverIdentifier, input.providerIdentifier, input.server) ||
    firstString(input.toolName, input.tool_name, input.tool)
  );
}

/**
 * MCP attribution looks only at explicit top-level identifiers. Nested `args`
 * / `arguments` fields (including copies `flattenToolArgs` lifts onto the
 * parent) do not count — `{ args: { toolName: "foo" } }` is not an MCP call.
 */
function topLevelMcpIdentifiers(input: Record<string, unknown>): Record<string, unknown> {
  const nestedKeys = new Set(
    nestedArgBags(input).flatMap((bag) => Object.keys(bag as Record<string, unknown>)),
  );
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "args" || key === "arguments") continue;
    if (nestedKeys.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function nestedArgBags(input: Record<string, unknown>): Record<string, unknown>[] {
  const bags: Record<string, unknown>[] = [];
  for (const key of ["args", "arguments"] as const) {
    const value = input[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      bags.push(value as Record<string, unknown>);
    }
  }
  return bags;
}

function flattenToolArgs(obj: Record<string, unknown>): void {
  for (const bag of nestedArgBags(obj)) {
    for (const [key, value] of Object.entries(bag)) {
      if (obj[key] === undefined) obj[key] = value;
    }
  }
}

const MCP_BOOKKEEPING_KEYS = new Set(["serverIdentifier", "providerIdentifier", "skipApproval"]);

function omitMcpBookkeeping(
  obj: Record<string, unknown>,
  mcp: { server?: string; tool?: string },
): void {
  for (const key of MCP_BOOKKEEPING_KEYS) delete obj[key];
  if (typeof obj.toolCallId === "string") delete obj.toolCallId;
  const server = mcp.server?.trim();
  const tool = mcp.tool?.trim();
  if (typeof obj.name === "string" && server && tool) {
    const name = obj.name.trim().toLowerCase();
    const dashed = `${server}-${tool}`.toLowerCase();
    const underscored = `${server}_${tool}`.toLowerCase();
    if (name === dashed || name === underscored) delete obj.name;
  }
}

/**
 * Live `communicate_update` calls send `{ currentStep }`, and that value is
 * often a JSON string wrapping `{ __sand_tool__: true, result: "…" }` or
 * `{ text, imageKey }`. Unwrap onto a readable one-line status.
 */
export function flattenGrokBotStatusText(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value == null) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return flattenGrokBotStatusText(JSON.parse(trimmed), depth + 1) ?? trimmed;
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = flattenGrokBotStatusText(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  const obj = value as Record<string, unknown>;
  for (const key of ["result", "update", "status", "currentStep", "text", "content", "message"]) {
    if (!(key in obj)) continue;
    const found = flattenGrokBotStatusText(obj[key], depth + 1);
    if (found) return found;
  }
  return undefined;
}

function sandSubagentSessionId(obj: Record<string, unknown>): string | undefined {
  for (const key of [
    "sessionId",
    "session_id",
    "subagentId",
    "subagent_id",
    "agentId",
    "agent_id",
  ]) {
    const value = obj[key];
    if (typeof value === "string" && isSandSubagentSessionId(value.trim())) return value.trim();
  }
  return undefined;
}

function nestedTypeName(value: unknown, depth = 0): string | undefined {
  if (depth > 4 || value == null) return undefined;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  return (
    firstString(obj.name, obj.type, obj.id, obj.subagent_type, obj.subagentType) ||
    nestedTypeName(obj.custom, depth + 1) ||
    nestedTypeName(obj.value, depth + 1)
  );
}

function summarizeComputerUseActions(actions: unknown): string | undefined {
  if (!Array.isArray(actions) || actions.length === 0) return undefined;
  const labels: string[] = [];
  for (const item of actions) {
    const label = computerUseActionLabel(item);
    if (label && !labels.includes(label)) labels.push(label);
  }
  if (labels.length === 0) return `${actions.length} actions`;
  if (labels.length <= 4) return labels.join(", ");
  return `${actions.length} actions`;
}

function computerUseActionLabel(item: unknown): string | undefined {
  if (typeof item === "string" && item.trim()) return item.trim();
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const obj = item as Record<string, unknown>;
  return firstString(obj.action, obj.type, obj.kind, obj.name, obj.command);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
