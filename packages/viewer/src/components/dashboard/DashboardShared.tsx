import { useCallback, useEffect, useRef, useState } from "react";
import { useOutsideClick } from "../../hooks/useOutsideClick";
import {
  fetchWithRetry,
  getFriendlyErrorMessage,
  normalizeTitleText,
  providerBadgeClass,
  providerBadgeLabel,
  providerDisplayName,
  TITLE_MAX_CHARS,
} from "../dashboard-utils";

const MoreDotsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="8" cy="3" r="1.5" />
    <circle cx="8" cy="8" r="1.5" />
    <circle cx="8" cy="13" r="1.5" />
  </svg>
);

function ProviderIcon({ provider }: { provider: string }) {
  if (provider.startsWith("claude-")) {
    return (
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
        <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
      </svg>
    );
  }

  if (provider === "cursor") {
    return (
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
        <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" />
      </svg>
    );
  }

  if (provider === "codex") {
    return (
      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
        <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654 2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
      </svg>
    );
  }

  if (provider === "pi") {
    return (
      <svg viewBox="0 0 800 800" className="h-3.5 w-3.5" fill="currentColor">
        <path
          fillRule="evenodd"
          d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
        />
        <path d="M517.36 400H634.72V634.72H517.36Z" />
      </svg>
    );
  }

  return (
    <span className="font-mono text-[10px] font-bold leading-none uppercase">
      {providerBadgeLabel(provider).slice(0, 1)}
    </span>
  );
}

export function ProviderBadge({
  provider,
  compact = false,
}: {
  provider: string;
  compact?: boolean;
}) {
  const label = providerDisplayName(provider);
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center ring-1 ring-current/15 ${
        compact ? "h-5 w-5 rounded-md" : "h-6 w-6 rounded-lg"
      } ${providerBadgeClass(provider)}`}
      title={label}
      aria-label={label}
    >
      <ProviderIcon provider={provider} />
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
  onDelete,
  onRawData,
  isArchived,
}: {
  onArchive: () => void;
  onDelete?: () => void;
  onRawData?: () => void;
  isArchived: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setConfirmingDelete(false);
  }, []);
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
          {onRawData && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRawData();
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
                <path d="M5 3L2 8l3 5M11 3l3 5-3 5M7 12l2-8" />
              </svg>
              Raw JSON
            </button>
          )}
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
          {onDelete && (
            <>
              <div className="mx-2 my-1 border-t border-terminal-border" />
              {confirmingDelete ? (
                <div className="flex items-center gap-1 px-2 py-1">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete();
                      setConfirmingDelete(false);
                      setOpen(false);
                    }}
                    className="h-6 px-2 text-xs font-sans rounded bg-terminal-red-subtle text-terminal-red hover:bg-terminal-red-emphasis transition-colors duration-200"
                  >
                    Confirm
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmingDelete(false);
                    }}
                    className="h-6 px-2 text-xs font-sans rounded text-terminal-dim hover:text-terminal-text transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingDelete(true);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-sans text-terminal-red hover:bg-terminal-red-subtle transition-colors"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M3 4h10M5.5 4V3a1 1 0 011-1h3a1 1 0 011 1v1M6.5 7v4M9.5 7v4M4.5 4l.5 9a1 1 0 001 1h4a1 1 0 001-1l.5-9" />
                  </svg>
                  Delete replay
                </button>
              )}
            </>
          )}
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
