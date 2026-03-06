import { readFile } from "node:fs/promises";
import type { RawMessage, ContentBlock, ParsedTurn } from "../../types.js";
import type { ProviderParseResult, TokenUsage, Compaction } from "../types.js";

export async function parseClaudeCodeSession(filePaths: string | string[]): Promise<ProviderParseResult> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];

  // Read all files and concatenate lines in order (files should be sorted chronologically)
  const allLines: string[] = [];
  for (const fp of paths) {
    const content = await readFile(fp, "utf-8");
    allLines.push(...content.split("\n").filter((l) => l.trim()));
  }

  const lines = allLines;

  let sessionId = "";
  let slug = "";
  let cwd = "";
  let model: string | undefined;
  let title: string | undefined;
  let startTime: string | undefined;
  let endTime: string | undefined;
  let totalDurationMs = 0;

  // Token usage: track last usage per message ID to avoid double-counting
  // (each message.id appears in multiple JSONL lines with the same cumulative usage)
  const usageByMsgId = new Map<string, { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number }>();

  // Compaction events
  const compactions: Compaction[] = [];

  // Group assistant messages by message.id
  const assistantBlocks = new Map<string, ContentBlock[]>();
  const assistantTimestamps = new Map<string, string>();
  const assistantOrder: string[] = [];

  // Collect tool results by tool_use_id
  const toolResults = new Map<string, string>();
  // Collect images from tool results (base64 data URIs) by tool_use_id
  const toolImages = new Map<string, string[]>();

  // User prompts in order
  const userTurns: ParsedTurn[] = [];

  for (const line of lines) {
    let obj: RawMessage;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Extract metadata
    if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
    if (!slug && obj.slug) slug = obj.slug;
    if (!cwd && obj.cwd) cwd = obj.cwd;

    if (obj.type === "custom-title" && (obj as any).title) {
      title = (obj as any).title;
    }

    if (obj.type === "file-history-snapshot") {
      if (!startTime && (obj as any).snapshot?.timestamp) {
        startTime = (obj as any).snapshot.timestamp;
      }
      continue;
    }

    // Skip non-message types
    if (obj.type === "progress") continue;

    if (obj.type === "system") {
      if (obj.subtype === "turn_duration" && obj.durationMs) {
        totalDurationMs += obj.durationMs;
        if (obj.timestamp) endTime = obj.timestamp;
      }
      if (obj.subtype === "compact_boundary" && obj.timestamp) {
        const cm = (obj as any).compactMetadata;
        compactions.push({
          timestamp: obj.timestamp,
          trigger: cm?.trigger || "unknown",
          preTokens: cm?.preTokens,
        });
      }
      continue;
    }

    if (!obj.message) continue;

    const { role, content: msgContent, id: msgId } = obj.message;

    // User message with string content = human prompt (or compaction summary)
    if (role === "user" && typeof msgContent === "string") {
      const isCompaction = msgContent.startsWith("This session is being continued from a previous conversation");
      userTurns.push({
        role: "user",
        ...(isCompaction ? { subtype: "compaction-summary" } : {}),
        timestamp: obj.timestamp,
        blocks: [{ type: "text", text: msgContent }],
      });
      continue;
    }

    // User message with array content (may contain text + images, or tool_results)
    if (role === "user" && Array.isArray(msgContent)) {
      // ToolSearch automated responses have sourceToolAssistantUUID on the raw object.
      // Process tool_result blocks for result matching, but skip emitting a user turn.
      const isToolSearchResponse = !!(obj as any).sourceToolAssistantUUID;

      const textParts: string[] = [];
      const userImages: string[] = [];

      for (const block of msgContent as ContentBlock[]) {
        if (block.type === "tool_result") {
          const resultText = extractToolResultText(block);
          toolResults.set(block.tool_use_id, resultText);
          const images = extractImages(block);
          if (images.length > 0) {
            toolImages.set(block.tool_use_id, images);
          }
        } else if (block.type === "text") {
          textParts.push((block as any).text || "");
        } else if (block.type === "image") {
          // User-pasted screenshot
          const src = (block as any).source;
          if (src?.data) {
            const mediaType = src.media_type || "image/png";
            userImages.push(`data:${mediaType};base64,${src.data}`);
          }
        }
      }

      // Skip emitting user turn for automated ToolSearch responses
      if (!isToolSearchResponse && (textParts.length > 0 || userImages.length > 0)) {
        const blocks: ContentBlock[] = textParts.map((t) => ({ type: "text", text: t } as ContentBlock));
        if (userImages.length > 0) {
          blocks.push({ type: "_user_images", images: userImages } as any);
        }
        userTurns.push({ role: "user", timestamp: obj.timestamp, blocks });
      }

      continue;
    }

    // Assistant message — group by message.id
    if (role === "assistant" && msgId && Array.isArray(msgContent)) {
      if (!model && obj.message.model) model = obj.message.model;

      // Track usage per message ID — overwrite so we keep the last (final) value
      const usage = (obj.message as any).usage;
      if (usage && msgId) {
        usageByMsgId.set(msgId, usage);
      }

      if (!assistantBlocks.has(msgId)) {
        assistantBlocks.set(msgId, []);
        assistantOrder.push(msgId);
        if (obj.timestamp) assistantTimestamps.set(msgId, obj.timestamp);
      }

      const blocks = assistantBlocks.get(msgId)!;
      for (const block of msgContent as ContentBlock[]) {
        if (block.type === "thinking") {
          blocks.push({ type: "thinking", thinking: block.thinking });
        } else if (block.type === "text") {
          blocks.push(block);
        } else if (block.type === "tool_use") {
          blocks.push(block);
        }
      }
    }
  }

  // Interleave user turns with assistant messages
  const finalTurns: ParsedTurn[] = [];
  let assistantIdx = 0;

  for (const turn of userTurns) {
    finalTurns.push(turn);

    // After each user prompt, emit assistant messages until we hit text-only end
    while (assistantIdx < assistantOrder.length) {
      const msgId = assistantOrder[assistantIdx];
      const blocks = assistantBlocks.get(msgId)!;
      assistantIdx++;

      const enrichedBlocks = blocks.map((block) => {
        if (block.type === "tool_use") {
          const result = toolResults.get(block.id) || "";
          const images = toolImages.get(block.id);
          return { ...block, _result: result, _images: images };
        }
        return block;
      });

      finalTurns.push({
        role: "assistant",
        messageId: msgId,
        model,
        timestamp: assistantTimestamps.get(msgId),
        blocks: enrichedBlocks,
      });

      // If last block is text (not tool_use), this assistant turn is complete
      const lastBlock = blocks[blocks.length - 1];
      if (lastBlock && lastBlock.type === "text") break;
    }
  }

  // Emit remaining assistant messages
  while (assistantIdx < assistantOrder.length) {
    const msgId = assistantOrder[assistantIdx];
    const blocks = assistantBlocks.get(msgId)!;
    assistantIdx++;

    const enrichedBlocks = blocks.map((block) => {
      if (block.type === "tool_use") {
        const result = toolResults.get(block.id) || "";
        const images = toolImages.get(block.id);
        return { ...block, _result: result, _images: images };
      }
      return block;
    });

    finalTurns.push({
      role: "assistant",
      messageId: msgId,
      model,
      blocks: enrichedBlocks,
    });
  }

  // Aggregate token usage from deduplicated per-message data
  let tokenUsage: TokenUsage | undefined;
  if (usageByMsgId.size > 0) {
    const totals: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    for (const u of usageByMsgId.values()) {
      totals.inputTokens += u.input_tokens || 0;
      totals.outputTokens += u.output_tokens || 0;
      totals.cacheCreationTokens += u.cache_creation_input_tokens || 0;
      totals.cacheReadTokens += u.cache_read_input_tokens || 0;
    }
    tokenUsage = totals;
  }

  return {
    sessionId,
    slug,
    title,
    cwd,
    model,
    startTime,
    endTime,
    totalDurationMs: totalDurationMs || undefined,
    turns: finalTurns,
    tokenUsage,
    compactions: compactions.length > 0 ? compactions : undefined,
  };
}

function extractImages(block: ContentBlock): string[] {
  if (block.type !== "tool_result") return [];
  const content = (block as any).content;
  if (!Array.isArray(content)) return [];

  const images: string[] = [];
  for (const c of content) {
    if (c.type === "image" && c.source?.data) {
      const mediaType = c.source.media_type || "image/jpeg";
      images.push(`data:${mediaType};base64,${c.source.data}`);
    }
  }
  return images;
}

function extractToolResultText(block: ContentBlock): string {
  if (block.type !== "tool_result") return "";

  const content = (block as any).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (typeof c === "string") return c;
        if (c.type === "text") return c.text;
        return JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(content);
}
