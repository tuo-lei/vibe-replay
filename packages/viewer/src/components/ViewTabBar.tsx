import { type ReactNode, useCallback, useState } from "react";

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
  { key: "summary", label: "Insights" },
  { key: "export", label: "Share & Export" },
];

const INSIGHTS_SEEN_KEY = "vr-insights-seen";

function hasSeenInsights(): boolean {
  try {
    return localStorage.getItem(INSIGHTS_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markInsightsSeen() {
  try {
    localStorage.setItem(INSIGHTS_SEEN_KEY, "1");
  } catch {
    /* noop */
  }
}

export default function ViewTabBar({
  activeView,
  onChangeView,
  className = "",
  rightContent,
  hiddenTabs,
}: Props) {
  const [insightsSeen, setInsightsSeen] = useState(
    () => hasSeenInsights() || activeView === "summary",
  );

  const handleChange = useCallback(
    (key: ActiveView) => {
      if (key === "summary" && !insightsSeen) {
        markInsightsSeen();
        setInsightsSeen(true);
      }
      onChangeView(key);
    },
    [onChangeView, insightsSeen],
  );

  return (
    <div
      className={`flex items-center justify-between border-b border-terminal-border-subtle bg-terminal-bg shrink-0 overflow-x-auto ${className}`}
    >
      <div className="flex bg-terminal-surface/30">
        {TABS.filter((t) => !hiddenTabs?.includes(t.key)).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => handleChange(key)}
            className={`relative px-4 py-2 text-[11px] font-sans font-semibold uppercase tracking-widest transition-colors ${
              activeView === key
                ? "text-terminal-green border-b-2 border-terminal-green bg-terminal-surface/50"
                : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
            }`}
          >
            {label}
            {key === "summary" && !insightsSeen && activeView !== "summary" && (
              <span className="absolute top-1.5 right-1 flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-terminal-green opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-terminal-green" />
              </span>
            )}
          </button>
        ))}
      </div>
      {rightContent && <div className="pr-4 py-1.5 flex items-center">{rightContent}</div>}
    </div>
  );
}
