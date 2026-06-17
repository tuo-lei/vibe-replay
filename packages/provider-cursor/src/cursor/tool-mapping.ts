export function parseJson<T = any>(raw: unknown): T | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function mapCursorToolName(name: string): string {
  const mapping: Record<string, string> = {
    Shell: "Bash",
    shell: "Bash", // Cursor SDK lowercase tool name
    run_terminal_command_v2: "Bash",
    run_terminal_cmd: "Bash",
    Read: "Read",
    ReadFile: "Read",
    read: "Read", // Cursor SDK lowercase tool name
    read_file_v2: "Read",
    read_file: "Read",
    read_lints: "ReadLints",
    Grep: "Grep",
    ripgrep_raw_search: "Grep",
    ripgrep: "Grep",
    rg: "Grep",
    grep: "Grep",
    grep_search: "Grep",
    Glob: "Glob",
    glob_file_search: "Glob",
    file_search: "Glob",
    list_dir: "Glob",
    list_dir_v2: "Glob",
    LS: "Glob",
    StrReplace: "Edit",
    EditFile: "Edit",
    edit: "Edit", // Cursor SDK lowercase tool name
    edit_file_v2: "Edit",
    edit_file: "Edit",
    search_replace: "Edit",
    ApplyPatch: "Edit",
    apply_patch: "Edit",
    MultiEdit: "MultiEdit",
    multi_edit: "MultiEdit",
    Write: "Write",
    WriteFile: "Write",
    write: "Write",
    Delete: "Delete",
    delete_file: "Delete",
    Task: "Agent",
    task_v2: "Agent",
    todo_write: "TodoWrite",
    ask_question: "AskQuestion",
    semantic_search_full: "SemanticSearch",
    codebase_search: "SemanticSearch",
    web_search: "WebSearch",
    WebFetch: "WebFetch",
    web_fetch: "WebFetch",
    create_plan: "Plan",
  };
  if (mapping[name]) return mapping[name];
  if (name.startsWith("mcp-cursor-ide-browser-cursor-ide-browser-browser_")) return "Browser";
  if (name.startsWith("chrome-devtools-")) return "Browser";
  return name;
}

function parseDiffStringSnippet(diffString: string): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of diffString.split("\n")) {
    if (
      line.startsWith("@@") ||
      line.startsWith("*** ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      continue;
    }
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      const shared = line.slice(1);
      oldLines.push(shared);
      newLines.push(shared);
    }
  }
  return { oldText: oldLines.join("\n"), newText: newLines.join("\n") };
}

function inferEditStringsFromResult(resultText: string): {
  old_string?: string;
  new_string?: string;
} {
  if (!resultText.trim()) return {};
  const parsed = parseJson<Record<string, any>>(resultText);
  if (!parsed || typeof parsed !== "object") return {};

  const out: { old_string?: string; new_string?: string } = {};
  if (typeof parsed.contentsAfterEdit === "string" && parsed.contentsAfterEdit.trim()) {
    out.new_string = parsed.contentsAfterEdit;
  }

  const chunks =
    parsed.diff && typeof parsed.diff === "object" && Array.isArray(parsed.diff.chunks)
      ? parsed.diff.chunks
      : [];
  const oldParts: string[] = [];
  const newParts: string[] = [];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    if (typeof chunk.diffString !== "string" || !chunk.diffString.trim()) continue;
    const parsedSnippet = parseDiffStringSnippet(chunk.diffString);
    if (parsedSnippet.oldText) oldParts.push(parsedSnippet.oldText);
    if (parsedSnippet.newText) newParts.push(parsedSnippet.newText);
  }
  if (oldParts.length > 0) out.old_string = oldParts.join("\n");
  if (!out.new_string && newParts.length > 0) out.new_string = newParts.join("\n");
  return out;
}

function parseApplyPatchArgs(rawPatch: string): Record<string, any> {
  const fileMatch = rawPatch.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s+(.+)$/m);
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of rawPatch.split("\n")) {
    if (
      line.startsWith("*** ") ||
      line.startsWith("@@") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      continue;
    }
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      const shared = line.slice(1);
      oldLines.push(shared);
      newLines.push(shared);
    }
  }
  return {
    ...(fileMatch?.[1] ? { file_path: fileMatch[1].trim() } : {}),
    old_string: oldLines.join("\n"),
    new_string: newLines.join("\n"),
    patch: rawPatch,
  };
}

