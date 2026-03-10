import { useCallback, useEffect } from "react";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ShortcutInfo {
  key: string;
  label: string;
}

interface ShortcutCategory {
  title: string;
  items: ShortcutInfo[];
}

const SHORTCUTS: ShortcutCategory[] = [
  {
    title: "Playback",
    items: [
      { key: "Space", label: "Play / Pause" },
      { key: "\u2191 / \u2193", label: "Step Back / Forward" },
      { key: "Home", label: "Reset to Start" },
      { key: "End / e", label: "Jump to End" },
    ],
  },
  {
    title: "Navigation",
    items: [
      { key: "n / p", label: "Next / Prev Turn" },
      { key: "\u2190 / \u2192", label: "Collapse / Expand Item" },
    ],
  },
  {
    title: "Global",
    items: [
      { key: "?", label: "Show Keyboard Shortcuts" },
      { key: "\u2318 K", label: "Open Search" },
      { key: "Esc", label: "Close Modal / Search" },
    ],
  },
];

export default function HelpOverlay({ open, onClose }: Props) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        onClose();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (open) {
      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }
  }, [open, handleKeyDown]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-in fade-in duration-300"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-terminal-bg border border-terminal-border-subtle rounded-2xl shadow-layer-xl overflow-hidden animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-terminal-border-subtle flex items-center justify-between">
          <h2 className="text-sm font-sans font-bold uppercase tracking-[0.2em] text-terminal-text">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="text-terminal-dimmer hover:text-terminal-red transition-colors"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 grid grid-cols-1 gap-8">
          {SHORTCUTS.map((cat) => (
            <div key={cat.title} className="space-y-3.5">
              <h3 className="text-[10px] font-sans font-bold text-terminal-dimmer uppercase tracking-[0.15em] pl-1">
                {cat.title}
              </h3>
              <div className="grid grid-cols-1 gap-2.5">
                {cat.items.map((item) => (
                  <div key={item.key} className="flex items-center justify-between group">
                    <span className="text-xs font-sans font-medium text-terminal-dim group-hover:text-terminal-text transition-colors">
                      {item.label}
                    </span>
                    <kbd className="min-w-[40px] px-2 py-1 flex items-center justify-center text-[11px] font-mono font-bold text-terminal-text bg-terminal-surface border border-terminal-border-subtle rounded-lg shadow-layer-sm">
                      {item.key}
                    </kbd>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 bg-terminal-surface/30 border-t border-terminal-border-subtle">
          <p className="text-[10px] font-sans font-medium text-terminal-dimmer text-center uppercase tracking-wider">
            Press <span className="text-terminal-text font-mono font-bold">?</span> to toggle this
            menu anytime
          </p>
        </div>
      </div>
    </div>
  );
}
