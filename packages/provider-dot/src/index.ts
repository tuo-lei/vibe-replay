import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  ParsedTurn,
  Provider,
  ProviderParseResult,
  SessionInfo,
} from "@vibe-replay/provider-contract";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const DOT_IMPORT_NOTES = [
  "Imported dot conversation text only; this is not a native agent session transcript.",
  "Tool calls, reasoning, model, token usage, costs, compactions, and attachment contents are not available in this source.",
  "Message timestamps describe chat activity, not agent execution duration. Export windows may omit older messages even when partial is false.",
];

/** Read only the user-visible read_messages response shape, never runtime logs. */
export function parseDotExport(value: unknown): ProviderParseResult {
  if (
    !record(value) ||
    !Array.isArray(value.before) ||
    !Array.isArray(value.after) ||
    !(value.message === null || record(value.message)) ||
    typeof value.partial !== "boolean"
  ) {
    throw new Error(
      "Expected a dot conversation read response with before, message, after, and partial fields.",
    );
  }
  const messages = [...value.before, ...(value.message ? [value.message] : []), ...value.after];
  const byId = new Map<string, RecordValue>();
  let skipped = 0;
  for (const message of messages) {
    if (!record(message) || typeof message.message_id !== "string" || !message.message_id) {
      skipped++;
      continue;
    }
    // A deletion tombstone wins regardless of duplicate order.
    if (byId.get(message.message_id)?.deleted_at != null) continue;
    byId.set(message.message_id, message);
  }
  const turns: ParsedTurn[] = [];
  let attachments = false;
  for (const [id, message] of byId) {
    if (message.deleted_at != null) continue;
    if (
      (message.author !== "user" && message.author !== "aeon") ||
      (message.channel !== "chatgpt" && message.channel !== "slack")
    ) {
      skipped++;
      continue;
    }
    const content = message.content;
    if (!record(content)) {
      skipped++;
      continue;
    }
    if (Array.isArray(content.library_attachments) && content.library_attachments.length)
      attachments = true;
    if (typeof content.text !== "string" || !content.text.trim()) continue;
    const timestamp =
      typeof message.sent_at === "string" && Number.isFinite(Date.parse(message.sent_at))
        ? new Date(message.sent_at).toISOString()
        : undefined;
    turns.push({
      role: message.author === "user" ? "user" : "assistant",
      messageId: id,
      timestamp,
      blocks: [{ type: "text", text: content.text }],
    });
  }
  // Preserve supplied room order. Missing or tied timestamps must not reorder messages.
  const times = turns.flatMap((turn) => (turn.timestamp ? [turn.timestamp] : [])).sort();
  const identity = createHash("sha256")
    .update(
      JSON.stringify({
        messages: [...byId].map(([id, message]) => ({ id, deleted: message.deleted_at != null })),
        turns,
        partial: value.partial,
      }),
    )
    .digest("hex")
    .slice(0, 20);
  const title = turns
    .find((turn) => turn.role === "user")
    ?.blocks.find((block) => block.type === "text");
  const notes = [...DOT_IMPORT_NOTES];
  if (!times.length)
    notes.push(
      "No valid message timestamps were supplied; conversation start and end are unavailable.",
    );
  if (value.partial) notes.push("The source marks this conversation window as partial.");
  if (skipped) notes.push(`${skipped} unsupported or malformed message records were omitted.`);
  if (attachments)
    notes.push(
      "Messages include attachments; only their accompanying text is imported. No attachment was fetched.",
    );
  return {
    sessionId: `dot-${identity}`,
    slug: `dot-${identity}`,
    title: title?.type === "text" ? title.text.slice(0, 80) : "dot conversation",
    cwd: "",
    turns,
    startTime: times[0],
    endTime: times.at(-1),
    dataSource: "json",
    dataSourceInfo: { primary: "json", sources: ["dot conversation export"], notes },
  };
}

export async function parseDotSession(
  filePaths: string | string[],
  sessionInfo?: SessionInfo,
): Promise<ProviderParseResult> {
  const paths = typeof filePaths === "string" ? [filePaths] : filePaths;
  if (paths.length !== 1)
    throw new Error(
      "Import one dot conversation window per JSON file; multi-file merging is not supported.",
    );
  const result = parseDotExport(JSON.parse(await readFile(paths[0], "utf8")));
  if (!result.turns.length)
    throw new Error("The dot export contains no replayable conversation text.");
  return {
    ...result,
    sessionId: sessionInfo?.sessionId || result.sessionId,
    slug: sessionInfo?.slug || result.slug,
  };
}

/** Optional, explicit flat export directory. There is deliberately no default raw-log scan. */
export async function discoverDotSessions(): Promise<SessionInfo[]> {
  const directory = process.env.DOT_EXPORTS_DIR?.trim();
  if (!directory) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions: SessionInfo[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(directory, entry.name);
    try {
      const parsed = await parseDotSession(path);
      const info = await stat(path);
      const prompts = parsed.turns
        .filter((turn) => turn.role === "user")
        .flatMap((turn) =>
          turn.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])),
        );
      sessions.push({
        provider: "dot",
        sessionId: parsed.sessionId,
        slug: parsed.slug,
        title: parsed.title,
        project: "dot conversations",
        cwd: "",
        version: "",
        timestamp: parsed.endTime || info.mtime.toISOString(),
        lineCount: parsed.turns.length,
        fileSize: info.size,
        filePath: path,
        filePaths: [path],
        firstPrompt: prompts[0] || "",
        prompts: prompts.slice(0, 2),
        promptCount: prompts.length,
      });
    } catch {
      /* Ignore unrelated/invalid exports rather than claiming they are dot sessions. */
    }
  }
  return sessions;
}

export const dotProvider: Provider = {
  name: "dot",
  displayName: "dot (conversation import)",
  discover: discoverDotSessions,
  parse: parseDotSession,
};
