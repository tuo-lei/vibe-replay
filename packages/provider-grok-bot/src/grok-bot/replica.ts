import type { ParsedTurn } from "@vibe-replay/provider-contract";
import { decodeBase32, encodeBase32 } from "./base32.js";
import { formatAttachedImageMention } from "./media.js";

/**
 * Mac desktop client cache. Blob filenames are base32 of
 * `sand.client.slice.account.<slot>.transcript.replicas.<agentUuid>`.
 * The JSON is `{ schemaVersion, value: { entries } }` — a recent UI window,
 * not the full tool timeline.
 */
const REPLICA_KEY_RE =
  /^sand\.client\.slice\.account\.[^.]+\.transcript\.replicas\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export function replicaKey(agentId: string, accountSlot = "0"): string {
  return `sand.client.slice.account.${accountSlot}.transcript.replicas.${agentId}`;
}

export function replicaBlobFilename(agentId: string, accountSlot = "0"): string {
  return `${encodeBase32(replicaKey(agentId, accountSlot))}.blob`;
}

export function agentIdFromReplicaFilename(filename: string): string | undefined {
  const base = filename.replace(/\.(blob|json)$/i, "");
  const decoded = decodeBase32(base);
  if (!decoded) return undefined;
  const match = REPLICA_KEY_RE.exec(decoded.trim());
  return match?.[1]?.toLowerCase();
}

export interface ReplicaSummary {
  prompts: string[];
  promptCount: number;
  timestamp?: string;
  title?: string;
  entryCount: number;
}

interface ReplicaEntry {
  kind?: unknown;
  timestampMs?: unknown;
  seq?: unknown;
  role?: unknown;
  content?: unknown;
  richText?: unknown;
  message?: unknown;
  file_name?: unknown;
  file_path?: unknown;
  reactions?: unknown;
  event?: unknown;
  call?: unknown;
}

export function replicaEntries(raw: unknown): ReplicaEntry[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.entries)) return obj.entries as ReplicaEntry[];
  const value = obj.value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = (value as Record<string, unknown>).entries;
    if (Array.isArray(entries)) return entries as ReplicaEntry[];
  }
  return [];
}

export function replicaTitleHint(raw: unknown): string | undefined {
  let title: string | undefined;
  for (const entry of sortedEntries(raw)) {
    if (entry.kind !== "event") continue;
    const event = asRecord(entry.event);
    if (event?.type === "name-changed") {
      const next = firstString(event.to);
      if (next) title = next;
    }
  }
  return title;
}

export function summarizeReplicaDocument(raw: unknown): ReplicaSummary | null {
  const entries = sortedEntries(raw);
  if (entries.length === 0) return null;
  const prompts: string[] = [];
  let promptCount = 0;
  let timestamp: string | undefined;
  let title: string | undefined;
  for (const entry of entries) {
    const iso = isoFromMs(entry.timestampMs);
    if (iso) timestamp = iso;
    const kind = typeof entry.kind === "string" ? entry.kind : "";
    if (kind === "message" && entryRole(entry) !== "assistant") {
      const text = messageText(entry);
      if (!text) continue;
      promptCount++;
      if (prompts.length < 2) prompts.push(text.slice(0, 200));
      continue;
    }
    if (kind === "user-attachment") {
      const name = firstString(entry.file_name) || "file";
      promptCount++;
      if (prompts.length < 2) prompts.push(`[attached image: ${name}]`);
      continue;
    }
    if (kind === "event") {
      const event = asRecord(entry.event);
      if (event?.type === "name-changed") {
        const next = firstString(event.to);
        if (next) title = next;
      }
    }
  }
  return { prompts, promptCount, timestamp, title, entryCount: entries.length };
}

/** Synthetic JSONL records so the existing user/send_message parser can run. */
export function replicaDocumentToLines(raw: unknown): string[] {
  const entries = sortedEntries(raw);
  const sendTexts = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "send-message") continue;
    const text = normalizeText(outboundText(sendPayload(entry)));
    if (text) sendTexts.add(text);
  }
  const lines: string[] = [];
  for (const entry of entries) {
    const timestamp = isoFromMs(entry.timestampMs);
    const kind = typeof entry.kind === "string" ? entry.kind : "";
    if (kind === "message") {
      const text = messageText(entry);
      if (!text) continue;
      if (entryRole(entry) === "assistant" && sendTexts.has(normalizeText(text))) continue;
      const role = entryRole(entry) === "assistant" ? "assistant" : "user";
      if (role === "assistant") {
        lines.push(
          JSON.stringify({
            ...(timestamp ? { timestamp } : {}),
            role,
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "send_message",
                  input: { text: { content: text } },
                },
              ],
            },
          }),
        );
      } else {
        lines.push(
          JSON.stringify({
            ...(timestamp ? { timestamp } : {}),
            role: "user",
            message: { content: [{ type: "text", text }] },
          }),
        );
      }
      continue;
    }
    if (kind === "send-message") {
      lines.push(
        JSON.stringify({
          ...(timestamp ? { timestamp } : {}),
          role: "assistant",
          message: {
            content: [{ type: "tool_use", name: "send_message", input: sendPayload(entry) }],
          },
        }),
      );
    }
  }
  return lines;
}

