/**
 * Rough token estimator using the chars/4 heuristic — close enough for
 * surfacing context-window cost in the UI without bundling a tokenizer.
 *
 * Returns 0 for empty/whitespace-only input so callers can use a truthy
 * check before rendering badges.
 */
export function estimateTokens(s: string | undefined | null): number {
  if (!s) return 0;
  if (!s.trim()) return 0;
  return Math.max(1, Math.round(s.length / 4));
}
