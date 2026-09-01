import type { ContextBreakdown, ContextComponentId } from "../types";

export interface TurnDurationHistogramData {
  buckets: Array<{ label: string; count: number; pct: number }>;
  percentiles: { p50Ms: number; p75Ms: number; p90Ms: number };
  totalTurns: number;
}

export interface TokenBreakdownData {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function formatDurationShort(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
}

export function TurnDurationChart({ histogram }: { histogram: TurnDurationHistogramData }) {
  const maxPct = Math.max(...histogram.buckets.map((bucket) => bucket.pct), 1);

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2 h-32">
        {histogram.buckets.map((bucket) => {
          const heightPct = Math.max((bucket.pct / maxPct) * 100, bucket.count > 0 ? 6 : 0);
          return (
            <div
              key={bucket.label}
              className="flex-1 flex flex-col items-center justify-end h-full group relative"
            >
              <div className="absolute bottom-full mb-1 hidden group-hover:block z-10">
                <div className="bg-terminal-surface-2 border border-terminal-border-subtle rounded-lg px-2 py-1 shadow-layer-md whitespace-nowrap">
                  <div className="text-[10px] font-mono text-terminal-dim">{bucket.label}</div>
                  <div className="text-[10px] font-mono text-terminal-response font-bold">
                    {bucket.count} turn{bucket.count !== 1 ? "s" : ""} ({bucket.pct}%)
                  </div>
                </div>
              </div>
              {bucket.pct > 0 && (
                <div className="text-[9px] font-mono text-terminal-dimmer tabular-nums mb-1">
                  {bucket.pct >= 10 ? Math.round(bucket.pct) : bucket.pct.toFixed(1)}%
                </div>
              )}
              <div
                className="w-full rounded-md bg-gradient-to-t from-terminal-response to-terminal-context hover:opacity-90 transition-all"
                style={{
                  height: `${heightPct}%`,
                  minHeight: bucket.count > 0 ? "4px" : "0",
                  opacity: bucket.count > 0 ? 0.7 : 0.1,
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex gap-2">
        {histogram.buckets.map((bucket) => (
          <div
            key={bucket.label}
            className="flex-1 text-center text-[9px] font-mono text-terminal-dimmer"
          >
            {bucket.label}
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between pt-2 border-t border-terminal-border/20">
        <div className="flex items-center gap-3 text-[10px] font-mono text-terminal-dim">
          <span>
            P50{" "}
            <span className="text-terminal-text font-bold">
              {formatDurationShort(histogram.percentiles.p50Ms)}
            </span>
          </span>
          <span className="text-terminal-dimmer">{"\u00b7"}</span>
          <span>
            P75{" "}
            <span className="text-terminal-text font-bold">
              {formatDurationShort(histogram.percentiles.p75Ms)}
            </span>
          </span>
          <span className="text-terminal-dimmer">{"\u00b7"}</span>
          <span>
            P90{" "}
            <span className="text-terminal-text font-bold">
              {formatDurationShort(histogram.percentiles.p90Ms)}
            </span>
          </span>
        </div>
        <span className="text-[10px] font-mono text-terminal-dimmer">
          {histogram.totalTurns.toLocaleString()} turns
        </span>
      </div>
      <div className="text-[9px] font-mono text-terminal-dimmer">
        Timing quality varies by provider; this combines recorded and estimated turn durations.
      </div>
    </div>
  );
}

const TOKEN_COLORS = [
  { key: "cacheRead", label: "Cache Read", color: "bg-terminal-context" },
  { key: "cacheCreation", label: "Cache Write", color: "bg-terminal-context-emphasis" },
  { key: "output", label: "Output", color: "bg-terminal-response" },
  { key: "input", label: "Input (uncached)", color: "bg-terminal-user" },
] as const;

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.floor(value / 1_000)}k`;
  return value.toString();
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

const CONTEXT_COMPONENTS: Record<ContextComponentId, { label: string; color: string }> = {
  "system-prompt": { label: "System prompt", color: "bg-terminal-blue" },
  "developer-context": { label: "Developer context", color: "bg-terminal-purple" },
  "tool-definitions": { label: "Tool definitions", color: "bg-terminal-tool" },
  rules: { label: "Rules", color: "bg-terminal-green" },
  skills: { label: "Skills", color: "bg-terminal-response" },
  "mcp-tool-definitions": { label: "MCP & dynamic tools", color: "bg-terminal-orange" },
  "subagent-definitions": { label: "Subagent definitions", color: "bg-terminal-thinking" },
  "summarized-conversation": {
    label: "Summarized conversation",
    color: "bg-terminal-context-emphasis",
  },
  conversation: { label: "Conversation", color: "bg-terminal-context" },
  other: { label: "Other", color: "bg-terminal-dimmer" },
};

function contextBreakdownNote(scope: ContextBreakdown["scope"]): string {
  if (scope === "latest-snapshot") {
    return "Provider-estimated latest context snapshot; this is not cumulative token usage.";
  }
  if (scope === "observed") {
    return "Observed descriptor payloads only; tools that were never discovered may be missing.";
  }
  return "UTF-8 size from persisted session metadata; bytes are not model-token counts.";
}

export function ContextBreakdownChart({ breakdown }: { breakdown: ContextBreakdown }) {
  const components = Array.isArray(breakdown.components) ? breakdown.components : [];
  const useTokens = components.some((component) => component.estimatedTokens !== undefined);
  const items = components
    .map((component) => {
      const presentation = CONTEXT_COMPONENTS[component.id] || CONTEXT_COMPONENTS.other;
      return {
        ...component,
        ...presentation,
        value: useTokens ? component.estimatedTokens : component.contentBytes,
      };
    })
    .filter((component) => component.value !== undefined);
  if (items.length === 0) return null;

  const componentTotal = items.reduce((sum, component) => sum + (component.value || 0), 0);
  const total = useTokens ? (breakdown.totalEstimatedTokens ?? componentTotal) : componentTotal;
  const formatValue = useTokens ? formatTokenCount : formatBytes;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-[10px] font-mono text-terminal-dimmer">
        <span>{breakdown.scope === "latest-snapshot" ? "Latest snapshot" : "Recorded size"}</span>
        <span className="font-bold text-terminal-text">
          {formatValue(total)} {useTokens ? "tokens" : ""}
          {useTokens && breakdown.contextLimit
            ? ` / ${formatTokenCount(breakdown.contextLimit)}`
            : ""}
        </span>
      </div>
      {componentTotal > 0 && (
        <div className="h-3 rounded-full bg-terminal-surface-2 overflow-hidden flex">
          {items
            .filter((item) => (item.value || 0) > 0)
            .map((item) => (
              <div
                key={item.id}
                className={`h-full ${item.color} transition-all duration-500`}
                style={{ width: `${((item.value || 0) / componentTotal) * 100}%`, opacity: 0.7 }}
              />
            ))}
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {items.map((item) => {
          const pct = componentTotal > 0 ? ((item.value || 0) / componentTotal) * 100 : 0;
          const count = item.itemCount;
          const available = item.availableItemCount;
          return (
            <div key={item.id} className="min-w-0">
              <div className="flex items-center gap-1.5">
                <div className={`h-2 w-2 shrink-0 rounded-sm ${item.color}`} />
                <span className="truncate text-[10px] font-mono text-terminal-dim">
                  {item.label}
                </span>
              </div>
              <div className="mt-0.5 text-[11px] font-mono text-terminal-text tabular-nums">
                {formatValue(item.value || 0)}
                <span className="ml-1 text-[9px] text-terminal-dimmer">
                  {pct > 0 && pct < 0.1 ? "<0.1%" : `${Math.round(pct)}%`}
                </span>
              </div>
              {count !== undefined && (
                <div className="text-[9px] font-mono text-terminal-dimmer">
                  {count.toLocaleString()} item{count === 1 ? "" : "s"}
                  {available !== undefined && available !== count
                    ? ` / ${available.toLocaleString()} available`
                    : ""}
                </div>
              )}
              {(item.descriptionBytes !== undefined || item.schemaBytes !== undefined) && (
                <div className="text-[9px] font-mono text-terminal-dimmer">
                  {item.descriptionBytes !== undefined
                    ? `${formatBytes(item.descriptionBytes)} descriptions`
                    : ""}
                  {item.descriptionBytes !== undefined && item.schemaBytes !== undefined
                    ? " · "
                    : ""}
                  {item.schemaBytes !== undefined ? `${formatBytes(item.schemaBytes)} schemas` : ""}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="text-[9px] font-mono text-terminal-dimmer">
        {contextBreakdownNote(breakdown.scope)} No prompt, description, schema, or conversation text
        is stored in this breakdown.
      </div>
    </div>
  );
}

export function TokenBreakdownChart({ breakdown }: { breakdown: TokenBreakdownData }) {
  const total = breakdown.input + breakdown.output + breakdown.cacheRead + breakdown.cacheCreation;
  if (total === 0) return null;
  const items = TOKEN_COLORS.map((token) => ({
    ...token,
    value: breakdown[token.key],
    pct: (breakdown[token.key] / total) * 100,
  }));
  const visibleItems = items.filter((item) => item.value > 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-[10px] font-mono text-terminal-dimmer">
        <span>Total</span>
        <span className="font-bold text-terminal-text">{formatTokenCount(total)}</span>
      </div>
      <div className="h-3 rounded-full bg-terminal-surface-2 overflow-hidden flex">
        {visibleItems.map((item) => (
          <div
            key={item.key}
            className={`h-full ${item.color} transition-all duration-500`}
            style={{ width: `${item.pct}%`, opacity: 0.7 }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {items.map((item) => (
          <div
            key={item.key}
            className="min-w-0"
            title={`${item.label}: ${formatTokenCount(item.value)} (${item.pct.toFixed(1)}%)`}
          >
            <div className="flex items-center gap-1.5">
              <div
                className={`h-2 w-2 shrink-0 rounded-sm ${item.color}`}
                style={{ opacity: 0.7 }}
              />
              <span className="truncate text-[10px] font-mono text-terminal-dim">{item.label}</span>
            </div>
            <div className="mt-0.5 text-[11px] font-mono text-terminal-text tabular-nums">
              {formatTokenCount(item.value)}
              <span className="ml-1 text-[9px] text-terminal-dimmer">
                {item.value === 0
                  ? "0%"
                  : item.pct < 0.1
                    ? "<0.1%"
                    : item.pct < 1
                      ? `${item.pct.toFixed(1)}%`
                      : `${Math.round(item.pct)}%`}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
