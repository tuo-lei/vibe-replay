/**
 * Grok Bot (Cursor Sand) stores tools under lowercase implementation names
 * (`read`, `write`, `shell`). The viewer's transform layer keys off canonical
 * names like `Read`, `Write`, `Bash` to build diffs and shell scenes.
 *
 * `send_message` and successful `communicate_update` are promoted to assistant
 * text in the parser. Failed `communicate_update` reaches this map as
 * `CommunicateUpdate`. `mcp` keeps its raw name so the scanner's
 * Pi-style `parseMcpUsage` branch can attribute server/tool from args.
 * Unrecognized tools (GitHub MCP names, future builtins) pass through unchanged.
 */
export function mapGrokBotToolName(name: string): string {
  const mapping: Record<string, string> = {
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
    get_mcp_tools: "GetMcpTools",
    communicate_update: "CommunicateUpdate",
  };
  return mapping[name.toLowerCase()] || name;
}

export function isGrokBotEditTool(name: string): boolean {
  const mapped = mapGrokBotToolName(name);
  return mapped === "Edit" || mapped === "Write" || mapped === "MultiEdit" || mapped === "Delete";
}

/**
 * Normalize Grok Bot tool input into the field names the transform expects.
 * File tools use `path`; the transform wants `file_path`. Edit replacements
 * map onto `old_string` / `new_string`.
 */
export function mapGrokBotToolArgs(toolName: string, input: unknown): Record<string, unknown> {
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>) }
      : {};
  const normalized = toolName.toLowerCase();

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
    if (description) obj.description = description;
    if (prompt) obj.prompt = prompt;
    if (subagentType) obj.subagent_type = subagentType;
  }

  if (normalized === "mcp") {
    const server = firstString(obj.server, obj.serverName, obj.server_name);
    const tool = firstString(obj.tool, obj.toolName, obj.tool_name, obj.name);
    if (server) obj.server = server;
    if (tool) {
      obj.tool = tool;
      if (!firstString(obj.tool_name)) obj.tool_name = tool;
    }
  }

  return obj;
}

export function grokBotMcpAttribution(
  toolName: string,
  input: Record<string, unknown>,
): { server?: string; tool?: string } | undefined {
  if (toolName.toLowerCase() !== "mcp") return undefined;
  const server = firstString(input.server, input.serverName, input.server_name);
  const tool = firstString(input.tool, input.toolName, input.tool_name);
  if (!server && !tool) return undefined;
  return {
    ...(server ? { server } : {}),
    ...(tool ? { tool } : {}),
  };
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
