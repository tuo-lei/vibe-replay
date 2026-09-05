import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { estimateActiveDuration } from "@vibe-replay/provider-core/duration";
import type { ParsedTurn, ProviderParseResult, SessionInfo } from "@vibe-replay/provider-contract";
import { readAgentGroup, readAgentProfile } from "./profiles.js";
import {
  humanMessageKey,
  normalizeGroupKey,
  parseGrokBotGroupWake,
  sameSpeakerName,
} from "./group-chat.js";
import { peelGrokBotMetaTag } from "./meta-wake.js";

const SAND_SUBAGENT_PREFIX = "sand-subagent-";

export interface GrokBotParsedMember {
  path: string;
  ownerName?: string;
  parsed: ProviderParseResult;
}

export function discoveredGroupKey(session: SessionInfo): string | undefined {
  if (session.sessionId.startsWith(SAND_SUBAGENT_PREFIX)) return undefined;
  const title = session.title?.trim() ?? "";
  if (!title.toLowerCase().startsWith("group:")) return undefined;
  const room = title.slice(title.indexOf(":") + 1).trim();
  return room ? normalizeGroupKey(room) : undefined;
}

export function mergeDiscoveredGroupSessions(sessions: SessionInfo[]): SessionInfo[] {
  const groups = new Map<string, SessionInfo[]>();
  const passthrough: SessionInfo[] = [];
  for (const session of sessions) {
    const key = discoveredGroupKey(session);
    if (!key) {
      passthrough.push(session);
      continue;
    }
    groups.set(key, [...(groups.get(key) || []), session]);
  }

  const merged = [...passthrough];
  for (const [key, members] of groups) {
    if (members.length === 1) {
      merged.push(members[0]);
      continue;
    }
    merged.push(mergeGroupSessionInfos(key, members));
  }
  merged.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return merged;
}

function mergeGroupSessionInfos(key: string, members: SessionInfo[]): SessionInfo {
  const chronological = [...members].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const latest = [...members].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  const filePaths = uniqueStrings(chronological.flatMap((member) => member.filePaths));
  const uniquePrompts = uniqueStrings(
    chronological.flatMap(
      (member) => member.prompts || (member.firstPrompt ? [member.firstPrompt] : []),
    ),
  );
  const roomTitle = latest.title?.replace(/^Group:\s*/i, "").trim() || key;
  return {
    ...latest,
    sessionId: `group-${key}`,
    slug: `group-${key}`,
    title: `Group: ${roomTitle}`,
    project: roomTitle,
    filePath: filePaths[0] || latest.filePath,
    filePaths,
    fileSize: members.reduce((sum, member) => sum + member.fileSize, 0),
    lineCount: members.reduce((sum, member) => sum + member.lineCount, 0),
    promptCount: Math.max(
      ...members.map((member) => member.promptCount || 0),
      uniquePrompts.length,
    ),
    toolCallCount: members.reduce((sum, member) => sum + (member.toolCallCount || 0), 0),
    editCountEst: members.reduce((sum, member) => sum + (member.editCountEst || 0), 0),
    firstPrompt: uniquePrompts[0] || latest.firstPrompt,
    ...(uniquePrompts.length > 0 ? { prompts: uniquePrompts.slice(0, 2) } : {}),
    timestamp: latest.timestamp,
  };
}

export async function resolveGrokBotParsePaths(
  filePaths: string | string[],
  sessionInfo?: SessionInfo,
): Promise<string[]> {
  const requested = (Array.isArray(filePaths) ? filePaths : [filePaths]).filter(Boolean);
  const fromInfo = sessionInfo?.filePaths?.filter(Boolean) ?? [];
  const unique = uniqueStrings([...requested, ...fromInfo]);
  if (unique.length > 1) return unique;
  if (unique.length === 1) return expandGroupTranscriptPaths(unique[0]);
  return unique;
}

export async function expandGroupTranscriptPaths(filePath: string): Promise<string[]> {
  const sessionId = basename(filePath, ".jsonl");
  if (!sessionId || sessionId.startsWith(SAND_SUBAGENT_PREFIX)) return [filePath];

  const content = await readFile(filePath, "utf-8").catch(() => "");
  const transcriptsRoot = dirname(dirname(filePath));
  const profile = await readAgentProfile(transcriptsRoot, sessionId);
  const group = await readAgentGroup(transcriptsRoot, sessionId, profile);
  const title = groupTitleFromContent(content) || group?.title || profile?.groupTitle;
  if (!title) return [filePath];
  const key = normalizeGroupKey(title);

  let entries: string[];
  try {
    entries = await readdir(transcriptsRoot);
  } catch {
    return [filePath];
  }

  const paths = [filePath];
  for (const entry of entries) {
    if (entry === sessionId || entry.startsWith(SAND_SUBAGENT_PREFIX)) continue;
    const sibling = join(transcriptsRoot, entry, `${entry}.jsonl`);
    const fileStat = await stat(sibling).catch(() => null);
    if (!fileStat?.isFile()) continue;
    if (await siblingSharesGroup(sibling, entry, transcriptsRoot, key)) {
      paths.push(sibling);
    }
  }
  return uniqueStrings(paths);
}

