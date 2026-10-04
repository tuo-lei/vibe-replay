import type { TokenUsage } from "@vibe-replay/provider-contract";

export interface CodexTokenInfo {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

export interface CodexTokenSnapshot {
  timestamp?: string;
  total?: CodexTokenInfo;
  last?: CodexTokenInfo;
  contextLimit?: number;
  model?: string;
  sourceIndex: number;
  /** Previous cumulative snapshot predates an automation interval with no bill. */
  attributionGap?: boolean;
}

export function normalizeCodexUsage(value: CodexTokenInfo): TokenUsage {
  const input = Math.max(0, value.input_tokens || 0);
  const cached = Math.min(input, Math.max(0, value.cached_input_tokens || 0));
  return {
    inputTokens: input - cached,
    outputTokens: Math.max(0, value.output_tokens || 0),
    cacheCreationTokens: 0,
    cacheReadTokens: cached,
  };
}

export function addUsage(target: TokenUsage, next: TokenUsage): void {
  target.inputTokens += next.inputTokens;
  target.outputTokens += next.outputTokens;
  target.cacheCreationTokens += next.cacheCreationTokens;
  target.cacheReadTokens += next.cacheReadTokens;
}

/** Repeated cumulative snapshots add zero. Never re-bill last_token_usage. */
export function snapshotUsageDeltas(snapshots: CodexTokenSnapshot[]): {
  deltas: Array<{ snapshot: CodexTokenSnapshot; usage: TokenUsage; attributable: boolean }>;
  reset: boolean;
} {
  let previous = normalizeCodexUsage({});
  let reset = false;
  const deltas: Array<{ snapshot: CodexTokenSnapshot; usage: TokenUsage; attributable: boolean }> =
    [];
  for (const snapshot of snapshots) {
    if (!snapshot.total) continue;
    const total = normalizeCodexUsage(snapshot.total);
    const keys = ["inputTokens", "outputTokens", "cacheCreationTokens", "cacheReadTokens"] as const;
    if (keys.some((key) => total[key] < previous[key])) {
      reset = true;
      // The final aggregate no longer contains a reliable representation of
      // earlier snapshots. Preserve that baseline as unknown, then attribute
      // the following monotonic deltas normally.
      deltas.length = 0;
      deltas.push({
        snapshot: { ...snapshot, model: undefined },
        usage: total,
        attributable: false,
      });
      previous = total;
      continue;
    }
    const usage = { ...total };
    for (const key of keys) usage[key] = Math.max(0, total[key] - previous[key]);
    deltas.push({
      snapshot: snapshot.attributionGap ? { ...snapshot, model: undefined } : snapshot,
      usage,
      attributable: !snapshot.attributionGap,
    });
    previous = total;
  }
  return { deltas, reset };
}

export function codexUsageByModel(
  snapshots: CodexTokenSnapshot[],
  aggregate: TokenUsage | undefined,
): { usage?: Record<string, TokenUsage>; notes: string[] } {
  if (!aggregate) return { notes: [] };
  const { deltas, reset } = snapshotUsageDeltas(snapshots);
  const usage: Record<string, TokenUsage> = Object.create(null);
  for (const { snapshot, usage: delta } of deltas) {
    if (!Object.values(delta).some((count) => count > 0)) continue;
    const key = snapshot.model || "unknown";
    usage[key] ||= normalizeCodexUsage({});
    addUsage(usage[key], delta);
  }
  return {
    usage: Object.keys(usage).length
      ? usage
      : { [snapshots.at(-1)?.model || "unknown"]: aggregate },
    notes: [
      ...(snapshots.some((snapshot) => snapshot.attributionGap)
        ? [
            "Some Codex cumulative token deltas span an automation interval with no usage snapshot; model and human-turn attribution are unknown.",
          ]
        : []),
      ...(reset
        ? [
            "Codex cumulative token counters reset; earlier usage has unknown model attribution. Later monotonic deltas retain their recorded models.",
          ]
        : []),
      ...(!reset && usage.unknown ? ["Some Codex token usage has unknown model attribution."] : []),
    ],
  };
}
