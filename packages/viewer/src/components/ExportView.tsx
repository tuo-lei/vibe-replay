import { useEffect, useState } from "react";
import type { AnnotationActions } from "../hooks/useAnnotations";
import type { ViewerMode } from "../hooks/useSessionLoader";

interface Props {
  actions: AnnotationActions;
  viewerMode: ViewerMode;
  readOnly: boolean;
}

function StatusMessage({ msg }: { msg: { type: "success" | "error"; text: string } | null }) {
  if (!msg) return null;
  return (
    <div
      className={`text-xs font-mono mt-2 ${msg.type === "success" ? "text-terminal-green" : "text-terminal-red"}`}
    >
      {msg.type === "success" && msg.text.startsWith("http") ? (
        <a
          href={msg.text}
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-terminal-text transition-colors"
        >
          {msg.text}
        </a>
      ) : (
        msg.text
      )}
    </div>
  );
}

function ExportCard({
  title,
  description,
  color,
  children,
}: {
  title: string;
  description: string;
  color: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-terminal-surface rounded-xl p-4 shadow-layer-sm flex flex-col gap-3">
      <div>
        <div className={`text-sm font-mono font-semibold ${color}`}>{title}</div>
        <div className="text-xs font-mono text-terminal-dim mt-1 leading-relaxed">
          {description}
        </div>
      </div>
      <div className="mt-auto">{children}</div>
    </div>
  );
}

export default function ExportView({ actions, viewerMode, readOnly }: Props) {
  const {
    hasUnsaved,
    canSaveHtml,
    downloadHtml,
    downloadJson,
    publishGist,
    exportHtml,
    exportGithub,
    gistPublishing,
    htmlExporting,
    githubExporting,
  } = actions;

  const [htmlStatus, setHtmlStatus] = useState<{ type: "success" | "error"; text: string } | null>(
    null,
  );
  const [ghStatus, setGhStatus] = useState<{ type: "success" | "error"; text: string } | null>(
    null,
  );
  const [gistStatus, setGistStatus] = useState<{ type: "success" | "error"; text: string } | null>(
    null,
  );
  const [ghAvailable, setGhAvailable] = useState<boolean | null>(null);

  // Check gh CLI availability in editor mode
  useEffect(() => {
    if (!publishGist) return;
    fetch("/api/gh-status")
      .then((r) => r.json())
      .then((data) => setGhAvailable(data.available ?? false))
      .catch(() => setGhAvailable(false));
  }, [publishGist]);

  if (readOnly) {
    return (
      <div className="p-6 text-center text-xs font-mono text-terminal-dim">
        Export is not available in read-only mode
      </div>
    );
  }

  const isEditor = viewerMode === "editor";
  const btnBase =
    "w-full px-3 py-2 text-xs font-mono rounded-lg transition-colors text-center disabled:opacity-50";

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="text-[10px] font-sans font-semibold text-terminal-dimmer uppercase tracking-widest mb-4">
        Export & Share
      </div>

      {hasUnsaved && (
        <div className="text-xs font-mono text-terminal-orange text-center mb-4 px-3 py-2 rounded-lg bg-terminal-orange-subtle">
          You have unsaved annotation changes
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Export HTML */}
        {isEditor && exportHtml && (
          <ExportCard
            title="Export HTML"
            description="Self-contained HTML replay with comments"
            color="text-terminal-green"
          >
            <button
              onClick={async () => {
                setHtmlStatus(null);
                try {
                  const path = await exportHtml();
                  setHtmlStatus({ type: "success", text: `Saved: ${path}` });
                } catch (e: any) {
                  setHtmlStatus({ type: "error", text: e.message });
                }
              }}
              disabled={htmlExporting}
              className={`${btnBase} bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis`}
            >
              {htmlExporting ? "Exporting..." : "Export HTML"}
            </button>
            <StatusMessage msg={htmlStatus} />
          </ExportCard>
        )}

        {/* Export for GitHub */}
        {isEditor && exportGithub && (
          <ExportCard
            title="Export for GitHub"
            description="Markdown + animated SVG for GitHub"
            color="text-terminal-orange"
          >
            <button
              onClick={async () => {
                setGhStatus(null);
                try {
                  const result = await exportGithub();
                  await navigator.clipboard.writeText(result.markdown);
                  setGhStatus({ type: "success", text: "Markdown copied to clipboard!" });
                } catch (e: any) {
                  setGhStatus({ type: "error", text: e.message });
                }
              }}
              disabled={githubExporting}
              className={`${btnBase} bg-terminal-orange-subtle text-terminal-orange hover:bg-terminal-orange-emphasis`}
            >
              {githubExporting ? "Exporting..." : "Copy Markdown"}
            </button>
            <StatusMessage msg={ghStatus} />
          </ExportCard>
        )}

        {/* Publish to Gist */}
        {isEditor && publishGist && (
          <ExportCard
            title="Publish to Gist"
            description="Share via GitHub Gist"
            color="text-terminal-purple"
          >
            {ghAvailable ? (
              <>
                <button
                  onClick={async () => {
                    setGistStatus(null);
                    try {
                      const result = await publishGist();
                      setGistStatus({ type: "success", text: result.viewerUrl });
                    } catch (e: any) {
                      setGistStatus({ type: "error", text: e.message });
                    }
                  }}
                  disabled={gistPublishing}
                  className={`${btnBase} bg-terminal-purple-subtle text-terminal-purple hover:bg-terminal-purple-emphasis`}
                >
                  {gistPublishing ? "Publishing..." : "Publish to Gist"}
                </button>
                <StatusMessage msg={gistStatus} />
              </>
            ) : ghAvailable === false ? (
              <div className="text-xs font-mono text-terminal-orange px-2 py-1.5 rounded bg-terminal-orange-subtle">
                Requires{" "}
                <a
                  href="https://cli.github.com/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  gh CLI
                </a>{" "}
                — install then run <span className="text-terminal-text">gh auth login</span>
              </div>
            ) : (
              <div className="text-xs font-mono text-terminal-dimmer">Checking gh CLI...</div>
            )}
          </ExportCard>
        )}

        {/* Save HTML with Comments (non-editor) */}
        {!isEditor && canSaveHtml && (
          <ExportCard
            title="Save HTML"
            description="Download HTML replay with comments"
            color="text-terminal-green"
          >
            <button
              onClick={downloadHtml}
              className={`${btnBase} bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis`}
            >
              Download HTML
            </button>
          </ExportCard>
        )}

        {/* Export JSON */}
        <ExportCard
          title="Export JSON"
          description="Raw replay data for backup"
          color="text-terminal-blue"
        >
          <button
            onClick={downloadJson}
            className={`${btnBase} bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis`}
          >
            Download JSON
          </button>
        </ExportCard>
      </div>
    </div>
  );
}
