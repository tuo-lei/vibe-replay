/**
 * Grok Bot group-chat wakes are injected as ordinary `role:"user"` JSONL
 * text starting with `[Group chat:`. This module splits that blob into room
 * metadata plus ordered speaker messages, and drops procedural turn cues.
 */

export interface GrokBotGroupParticipant {
  name: string;
  description?: string;
}

export interface GrokBotGroupMessage {
  speaker: string;
  text: string;
  mentions: string[];
}

export interface GrokBotGroupWake {
  groupTitle: string;
  withParticipants: string[];
  participants: GrokBotGroupParticipant[];
  messages: GrokBotGroupMessage[];
  noNewMessages: boolean;
  mentions: string[];
  turnRecipient?: string;
}

const GROUP_PREFIX_RE = /^\s*\[Group chat:/i;
const HEADER_RE =
  /^\[Group chat:\s*(?:"([^"]+)"|“([^”]+)”|([^\]-]+?))(?:\s*-\s*with\s+([^\]]+))?\]\s*/i;
const PARTICIPANT_PAIR_RE = /([^,()]+?)\s*\(([^)]*)\)/g;
const MENTION_TOKEN_RE = /@([A-Za-z][\w.-]*)/g;
const TURN_RECIPIENT_RE = /^It's your turn,\s*(.+?)(?:\.|$)/i;
const NEW_MESSAGES_RE = /^New messages in the room\b/i;
const NO_NEW_MESSAGES_RE = /^No new messages in the room\b/i;
const WRAPPING_UP_RE = /^The room is wrapping up\b/i;
const YOUR_TURN_RE = /^It's your turn\b/i;
const REPLY_IN_ROOM_RE = /^Reply in the room\b/i;
const PARTICIPANTS_RE = /^Participants:\s*/i;

const RESERVED_SPEAKERS = new Set([
  "error",
  "example",
  "fix",
  "input",
  "issue",
  "note",
  "output",
  "participants",
  "summary",
  "tip",
  "usage",
  "warning",
]);

export function isGrokBotGroupChatPayload(text: string): boolean {
  return GROUP_PREFIX_RE.test(text);
}

export function parseGrokBotGroupWake(text: string): GrokBotGroupWake | null {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!isGrokBotGroupChatPayload(trimmed)) return null;

  const header = HEADER_RE.exec(trimmed);
  const groupTitle = (header?.[1] || header?.[2] || header?.[3] || "").trim();
  const withParticipants = splitNameList(header?.[4] || "");
  const afterHeader = header ? trimmed.slice(header[0].length) : trimmed.replace(GROUP_PREFIX_RE, "");
  const lines = afterHeader.replace(/\r\n/g, "\n").split("\n");

  const participants: GrokBotGroupParticipant[] = [];
  const messages: GrokBotGroupMessage[] = [];
  let noNewMessages = false;
  let turnRecipient: string | undefined;
  let inMessages = false;
  let current: { speaker: string; lines: string[] } | undefined;

  const knownNames = (): string[] => {
    const names = ["User", ...withParticipants, ...participants.map((p) => p.name)];
    if (turnRecipient) names.push(turnRecipient);
    return uniqueNames(names);
  };

  const flush = () => {
    if (!current) return;
    const textBody = current.lines.join("\n").trim();
    if (textBody) {
      messages.push({
        speaker: current.speaker,
        text: textBody,
        mentions: [],
      });
    }
    current = undefined;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      if (current) current.lines.push("");
      continue;
    }

    if (PARTICIPANTS_RE.test(trimmedLine) && !inMessages) {
      participants.push(...parseParticipantList(trimmedLine.replace(PARTICIPANTS_RE, "")));
      continue;
    }

    if (NO_NEW_MESSAGES_RE.test(trimmedLine)) {
      flush();
      noNewMessages = true;
      inMessages = false;
      continue;
    }

    if (NEW_MESSAGES_RE.test(trimmedLine)) {
      flush();
      inMessages = true;
      continue;
    }

    if (YOUR_TURN_RE.test(trimmedLine) || WRAPPING_UP_RE.test(trimmedLine) || REPLY_IN_ROOM_RE.test(trimmedLine)) {
      flush();
      inMessages = false;
      const recipient = TURN_RECIPIENT_RE.exec(trimmedLine)?.[1]?.trim();
      if (recipient) turnRecipient = recipient;
      continue;
    }

    const speaker = findSpeaker(trimmedLine, knownNames());
    if (speaker && (inMessages || current || messages.length > 0 || speaker.known)) {
      flush();
      inMessages = true;
      current = { speaker: speaker.name, lines: speaker.text ? [speaker.text] : [] };
      continue;
    }

    if (current) {
      current.lines.push(line.trimStart());
      continue;
    }
  }
  flush();

  const mentionNames = uniqueNames([
    "User",
    ...withParticipants,
    ...participants.map((p) => p.name),
    ...(turnRecipient ? [turnRecipient] : []),
    ...messages.map((msg) => msg.speaker),
  ]);
  const allMentions: string[] = [];
  for (const msg of messages) {
    msg.mentions = extractGroupMentions(msg.text, mentionNames);
    for (const mention of msg.mentions) {
      if (!allMentions.includes(mention)) allMentions.push(mention);
    }
  }

  return {
    groupTitle,
    withParticipants,
    participants,
    messages,
    noNewMessages,
    mentions: allMentions,
    ...(turnRecipient ? { turnRecipient } : {}),
  };
}

