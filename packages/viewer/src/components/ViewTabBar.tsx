import type { ReactNode } from "react";

export type ActiveView = "replay" | "summary" | "export";

interface Props {
  activeView: ActiveView;
  onChangeView: (view: ActiveView) => void;
  className?: string;
  rightContent?: ReactNode;
  hiddenTabs?: ActiveView[];
}

const TABS: { key: ActiveView; label: string }[] = [
  { key: "replay", label: "Replay" },
  { key: "summary", label: "Summary" },
  { key: "export", label: "Export" },
];

export default function ViewTabBar({
  activeView,
  onChangeView,
  className = "",
  rightContent,
  hiddenTabs,
}: Props) {
  return (
    <div
      className={`flex items-center justify-between border-b border-terminal-border-subtle bg-terminal-bg shrink-0 ${className}`}
    >
      <div className="flex bg-terminal-surface/30">
        {TABS.filter((t) => !hiddenTabs?.includes(t.key)).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => onChangeView(key)}
            className={`px-4 py-2 text-[11px] font-sans font-semibold uppercase tracking-widest transition-colors ${
              activeView === key
                ? "text-terminal-green border-b-2 border-terminal-green bg-terminal-surface/50"
                : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {rightContent && <div className="pr-4 py-1.5 flex items-center">{rightContent}</div>}
    </div>
  );
}