/** UI entries that are not chat text: attachments, voice calls, name changes. */
export function replicaSideTurns(raw: unknown): ParsedTurn[] {
  const turns: ParsedTurn[] = [];
  for (const entry of sortedEntries(raw)) {
    const timestamp = isoFromMs(entry.timestampMs);
    const kind = typeof entry.kind === "string" ? entry.kind : "";
    if (kind === "user-attachment") {
      const name = firstString(entry.file_name) || "file";
      const path = firstString(entry.file_path);
      const text = path
        ? formatAttachedImageMention(name, path.split("?")[0] || path)
        : `[attached image: ${name}]`;
      turns.push({
        role: "user",
        ...(timestamp ? { timestamp } : {}),
        blocks: [{ type: "text", text }],
      });
      continue;
    }
    if (kind === "voice-call") {
      const call = asRecord(entry.call);
      const ending = firstString(call?.ending) || "ended";
      const duration =
        typeof call?.durationMs === "number" && call.durationMs >= 0
          ? ` (${Math.round(call.durationMs / 1000)}s)`
          : "";
      turns.push({
        role: "user",
        subtype: "context-injection",
        ...(timestamp ? { timestamp } : {}),
        blocks: [{ type: "text", text: `Voice call ${ending}${duration}` }],
      });
      continue;
    }
    if (kind === "event") {
      const text = eventLine(asRecord(entry.event));
      if (!text) continue;
      turns.push({
        role: "user",
        subtype: "context-injection",
        ...(timestamp ? { timestamp } : {}),
        blocks: [{ type: "text", text }],
      });
    }
  }
  return turns;
}

export function mergeReplicaTurns(base: ParsedTurn[], extra: ParsedTurn[]): ParsedTurn[] {
  const basePool = base
    .map((turn) => ({ key: turnKey(turn), timestamp: turn.timestamp, used: false }))
    .filter((item) => !item.key.endsWith(":"));
  const seenExtra = new Set<string>();
  const added: ParsedTurn[] = [];
  for (const turn of extra) {
    const key = turnKey(turn);
    if (key.endsWith(":")) continue;
    const identity = `${key}\0${turn.timestamp || ""}`;
    if (seenExtra.has(identity)) continue;
    // Allow small tool-result/UI clock skew, never match old and recent activity
    // solely by text. Missing clocks retain legacy one-to-one content matching.
    const stamp = turn.timestamp ? Date.parse(turn.timestamp) : NaN;
    const match =
      basePool.find(
        (item) =>
          !item.used &&
          item.key === key &&
          item.timestamp &&
          Math.abs(Date.parse(item.timestamp) - stamp) <= 5_000,
      ) ||
      basePool.find(
        (item) => !item.used && item.key === key && (!item.timestamp || !turn.timestamp),
      );
    if (match) {
      match.used = true;
      continue;
    }
    seenExtra.add(identity);
    added.push(turn);
  }
  added.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
  if (added.length === 0) return base;
  const merged = [...base];
  for (const turn of added) {
    const stamp = turn.timestamp || "";
    if (!stamp) {
      merged.push(turn);
      continue;
    }
    let index = merged.length;
    for (let i = 0; i < merged.length; i++) {
      const other = merged[i]?.timestamp || "";
      if (other && other > stamp) {
        index = i;
        break;
      }
    }
    merged.splice(index, 0, turn);
  }
  return merged;
}

function turnKey(turn: ParsedTurn): string {
  const text = turn.blocks
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
  return `${turn.role}:${turn.subtype || ""}:${normalizeText(text)}`;
}

function outboundText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return typeof payload === "string" ? payload : "";
  }
  const obj = payload as Record<string, unknown>;
  if (typeof obj.content === "string") return obj.content;
  const text = obj.text;
  if (typeof text === "string") return text;
  if (text && typeof text === "object" && !Array.isArray(text)) {
    const content = (text as Record<string, unknown>).content;
    if (typeof content === "string") return content;
  }
  return "";
}

function sendPayload(entry: ReplicaEntry): unknown {
  if (entry.message && typeof entry.message === "object") return entry.message;
  return entry;
}

function messageText(entry: ReplicaEntry): string {
  const content = firstString(entry.content, entry.richText);
  if (content) return content;
  if (!Array.isArray(entry.reactions) || entry.reactions.length === 0) return "";
  const emojis = entry.reactions
    .map((reaction) => {
      if (!reaction || typeof reaction !== "object") return "";
      return firstString((reaction as Record<string, unknown>).emoji) || "";
    })
    .filter(Boolean);
  if (emojis.length === 0) return "";
  return `[reaction: ${emojis.join(" ")}]`;
}

function entryRole(entry: ReplicaEntry): string {
  return typeof entry.role === "string" ? entry.role.toLowerCase() : "user";
}

function eventLine(event: Record<string, unknown> | undefined): string | undefined {
  if (!event) return undefined;
  const type = firstString(event.type);
  if (type === "name-changed") {
    const from = firstString(event.from);
    const to = firstString(event.to);
    if (from && to) return `Name changed from ${from} to ${to}`;
    if (to) return `Name changed to ${to}`;
    return undefined;
  }
  if (type === "automation-changed") {
    const action = firstString(event.action) || "updated";
    const name = firstString(event.automationName, event.automationId) || "automation";
    return `Automation ${action}: ${name}`;
  }
  return undefined;
}

function sortedEntries(raw: unknown): ReplicaEntry[] {
  return [...replicaEntries(raw)].sort((a, b) => {
    const seqA = typeof a.seq === "number" ? a.seq : Number.MAX_SAFE_INTEGER;
    const seqB = typeof b.seq === "number" ? b.seq : Number.MAX_SAFE_INTEGER;
    if (seqA !== seqB) return seqA - seqB;
    const timeA = typeof a.timestampMs === "number" ? a.timestampMs : 0;
    const timeB = typeof b.timestampMs === "number" ? b.timestampMs : 0;
    return timeA - timeB;
  });
}

function isoFromMs(value: unknown): string | undefined {
  const ms =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d{10,13}$/.test(value.trim())
        ? Number(value.trim())
        : undefined;
  if (ms == null || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms < 1e12 ? ms * 1000 : ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
