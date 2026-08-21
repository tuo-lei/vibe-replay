import { readFile } from "node:fs/promises";
import { parseClaudeCodeLines } from "../claude-code/parser.js";
import { getTimestampBounds } from "@vibe-replay/provider-core/duration";
import type { ProviderParseResult, TokenUsage } from "@vibe-replay/provider-contract";
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
 * Cowork writes one `result` record per completed host-loop run holding that
 * run's final billing: token usage, per-model usage, cost and wall-clock time.
 * Assistant messages only carry partial streaming snapshots, so a session total
 * is the sum over result records — never a mix of both sources.
 */
interface CoworkRunTotals {
  tokenUsage: TokenUsage;
  tokenUsageByModel: Record<string, TokenUsage>;
  reportedCostUsd?: number;
  totalDurationMs?: number;
}

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
};

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(total: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    cacheCreationTokens: total.cacheCreationTokens + next.cacheCreationTokens,
    cacheReadTokens: total.cacheReadTokens + next.cacheReadTokens,
  };
}

function isEmptyUsage(usage: TokenUsage): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.outputTokens === 0 &&
    usage.cacheCreationTokens === 0 &&
    usage.cacheReadTokens === 0
  );
}

/** `result.usage` uses the Anthropic API field names. */
function resultUsage(usage: Record<string, unknown>): TokenUsage {
  return {
    inputTokens: numberOrZero(usage.input_tokens),
    outputTokens: numberOrZero(usage.output_tokens),
    cacheCreationTokens: numberOrZero(usage.cache_creation_input_tokens),
    cacheReadTokens: numberOrZero(usage.cache_read_input_tokens),
  };
}

/** `result.modelUsage` is keyed by model and uses camelCase field names. */
function modelUsageEntry(entry: Record<string, unknown>): TokenUsage {
  return {
    inputTokens: numberOrZero(entry.inputTokens),
    outputTokens: numberOrZero(entry.outputTokens),
    cacheCreationTokens: numberOrZero(entry.cacheCreationInputTokens),
    cacheReadTokens: numberOrZero(entry.cacheReadInputTokens),
  };
}

/** Model keys can carry a context-mode suffix such as `claude-sonnet-4-6[1m]`. */
function modelUsageKey(rawKey: string, entry: Record<string, unknown>): string {
  const canonical = entry.canonicalModel;
  if (typeof canonical === "string" && canonical.trim()) return canonical.trim();
  return rawKey.replace(/\[[^\]]*\]$/, "").trim() || rawKey;
}

function summarizeCoworkRuns(records: Record<string, unknown>[]): CoworkRunTotals | undefined {
  if (records.length === 0) return undefined;

  let tokenUsage = EMPTY_USAGE;
  const tokenUsageByModel: Record<string, TokenUsage> = {};
  let reportedCostUsd = 0;
  let sawCost = false;
  let totalDurationMs = 0;
  let sawDuration = false;

  for (const record of records) {
    const usage = record.usage;
    if (usage && typeof usage === "object") {
      tokenUsage = addUsage(tokenUsage, resultUsage(usage as Record<string, unknown>));
    }

    const modelUsage = record.modelUsage;
    if (modelUsage && typeof modelUsage === "object") {
      for (const [rawKey, rawEntry] of Object.entries(modelUsage as Record<string, unknown>)) {
        if (!rawEntry || typeof rawEntry !== "object") continue;
        const entry = rawEntry as Record<string, unknown>;
        const key = modelUsageKey(rawKey, entry);
        tokenUsageByModel[key] = addUsage(tokenUsageByModel[key] || EMPTY_USAGE, {
          ...modelUsageEntry(entry),
        });
      }
    }

    // `total_cost_usd` already equals the sum of the per-model costs, so only
    // one of the two is counted.
    if (typeof record.total_cost_usd === "number" && Number.isFinite(record.total_cost_usd)) {
      reportedCostUsd += record.total_cost_usd;
      sawCost = true;
    }
    if (typeof record.duration_ms === "number" && Number.isFinite(record.duration_ms)) {
      totalDurationMs += Math.max(0, record.duration_ms);
      sawDuration = true;
    }
  }

  // Duration-only runs intentionally return no totals so callers retain their
  // timestamp-gap duration fallback when usage and cost are unavailable.
  if (isEmptyUsage(tokenUsage) && Object.keys(tokenUsageByModel).length === 0 && !sawCost) {
    return undefined;
  }

  return {
    tokenUsage,
    tokenUsageByModel,
    ...(sawCost ? { reportedCostUsd } : {}),
    ...(sawDuration && totalDurationMs > 0 ? { totalDurationMs } : {}),
  };
}

