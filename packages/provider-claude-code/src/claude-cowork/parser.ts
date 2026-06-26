import { readFile } from "node:fs/promises";
import { parseClaudeCodeLines } from "../claude-code/parser.js";
import type { ProviderParseResult } from "@vibe-replay/provider-contract";
import { addParseWarning } from "@vibe-replay/provider-contract/warnings";
import type { SessionInfo } from "@vibe-replay/provider-contract";

/**
 * Cowork audit.jsonl stores the same conversation schema as Claude Code JSONL,
 * but with a few field-name differences and extra record types. Normalize each
 * line to the CLI shape so we can reuse the Claude Code parser verbatim.
 *
 * Known differences:
 *   - `session_id`           → `sessionId`
 *   - `parent_tool_use_id`   → `parentToolUseID`
 *   - `_audit_timestamp`     → fallback `timestamp`
 *   - `isReplay: true` human user records duplicate the host-loop originals.
 *   - Extra types like `rate_limit_event`, `tool_use_summary` — parser ignores them.
 *   - Missing `cwd` / `gitBranch` / `custom-title` — supplied by sibling metadata JSON.
 */
export function normalizeCoworkLine(line: string, onMalformedJson?: () => void): string | null {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line);
  } catch {
    onMalformedJson?.();
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  if (typeof obj.session_id === "string" && !obj.sessionId) {
    obj.sessionId = obj.session_id;
    delete obj.session_id;
  }
  if ("parent_tool_use_id" in obj && !("parentToolUseID" in obj)) {
    obj.parentToolUseID = obj.parent_tool_use_id;
    delete obj.parent_tool_use_id;
  }
  const auditTimestamp = obj["_audit_timestamp"];
  if (!obj.timestamp && typeof auditTimestamp === "string") {
    obj.timestamp = auditTimestamp;
  }

  return JSON.stringify(obj);
}

function humanUserReplayKeys(obj: Record<string, unknown>): string[] {
  if (obj.type !== "user" || !obj.message || typeof obj.message !== "object") return [];
  const message = obj.message as { role?: unknown; content?: unknown };
  if (message.role !== "user") return [];

  const content = message.content;
  const hasHumanContent =
    typeof content === "string" ||
    (Array.isArray(content) &&
      content.some(
        (block) =>
          block &&
          typeof block === "object" &&
          ((block as { type?: unknown }).type === "text" ||
            (block as { type?: unknown }).type === "image"),
      ));
  if (!hasHumanContent) return [];

  const keys: string[] = [];
  if (typeof obj.uuid === "string" && obj.uuid) keys.push(`uuid:${obj.uuid}`);
  if (typeof content === "string") {
    keys.push(`content:${content}`);
  } else if (Array.isArray(content)) {
    // Key text blocks only. Image-only prompts without UUID intentionally fall
    // through as non-dedupable so we preserve rather than accidentally drop them.
    const text = content
      .filter(
        (block): block is { text?: unknown; type?: unknown } =>
          !!block && typeof block === "object" && (block as { type?: unknown }).type === "text",
      )
      .map((block) => block.text)
      .filter((text): text is string => typeof text === "string" && text.length > 0)
      .join("\n");
    if (text) keys.push(`content:${text}`);
  }
  return keys;
}

function isDuplicateCoworkReplayUser(
  obj: Record<string, unknown>,
  originalUserKeys: Set<string>,
): boolean {
  if (obj.isReplay !== true) return false;
  const keys = humanUserReplayKeys(obj);
  return keys.some((key) => originalUserKeys.has(key));
}

function collectOriginalCoworkUserKeys(lines: string[]): Set<string> {
  const keys = new Set<string>();
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.isReplay === true) continue;
    for (const key of humanUserReplayKeys(obj)) keys.add(key);
  }
  return keys;
}

/**
 * Parse a Cowork audit.jsonl. When invoked from the CLI picker, `sessionInfo`
 * carries the overlay metadata (title, timestamps, model) pulled from the
 * sibling `local_{id}.json` during discovery.
 */
export async function parseClaudeCoworkSession(
  filePaths: string | string[],
  sessionInfo?: SessionInfo,
): Promise<ProviderParseResult> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const normalized: string[] = [];
  const parseWarnings: NonNullable<ProviderParseResult["parseWarnings"]> = [];
  for (const fp of paths) {
    const content = await readFile(fp, "utf-8");
    const lines = content.split("\n");
    const originalUserKeys = collectOriginalCoworkUserKeys(lines);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const raw = lines[lineIndex];
      const t = raw.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as Record<string, unknown>;
        if (isDuplicateCoworkReplayUser(obj, originalUserKeys)) continue;
      } catch {
        // Let normalizeCoworkLine report malformed JSON consistently below.
      }
      const line = normalizeCoworkLine(t, () => {
        addParseWarning(parseWarnings, {
          kind: "malformed-json",
          source: "claude-cowork audit JSONL",
          firstLine: lineIndex + 1,
          message: "Skipped malformed JSONL line",
          sample: t,
        });
      });
      if (line) normalized.push(line);
    }
  }

  // Cowork transcripts are self-contained — no sibling `agents/` directory, so
  // subagentsSourcePath is intentionally omitted (parser will use an empty map).
  const result = await parseClaudeCodeLines(normalized);
  if (parseWarnings.length > 0) {
    result.parseWarnings = [...parseWarnings, ...(result.parseWarnings || [])];
  }

  // Overlay metadata that audit.jsonl does not carry but the sibling JSON does.
  // Only fall back to the overlay — parsed values always win when present.
  if (sessionInfo) {
    if (!result.title && sessionInfo.title) result.title = sessionInfo.title;
    if (!result.model && sessionInfo.model) result.model = sessionInfo.model;
    if (!result.startTime && sessionInfo.timestamp) result.startTime = sessionInfo.timestamp;
    if (!result.cwd && sessionInfo.cwd) result.cwd = sessionInfo.cwd;
  }

  return result;
}
