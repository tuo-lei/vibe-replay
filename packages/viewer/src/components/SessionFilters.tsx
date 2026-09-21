import type { ReactNode } from "react";
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
  return (
    <div className="relative flex-1">
      <svg
        className="absolute left-3 top-1/2 -translate-y-1/2 text-terminal-dim"
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <circle cx="7" cy="7" r="5" />
        <path d="M11 11l3.5 3.5" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="w-full bg-terminal-surface rounded-lg pl-9 pr-3 py-2.5 text-sm font-mono text-terminal-text placeholder:text-terminal-dimmer outline-none ring-1 ring-transparent focus:ring-terminal-green/40 transition-shadow duration-200 shadow-layer-sm"
      />
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
