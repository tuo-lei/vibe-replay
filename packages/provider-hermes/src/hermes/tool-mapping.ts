/**
 * Hermes stores tool calls under their implementation name (lowercase, e.g.
 * `terminal`, `write_file`, `patch`). The viewer's transform layer keys off
 * canonical names like `Bash`, `Write`, `Edit` to build shell output and
 * diff scenes, so map Hermes tool names onto that shared vocabulary.
 * Unrecognized tools (MCP servers, future builtins) pass through unchanged.
 */
export function mapHermesToolName(name: string): string {
  const mapping: Record<string, string> = {
    terminal: "Bash",
    read_file: "Read",
    write_file: "Write",
    patch: "Edit",
    search_files: "Grep",
    web_search: "WebSearch",
    web_extract: "WebFetch",
    delegate_task: "Agent",
    clarify: "AskQuestion",
    todo: "TodoWrite",
    skill_view: "Skill",
    skill_manage: "Skill",
    skills_list: "Skill",
    vision_analyze: "Vision",
    computer_use: "ComputerUse",
    execute_code: "ExecuteCode",
    session_search: "SessionSearch",
    text_to_speech: "TextToSpeech",
    // Browser + cron + memory tools: no special scene handling in the
    // transform yet, but CamelCase ids read better than raw snake_case in
    // tool lists and labels.
    browser_navigate: "BrowserNavigate",
    browser_click: "BrowserClick",
    browser_type: "BrowserType",
    browser_snapshot: "BrowserSnapshot",
    browser_console: "BrowserConsole",
    browser_scroll: "BrowserScroll",
    browser_press: "BrowserPress",
    browser_get_images: "BrowserImages",
    cronjob: "Cron",
    memory: "Memory",
    codex: "Codex",
  };
  return mapping[name] || name;
}

/**
 * Normalize Hermes tool input into the field names the transform expects.
 * Hermes's file tools use `path`; the transform wants `file_path`. The
 * `patch` tool (replace mode) is the analogue of Claude's `Edit`, so its
 * old/new strings map onto the diff scene fields.
 */
export function mapHermesToolArgs(toolName: string, input: unknown): Record<string, any> {
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, any>)
      : null;
  if (!obj) return obj || {};

  if (toolName === "patch") {
    return {
      file_path: obj.path ?? "",
      old_string: obj.old_string ?? "",
      new_string: obj.new_string ?? "",
    };
  }
  if (toolName === "write_file") {
    return {
      file_path: obj.path ?? "",
      content: obj.content ?? "",
    };
  }
  if (toolName === "read_file") {
    return {
      file_path: obj.path ?? "",
    };
  }
  if (toolName === "terminal") {
    return {
      command: obj.command ?? "",
      ...(typeof obj.workdir === "string" ? { workdir: obj.workdir } : {}),
    };
  }
  if (toolName === "delegate_task") {
    return {
      description: obj.goal ?? "",
      prompt: obj.context ?? "",
      subagent_type: obj.role === "orchestrator" ? "orchestrator" : "subagent",
    };
  }
  return obj;
}
