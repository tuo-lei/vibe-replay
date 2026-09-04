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
 */

export type GrokBotMetaLabel = "routine" | "agent" | "inbound" | "answering-question";

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

export function parseGrokBotMetaWake(text: string): GrokBotMetaWake | null {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return null;

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
  const wake = parseGrokBotMetaWake(text);
  if (!wake) return null;

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
  const wake = parseGrokBotMetaWake(text);
  if (!wake) return null;
  return { rest: wake.body, wake };
}
