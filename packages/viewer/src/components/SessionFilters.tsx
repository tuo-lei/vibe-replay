import { useRef, type ReactNode } from "react";
import { ActiveFilterChip } from "./SessionCard";

/**
 * Filter-bar building blocks shared by the local dashboard
 * (`components/Dashboard.tsx`) and the E2E-encrypted live viewer
 * (`live/SessionFilterBar.tsx`): the search input and the active-filter
 * chip row render from this one source of truth so the two surfaces cannot
 * drift apart. The actual matching logic already lives in the shared
 * `engine/dashboard-filtering.ts`; this file covers the presentation.
 */

export { ActiveFilterChip };

/** The dashboard's search box: magnifier icon + input, exact visual. */
export function SearchFilterInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const clearSearch = () => {
    onChange("");
    inputRef.current?.focus();
  };
  return (
    <div className="relative min-w-0 flex-1">
      <svg
        className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-dim"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        aria-hidden="true"
      >
        <circle cx="7" cy="7" r="5" />
        <path d="M11 11l3.5 3.5" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            e.stopPropagation();
            clearSearch();
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="w-full bg-terminal-surface rounded-lg pl-9 pr-10 py-2.5 text-sm font-mono text-terminal-text placeholder:text-terminal-dimmer outline-none ring-1 ring-transparent focus:ring-terminal-green/40 transition-shadow duration-200 shadow-layer-sm"
      />
      {value && (
        <button
          type="button"
          onClick={clearSearch}
          aria-label={`Clear ${ariaLabel.toLowerCase()}`}
          title="Clear search (Esc)"
          className="absolute right-0 top-0 flex h-full w-10 items-center justify-center rounded-lg text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}

/** Recovery belongs beside the empty result, where the user's attention is. */
export function FilterEmptyState({
  kind,
  hasActiveFilters,
  onClearFilters,
  onBrowseSessions,
}: {
  kind: "sessions" | "replays";
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  onBrowseSessions?: () => void;
}) {
  return (
    <div className="mx-auto max-w-md px-6 py-12 text-center space-y-4">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-terminal-surface text-terminal-dim">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m16 16 5 5" />
        </svg>
      </div>
      <div className="space-y-2" aria-live="polite" aria-atomic="true">
        <h3 className="text-sm font-sans font-semibold text-terminal-text">
          {hasActiveFilters ? `No ${kind} match the current filters` : `No ${kind} found`}
        </h3>
        <p className="text-xs font-sans text-terminal-dim leading-relaxed">
          {hasActiveFilters
            ? "Try a broader search or clear your filters to see the full list."
            : kind === "replays"
              ? "Choose a session and generate a replay to start watching."
              : "Sessions appear here after you use a supported coding agent. Refresh to check for new sessions."}
        </p>
      </div>
      <div className="flex justify-center flex-wrap gap-2">
        {hasActiveFilters && (
          <button
            type="button"
            onClick={onClearFilters}
            className="rounded-lg bg-terminal-green-subtle px-4 py-2.5 text-xs font-sans font-semibold text-terminal-green hover:bg-terminal-green-emphasis transition-colors"
          >
            Clear filters
          </button>
        )}
        {onBrowseSessions && (
          <button
            type="button"
            onClick={onBrowseSessions}
            className="rounded-lg border border-terminal-border-subtle bg-terminal-surface px-4 py-2.5 text-xs font-sans font-semibold text-terminal-text hover:bg-terminal-surface-hover transition-colors"
          >
            Browse sessions
          </button>
        )}
      </div>
    </div>
  );
}

/** Row of removable active-filter chips + a "Clear all" button. */
export function ActiveFilterChipRow({
  onClearAll,
  className,
  children,
}: {
  onClearAll: () => void;
  /** Extra classes on the row (e.g. "mt-3"). */
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex items-center gap-2 flex-wrap${className ? ` ${className}` : ""}`}>
      {children}
      <button
        onClick={onClearAll}
        className="text-xs font-mono text-terminal-dimmer hover:text-terminal-text transition-colors"
      >
        Clear all
      </button>
    </div>
  );
}
