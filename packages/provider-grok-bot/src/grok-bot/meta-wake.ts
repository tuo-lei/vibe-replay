/**
 * Grok Bot injects system/channel wakes as ordinary `role:"user"` text with
 * bracket tags. These are not the same as `[SAND_HIDDEN_PROMPT]` (those are
 * dropped entirely). Classify the ones that would otherwise look like a
 * human prompt.
 *
 *   [routine]  scheduled/cron fire → context-injection
 *   [agent]    agent-to-agent / system resume → context-injection
 *   [inbound]  channel wrap; remaining body is the inbound message (prompt)
 *   [Answering your question tbs1: "…"] → context-injection; trailing text
 *              after the wrapper is a follow-up prompt when present
 *   [A background task just completed] → context-injection (not a user chat)
 *   [event]    system event note → context-injection
 *   [first run] → skip (bootstrap; often also wrapped in SAND_HIDDEN_PROMPT)
 *   <<SAND_AGENT_PROFILE_UPDATE…>> → skip / strip; not a prompt
 *
 * Group wakes sometimes append `[SAND_HIDDEN_PROMPT]<<SAND_AGENT_PROFILE_UPDATE…>>`
 * after the room payload. Strip that suffix so the splitter still runs; a
 * turn that is *only* the hidden marker stays skipped. A leading marker
 * keeps the remainder so wrapped routine/group wakes still parse. Concatenated
 * wakes in one record are split before classification.
 */

export const SAND_HIDDEN_PROMPT = "[SAND_HIDDEN_PROMPT]";

export type GrokBotMetaLabel =
  | "routine"
  | "agent"
  | "inbound"
  | "answering-question"
  | "background-task"
  | "event"
  | "first-run"
  | "profile-update";

export interface GrokBotMetaWake {
  label: GrokBotMetaLabel;
  /** Body after the tag (inbound message, routine instruction, …). */
  body: string;
  /** Quoted prior question for answering-question wraps. */
  quoted?: string;
  /** Question id such as `tbs1` when present. */
  questionId?: string;
}

export type ClassifiedGrokBotUserWake =
  | { kind: "prompt"; text: string; label?: GrokBotMetaLabel }
  | { kind: "context-injection"; text: string; label: GrokBotMetaLabel }
  | { kind: "skip" };

const META_TAG_RE = /^\s*\[(routine|agent|inbound)\]\s*/i;
const ANSWERING_RE =
  /^\s*\[Answering your question\s+([^\]:]+):\s*(?:"([^"]*)"|“([^”]*)”|'([^']*)')\]\s*/i;