function mapEditLikeArgs(argsObj: Record<string, any>, resultText: string): Record<string, any> {
  const mapped: Record<string, any> = {
    file_path: argsObj.file_path ?? argsObj.path ?? argsObj.relativeWorkspacePath ?? "",
    old_string: argsObj.old_string ?? argsObj.oldStr ?? "",
    new_string:
      argsObj.new_string ?? argsObj.newStr ?? argsObj.streamingContent ?? argsObj.content ?? "",
  };
  if (!mapped.old_string || !mapped.new_string) {
    const inferred = inferEditStringsFromResult(resultText);
    if (!mapped.old_string && inferred.old_string) mapped.old_string = inferred.old_string;
    if (!mapped.new_string && inferred.new_string) mapped.new_string = inferred.new_string;
  }
  return mapped;
}

export function mapToolArgs(toolName: string, args: unknown, resultText = ""): Record<string, any> {
  const argsObj =
    args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, any>) : null;
  if (toolName === "ApplyPatch" || toolName === "apply_patch") {
    const rawPatch =
      typeof args === "string"
        ? args
        : typeof argsObj?.patch === "string"
          ? argsObj.patch
          : typeof argsObj?.input === "string"
            ? argsObj.input
            : typeof argsObj?.content === "string"
              ? argsObj.content
              : typeof argsObj?.contents === "string"
                ? argsObj.contents
                : "";
    if (rawPatch) return parseApplyPatchArgs(rawPatch);
    if (argsObj && (argsObj.path || argsObj.file_path || argsObj.relativeWorkspacePath)) {
      return mapEditLikeArgs(argsObj, resultText);
    }
    return argsObj || {};
  }
  if (typeof args === "string") {
    return { raw: args };
  }
  if (!argsObj) return {};
  if (toolName === "Shell" && argsObj.command) {
    return {
      command: argsObj.command,
      ...(argsObj.description ? { description: argsObj.description } : {}),
    };
  }
  if (
    toolName === "StrReplace" &&
    (argsObj.path || argsObj.file_path || argsObj.relativeWorkspacePath)
  ) {
    return mapEditLikeArgs(argsObj, resultText);
  }
  if (
    toolName === "EditFile" &&
    (argsObj.path || argsObj.file_path || argsObj.relativeWorkspacePath)
  ) {
    return mapEditLikeArgs(argsObj, resultText);
  }
  if (toolName === "Edit" && (argsObj.path || argsObj.file_path || argsObj.relativeWorkspacePath)) {
    return mapEditLikeArgs(argsObj, resultText);
  }
  if (
    (toolName === "MultiEdit" || toolName === "multi_edit") &&
    (argsObj.path || argsObj.file_path || argsObj.relativeWorkspacePath)
  ) {
    return {
      file_path: argsObj.file_path ?? argsObj.path ?? argsObj.relativeWorkspacePath,
      edits: Array.isArray(argsObj.edits) ? argsObj.edits : [],
    };
  }
  if (
    (toolName === "Write" || toolName === "WriteFile") &&
    (argsObj.path || argsObj.relativeWorkspacePath || argsObj.targetFile || argsObj.file_path)
  ) {
    const codeValue =
      typeof argsObj.code === "string"
        ? argsObj.code
        : argsObj.code && typeof argsObj.code === "object" && typeof argsObj.code.code === "string"
          ? argsObj.code.code
          : "";
    return {
      file_path:
        argsObj.file_path ?? argsObj.path ?? argsObj.relativeWorkspacePath ?? argsObj.targetFile,
      content: argsObj.contents ?? argsObj.content ?? codeValue,
    };
  }
  if ((toolName === "Read" || toolName === "ReadFile") && argsObj.path) {
    return { file_path: argsObj.path };
  }
  if (toolName === "run_terminal_command_v2" && argsObj.command) {
    return {
      command: argsObj.command,
      ...(argsObj.commandDescription ? { description: argsObj.commandDescription } : {}),
      ...(argsObj.cwd ? { cwd: argsObj.cwd } : {}),
    };
  }
  if (toolName === "run_terminal_cmd" && argsObj.command) {
    return {
      command: argsObj.command,
      ...(argsObj.cwd ? { cwd: argsObj.cwd } : {}),
      ...(argsObj.requireUserApproval !== undefined
        ? { requireUserApproval: Boolean(argsObj.requireUserApproval) }
        : {}),
    };
  }
  if (toolName === "read_file_v2" && argsObj.targetFile) {
    return { file_path: argsObj.targetFile };
  }
  if (toolName === "read_file" && argsObj.targetFile) {
    return { file_path: argsObj.targetFile };
  }
  if (toolName === "edit_file_v2" && argsObj.relativeWorkspacePath) {
    return {
      file_path: argsObj.relativeWorkspacePath,
      new_string: argsObj.streamingContent ?? "",
    };
  }
  if (toolName === "edit_file" || toolName === "search_replace") {
    return mapEditLikeArgs(argsObj, resultText);
  }
  if (
    toolName === "write" &&
    (argsObj.relativeWorkspacePath || argsObj.path || argsObj.targetFile)
  ) {
    const codeValue =
      typeof argsObj.code === "string"
        ? argsObj.code
        : argsObj.code && typeof argsObj.code === "object" && typeof argsObj.code.code === "string"
          ? argsObj.code.code
          : "";
    return {
      file_path: argsObj.relativeWorkspacePath ?? argsObj.path ?? argsObj.targetFile,
      content: argsObj.content ?? argsObj.contents ?? codeValue,
    };
  }
  if (
    (toolName === "Delete" || toolName === "delete_file") &&
    (argsObj.relativeWorkspacePath || argsObj.path || argsObj.file_path || argsObj.targetFile)
  ) {
    return {
      file_path:
        argsObj.file_path ?? argsObj.path ?? argsObj.relativeWorkspacePath ?? argsObj.targetFile,
    };
  }
  if (toolName === "list_dir" || toolName === "list_dir_v2" || toolName === "LS") {
    return {
      path: argsObj.targetDirectory ?? argsObj.target_directory ?? "",
    };
  }
  if (toolName === "glob_file_search") {
    return {
      pattern: argsObj.globPattern ?? "",
      path: argsObj.targetDirectory ?? "",
    };
  }
  if (toolName === "file_search") {
    return {
      pattern: argsObj.pattern ?? argsObj.query ?? argsObj.searchTerm ?? "",
      path: argsObj.path ?? argsObj.targetDirectory ?? "",
    };
  }
  if (toolName === "ripgrep_raw_search") {
    return {
      pattern: argsObj.pattern ?? "",
      path: argsObj.path ?? "",
      ...(argsObj.glob ? { glob: argsObj.glob } : {}),
      ...(argsObj.caseInsensitive !== undefined
        ? { case_insensitive: Boolean(argsObj.caseInsensitive) }
        : {}),
    };
  }
  if (toolName === "ripgrep") {
    return {
      pattern: argsObj.pattern ?? argsObj.query ?? "",
      path: argsObj.path ?? argsObj.targetDirectory ?? "",
      ...(argsObj.glob ? { glob: argsObj.glob } : {}),
    };
  }
  if (toolName === "web_search" && argsObj.searchTerm) {
    return { search_term: argsObj.searchTerm };
  }
  if (toolName === "codebase_search") {
    return {
      query: argsObj.query ?? "",
      path:
        argsObj.repositoryInfo &&
        typeof argsObj.repositoryInfo === "object" &&
        typeof (argsObj.repositoryInfo as Record<string, any>).relativeWorkspacePath === "string"
          ? (argsObj.repositoryInfo as Record<string, any>).relativeWorkspacePath
          : "",
      ...(argsObj.includePattern ? { includePattern: argsObj.includePattern } : {}),
    };
  }
  if (toolName === "task_v2" || toolName === "Task") {
    return {
      ...(argsObj.description ? { description: argsObj.description } : {}),
      ...(argsObj.prompt ? { prompt: argsObj.prompt } : {}),
      ...(argsObj.subagentType ? { subagent_type: argsObj.subagentType } : {}),
    };
  }
  if (toolName.startsWith("mcp-") && Array.isArray(argsObj.tools) && argsObj.tools.length > 0) {
    const first = argsObj.tools[0] || {};
    const parsedParameters =
      typeof first.parameters === "string"
        ? (parseJson(first.parameters) ?? first.parameters)
        : first.parameters;
    return {
      ...(first.serverName ? { server: first.serverName } : {}),
      ...(first.name ? { tool_name: first.name } : {}),
      ...(parsedParameters !== undefined ? { arguments: parsedParameters } : {}),
    };
  }
  return argsObj;
}
