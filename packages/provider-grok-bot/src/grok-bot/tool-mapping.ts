/**
 * Grok Bot (Cursor Sand) stores tools under lowercase implementation names
 * (`read`, `write`, `shell`). The viewer's transform layer keys off canonical
 * names like `Read`, `Write`, `Bash` to build diffs and shell scenes.
 *
 * `send_message` is promoted to assistant text in the parser.
 * `communicate_update` is a status/memory side-effect and stays a
 * `CommunicateUpdate` tool scene (success and failure); its update text is
 * flattened onto `update` so tool cards have a one-line summary.
 * `get_mcp_tools` is discovery noise and is omitted from replay scenes.
 * `mcp` and dynamic short names (`pull_request_read`) both become
 * `mcp__<server>__<tool>` cards when server+tool are known so Insights and
 * the 🔌 viewer label stay consistent. Unrecognized non-MCP tools pass through.
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
 * copy `serverIdentifier` / `toolName` onto `server` / `tool`.
 */
export function mapGrokBotToolArgs(toolName: string, input: unknown): Record<string, unknown> {
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>) }
      : {};
  const normalized = toolName.toLowerCase();

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
    const subagentType = firstString(obj.subagent_type, obj.subagentType, obj.role, obj.type);
    const sessionId = firstString(
      obj.sessionId,
      obj.session_id,
      obj.agentId,
      obj.agent_id,
      obj.subagentId,
    );
    if (description) obj.description = description;
    if (prompt) obj.prompt = prompt;
    if (subagentType) obj.subagent_type = subagentType;
    if (sessionId) obj.sessionId = sessionId;
  }

  if (normalized === "generate_image") {
    const prompt = firstString(obj.prompt, obj.text, obj.description);
    if (prompt) obj.prompt = prompt;
  }

  if (normalized === "communicate_update") {
    const nestedText =
      obj.text && typeof obj.text === "object" && !Array.isArray(obj.text)
        ? (obj.text as Record<string, unknown>).content
        : obj.text;
    const update = firstString(obj.update, obj.status, nestedText);
    if (update) obj.update = update;
  }

  if (normalized === "mcp" || !isGrokBotBuiltinTool(toolName)) {
    const mcp = grokBotMcpFields(obj);
    if (mcp.server) obj.server = mcp.server;
    if (mcp.tool) {
      obj.tool = mcp.tool;
      if (!firstString(obj.tool_name)) obj.tool_name = mcp.tool;
    }
  }

  return obj;
}

export function grokBotMcpAttribution(
  toolName: string,
  input: Record<string, unknown>,
): { server?: string; tool?: string } | undefined {
  const fields = grokBotMcpFields(input);
  if (toolName.toLowerCase() === "mcp") {
    if (!fields.server && !fields.tool) return undefined;
    return fields;
  }
  if (isGrokBotBuiltinTool(toolName)) return undefined;
  if (!hasDynamicMcpIdentifiers(input)) return undefined;
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
    firstString(input.toolName, input.tool_name)
  );
}

function flattenToolArgs(obj: Record<string, unknown>): void {
  const args = obj.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return;
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (obj[key] === undefined) obj[key] = value;
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}
