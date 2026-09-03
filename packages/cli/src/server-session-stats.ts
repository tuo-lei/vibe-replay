import { previewPrompt } from "./clean-prompt.js";
import type { ParsedTurn } from "./types.js";

export function countSessionStats(turns: ParsedTurn[]): {
  promptCount: number;
  toolCallCount: number;
} {
  let promptCount = 0;
  let toolCallCount = 0;
  for (const turn of turns) {
    if (turn.role === "user" && turn.subtype !== "compaction-summary") {
      const hasText = turn.blocks.some(
        (block) =>
          block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0,
      );
      const hasImages = turn.blocks.some(
        (block) => block.type === "_user_images" && block.images.length > 0,
      );
      if (hasText || hasImages) promptCount++;
    }
    for (const block of turn.blocks) {
      if (block.type === "tool_use") toolCallCount++;
    }
  }
  return { promptCount, toolCallCount };
}

export function extractPromptPreviewsFromTurns(turns: ParsedTurn[], limit = 3): string[] {
  const prompts: string[] = [];
  for (const turn of turns) {
    if (turn.role !== "user" || turn.subtype === "compaction-summary") continue;
    const text = turn.blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    const cleaned = previewPrompt(text);
    if (cleaned.length < 8 || prompts.includes(cleaned)) continue;
    prompts.push(cleaned);
    if (prompts.length >= limit) break;
  }
  return prompts;
}
