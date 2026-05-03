export const USER_MESSAGE_BEGIN = "## My request for Codex:";
export const CODEX_CONTEXT_TAGS = [
  "environment_context",
  "permissions instructions",
  "app-context",
  "collaboration_mode",
  "apps_instructions",
  "skills_instructions",
  "plugins_instructions",
];

export function isCodexToolCallType(type?: string): boolean {
  return (
    type === "function_call" ||
    type === "local_shell_call" ||
    type === "custom_tool_call" ||
    type === "tool_search_call" ||
    type === "web_search_call" ||
    type === "image_generation_call"
  );
}
