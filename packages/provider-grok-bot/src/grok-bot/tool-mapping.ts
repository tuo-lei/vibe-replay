/**
 * Grok Bot (Cursor Sand) stores tools under lowercase implementation names
 * (`read`, `write`, `shell`). The viewer's transform layer keys off canonical
 * names like `Read`, `Write`, `Bash` to build diffs and shell scenes.
 * Unrecognized tools (future builtins, MCP) pass through unchanged.
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
    task: "Agent",
    delegate_task: "Agent",
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

  return obj;
}
