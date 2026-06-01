import type { ParseWarning } from "@vibe-replay/types";

export function addParseWarning(
  warnings: ParseWarning[],
  warning: Omit<ParseWarning, "count"> & { count?: number },
): void {
  const existing = warnings.find(
    (w) => w.kind === warning.kind && w.source === warning.source && w.message === warning.message,
  );
  if (existing) {
    existing.count += warning.count ?? 1;
    return;
  }

  warnings.push({
    kind: warning.kind,
    count: warning.count ?? 1,
    message: warning.message,
    source: warning.source,
    firstLine: warning.firstLine,
    sample: warning.kind === "malformed-json" ? undefined : warning.sample,
  });
}

export function compactWarningSample(value: string, max = 160): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= max) return compacted;
  return `${compacted.slice(0, max)}...`;
}