export function formatGroupHeader(wake: GrokBotGroupWake): string {
  const lines: string[] = [];
  if (wake.groupTitle) lines.push(`Group chat: ${wake.groupTitle}`);
  else lines.push("Group chat");

  const participantBits = wake.participants.map((p) =>
    p.description ? `${p.name} (${p.description})` : p.name,
  );
  if (participantBits.length === 0 && wake.withParticipants.length > 0) {
    participantBits.push(...wake.withParticipants);
  }
  if (participantBits.length > 0) lines.push(`Participants: ${participantBits.join(", ")}`);
  if (wake.mentions.length > 0) lines.push(`Mentions: ${wake.mentions.join(", ")}`);
  if (wake.noNewMessages) lines.push("No new messages since last turn.");
  return lines.join("\n");
}

export function formatGroupSpeakerMessage(speaker: string, text: string): string {
  const body = text.replace(/\s+$/, "");
  if (!body) return `**${speaker}:**`;
  const lines = body.split("\n");
  if (lines.length === 1) return `**${speaker}:** ${lines[0]}`;
  return `**${speaker}:** ${lines[0]}\n${lines.slice(1).join("\n")}`;
}

export function extractGroupMentions(text: string, knownNames: string[] = []): string[] {
  const mentions: string[] = [];
  const add = (value: string) => {
    const mention = value.startsWith("@") ? value : `@${value}`;
    if (!mentions.some((item) => item.toLowerCase() === mention.toLowerCase())) {
      mentions.push(mention);
    }
  };

  const sorted = uniqueNames(knownNames).sort((a, b) => b.length - a.length);
  const used = new Set<number>();
  for (const name of sorted) {
    const needle = `@${name}`;
    const lower = text.toLowerCase();
    const target = needle.toLowerCase();
    let from = 0;
    while (from < text.length) {
      const index = lower.indexOf(target, from);
      if (index < 0) break;
      const end = index + needle.length;
      const next = text[end];
      const nameContinues = next != null && /[\w.-]/.test(next);
      if (!nameContinues) {
        let overlap = false;
        for (let i = index; i < end; i++) {
          if (used.has(i)) {
            overlap = true;
            break;
          }
        }
        if (!overlap) {
          add(needle);
          for (let i = index; i < end; i++) used.add(i);
        }
      }
      from = index + 1;
    }
  }

  for (const match of text.matchAll(MENTION_TOKEN_RE)) {
    const start = match.index ?? 0;
    if (used.has(start)) continue;
    add(`@${match[1]}`);
  }
  return mentions;
}

function parseParticipantList(rest: string): GrokBotGroupParticipant[] {
  const participants: GrokBotGroupParticipant[] = [];
  let cursor = 0;
  PARTICIPANT_PAIR_RE.lastIndex = 0;
  for (const match of rest.matchAll(PARTICIPANT_PAIR_RE)) {
    const name = match[1]?.trim();
    if (name) {
      const description = match[2]?.trim();
      participants.push({
        name,
        ...(description ? { description } : {}),
      });
    }
    cursor = (match.index ?? 0) + match[0].length;
  }
  const leftover = rest.slice(cursor).replace(/^[,;\s]+/, "").trim();
  if (leftover) participants.push(...splitNameList(leftover).map((name) => ({ name })));
  return participants;
}

function splitNameList(value: string): string[] {
  return value
    .split(/\s*(?:,|;|\band\b)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

function findSpeaker(
  line: string,
  knownNames: string[],
): { name: string; text: string; known: boolean } | null {
  const sorted = [...knownNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const prefix = `${name}:`;
    if (startsWithInsensitive(line, prefix)) {
      return { name, text: line.slice(prefix.length).trim(), known: true };
    }
    const spaced = `${name} :`;
    if (startsWithInsensitive(line, spaced)) {
      return { name, text: line.slice(spaced.length).trim(), known: true };
    }
  }

  const fallback = /^([A-Z][\w .'-]{0,60}?)\s*:\s+(.*)$/.exec(line);
  if (!fallback) return null;
  const name = fallback[1].trim();
  if (!looksLikeSpeakerName(name)) return null;
  return { name, text: fallback[2], known: false };
}

function looksLikeSpeakerName(name: string): boolean {
  if (name.length < 1 || name.length > 60) return false;
  if (RESERVED_SPEAKERS.has(name.toLowerCase())) return false;
  if (/[.?!]$/.test(name)) return false;
  return /^[A-Z][A-Za-z0-9]*(?:[ _-][A-Z][A-Za-z0-9]*)*$/.test(name);
}

function startsWithInsensitive(line: string, prefix: string): boolean {
  return line.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