const BACKGROUND_TASK_RE = /^\s*\[A background task just completed\]\s*/i;
const EVENT_RE = /^\s*\[event\]\s*/i;
const FIRST_RUN_RE = /^\s*\[first run\]\s*/i;
const TRUSTED_AUTOMATION = "[SAND_TRUSTED_AUTOMATION_PROMPT]";
const SEGMENT_RE =
  /\[(?:routine|agent|inbound|event|first run|A background task just completed|Answering your question|Group chat:|object Object|SAND_TRUSTED_AUTOMATION_PROMPT)/gi;
export function stripGrokBotProfileUpdate(text: string): string {
  return text.replace(/<<SAND_AGENT_PROFILE_UPDATE[\s\S]*?>>/gi, "").trim();
}

/**
 * Drop a trailing/leading hidden-prompt payload while keeping any visible
 * text that preceded it (group-chat wakes). Empty result means skip the turn.
 */
/**
 * A leading `[SAND_HIDDEN_PROMPT]` only marks the wrapper. Keep the remainder
 * (routine / background task / group wake). A later marker is still a suffix
 * attached after visible text and is dropped, including profile-update blobs.
 */
export function stripGrokBotHiddenPayload(text: string): string {
  let rest = text.replace(/^\uFEFF/, "");
  for (let guard = 0; guard < 6; guard++) {
    const trimmed = rest.trimStart();
    if (trimmed.startsWith(SAND_HIDDEN_PROMPT)) {
      rest = trimmed.slice(SAND_HIDDEN_PROMPT.length);
      continue;
    }
    if (trimmed.startsWith(TRUSTED_AUTOMATION)) {
      rest = trimmed.slice(TRUSTED_AUTOMATION.length);
      continue;
    }
    break;
  }
  const later = rest.indexOf(SAND_HIDDEN_PROMPT);
  const cut = later >= 0 ? rest.slice(0, later) : rest;
  return stripGrokBotProfileUpdate(cut).trim();
}

/**
 * One user record can concatenate several wakes (`[routine]` then `[Group chat:`).
 * Split on a later wake tag so the group splitter is not swallowed by the first tag.
 */
export function splitGrokBotUserSegments(text: string): string[] {
  const cleaned = stripGrokBotHiddenPayload(text);
  if (!cleaned) return [];
  const indexes: number[] = [];
  SEGMENT_RE.lastIndex = 0;
  for (const match of cleaned.matchAll(SEGMENT_RE)) {
    const index = match.index ?? 0;
    if (index === 0 || /\s/.test(cleaned[index - 1] || "")) indexes.push(index);
  }
  const starts = indexes.length === 0 ? [0] : indexes[0] === 0 ? indexes : [0, ...indexes];
  const parts: string[] = [];
  for (let i = 0; i < starts.length; i++) {
    const slice = cleaned.slice(starts[i], starts[i + 1] ?? cleaned.length).trim();
    if (!slice || /^\[object Object\]$/i.test(slice)) continue;
    const trusted = slice.replace(/^\s*\[SAND_TRUSTED_AUTOMATION_PROMPT\]\s*/i, "").trim();
    if (trusted) parts.push(trusted);
  }
  return parts;
}

function hasProfileUpdate(text: string): boolean {
  return /<<SAND_AGENT_PROFILE_UPDATE/i.test(text);
}

export function parseGrokBotMetaWake(text: string): GrokBotMetaWake | null {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return null;

  const firstRun = FIRST_RUN_RE.exec(trimmed);
  if (firstRun) {
    return {
      label: "first-run",
      body: trimmed.slice(firstRun[0].length).trim(),
    };
  }

  const background = BACKGROUND_TASK_RE.exec(trimmed);
  if (background) {
    return {
      label: "background-task",
      body: trimmed.slice(background[0].length).trim(),
    };
  }

  const event = EVENT_RE.exec(trimmed);
  if (event) {
    return {
      label: "event",
      body: trimmed.slice(event[0].length).trim(),
    };
  }

  const answering = ANSWERING_RE.exec(trimmed);
  if (answering) {
    const quoted = (answering[2] || answering[3] || answering[4] || "").trim();
    return {
      label: "answering-question",
      body: trimmed.slice(answering[0].length).trim(),
      ...(quoted ? { quoted } : {}),
      ...(answering[1]?.trim() ? { questionId: answering[1].trim() } : {}),
    };
  }

  const tag = META_TAG_RE.exec(trimmed);
  if (!tag) return null;
  const label = tag[1].toLowerCase() as "routine" | "agent" | "inbound";
  return {
    label,
    body: trimmed.slice(tag[0].length).trim(),
  };
}

export function classifyGrokBotUserWake(text: string): ClassifiedGrokBotUserWake | null {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  const stripped = stripGrokBotProfileUpdate(trimmed);
  if (hasProfileUpdate(trimmed) && !stripped) return { kind: "skip" };
  const source = stripped || trimmed;

  const wake = parseGrokBotMetaWake(source);
  if (!wake) {
    if (stripped && stripped !== trimmed) return { kind: "prompt", text: stripped };
    return null;
  }

  if (wake.label === "first-run") return { kind: "skip" };

  if (wake.label === "background-task") {
    const header = "Background task completed";
    if (!wake.body) return { kind: "context-injection", text: header, label: "background-task" };
    return {
      kind: "context-injection",
      text: `${header}:\n${wake.body}`,
      label: "background-task",
    };
  }

  if (wake.label === "event") {
    if (!wake.body) return { kind: "skip" };
    return { kind: "context-injection", text: `Event:\n${wake.body}`, label: "event" };
  }

  if (wake.label === "inbound") {
    if (!wake.body) return { kind: "skip" };
    return { kind: "prompt", text: wake.body, label: "inbound" };
  }

  if (wake.label === "answering-question") {
    const header = formatAnsweringHeader(wake);
    if (wake.body) {
      // Caller emits the header as context-injection and the body as a prompt.
      return { kind: "prompt", text: wake.body, label: "answering-question" };
    }
    if (!header) return { kind: "skip" };
    return { kind: "context-injection", text: header, label: "answering-question" };
  }

  if (!wake.body) return { kind: "skip" };
  const label = wake.label === "routine" ? "Routine" : "Agent";
  return {
    kind: "context-injection",
    text: `${label}: ${wake.body}`,
    label: wake.label,
  };
}

export function formatAnsweringHeader(wake: GrokBotMetaWake): string {
  const id = wake.questionId ? ` ${wake.questionId}` : "";
  if (wake.quoted) return `Answering previous question${id}: ${wake.quoted}`;
  if (wake.questionId) return `Answering previous question ${wake.questionId}`;
  return "";
}

/** Remainder after peeling one meta tag — used so `[routine]\\n[Group chat:` still splits. */
export function peelGrokBotMetaTag(text: string): { rest: string; wake: GrokBotMetaWake } | null {
  const stripped = stripGrokBotProfileUpdate(text);
  const wake = parseGrokBotMetaWake(stripped || text);
  if (!wake) return null;
  return { rest: wake.body, wake };
}
