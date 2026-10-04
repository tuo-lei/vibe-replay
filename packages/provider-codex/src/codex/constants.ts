const USER_MESSAGE_PREFIXES = ["## My request for Codex:", "## My request:"];
export const CODEX_CONTEXT_TAGS = [
  "environment_context",
  "permissions instructions",
  "app-context",
  "collaboration_mode",
  "apps_instructions",
  "skills_instructions",
  "plugins_instructions",
  "recommended_plugins",
  "external_codex_apps_open_page",
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
  for (const prefix of USER_MESSAGE_PREFIXES) {
    if (text.startsWith(prefix)) return text.slice(prefix.length);
  }
  // File/IDE context is a host envelope. Prefix-looking examples elsewhere in
  // a human's prose must remain part of that human request.
  if (/^# (?:Files mentioned by the user|Context from my IDE setup):(?:\r?\n|$)/.test(text)) {
    const request = /^## My request(?: for Codex)?:/m.exec(text);
    if (request) return text.slice(request.index + request[0].length);
  }
  return text;
}

/** Persisted host messages are replay context, not human interventions. */
export function codexUserMessageSubtype(text: string): string | undefined {
  const leading = stripLeadingCodexContextBlocks(text).trim();
  // An instructions document stays injected context even if its examples
  // contain request-prefix syntax. Otherwise classify the displayed content.
  if (/^# AGENTS\.md instructions for [^\n]+\n/.test(leading)) return "context-injection";
  const value = codexStripTwoPass(leading);
  if (value.startsWith("<heartbeat>")) return "automation-trigger";
  if (/^Automation: [^\n]+\nAutomation ID: [^\n]+(?:\n|$)/.test(value)) return "automation-trigger";
  if (/^# AGENTS\.md instructions for [^\n]+\n/.test(value)) return "context-injection";
  return undefined;
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
