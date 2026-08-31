import type { Scene } from "../types";

/** Semantic accents shared by replay cards, badges, search results, and the timeline. */
export type SceneTone = "user" | "response" | "tool" | "context" | "thinking" | "error";

export interface SceneToneClasses {
  color: string;
  text: string;
  subtle: string;
  emphasis: string;
  border: string;
}

/**
 * Keep the role palette in one place. The CSS variables resolve to the
 * current light/dark theme, while the Tailwind classes keep the same mapping
 * available to React components.
 */
export const SCENE_TONE_CLASSES: Record<SceneTone, SceneToneClasses> = {
  user: {
    color: "var(--accent-user)",
    text: "text-terminal-user",
    subtle: "bg-terminal-user-subtle",
    emphasis: "bg-terminal-user-emphasis",
    border: "border-terminal-user",
  },
  response: {
    color: "var(--accent-response)",
    text: "text-terminal-response",
    subtle: "bg-terminal-response-subtle",
    emphasis: "bg-terminal-response-emphasis",
    border: "border-terminal-response",
  },
  tool: {
    color: "var(--accent-tool)",
    text: "text-terminal-tool",
    subtle: "bg-terminal-tool-subtle",
    emphasis: "bg-terminal-tool-emphasis",
    border: "border-terminal-tool",
  },
  context: {
    color: "var(--accent-context)",
    text: "text-terminal-context",
    subtle: "bg-terminal-context-subtle",
    emphasis: "bg-terminal-context-emphasis",
    border: "border-terminal-context",
  },
  thinking: {
    color: "var(--accent-thinking)",
    text: "text-terminal-thinking",
    subtle: "bg-terminal-thinking-subtle",
    emphasis: "bg-terminal-thinking-emphasis",
    border: "border-terminal-thinking",
  },
  error: {
    color: "var(--accent-error)",
    text: "text-terminal-error",
    subtle: "bg-terminal-error-subtle",
    emphasis: "bg-terminal-error-emphasis",
    border: "border-terminal-error",
  },
};

export function sceneTone(scene: Scene): SceneTone {
  if (scene.type === "tool-call" && scene.isError) return "error";
  if (scene.type === "text-response" && scene.isTruncated) return "error";
  switch (scene.type) {
    case "user-prompt":
      return "user";
    case "text-response":
      return "response";
    case "tool-call":
      return "tool";
    case "thinking":
      return "thinking";
    case "compaction-summary":
    case "context-injection":
      return "context";
  }
}

export function sceneToneClasses(scene: Scene): SceneToneClasses {
  return SCENE_TONE_CLASSES[sceneTone(scene)];
}

export function sceneToneTextClass(scene: Scene): string {
  return sceneToneClasses(scene).text;
}