async function siblingSharesGroup(
  siblingPath: string,
  agentId: string,
  transcriptsRoot: string,
  key: string,
): Promise<boolean> {
  const content = await readFile(siblingPath, "utf-8").catch(() => "");
  const profile = await readAgentProfile(transcriptsRoot, agentId);
  const group = await readAgentGroup(transcriptsRoot, agentId, profile);
  const title = groupTitleFromContent(content) || group?.title || profile?.groupTitle;
  return !!title && normalizeGroupKey(title) === key;
}

export async function resolveOwnerName(
  filePath: string,
  sessionInfo?: SessionInfo,
): Promise<string | undefined> {
  const sessionId = basename(filePath, ".jsonl");
  if (!sessionId || sessionId.startsWith("group-")) return undefined;
  const transcriptsRoot = dirname(dirname(filePath));
  const profile = await readAgentProfile(transcriptsRoot, sessionId);
  if (profile?.name) return profile.name;
  const title = sessionInfo?.title?.trim();
  if (title && !title.toLowerCase().startsWith("group:") && title !== "Grok Bot subagent") {
    return title;
  }
  return undefined;
}

export function assignTurnClocks(turns: ParsedTurn[], fallbackIso?: string): ParsedTurn[] {
  if (turns.length === 0) return turns;
  const times = turns.map((turn) => parseMs(turn.timestamp));
  const fallback = parseMs(fallbackIso) ?? Date.now();
  const result = turns.map((turn) => ({ ...turn }));
  const knownIdx = times
    .map((time, index) => (time != null ? index : -1))
    .filter((index) => index >= 0);

  if (knownIdx.length === 0) {
    for (let i = 0; i < result.length; i++) {
      result[i].timestamp = new Date(fallback + i).toISOString();
    }
    return result;
  }

  const firstKnown = knownIdx[0];
  const firstT = times[firstKnown]!;
  for (let i = 0; i < firstKnown; i++) {
    result[i].timestamp = new Date(firstT - (firstKnown - i)).toISOString();
  }

  for (let k = 0; k < knownIdx.length - 1; k++) {
    const start = knownIdx[k];
    const end = knownIdx[k + 1];
    const nextT = times[end]!;
    for (let i = start + 1; i < end; i++) {
      result[i].timestamp = new Date(nextT - (end - i)).toISOString();
    }
  }

  const lastKnown = knownIdx[knownIdx.length - 1];
  const lastT = times[lastKnown]!;
  for (let i = lastKnown + 1; i < result.length; i++) {
    result[i].timestamp = new Date(lastT + (i - lastKnown)).toISOString();
  }
  return result;
}

