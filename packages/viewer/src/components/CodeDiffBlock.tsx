import { diffLines as computeLineDiff } from "diff";
import { Highlight, themes } from "prism-react-renderer";
import { memo, useMemo, useSyncExternalStore } from "react";

// Subscribe to dark/light class changes on <html> for prism theme switching
const subscribe = (cb: () => void) => {
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
};
const getIsDark = () => document.documentElement.classList.contains("dark");

interface Props {
  toolName: string;
  filePath: string;
  oldContent: string;
  newContent: string;
  isActive: boolean;
}

interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
}

function computeDiff(oldStr: string, newStr: string): DiffLine[] {
  if (!oldStr && newStr) {
    return newStr.split("\n").map((line) => ({ type: "add", content: line }));
  }

  const changes = computeLineDiff(oldStr, newStr);
  const lines: DiffLine[] = [];

  for (const change of changes) {
    const changeLines = change.value.replace(/\n$/, "").split("\n");
    const type: DiffLine["type"] = change.added ? "add" : change.removed ? "remove" : "context";
    for (const line of changeLines) {
      lines.push({ type, content: line });
    }
  }

  return lines;
}

function guessLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    rb: "ruby",
    java: "java",
    css: "css",
    html: "html",
    json: "json",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    sh: "bash",
    zsh: "bash",
    bash: "bash",
  };
  return map[ext] || "text";
}

export default memo(function CodeDiffBlock({
  toolName,
  filePath,
  oldContent,
  newContent,
  isActive: _isActive,
}: Props) {
  const diffLines = useMemo(() => computeDiff(oldContent, newContent), [oldContent, newContent]);
  const language = guessLanguage(filePath);
  const isDark = useSyncExternalStore(subscribe, getIsDark);
  const isNewFile = !oldContent;

  return (
    <div className="border border-terminal-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-terminal-surface border-b border-terminal-border">
        <span className="text-xs font-mono font-bold text-terminal-orange">{toolName}</span>
        <span className="text-xs font-mono text-terminal-blue truncate">{filePath}</span>
        {isNewFile && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-terminal-green/20 text-terminal-green">
            new
          </span>
        )}
      </div>
      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        <Highlight
          theme={isDark ? themes.nightOwl : themes.nightOwlLight}
          code={diffLines.map((l) => l.content).join("\n")}
          language={language}
        >
          {({ tokens, getLineProps, getTokenProps }) => (
            <pre className="text-xs font-mono !bg-transparent !m-0 p-0">
              {tokens.map((line, i) => {
                const diffLine = diffLines[i];
                if (!diffLine) return null;
                const bgClass =
                  diffLine.type === "add"
                    ? "bg-green-100 dark:bg-green-900/30"
                    : diffLine.type === "remove"
                      ? "bg-red-100 dark:bg-red-900/30"
                      : "";
                const prefix =
                  diffLine.type === "add" ? "+" : diffLine.type === "remove" ? "-" : " ";
                const prefixColor =
                  diffLine.type === "add"
                    ? "text-terminal-green"
                    : diffLine.type === "remove"
                      ? "text-terminal-red"
                      : "text-terminal-dim";

                return (
                  <div
                    key={i}
                    {...getLineProps({ line })}
                    className={`flex ${bgClass} px-3 leading-5`}
                  >
                    <span className={`select-none w-4 shrink-0 ${prefixColor}`}>{prefix}</span>
                    <span>
                      {line.map((token, j) => (
                        <span key={j} {...getTokenProps({ token })} />
                      ))}
                    </span>
                  </div>
                );
              })}
            </pre>
          )}
        </Highlight>
      </div>
    </div>
  );
});
