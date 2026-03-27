import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PrLink, TurnStat } from "@vibe-replay/types";
import { isSystemGeneratedMessage } from "../../clean-prompt.js";
import { estimateActiveDuration } from "../../duration.js";
import type { ContentBlock, ParsedTurn, RawMessage } from "../../types.js";
import type { Compaction, ProviderParseResult, TokenUsage } from "../types.js";

export async function parseClaudeCodeSession(
  filePaths: string | string[],
): Promise<ProviderParseResult> {
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
  const gitBranches: string[] = []; // all branches in order of appearance
  let entrypoint: string | undefined;
  let permissionMode: string | undefined;

  // Token usage: track last usage + model per message ID to avoid double-counting
  // (each message.id appears in multiple JSONL lines with the same cumulative usage)
  const usageByMsgId = new Map<
    string,
    {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      model?: string;
    }
  >();

  // Compaction events
  const compactions: Compaction[] = [];

  // Per-turn duration events (timestamp → durationMs)
  const turnDurations: Array<{ timestamp: string; durationMs: number }> = [];

  // PR link events
  const prLinks: PrLink[] = [];

  // Agent tool_use_id → subagent agentId mapping (from progress messages)
  const agentMapping = new Map<string, string>();

  // API error events
  const apiErrors: Array<{
    timestamp: string;
    statusCode?: number;
    errorType?: string;
    retryAttempt?: number;
  }> = [];

  // Tracked files (from file-history-snapshot messages)
  const trackedFiles = new Set<string>();

  // Group assistant messages by message.id
  const assistantBlocks = new Map<string, ContentBlock[]>();
  const assistantTimestamps = new Map<string, string>();
  const assistantModels = new Map<string, string>();
  const assistantOrder: string[] = [];

  // Collect tool results by tool_use_id
  const toolResults = new Map<string, string>();
  // Collect tool error flags by tool_use_id
  const toolErrors = new Map<string, boolean>();
  // Collect tool result timestamps by tool_use_id (for duration calculation)
  const toolResultTimestamps = new Map<string, string>();
  // Collect images from tool results (base64 data URIs) by tool_use_id
  const toolImages = new Map<string, string[]>();

  // User prompts in order
  const userTurns: ParsedTurn[] = [];

  // All JSONL entry timestamps — used to estimate active duration when turn_duration events are missing
  const allTimestamps: string[] = [];

  for (const line of lines) {
    let obj: RawMessage;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    // Collect timestamps for active-duration estimation
    if (obj.timestamp) allTimestamps.push(obj.timestamp);

    // Extract metadata
    if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
    if (!slug && obj.slug) slug = obj.slug;
    if (!cwd && obj.cwd) cwd = obj.cwd;
    if ((obj as any).gitBranch) {
      const b = (obj as any).gitBranch as string;
      if (gitBranches.length === 0 || gitBranches[gitBranches.length - 1] !== b) {
        gitBranches.push(b);
      }
    }
    if (!entrypoint && (obj as any).entrypoint) entrypoint = (obj as any).entrypoint;
    if (!permissionMode && (obj as any).permissionMode)
      permissionMode = (obj as any).permissionMode;

    if (obj.type === "custom-title") {
      // Real JSONL uses `customTitle`; support `title` as fallback for compatibility
      title = (obj as any).customTitle || (obj as any).title || title;
    }

    if (obj.type === "file-history-snapshot") {
      if (!startTime && (obj as any).snapshot?.timestamp) {
        startTime = (obj as any).snapshot.timestamp;
      }
      // Extract tracked file paths
      const backups = (obj as any).snapshot?.trackedFileBackups;
      if (backups && typeof backups === "object") {
        for (const fp of Object.keys(backups)) {
          trackedFiles.add(fp);
        }
      }
      continue;
    }

    // Progress lines: extract agent mapping before skipping
    if (obj.type === "progress") {
      const data = (obj as any).data;
      if (data?.type === "agent_progress" && data?.agentId && (obj as any).parentToolUseID) {
        agentMapping.set((obj as any).parentToolUseID as string, data.agentId as string);
      }
      continue;
    }

    // PR link events (deduplicate by URL)
    if (obj.type === "pr-link") {
      const d = obj.data || (obj as any);
      if (d.prNumber && d.prUrl && !prLinks.some((p) => p.prUrl === d.prUrl)) {
        prLinks.push({
          prNumber: d.prNumber,
          prUrl: d.prUrl,
          prRepository: d.prRepository || "",
        });
      }
      continue;
    }

    if (obj.type === "system") {
      if (obj.subtype === "turn_duration" && obj.durationMs) {
        totalDurationMs += obj.durationMs;
        if (obj.timestamp) {
          endTime = obj.timestamp;
          turnDurations.push({ timestamp: obj.timestamp, durationMs: obj.durationMs });
        }
      }
      if (obj.subtype === "compact_boundary" && obj.timestamp) {
        const cm = (obj as any).compactMetadata;
        compactions.push({
          timestamp: obj.timestamp,
          trigger: cm?.trigger || "unknown",
          preTokens: cm?.preTokens,
        });
      }
      if (obj.subtype === "api_error" && obj.timestamp) {
        const err = (obj as any).error;
        apiErrors.push({
          timestamp: obj.timestamp,
          statusCode: err?.status || (obj as any).statusCode,
          errorType: err?.error?.error?.type || err?.error?.type,
          retryAttempt: (obj as any).retryAttempt,
        });
      }
      continue;
    }

    if (!obj.message) continue;

    const { role, content: msgContent, id: msgId } = obj.message;

    // User message with string content = human prompt (or compaction summary)
    if (role === "user" && typeof msgContent === "string") {
      if (isSystemGeneratedMessage(msgContent)) continue;
      const isCompaction = msgContent.startsWith(
        "This session is being continued from a previous conversation",
      );
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
          // Capture timestamp for duration calculation
          if (obj.timestamp) toolResultTimestamps.set(block.tool_use_id, obj.timestamp);
          // Capture is_error flag
          if ((block as any).is_error) {
            toolErrors.set(block.tool_use_id, true);
          }
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

      // Skip emitting user turn for automated ToolSearch responses and system-generated messages
      const combinedText = textParts.join("").trim();
      if (
        !isToolSearchResponse &&
        !isSystemGeneratedMessage(combinedText) &&
        (textParts.length > 0 || userImages.length > 0)
      ) {
        const blocks: ContentBlock[] = textParts.map(
          (t) => ({ type: "text", text: t }) as ContentBlock,
        );
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
        usageByMsgId.set(msgId, { ...usage, model: obj.message.model });
      }

      // Track per-message model
      if (obj.message.model && msgId) {
        assistantModels.set(msgId, obj.message.model);
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

  // Read subagent JSONL files: extract full conversations + token usage.
  // Must happen before enrichment so subAgentData is available.
  const subAgentData = await readSubagents(paths[0], usageByMsgId);

  // Build assistant turns with enriched blocks
  const assistantTurns: { turn: ParsedTurn; timestamp: string }[] = [];
  for (const msgId of assistantOrder) {
    const blocks = assistantBlocks.get(msgId)!;
    // Track the previous tool_result timestamp for sequential duration calculation.
    // For the first tool in a message, use the assistant message timestamp as start.
    // For subsequent tools, use the previous tool's result timestamp as start.
    let prevToolEndTs = assistantTimestamps.get(msgId);
    const enrichedBlocks = blocks.map((block) => {
      if (block.type === "tool_use") {
        const result = toolResults.get(block.id) || "";
        const images = toolImages.get(block.id);
        const isError = toolErrors.get(block.id);
        // Attach subagent data for Agent tool calls
        const agentId = agentMapping.get(block.id);
        const subAgent = agentId ? subAgentData.get(agentId) : undefined;
        // Calculate tool execution duration (start = previous tool end or assistant timestamp)
        const resultTs = toolResultTimestamps.get(block.id);
        let toolDurationMs: number | undefined;
        if (resultTs && prevToolEndTs) {
          const diff = Date.parse(resultTs) - Date.parse(prevToolEndTs);
          if (diff > 0 && diff < 3600_000) toolDurationMs = diff;
        }
        if (resultTs) prevToolEndTs = resultTs;
        return {
          ...block,
          _result: result,
          _images: images,
          ...(isError ? { _isError: true } : {}),
          ...(subAgent ? { _subAgent: subAgent } : {}),
          ...(toolDurationMs ? { _durationMs: toolDurationMs } : {}),
        };
      }
      return block;
    });
    const msgModel = assistantModels.get(msgId);
    assistantTurns.push({
      turn: {
        role: "assistant",
        messageId: msgId,
        model: msgModel || model,
        timestamp: assistantTimestamps.get(msgId),
        blocks: enrichedBlocks,
      },
      timestamp: assistantTimestamps.get(msgId) || "",
    });
  }

  // Timestamp-based pairing: merge user and assistant turns chronologically
  type Entry = { type: "user" | "assistant"; turn: ParsedTurn; timestamp: string };
  const entries: Entry[] = [];
  for (const turn of userTurns) {
    entries.push({ type: "user", turn, timestamp: turn.timestamp || "" });
  }
  for (const at of assistantTurns) {
    entries.push({ type: "assistant", turn: at.turn, timestamp: at.timestamp });
  }
  entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  const finalTurns: ParsedTurn[] = entries.map((e) => e.turn);

  // Aggregate token usage from deduplicated per-message data
  let tokenUsage: TokenUsage | undefined;
  let tokenUsageByModel: Record<string, TokenUsage> | undefined;
  if (usageByMsgId.size > 0) {
    const totals: TokenUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    };
    const byModel: Record<string, TokenUsage> = {};
    for (const u of usageByMsgId.values()) {
      const input = u.input_tokens || 0;
      const output = u.output_tokens || 0;
      const cacheCreate = u.cache_creation_input_tokens || 0;
      const cacheRead = u.cache_read_input_tokens || 0;

      totals.inputTokens += input;
      totals.outputTokens += output;
      totals.cacheCreationTokens += cacheCreate;
      totals.cacheReadTokens += cacheRead;

      // Falls back to session-level model, then "unknown" (priced at Sonnet rates via DEFAULT_PRICING)
      const msgModel = u.model || model || "unknown";
      if (!byModel[msgModel]) {
        byModel[msgModel] = {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        };
      }
      byModel[msgModel].inputTokens += input;
      byModel[msgModel].outputTokens += output;
      byModel[msgModel].cacheCreationTokens += cacheCreate;
      byModel[msgModel].cacheReadTokens += cacheRead;
    }
    tokenUsage = totals;
    tokenUsageByModel = byModel;
  }

  // Build per-user-turn stats: aggregate token usage + model + duration for each user turn
  const turnStats = buildTurnStats(finalTurns, usageByMsgId, turnDurations);

  // Build subagent summary for metadata
  const subAgentSummary =
    subAgentData.size > 0
      ? Array.from(subAgentData.values()).map((sa) => ({
          agentId: sa.agentId,
          agentType: sa.agentType,
          description: sa.description,
          toolCalls: sa.toolCalls,
          model: sa.model,
        }))
      : undefined;

  // Convert tracked files to sorted array (limit to 200)
  const trackedFilesArr =
    trackedFiles.size > 0 ? [...trackedFiles].sort().slice(0, 200) : undefined;

  return {
    sessionId,
    slug,
    title,
    cwd,
    model,
    startTime,
    endTime,
    totalDurationMs: totalDurationMs || estimateActiveDuration(allTimestamps),
    turns: finalTurns,
    tokenUsage,
    tokenUsageByModel,
    compactions: compactions.length > 0 ? compactions : undefined,
    turnStats: turnStats.length > 0 ? turnStats : undefined,
    prLinks: prLinks.length > 0 ? prLinks : undefined,
    subAgentSummary,
    gitBranch: gitBranches.length > 0 ? gitBranches[gitBranches.length - 1] : undefined,
    gitBranches: gitBranches.length > 1 ? gitBranches : undefined,
    entrypoint,
    permissionMode,
    apiErrors: apiErrors.length > 0 ? apiErrors : undefined,
    trackedFiles: trackedFilesArr,
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

/**
 * Build per-user-turn stats by aggregating assistant messageId token usage + model + duration.
 * A "turn" = one user prompt + all assistant responses until the next user prompt.
 */
function buildTurnStats(
  finalTurns: ParsedTurn[],
  usageByMsgId: Map<
    string,
    {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      model?: string;
    }
  >,
  turnDurations: Array<{ timestamp: string; durationMs: number }>,
): TurnStat[] {
  if (usageByMsgId.size === 0 && turnDurations.length === 0) return [];

  // Group assistant messageIds by user-turn index (0-based)
  // A user turn boundary = where role === "user" and subtype is not compaction-summary
  const turnGroups: Array<{ msgIds: string[]; startTimestamp: string; endTimestamp: string }> = [];
  let currentMsgIds: string[] = [];
  let lastTimestamp = "";
  let turnStartTimestamp = "";

  for (const turn of finalTurns) {
    if (turn.role === "user" && turn.subtype !== "compaction-summary") {
      if (turnGroups.length > 0 || currentMsgIds.length > 0) {
        // Close previous turn group
        turnGroups.push({
          msgIds: currentMsgIds,
          startTimestamp: turnStartTimestamp,
          endTimestamp: lastTimestamp,
        });
        currentMsgIds = [];
      }
      turnStartTimestamp = turn.timestamp || "";
    }
    if (turn.role === "assistant" && turn.messageId) {
      currentMsgIds.push(turn.messageId);
      lastTimestamp = turn.timestamp || lastTimestamp;
    }
  }
  // Close last group (only if it has assistant messages to avoid empty trailing entry)
  if (currentMsgIds.length > 0) {
    turnGroups.push({
      msgIds: currentMsgIds,
      startTimestamp: turnStartTimestamp,
      endTimestamp: lastTimestamp,
    });
  }

  // Sort duration events by timestamp for matching
  const sortedDurations = [...turnDurations].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  let durationIdx = 0;

  const stats: TurnStat[] = [];
  for (let i = 0; i < turnGroups.length; i++) {
    const group = turnGroups[i];
    let turnTokens: TokenUsage | undefined;
    let turnModel: string | undefined;
    let maxContextTokens = 0;

    for (const msgId of group.msgIds) {
      const u = usageByMsgId.get(msgId);
      if (!u) continue;
      if (!turnModel && u.model) turnModel = u.model;

      if (!turnTokens) {
        turnTokens = {
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        };
      }
      turnTokens.inputTokens += u.input_tokens || 0;
      turnTokens.outputTokens += u.output_tokens || 0;
      turnTokens.cacheCreationTokens += u.cache_creation_input_tokens || 0;
      turnTokens.cacheReadTokens += u.cache_read_input_tokens || 0;

      // Context window = total prompt tokens for this single API call
      const msgContext =
        (u.input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.cache_creation_input_tokens || 0);
      if (msgContext > maxContextTokens) maxContextTokens = msgContext;
    }

    // Match duration sequentially — turn_duration events fire in order, one per user turn
    let durationMs: number | undefined;
    if (durationIdx < sortedDurations.length) {
      durationMs = sortedDurations[durationIdx].durationMs;
      durationIdx++;
    } else if (group.startTimestamp && group.endTimestamp) {
      // Fallback: estimate active duration from turn timestamps (avoids wall-clock inflation
      // for VS Code sessions where turn_duration events are absent)
      durationMs = estimateActiveDuration([group.startTimestamp, group.endTimestamp]);
    }

    const stat: TurnStat = { turnIndex: i };
    if (turnModel) stat.model = turnModel;
    if (durationMs !== undefined) stat.durationMs = durationMs;
    if (turnTokens) stat.tokenUsage = turnTokens;
    if (maxContextTokens > 0) stat.contextTokens = maxContextTokens;
    stats.push(stat);
  }

  return stats;
}

interface SubAgentParsed {
  agentId: string;
  agentType: string;
  description?: string;
  prompt: string;
  toolCalls: number;
  thinkingBlocks: number;
  textResponses: number;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  };
  model?: string;
  scenes: Array<{
    type: string;
    content?: string;
    toolName?: string;
    input?: Record<string, any>;
    result?: string;
    isError?: boolean;
    timestamp?: string;
  }>;
}

/**
 * Read subagent JSONL files: merge token usage AND parse full conversations.
 * Returns Map<agentId, SubAgentParsed> keyed by the agent identifier from the filename.
 */
async function readSubagents(
  mainFilePath: string,
  usageByMsgId: Map<
    string,
    {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      model?: string;
    }
  >,
): Promise<Map<string, SubAgentParsed>> {
  const result = new Map<string, SubAgentParsed>();
  const sessionDir = mainFilePath.replace(/\.jsonl$/, "");
  const subagentsDir = join(sessionDir, "subagents");

  let files: string[];
  try {
    files = await readdir(subagentsDir);
  } catch {
    return result; // No subagents directory
  }

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    // Agent ID derived from filename must match data.agentId in progress messages.
    // Convention: filename is "agent-<id>.jsonl", progress has data.agentId = "<id>".
    // If Claude Code changes this convention, subagent data won't be linked (silent miss).
    const agentId = file.replace(/\.jsonl$/, "").replace(/^agent-/, "");

    // Read meta.json for agent type
    let agentType = "unknown";
    let description: string | undefined;
    try {
      const metaPath = join(subagentsDir, file.replace(/\.jsonl$/, ".meta.json"));
      const metaContent = await readFile(metaPath, "utf-8");
      const meta = JSON.parse(metaContent);
      agentType = meta.agentType || "unknown";
      description = meta.description;
    } catch {}

    let content: string;
    try {
      content = await readFile(join(subagentsDir, file), "utf-8");
    } catch {
      continue;
    }

    // Parse subagent JSONL into lightweight scenes
    let prompt = "";
    let model: string | undefined;
    let toolCalls = 0;
    let thinkingBlocks = 0;
    let textResponses = 0;
    const scenes: SubAgentParsed["scenes"] = [];
    const saUsage = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
    let hasUsage = false;

    // Track tool results for enrichment
    const saToolResults = new Map<string, string>();
    const saToolErrors = new Map<string, boolean>();

    // Collect assistant blocks by message ID (same dedup as main parser)
    const saAssistantBlocks = new Map<string, ContentBlock[]>();
    const saAssistantOrder: string[] = [];
    const saAssistantTimestamps = new Map<string, string>();

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      // Merge usage into main map (existing behavior)
      const msg = obj?.message;
      if (msg?.usage && msg?.id) {
        usageByMsgId.set(msg.id, { ...msg.usage, model: msg.model });
      }

      if (obj.type === "progress") continue;
      if (!obj.message) continue;

      const { role, content: msgContent, id: msgId } = obj.message;

      // Extract first user prompt
      if (role === "user" && typeof msgContent === "string" && !prompt) {
        prompt = msgContent.slice(0, 500);
      }
      if (role === "user" && Array.isArray(msgContent)) {
        // Collect user prompt text and tool results
        for (const block of msgContent) {
          if (block.type === "text" && !prompt) {
            prompt = (block.text || "").slice(0, 500);
          }
          if (block.type === "tool_result") {
            const resultText =
              typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.map((c: any) => c.text || "").join("\n")
                  : "";
            saToolResults.set(block.tool_use_id, resultText.slice(0, 1000));
            if (block.is_error) saToolErrors.set(block.tool_use_id, true);
          }
        }
      }

      // Assistant blocks — dedup by message ID
      if (role === "assistant" && msgId && Array.isArray(msgContent)) {
        if (!model && obj.message.model && obj.message.model !== "<synthetic>") {
          model = obj.message.model;
        }

        // Accumulate usage
        const u = obj.message.usage;
        if (u && msgId) {
          // Only count final usage per message ID
          if (!saAssistantBlocks.has(msgId)) {
            hasUsage = true;
            saUsage.inputTokens += u.input_tokens || 0;
            saUsage.outputTokens += u.output_tokens || 0;
            saUsage.cacheCreationTokens += u.cache_creation_input_tokens || 0;
            saUsage.cacheReadTokens += u.cache_read_input_tokens || 0;
          }
        }

        if (!saAssistantBlocks.has(msgId)) {
          saAssistantBlocks.set(msgId, []);
          saAssistantOrder.push(msgId);
          if (obj.timestamp) saAssistantTimestamps.set(msgId, obj.timestamp);
        }

        const blocks = saAssistantBlocks.get(msgId)!;
        for (const block of msgContent) {
          if (block.type === "thinking" || block.type === "text" || block.type === "tool_use") {
            blocks.push(block);
          }
        }
      }
    }

    // Build scenes from deduplicated assistant blocks
    for (const msgId of saAssistantOrder) {
      const blocks = saAssistantBlocks.get(msgId)!;
      const ts = saAssistantTimestamps.get(msgId);
      for (const block of blocks) {
        if (block.type === "thinking") {
          const thinking = (block as any).thinking || "";
          if (thinking.trim()) {
            scenes.push({ type: "thinking", content: thinking.slice(0, 500), timestamp: ts });
            thinkingBlocks++;
          }
        } else if (block.type === "text") {
          const text = (block as any).text || "";
          if (text.trim()) {
            scenes.push({ type: "text-response", content: text.slice(0, 1000), timestamp: ts });
            textResponses++;
          }
        } else if (block.type === "tool_use") {
          const toolResult = saToolResults.get(block.id) || "";
          const isError = saToolErrors.get(block.id);
          scenes.push({
            type: "tool-call",
            toolName: block.name,
            input: block.input,
            result: toolResult,
            isError: isError || false,
            timestamp: ts,
          });
          toolCalls++;
        }
      }
    }

    // Cap scenes to keep HTML size reasonable
    const maxScenes = 60;
    const cappedScenes = scenes.length > maxScenes ? scenes.slice(0, maxScenes) : scenes;

    result.set(agentId, {
      agentId,
      agentType,
      description,
      prompt,
      toolCalls,
      thinkingBlocks,
      textResponses,
      tokenUsage: hasUsage ? saUsage : undefined,
      model,
      scenes: cappedScenes,
    });
  }

  return result;
}
