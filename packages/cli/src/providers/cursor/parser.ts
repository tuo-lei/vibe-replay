import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ParsedTurn } from "../../types.js";
import type { ProviderParseResult } from "../types.js";

export async function parseCursorSession(
  filePaths: string | string[],
): Promise<ProviderParseResult> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

  const allTurns: ParsedTurn[] = [];
  let sessionId = "";

  for (const filePath of paths) {
    if (!sessionId) sessionId = basename(filePath, ".jsonl");

    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      const role = obj.role as "user" | "assistant";
      const contentBlocks = obj.message?.content;
      if (!Array.isArray(contentBlocks)) continue;

      const textParts: string[] = [];
      for (const block of contentBlocks) {
        if (block.type === "text" && block.text) {
          let text = block.text;
          // Strip Cursor's <user_query> wrapper
          text = text.replace(/<\/?user_query>/g, "").trim();
          if (text) textParts.push(text);
        }
      }

      if (textParts.length === 0) continue;

      const fullText = textParts.join("\n");

      allTurns.push({
        role,
        blocks: [{ type: "text", text: fullText }],
      });
    }
  }

  // Derive slug from session ID
  const slug = sessionId.slice(0, 8);

  // Try to extract a meaningful title from first user prompt
  const firstUser = allTurns.find((t) => t.role === "user");
  const firstText = firstUser?.blocks[0]?.type === "text"
    ? (firstUser.blocks[0] as any).text?.slice(0, 80)
    : undefined;

  return {
    sessionId,
    slug,
    title: firstText,
    cwd: "",
    turns: allTurns,
  };
}
