/**
 * Map Muse's built-in tool names and argument shapes to the canonical names
 * the rest of vibe-replay understands (`Bash`/`Edit`/`Write` with
 * `command`/`file_path`/`old_string`/`new_string`).
 *
 * Without this, `buildToolScene` cannot render terminal output or diffs for
 * Muse calls, and scanner edit analytics (which count `FILE_EDIT_TOOLS`
 * names) report zero edits for them. Namespaced agent tools
 * (`memory_search`, `subagent.spawn`, ...) pass through untouched.
 */

const CANONICAL_TOOL_NAMES: Record<string, string> = {
  exec: "Bash",
  read: "Read",
  edit: "Edit",
  write: "Write",
};

export function mapMuseToolName(name: string): string {
  return CANONICAL_TOOL_NAMES[name] ?? name;
}

/**
 * Translate Muse's provider-specific argument fields to canonical ones.
 * Unknown extra fields are preserved for forward compatibility.
 */
export function mapMuseToolArgs(
  rawName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (rawName === "edit" || rawName === "write" || rawName === "read") {
    const { path, old_text, new_text, ...rest } = args as {
      path?: unknown;
      old_text?: unknown;
      new_text?: unknown;
      [key: string]: unknown;
    };
    return {
      ...(typeof path === "string" ? { file_path: path } : {}),
      ...(typeof old_text === "string" ? { old_string: old_text } : {}),
      ...(typeof new_text === "string" ? { new_string: new_text } : {}),
      ...rest,
    };
  }
  return args;
}
