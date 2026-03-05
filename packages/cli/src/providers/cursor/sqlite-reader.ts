import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { stat, readFile } from "node:fs/promises";
import type { ParsedTurn, ContentBlock } from "../../types.js";
import type { ProviderParseResult } from "../types.js";

const CURSOR_CHATS_DIR = join(homedir(), ".cursor", "chats");

export function workspaceHash(absolutePath: string): string {
  return createHash("md5").update(absolutePath).digest("hex");
}

export function storeDbPath(workspacePath: string, sessionId: string): string {
  return join(CURSOR_CHATS_DIR, workspaceHash(workspacePath), sessionId, "store.db");
}

export async function storeDbExists(workspacePath: string, sessionId: string): Promise<boolean> {
  const dbPath = storeDbPath(workspacePath, sessionId);
  const s = await stat(dbPath).catch(() => null);
  return !!s?.isFile();
}

interface ChatMeta {
  agentId: string;
  latestRootBlobId: string;
  name?: string;
  mode?: string;
  createdAt?: number;
  lastUsedModel?: string;
}

interface CursorBlock {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, any>;
  result?: string;
  experimental_content?: any[];
  providerOptions?: any;
  signature?: string;
}

interface CursorMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | CursorBlock[];
  providerOptions?: any;
}

function extractChildBlobIds(data: Uint8Array): string[] {
  const ids: string[] = [];
  let i = 0;
  while (i < data.length - 33) {
    if (data[i] === 0x0a && data[i + 1] === 0x20) {
      const hex = Buffer.from(data.subarray(i + 2, i + 34)).toString("hex");
      ids.push(hex);
      i += 34;
    } else {
      i++;
    }
  }
  return ids;
}

export async function parseCursorSqlite(
  workspacePath: string,
  sessionId: string,
): Promise<ProviderParseResult | null> {
  let initSqlJs: any;
  try {
    initSqlJs = (await import("sql.js")).default;
  } catch {
    return null;
  }

  const dbPath = storeDbPath(workspacePath, sessionId);
  const s = await stat(dbPath).catch(() => null);
  if (!s?.isFile()) return null;

  const dbBuffer = await readFile(dbPath);
  const SQL = await initSqlJs();
  const db = new SQL.Database(dbBuffer);

  try {
    const metaRows = db.exec("SELECT value FROM meta WHERE key = '0'");
    if (!metaRows.length || !metaRows[0].values.length) return null;

    const metaHex = metaRows[0].values[0][0] as string;
    const metaJson: ChatMeta = JSON.parse(Buffer.from(metaHex, "hex").toString("utf-8"));
    const rootId = metaJson.latestRootBlobId;

    const rootRows = db.exec("SELECT data FROM blobs WHERE id = ?", [rootId]);
    if (!rootRows.length || !rootRows[0].values.length) return null;

    const rootData = rootRows[0].values[0][0] as Uint8Array;
    const childIds = extractChildBlobIds(rootData);
    if (childIds.length === 0) return null;

    const messages: CursorMessage[] = [];
    const stmt = db.prepare("SELECT data FROM blobs WHERE id = ?");
    for (const cid of childIds) {
      stmt.bind([cid]);
      if (stmt.step()) {
        const blobData = stmt.get()[0] as Uint8Array;
        try {
          const text = new TextDecoder().decode(blobData);
          messages.push(JSON.parse(text));
        } catch {
          // binary or corrupted blob, skip
        }
      }
      stmt.reset();
    }
    stmt.free();

    const turns = messagesToTurns(messages);
    const slug = sessionId.slice(0, 8);

    const firstUser = turns.find((t) => t.role === "user");
    const firstText = firstUser?.blocks.find((b) => b.type === "text");
    const title = metaJson.name || (firstText as any)?.text?.slice(0, 80);

    return {
      sessionId,
      slug,
      title,
      cwd: "",
      model: metaJson.lastUsedModel,
      startTime: metaJson.createdAt ? new Date(metaJson.createdAt).toISOString() : undefined,
      turns,
      dataSource: "sqlite",
    };
  } finally {
    db.close();
  }
}

