import { useCallback, useEffect, useRef, useState } from "react";
import { useOutsideClick } from "../../hooks/useOutsideClick";
import {
  fetchWithRetry,
  getFriendlyErrorMessage,
  normalizeTitleText,
  providerBadgeClass,
  providerBadgeLabel,
  TITLE_MAX_CHARS,
} from "../dashboard-utils";

const MoreDotsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="8" cy="3" r="1.5" />
    <circle cx="8" cy="8" r="1.5" />
    <circle cx="8" cy="13" r="1.5" />
  </svg>
);

export function ProviderBadge({ provider }: { provider: string }) {
  return (
    <span
      className={`text-[10px] font-sans font-medium px-1.5 py-0.5 rounded-full uppercase tracking-wider ${providerBadgeClass(provider)}`}
    >
      {providerBadgeLabel(provider)}
    </span>
  );
}

export function EditableTitle({
  slug,
  title,
  fallbackTitle,
  onSave,
}: {
  slug: string;
  title?: string;
  fallbackTitle?: string;
  onSave: (slug: string, title: string) => Promise<void>;
}) {
  const suggestedTitle = normalizeTitleText(title || fallbackTitle || slug);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(suggestedTitle);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    setValue(suggestedTitle);
  }, [suggestedTitle]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = async () => {
    if (saving) return;
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    setSaving(true);
    try {
      await onSave(slug, normalizeTitleText(value));
    } finally {
      setSaving(false);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <div className="min-w-0">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
          className="flex items-center gap-1.5 min-w-0"
        >
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                cancelledRef.current = true;
                setValue(suggestedTitle);
                setEditing(false);
              }
            }}
            className="bg-terminal-surface-2 rounded px-2 py-0.5 text-sm font-sans text-terminal-text w-full outline-none ring-1 ring-terminal-border-subtle focus:ring-terminal-green/50 transition-shadow duration-200"
            placeholder={suggestedTitle}
            maxLength={TITLE_MAX_CHARS}
            disabled={saving}
          />
        </form>
        <div className="text-[11px] font-mono text-terminal-dimmer truncate mt-0.5">
          slug: <span className="text-terminal-dim">{slug}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-w-0">
      <button
        onClick={() => {
          cancelledRef.current = false;
          setEditing(true);
        }}
        className="group flex items-center gap-1 min-w-0 max-w-full text-left"
        title="Click to edit title"
      >
        <span className="text-sm font-sans font-medium text-terminal-text truncate">
          {suggestedTitle || slug}
        </span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="shrink-0 text-terminal-dim opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <path d="M11.5 1.5l3 3-9 9H2.5v-3l9-9z" />
        </svg>
      </button>
      <div className="text-[11px] font-mono text-terminal-dimmer truncate mt-0.5">
        slug: <span className="text-terminal-dim">{slug}</span>
      </div>
    </div>
  );
}

/** "..." menu for session cards (archive only) */
export function SessionMoreMenu({
  onArchive,
  isArchived,
}: {
  onArchive: () => void;
  isArchived: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => setOpen(false), []);
  useOutsideClick(ref, close, open);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="h-7 w-7 flex items-center justify-center rounded-md bg-terminal-surface-2 text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors duration-200"
        title="More actions"
      >
        <MoreDotsIcon />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[140px] rounded-lg bg-terminal-surface-2 border border-terminal-border shadow-layer-md py-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onArchive();
              setOpen(false);
            }}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-sans text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover transition-colors"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M2 4h12v2H2zM3 6v7h10V6M6.5 8h3" />
            </svg>
            {isArchived ? "Unarchive" : "Archive"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Info row for popup metadata grid */
export function InfoRow({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-[11px] font-sans text-terminal-dimmer uppercase tracking-wider shrink-0 w-[68px]">
        {label}
      </span>
      <span className="text-sm font-mono text-terminal-dim truncate" title={title || value}>
        {value}
      </span>
    </div>
  );
}

/** Regenerate all existing replays from source JSONL files */
export function RegenerateAllButton() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ regenerated: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRegenerate = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      // Retry transient network drops: regeneration overwrites every replay in
      // place (keyed by slug), so re-issuing the request is idempotent.
      const res = await fetchWithRetry("/api/regenerate-all", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      setResult({ regenerated: data.regenerated, total: data.total });
      // Reload after short delay to show updated replays
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      setError(getFriendlyErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={handleRegenerate}
        disabled={loading}
        className="px-3 py-1.5 text-xs font-mono rounded-lg bg-terminal-surface text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover border border-terminal-border-subtle transition-colors duration-200 disabled:opacity-40"
      >
        {loading ? "Regenerating..." : "Regenerate All"}
      </button>
      {result && (
        <span className="text-xs font-mono text-terminal-green">
          {result.regenerated}/{result.total} regenerated
        </span>
      )}
      {error && <span className="text-xs font-mono text-terminal-red">{error}</span>}
    </div>
  );
}
