const USER_MESSAGE_BEGIN = "## My request for Codex:";
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

function stripUserMessagePrefix(text: string): string {
  const idx = text.indexOf(USER_MESSAGE_BEGIN);
  return idx === -1 ? text : text.slice(idx + USER_MESSAGE_BEGIN.length);
}

function stripLeadingCodexContextBlocks(text: string): string {
  let remaining = text.trim();
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const tag of CODEX_CONTEXT_TAGS) {
      const open = `<${tag}>`;
      const close = `</${tag}>`;
      if (!remaining.startsWith(open)) continue;
      const closeIndex = remaining.indexOf(close);
      if (closeIndex === -1) return "";
      remaining = remaining.slice(closeIndex + close.length).trim();
      stripped = true;
      break;
    }
  }
  return remaining;
}

export function codexStripTwoPass(text: string): string {
  let result = text;
  for (let i = 0; i < 2; i++) {
    result = stripUserMessagePrefix(stripLeadingCodexContextBlocks(result)).trim();
  }
  return result;
}

export function contentText(content: any): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    if (typeof content.text === "string") return content.text;
    if (Array.isArray(content.content)) return contentText(content.content);
    return "";
  }
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "output_text" || part?.type === "input_text" || part?.type === "text") {
        return part.text || "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
