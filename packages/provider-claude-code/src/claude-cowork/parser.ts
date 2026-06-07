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
  if (!obj.timestamp && typeof obj._audit_timestamp === "string") {
    obj.timestamp = obj._audit_timestamp;
  }

  return JSON.stringify(obj);
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
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const raw = lines[lineIndex];
      const t = raw.trim();
      if (!t) continue;
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