/**
 * Cowork records transient API failures as `system/api_retry`. Only the
 * structured attempt metadata is kept — the raw error text is never stored.
 */
function coworkRetryError(
  record: Record<string, unknown>,
): NonNullable<ProviderParseResult["apiErrors"]>[number] | undefined {
  const timestamp = record.timestamp || record["_audit_timestamp"];
  if (typeof timestamp !== "string" || !timestamp) return undefined;
  const status = record.error_status;
  const attempt = record.attempt;
  return {
    timestamp,
    errorType: "api_retry",
    ...(typeof status === "number" && Number.isFinite(status) ? { statusCode: status } : {}),
    ...(typeof attempt === "number" && Number.isFinite(attempt) ? { retryAttempt: attempt } : {}),
  };
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
  const runRecords: Record<string, unknown>[] = [];
  const seenRunUuids = new Set<string>();
  const retryErrors: NonNullable<ProviderParseResult["apiErrors"]> = [];
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
        if (obj.type === "result") {
          const uuid = typeof obj.uuid === "string" ? obj.uuid : "";
          if (!uuid || !seenRunUuids.has(uuid)) {
            if (uuid) seenRunUuids.add(uuid);
            runRecords.push(obj);
          }
        } else if (obj.type === "system" && obj.subtype === "api_retry") {
          const retry = coworkRetryError(obj);
          if (retry) retryErrors.push(retry);
        }
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

  // Prefer the run-level billing records. Older audits without them keep the
  // assistant-snapshot totals and timestamp-based duration estimate.
  const runTotals = summarizeCoworkRuns(runRecords);
  if (runTotals) {
    const modelTotals = Object.values(runTotals.tokenUsageByModel);
    result.tokenUsage =
      isEmptyUsage(runTotals.tokenUsage) && modelTotals.length > 0
        ? modelTotals.reduce(addUsage, EMPTY_USAGE)
        : runTotals.tokenUsage;
    // A result record is authoritative even when it has no modelUsage field;
    // do not retain partial assistant-snapshot model totals in that case.
    result.tokenUsageByModel = modelTotals.length > 0 ? runTotals.tokenUsageByModel : undefined;
    if (runTotals.reportedCostUsd !== undefined) {
      result.reportedCostUsd = runTotals.reportedCostUsd;
    }
    if (runTotals.totalDurationMs !== undefined) {
      result.totalDurationMs = runTotals.totalDurationMs;
    }
  }
  if (retryErrors.length > 0) {
    result.apiErrors = [...(result.apiErrors || []), ...retryErrors];
  }

  // Overlay metadata that audit.jsonl does not carry but the sibling JSON does.
  // Only fall back to the overlay — parsed values always win when present.
  if (sessionInfo) {
    if (!result.title && sessionInfo.title) result.title = sessionInfo.title;
    if (!result.model && sessionInfo.model) result.model = sessionInfo.model;
    const metadataTimestamp = getTimestampBounds([sessionInfo.timestamp]).startTime;
    if (!result.startTime && metadataTimestamp) result.startTime = metadataTimestamp;
    const endBounds = getTimestampBounds([result.endTime, metadataTimestamp]);
    result.endTime = endBounds.endTime || result.startTime;
    if (!result.cwd && sessionInfo.cwd) result.cwd = sessionInfo.cwd;
  }

  return result;
}
