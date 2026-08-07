import type { Annotation, ReplaySession, Scene } from "../types";
import { displayToolName } from "./toolName";
import { getToolDiffs } from "./sceneDiffs";

const MAX_CONTEXT_CHARS = 1_200;

function truncate(text: string, max = MAX_CONTEXT_CHARS): string {
  const normalized = text.trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max).trimEnd()}\n...`;
}

function fence(text: string, language = "markdown"): string {
  const maxBacktickRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const ticks = "`".repeat(Math.max(3, maxBacktickRun + 1));
  return `${ticks}${language}\n${text}\n${ticks}`;
}

export function sceneKindLabel(scene: Scene): string {
  switch (scene.type) {
    case "user-prompt":
      return "User prompt";
    case "compaction-summary":
      return "Context compaction";
    case "context-injection":
      return scene.injectionType
        ? `Context injection (${scene.injectionType})`
        : "Context injection";
    case "thinking":
      return "Agent thinking";
    case "text-response":
      return "Assistant response";
    case "tool-call":
      return `Tool call: ${displayToolName(scene.toolName)}`;
  }
}

export function sceneFeedbackContext(scene: Scene): { text: string; language?: string } {
  switch (scene.type) {
    case "user-prompt":
    case "compaction-summary":
    case "context-injection":
    case "thinking":
    case "text-response":
      return { text: truncate(scene.content), language: "markdown" };
    case "tool-call": {
      const parts = [`Tool: ${displayToolName(scene.toolName)}`];
      const files = getToolDiffs(scene).map((diff) => diff.filePath);
      if (files.length > 0) parts.push(`Files: ${files.join(", ")}`);
      if (scene.bashOutput?.command) parts.push(`Command: ${scene.bashOutput.command}`);
      if (scene.isError) parts.push("Result: error");
      const input = JSON.stringify(scene.input, null, 2);
      if (input && input !== "{}") parts.push(`Input:\n${input}`);
      if (scene.result) parts.push(`Output:\n${truncate(scene.result, 800)}`);
      return { text: truncate(parts.join("\n\n")), language: "text" };
    }
  }
}

export function exportExecutableFeedback(
  session: ReplaySession,
  annotations: Annotation[],
): string {
  const sorted = [...annotations].sort((a, b) => {
    if (a.sceneIndex !== b.sceneIndex) return a.sceneIndex - b.sceneIndex;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  });

  const title = session.meta.title || session.meta.slug || "Untitled replay";
  let output = `# Replay Feedback\n\n`;
  output += `Session: **${title}**\n`;
  output += `Provider: \`${session.meta.provider}\`\n`;
  if (session.meta.project) output += `Project: \`${session.meta.project}\`\n`;
  if (session.meta.model) output += `Model: \`${session.meta.model}\`\n`;
  output += `\n`;

  if (sorted.length === 0) {
    output += "No feedback annotations were added to this replay.\n";
    return output;
  }

  output += `I reviewed this AI coding session and have ${sorted.length} feedback item${
    sorted.length === 1 ? "" : "s"
  }. Please address the comments below, using the cited scene context to understand what happened in the session.\n\n`;

  sorted.forEach((annotation, index) => {
    const scene = session.scenes[annotation.sceneIndex];
    output += `## ${index + 1}. Scene ${annotation.sceneIndex + 1}`;
    if (scene) output += ` - ${sceneKindLabel(scene)}`;
    output += `\n\n`;

    if (scene?.timestamp) output += `Timestamp: \`${scene.timestamp}\`\n\n`;

    if (annotation.selectedText) {
      output += `Selected text:\n\n${fence(annotation.selectedText)}\n\n`;
    }

    output += `Feedback:\n\n> ${annotation.body.replace(/\n/g, "\n> ")}\n\n`;

    if (scene) {
      const context = sceneFeedbackContext(scene);
      output += `Scene context:\n\n${fence(context.text, context.language)}\n\n`;
    }
  });

  return `${output.trimEnd()}\n`;
}