export function mergeGrokBotGroupParses(
  members: GrokBotParsedMember[],
  sessionInfo?: SessionInfo,
): ProviderParseResult {
  const usable = members.filter((member) => member.parsed.turns.length > 0 || members.length === 1);
  if (usable.length === 1) return usable[0]?.parsed ?? emptyParse(sessionInfo);

  const ownerNames = uniqueStrings(
    usable.map((member) => member.ownerName).filter((name): name is string => !!name),
  );
  const items: {
    turn: ParsedTurn;
    ownerName?: string;
    path: string;
    index: number;
  }[] = [];

  for (const member of usable) {
    const clocked = assignTurnClocks(
      member.parsed.turns,
      member.parsed.endTime || member.parsed.startTime,
    );
    clocked.forEach((turn, index) => {
      items.push({ turn, ownerName: member.ownerName, path: member.path, index });
    });
  }

  items.sort((left, right) => {
    const ts = (left.turn.timestamp || "").localeCompare(right.turn.timestamp || "");
    if (ts !== 0) return ts;
    if (left.turn.role !== right.turn.role) return left.turn.role === "user" ? -1 : 1;
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    return left.index - right.index;
  });

  const seenHeaders = new Set<string>();
  const seenHumans = new Set<string>();
  const turns: ParsedTurn[] = [];

  for (const item of items) {
    const turn = item.turn;
    if (turn.subtype === "context-injection" && isGroupHeaderTurn(turn)) {
      const signature = groupHeaderDedupeKey(turnText(turn));
      if (seenHeaders.has(signature)) continue;
      seenHeaders.add(signature);
      turns.push(turn);
      continue;
    }
    if (turn.role === "user" && !turn.subtype) {
      const key = humanMessageKey(turn.speaker || "User", turnText(turn));
      if (seenHumans.has(key)) continue;
      seenHumans.add(key);
      turns.push(turn);
      continue;
    }
    if (isForeignAssistantTurn(turn, item.ownerName)) {
      const speaker = turn.speaker;
      if (speaker && ownerNames.some((name) => sameSpeakerName(name, speaker))) continue;
    }
    turns.push(turn);
  }

  const title =
    usable.map((member) => member.parsed.title).find((value) => value?.startsWith("Group: ")) ||
    sessionInfo?.title;
  const groupTitle = title?.replace(/^Group:\s*/i, "").trim();
  const timestamps = turns
    .map((turn) => turn.timestamp)
    .filter((value): value is string => !!value)
    .sort();
  const startTime = timestamps[0] || sessionInfo?.timestamp;
  const endTime = timestamps[timestamps.length - 1] || startTime;
  const ownerLabel = ownerNames.length > 0 ? ownerNames.join(", ") : "unknown agents";
  const notes = [
    `Merged ${usable.length} sibling Grok Bot transcripts for group "${groupTitle || "room"}" (${ownerLabel}).`,
    "Peer messages use each agent's own send_message / tools / scratch; injected wake copies are dropped when that peer's JSONL is present.",
    "Assistant text blocks are private scratch (thinking); send_message and successful communicate_update stay visible replies.",
  ];

  const parseWarnings = usable.flatMap((member) => member.parsed.parseWarnings || []);
  return {
    sessionId:
      sessionInfo?.sessionId ||
      (groupTitle ? `group-${normalizeGroupKey(groupTitle)}` : "grok-bot-group"),
    slug:
      sessionInfo?.slug ||
      (groupTitle ? `group-${normalizeGroupKey(groupTitle)}` : "grok-bot-group"),
    title,
    cwd: sessionInfo?.cwd || usable[0]?.parsed.cwd || "",
    startTime,
    endTime,
    totalDurationMs: estimateActiveDuration(timestamps),
    turns,
    dataSource: "jsonl",
    dataSourceInfo: {
      primary: "jsonl",
      sources: uniqueStrings(
        usable.flatMap((member) => member.parsed.dataSourceInfo?.sources || []),
      ),
      notes,
    },
    diagnosticNotes: [
      `Merged group room from ${usable.length} agent transcripts; sand-subagent files stay separate.`,
    ],
    ...(parseWarnings.length > 0 ? { parseWarnings } : {}),
  };
}

const USER_TURN_PREFIX_RE = /^\s*\[t\d+u\]\s*/i;

function groupTitleFromContent(content: string): string | undefined {
  let title: string | undefined;
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let record: { role?: unknown; message?: { content?: unknown } };
    try {
      record = JSON.parse(line) as { role?: unknown; message?: { content?: unknown } };
    } catch {
      continue;
    }
    if (record.role !== "user") continue;
    const text = extractPlainText(record.message?.content).replace(USER_TURN_PREFIX_RE, "").trim();
    if (!text) continue;
    const peeled = peelGrokBotMetaTag(text);
    const wake = parseGrokBotGroupWake(peeled?.rest || text);
    if (wake?.groupTitle) title = wake.groupTitle;
  }
  return title;
}

function extractPlainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && typeof block === "object" && !Array.isArray(block))
    .filter((block) => (block as { type?: unknown }).type === "text")
    .map((block) => {
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

function isGroupHeaderTurn(turn: ParsedTurn): boolean {
  return /^group chat\b/i.test(turnText(turn));
}

/** Title + participants only — mentions can differ per agent's wake. */
function groupHeaderDedupeKey(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.startsWith("group chat") || line.startsWith("participants:"))
    .join("\n");
}

function isForeignAssistantTurn(turn: ParsedTurn, ownerName?: string): boolean {
  if (turn.role !== "assistant" || !turn.speaker) return false;
  if (!ownerName) return true;
  return !sameSpeakerName(turn.speaker, ownerName);
}

function turnText(turn: ParsedTurn): string {
  return turn.blocks
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n");
}

function parseMs(value?: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function emptyParse(sessionInfo?: SessionInfo): ProviderParseResult {
  return {
    sessionId: sessionInfo?.sessionId || "grok-bot-session",
    slug: sessionInfo?.slug || sessionInfo?.sessionId || "grok-bot-session",
    cwd: sessionInfo?.cwd || "",
    turns: [],
    dataSource: "jsonl",
  };
}
