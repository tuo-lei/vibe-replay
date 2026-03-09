export type ActiveView = "replay" | "summary" | "export";

interface Props {
  activeView: ActiveView;
  onChangeView: (view: ActiveView) => void;
  className?: string;
}

const TABS: { key: ActiveView; label: string }[] = [
  { key: "replay", label: "Replay" },
  { key: "summary", label: "Summary" },
  { key: "export", label: "Export" },
];

export default function ViewTabBar({ activeView, onChangeView, className = "" }: Props) {
  return (
    <div
      className={`flex border-b border-terminal-border-subtle bg-terminal-bg shrink-0 ${className}`}
    >
      {TABS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onChangeView(key)}
          className={`px-4 py-2 text-[11px] font-sans font-semibold uppercase tracking-widest transition-colors ${
            activeView === key
              ? "text-terminal-green border-b-2 border-terminal-green"
              : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
