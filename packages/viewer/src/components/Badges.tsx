/**
 * Tiny shared badges used across tool blocks. Centralized so error / status
 * styling stays consistent — change the pill once, all variants update.
 */

import { formatToolDuration, formatTokens } from "./StatsPanel";

export function ErrorBadge() {
  return (
    <span
      className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30 shrink-0"
      title="This tool call returned an error"
    >
      ERROR
    </span>
  );
}

export function ToolDuration({ ms }: { ms?: number }) {
  const label = formatToolDuration(ms);
  if (!label) return null;
  return (
    <span
      className="text-[10px] text-terminal-dimmer font-mono shrink-0"
      title={`Tool execution: ${label}`}
    >
      {label}
    </span>
  );
}

export function ToolTokens({ tokens }: { tokens?: number }) {
  const label = formatTokens(tokens);
  if (!label) return null;
  return (
    <span
      className="text-[10px] text-terminal-dimmer font-mono shrink-0"
      title={`~${label} tokens added to context (heuristic estimate)`}
    >
      ~{label} tok
    </span>
  );
}
