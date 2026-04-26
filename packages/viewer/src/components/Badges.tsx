/**
 * Tiny shared badges used across tool blocks. Centralized so error / status
 * styling stays consistent — change the pill once, all variants update.
 */

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
