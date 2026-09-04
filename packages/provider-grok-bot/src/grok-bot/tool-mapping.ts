/**
 * Grok Bot (Cursor Sand) stores tools under lowercase implementation names
 * (`read`, `write`, `shell`). The viewer's transform layer keys off canonical
 * names like `Read`, `Write`, `Bash` to build diffs and shell scenes.
 *
 * `send_message` / `communicate_update` are promoted to assistant text in the
 * parser and never reach this map. `mcp` keeps its raw name so the scanner's
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
    if (typeof obj.file_path !== "string" && typeof obj.path === "string") {
      obj.file_path = obj.path;
    }
  }

  if (normalized === "edit" || normalized === "strreplace" || normalized === "search_replace") {
    if (typeof obj.old_string !== "string") {
      if (typeof obj.oldText === "string") obj.old_string = obj.oldText;
      else if (typeof obj.old_text === "string") obj.old_string = obj.old_text;
    }
    if (typeof obj.new_string !== "string") {
      if (typeof obj.newText === "string") obj.new_string = obj.newText;
      else if (typeof obj.new_text === "string") obj.new_string = obj.new_text;
    }
  }

  if (
    normalized === "write" &&
    typeof obj.content !== "string" &&
    typeof obj.contents === "string"
  ) {
    obj.content = obj.contents;
  }

  if (normalized === "shell" || normalized === "bash" || normalized === "exec") {
    if (typeof obj.command !== "string") {
      if (typeof obj.cmd === "string") obj.command = obj.cmd;
      else if (typeof obj.command_line === "string") obj.command = obj.command_line;
    }
  }

  if (normalized === "web_search" || normalized === "websearch") {
    if (typeof obj.query !== "string") {
      if (typeof obj.search_term === "string") obj.query = obj.search_term;
      else if (typeof obj.q === "string") obj.query = obj.q;
    }
  }

  if (normalized === "web_fetch" || normalized === "webfetch") {
    if (typeof obj.url !== "string" && typeof obj.uri === "string") obj.url = obj.uri;
  }

  if (normalized === "todo" || normalized === "todowrite" || normalized === "update_todos") {
    if (!Array.isArray(obj.todos)) {
      if (Array.isArray(obj.items)) obj.todos = obj.items;
      else if (Array.isArray(obj.updates)) obj.todos = obj.updates;
    }
  }

  if (normalized === "task" || normalized === "delegate_task") {
    if (typeof obj.description !== "string") {
      const description = firstString(obj.goal, obj.title);
      if (description) obj.description = description;
    }
    if (typeof obj.prompt !== "string") {
      const prompt = firstString(obj.context, obj.task, obj.instruction);
      if (prompt) obj.prompt = prompt;
    }
    if (typeof obj.subagent_type !== "string") {
      const subagentType = firstString(obj.subagentType, obj.role, obj.type);
      if (subagentType) obj.subagent_type = subagentType;
    }
  }

  if (normalized === "mcp") {
    const server = firstString(obj.server, obj.serverName, obj.server_name);
    const tool = firstString(obj.tool, obj.toolName, obj.tool_name, obj.name);
    if (server && typeof obj.server !== "string") obj.server = server;
    if (tool) {
      if (typeof obj.tool !== "string") obj.tool = tool;
      if (typeof obj.tool_name !== "string") obj.tool_name = tool;
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