function buildToolResultMap(messages: CursorMessage[]): Map<string, CursorBlock> {
  const map = new Map<string, CursorBlock>();
  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type === "tool-result" && block.toolCallId) {
        map.set(block.toolCallId, block);
      }
    }
  }
  return map;
}

function messagesToTurns(messages: CursorMessage[]): ParsedTurn[] {
  const toolResults = buildToolResultMap(messages);
  const turns: ParsedTurn[] = [];

  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "tool") continue;

    if (msg.role === "user") {
      const blocks = parseUserContent(msg.content);
      if (blocks.length > 0) {
        turns.push({ role: "user", blocks });
      }
      continue;
    }

    if (msg.role === "assistant") {
      const blocks = parseAssistantContent(msg.content, toolResults);
      if (blocks.length > 0) {
        turns.push({
          role: "assistant",
          blocks,
          model: extractModel(msg),
        });
      }
    }
  }

  return turns;
}

const SYSTEM_CONTEXT_RE = /^<(?:user_info|system_reminder|agent_transcripts|rules|git_status)>/;

function parseUserContent(content: string | CursorBlock[] | undefined): ContentBlock[] {
  if (!content) return [];
  if (typeof content === "string") {
    if (SYSTEM_CONTEXT_RE.test(content.trim())) return [];
    const cleaned = content.replace(/<\/?user_query>/g, "").trim();
    return cleaned ? [{ type: "text", text: cleaned }] : [];
  }
  const blocks: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === "text" && b.text) {
      if (SYSTEM_CONTEXT_RE.test(b.text.trim())) continue;
      const cleaned = b.text.replace(/<\/?user_query>/g, "").trim();
      if (cleaned) blocks.push({ type: "text", text: cleaned });
    }
  }
  return blocks;
}

function parseAssistantContent(
  content: string | CursorBlock[] | undefined,
  toolResults: Map<string, CursorBlock>,
): ContentBlock[] {
  if (!content) return [];
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : [];
  }

  const blocks: ContentBlock[] = [];
  for (const b of content) {
    if (b.type === "reasoning" && b.text?.trim()) {
      blocks.push({ type: "thinking", thinking: b.text } as ContentBlock);
    } else if (b.type === "text" && b.text?.trim()) {
      blocks.push({ type: "text", text: b.text });
    } else if (b.type === "tool-call" && b.toolCallId && b.toolName) {
      const result = toolResults.get(b.toolCallId);
      const toolBlock: any = {
        type: "tool_use",
        id: b.toolCallId,
        name: mapCursorToolName(b.toolName),
        input: mapToolArgs(b.toolName, b.args || {}),
        _result: result?.result || "",
      };
      blocks.push(toolBlock);
    }
  }
  return blocks;
}

function mapCursorToolName(name: string): string {
  const mapping: Record<string, string> = {
    Shell: "Bash",
    Read: "Read",
    ReadFile: "Read",
    Grep: "Grep",
    Glob: "Glob",
    StrReplace: "Edit",
    EditFile: "Edit",
    Write: "Write",
    WriteFile: "Write",
    Delete: "Delete",
    Task: "Task",
    WebFetch: "WebFetch",
  };
  return mapping[name] || name;
}

function mapToolArgs(toolName: string, args: Record<string, any>): Record<string, any> {
  if (toolName === "Shell" && args.command) {
    return { command: args.command, ...(args.description ? { description: args.description } : {}) };
  }
  if (toolName === "StrReplace" && args.path) {
    return {
      file_path: args.path,
      old_string: args.old_string ?? "",
      new_string: args.new_string ?? "",
    };
  }
  if ((toolName === "Write" || toolName === "WriteFile") && args.path) {
    return { file_path: args.path, content: args.contents ?? args.content ?? "" };
  }
  if ((toolName === "Read" || toolName === "ReadFile") && args.path) {
    return { file_path: args.path };
  }
  return args;
}

function extractModel(msg: CursorMessage): string | undefined {
  if (!Array.isArray(msg.content)) return undefined;
  for (const b of msg.content) {
    const model = b.providerOptions?.cursor?.modelName;
    if (model) return model;
  }
  return undefined;
}
