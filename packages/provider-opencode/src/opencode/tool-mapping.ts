/**
 * opencode stores tool calls under their implementation name (lowercase, e.g.
 * `edit`, `bash`, `write`). The viewer's transform layer keys off canonical
 * names like `Edit`, `Bash`, `Write` to build diffs and shell output scenes,
 * so map opencode tool names onto that shared vocabulary. Unrecognized tools
 * (MCP servers, future builtins) pass through unchanged.
 */
export function mapOpencodeToolName(name: string): string {
  const mapping: Record<string, string> = {
    bash: "Bash",
    edit: "Edit",
    write: "Write",
    patch: "Patch",
    read: "Read",
    glob: "Glob",
    grep: "Grep",
    webfetch: "WebFetch",
    websearch: "WebSearch",
    skill: "Skill",
    task: "Agent",
    question: "AskQuestion",
    todowrite: "TodoWrite",
  };
  return mapping[name] || name;
}

/**
 * Normalize opencode tool input into the field names the transform expects.
 * opencode's edit/write tools use camelCase (`filePath`, `oldString`, ...);
 * the transform wants snake_case (`file_path`, `old_string`, ...).
 */
export function mapOpencodeToolArgs(toolName: string, input: unknown): Record<string, any> {
  const obj =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, any>)
      : null;
  if (!obj) return obj || {};

  if (toolName === "edit") {
    return {
      file_path: obj.filePath ?? "",
      old_string: obj.oldString ?? "",
      new_string: obj.newString ?? "",
    };
  }
  if (toolName === "write") {
    return {
      file_path: obj.filePath ?? "",
      content: obj.content ?? "",
    };
  }
  if (toolName === "read") {
    return {
      file_path: obj.filePath ?? "",
    };
  }
  if (toolName === "task") {
    return {
      description: obj.description ?? "",
      subagent_type: obj.subagent_type ?? "",
      prompt: obj.prompt ?? "",
    };
  }
  return obj;
}
