import type { Scene } from "../../types";

export function userPrompt(content = "hello"): Scene {
  return { type: "user-prompt", content };
}

export function thinking(content = "hmm"): Scene {
  return { type: "thinking", content };
}

export function textResponse(content = "hi"): Scene {
  return { type: "text-response", content };
}

export function toolCall(
  toolName = "Read",
  opts: { diff?: boolean; bashOutput?: boolean } = {},
): Scene {
  return {
    type: "tool-call",
    toolName,
    input: {},
    result: "",
    ...(opts.diff ? { diff: { filePath: "a.ts", oldContent: "", newContent: "x" } } : {}),
    ...(opts.bashOutput ? { bashOutput: { command: "ls", stdout: "files" } } : {}),
  };
}
