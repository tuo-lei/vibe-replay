import { marked } from "marked";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnnotationActions } from "../hooks/useAnnotations";
import type { ViewerMode } from "../hooks/useSessionLoader";
import type { ReplaySession } from "../types";
import { sanitizeHtml, sanitizeSvg } from "../utils/sanitize";

interface Props {
  actions: AnnotationActions;
  viewerMode: ViewerMode;
  readOnly: boolean;
  session?: ReplaySession;
}

interface GistInfo {
  gistId: string;
  gistUrl: string;
  viewerUrl: string;
  updatedAt: string;
}

interface GhExportResult {
  svgContent: string | null;
  markdown: string | null;
  svgPath: string;
  mdPath: string;
  replayUrl?: string;
  warnings?: string[];
}

type Status = { type: "success" | "error"; text: string } | null;

function apiUrl(path: string): string {
  const slug = new URLSearchParams(window.location.search).get("session");
  if (!slug) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}slug=${encodeURIComponent(slug)}`;
}

function SectionHeader({ title, color }: { title: string; color: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className={`text-[10px] font-sans font-semibold uppercase tracking-widest ${color}`}>
        {title}
      </span>
      <div className="flex-1 h-px bg-terminal-border-subtle" />
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="text-[10px] font-mono text-terminal-dim hover:text-terminal-text transition-colors px-1.5 py-0.5 rounded bg-terminal-surface hover:bg-terminal-surface-hover border border-terminal-border-subtle"
      title="Copy to clipboard"
    >
      {copied ? "Copied!" : label || "Copy"}
    </button>
  );
}

function relativeTime(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  } catch {
    return "";
  }
}

function FilePath({ label, path }: { label: string; path: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-mono text-terminal-dim">
      <span className="text-terminal-dimmer w-8 shrink-0">{label}</span>
      <span className="text-terminal-text truncate">{path}</span>
    </div>
  );
}

export default function ExportView({ actions, viewerMode, readOnly, session }: Props) {
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

  const isEditor = viewerMode === "editor";
  const [htmlStatus, setHtmlStatus] = useState<Status>(null);
  const [gistStatus, setGistStatus] = useState<Status>(null);
  const [ghAvailable, setGhAvailable] = useState<boolean | null>(null);
  const [gistInfo, setGistInfo] = useState<GistInfo | null>(null);
  const [gistInfoLoading, setGistInfoLoading] = useState(false);
  const [ghExportResult, setGhExportResult] = useState<GhExportResult | null>(null);
  const [ghExporting, setGhExporting] = useState(false);
  const [ghError, setGhError] = useState<string | null>(null);
  const [mdViewMode, setMdViewMode] = useState<"preview" | "source">("preview");

  // Fetch gh CLI status, gist info, and existing export files
  useEffect(() => {
    if (!isEditor) return;
    if (publishGist) {
      fetch(apiUrl("/api/gh-status"))
        .then((r) => r.json())
        .then((data) => setGhAvailable(data.available ?? false))
        .catch(() => setGhAvailable(false));

      setGistInfoLoading(true);
      fetch(apiUrl("/api/gist-info"))
        .then((r) => r.json())
        .then((data) => {
          if (data.gist) setGistInfo(data.gist);
        })
        .catch(() => {})
        .finally(() => setGistInfoLoading(false));
    }

    // Load existing SVG/MD if previously exported
    if (exportGithub) {
      fetch(apiUrl("/api/export/github/status"))
        .then((r) => r.json())
        .then((data) => {
          if (data.exists) {
            setGhExportResult({
              svgContent: data.svgContent,
              markdown: data.markdown,
              svgPath: data.svgPath,
              mdPath: data.mdPath,
              replayUrl: data.replayUrl,
            });
          }
        })
        .catch(() => {});
    }
  }, [isEditor, publishGist, exportGithub]);

  const handlePublishGist = useCallback(async () => {
    if (!publishGist) return;
    setGistStatus(null);
    try {
      const result = await publishGist();
      setGistInfo({
        gistId: result.gistId,
        gistUrl: result.gistUrl,
        viewerUrl: result.viewerUrl,
        updatedAt: new Date().toISOString(),
      });
      setGistStatus({ type: "success", text: "Published successfully!" });
    } catch (e: any) {
      setGistStatus({ type: "error", text: e.message });
    }
  }, [publishGist]);

  const handleExportGithub = useCallback(async () => {
    if (!exportGithub) return;
    setGhError(null);
    setGhExporting(true);
    try {
      const result = await exportGithub();
      await navigator.clipboard.writeText(result.markdown);
      setGhExportResult({
        svgContent: result.svgContent,
        markdown: result.markdown,
        svgPath: result.svgPath,
        mdPath: result.mdPath,
        replayUrl: result.replayUrl,
        warnings: result.warnings,
      });
    } catch (e: any) {
      setGhError(e.message);
    } finally {
      setGhExporting(false);
    }
  }, [exportGithub]);

  const renderedMarkdown = useMemo(() => {
    if (!ghExportResult?.markdown) return "";
    // Strip the image line — SVG is shown separately
    const md = ghExportResult.markdown.replace(/!\[[^\]]*\]\([^)]*\.svg\)\n*/g, "");
    return sanitizeHtml(marked.parse(md) as string);
  }, [ghExportResult?.markdown]);

  const sanitizedSvg = useMemo(() => {
    if (!ghExportResult?.svgContent) return "";
    return sanitizeSvg(ghExportResult.svgContent);
  }, [ghExportResult?.svgContent]);

  if (readOnly) {
    return (
      <div className="p-6 text-center text-xs font-mono text-terminal-dim">
        Export is not available in read-only mode
      </div>
    );
  }

  const ghUnavailable = ghAvailable === false;
  const btnBase =
    "px-4 py-2 text-xs font-mono rounded-lg transition-colors text-center disabled:opacity-50 shrink-0";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-3xl mx-auto">
        {/* Session context */}
        {session && (
          <div className="flex items-center gap-2.5 mb-5">
            <h2 className="text-sm font-mono font-semibold text-terminal-text truncate">
              {session.meta.title || session.meta.slug}
            </h2>
            {session.meta.provider && (
              <span className="shrink-0 text-[10px] font-mono text-terminal-dimmer px-1.5 py-0.5 rounded bg-terminal-surface border border-terminal-border-subtle">
                {session.meta.provider}
              </span>
            )}
          </div>
        )}
        {hasUnsaved && (
          <div className="text-xs font-mono text-terminal-orange text-center mb-5 px-3 py-2 rounded-lg bg-terminal-orange-subtle border border-terminal-orange/20">
            You have unsaved annotation changes
          </div>
        )}

        {/* ─── SHARE ──────────────────────────────────────────── */}
        {isEditor && publishGist && (
          <div className="mb-8">
            <SectionHeader title="Share" color="text-terminal-purple" />

            <div className="bg-terminal-surface rounded-2xl border border-terminal-border-subtle shadow-layer-sm overflow-hidden">
              <div className="p-5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-mono font-semibold text-terminal-purple">
                      GitHub Gist
                    </span>
                    <span className="inline-flex items-center gap-1 text-[10px] font-mono text-terminal-dim px-1.5 py-0.5 rounded-full bg-terminal-surface-hover border border-terminal-border-subtle">
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="10"
                        height="10"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <line x1="2" y1="12" x2="22" y2="12" />
                        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
                      </svg>
                      Public
                    </span>
                  </div>
                  <p className="text-[11px] font-mono text-terminal-dim leading-relaxed">
                    Publish as a public GitHub Gist. Anyone with the link can view the interactive
                    replay on vibe-replay.com.
                  </p>
                </div>

                {gistInfo && (
                  <div className="mt-4 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-[10px] font-mono font-semibold text-terminal-green px-2 py-0.5 rounded-full bg-terminal-green-subtle">
                        <span className="w-1.5 h-1.5 rounded-full bg-terminal-green" />
                        Published
                      </span>
                      <span className="text-[10px] font-mono text-terminal-dimmer">
                        {relativeTime(gistInfo.updatedAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 bg-terminal-bg rounded-lg px-3 py-2 border border-terminal-border-subtle">
                      <a
                        href={gistInfo.viewerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-xs font-mono text-terminal-blue hover:text-terminal-text transition-colors truncate"
                      >
                        {gistInfo.viewerUrl}
                      </a>
                      <CopyButton text={gistInfo.viewerUrl} />
                    </div>
                    <div className="flex items-center gap-2 text-[11px] font-mono text-terminal-dim">
                      <span>Gist:</span>
                      <a
                        href={gistInfo.gistUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-terminal-dim hover:text-terminal-text transition-colors truncate"
                      >
                        {gistInfo.gistUrl}
                      </a>
                    </div>
                  </div>
                )}

                {gistInfoLoading && !gistInfo && (
                  <div className="mt-4 text-[11px] font-mono text-terminal-dimmer animate-pulse">
                    Checking publish status...
                  </div>
                )}

                <div className="mt-4 flex items-center gap-3">
                  {ghUnavailable ? (
                    <div className="flex-1 text-xs font-mono text-terminal-orange px-3 py-2 rounded-lg bg-terminal-orange-subtle/50 border border-terminal-orange/10">
                      Requires{" "}
                      <a
                        href="https://cli.github.com/"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline"
                      >
                        gh CLI
                      </a>{" "}
                      — install then run{" "}
                      <span className="text-terminal-text font-semibold">gh auth login</span>
                    </div>
                  ) : ghAvailable === null ? (
                    <div className="text-[11px] font-mono text-terminal-dimmer animate-pulse">
                      Checking gh CLI...
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={handlePublishGist}
                        disabled={gistPublishing}
                        className={`${btnBase} ${
                          gistInfo
                            ? "bg-terminal-surface-hover text-terminal-purple hover:bg-terminal-purple-subtle border border-terminal-border"
                            : "bg-terminal-purple-subtle text-terminal-purple hover:bg-[rgba(168,85,247,0.25)] border border-[rgba(168,85,247,0.2)]"
                        }`}
                      >
                        {gistPublishing
                          ? "Publishing..."
                          : gistInfo
                            ? "Update Gist"
                            : "Publish to Gist"}
                      </button>
                      {gistStatus && (
                        <span
                          className={`text-[11px] font-mono ${gistStatus.type === "success" ? "text-terminal-green" : "text-terminal-red"}`}
                        >
                          {gistStatus.text}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─── EXPORT ─────────────────────────────────────────── */}
        <div>
          <SectionHeader title="Export" color="text-terminal-green" />
          <div className="space-y-4">
            {/* ─── SVG + Markdown (for GitHub PRs/READMEs) ─── */}
            {isEditor && exportGithub && (
              <>
                {/* SVG Preview Card */}
                {ghExportResult?.svgContent && (
                  <div className="bg-terminal-surface rounded-2xl border border-terminal-border-subtle shadow-layer-sm overflow-hidden">
                    <div className="px-5 py-3 flex items-center justify-between border-b border-terminal-border-subtle">
                      <div>
                        <div className="text-sm font-mono font-semibold text-terminal-orange">
                          Animated SVG
                        </div>
                        <p className="text-[10px] font-mono text-terminal-dim mt-0.5">
                          Embed in READMEs, PRs, or anywhere that renders SVG.
                        </p>
                      </div>
                    </div>

                    {/* Inline SVG render (scaled to fit) */}
                    <div
                      className="bg-white p-1 [&>svg]:w-full [&>svg]:h-auto [&>svg]:max-h-52 [&>svg]:block"
                      dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
                    />

                    <div className="px-5 py-3 space-y-1.5 border-t border-terminal-border-subtle">
                      <FilePath label="File" path={ghExportResult.svgPath} />
                      {ghExportResult.replayUrl && (
                        <div className="flex items-center gap-2 text-[11px] font-mono text-terminal-dim">
                          <span className="text-terminal-dimmer w-8 shrink-0">Link</span>
                          <a
                            href={ghExportResult.replayUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-terminal-blue hover:text-terminal-text transition-colors truncate"
                          >
                            {ghExportResult.replayUrl}
                          </a>
                        </div>
                      )}
                      <p className="text-[10px] font-mono text-terminal-dimmer leading-relaxed pt-1">
                        Usage:{" "}
                        <span className="text-terminal-text">
                          {"![Session](./session-preview.svg)"}
                        </span>
                      </p>
                    </div>
                  </div>
                )}

                {/* Markdown Card */}
                {ghExportResult?.markdown && (
                  <div className="bg-terminal-surface rounded-2xl border border-terminal-border-subtle shadow-layer-sm overflow-hidden">
                    <div className="px-5 py-3 flex items-center justify-between border-b border-terminal-border-subtle">
                      <div>
                        <div className="text-sm font-mono font-semibold text-terminal-orange">
                          Markdown Summary
                        </div>
                        <p className="text-[10px] font-mono text-terminal-dim mt-0.5">
                          Paste into GitHub PRs, issues, or README files.
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <CopyButton text={ghExportResult.markdown} label="Copy MD" />
                        <div className="flex items-center h-6 rounded-md overflow-hidden bg-terminal-bg border border-terminal-border-subtle">
                          <button
                            onClick={() => setMdViewMode("preview")}
                            className={`h-full px-2.5 text-[10px] font-mono transition-colors ${
                              mdViewMode === "preview"
                                ? "bg-terminal-orange-subtle text-terminal-orange"
                                : "text-terminal-dim hover:text-terminal-text"
                            }`}
                          >
                            Preview
                          </button>
                          <button
                            onClick={() => setMdViewMode("source")}
                            className={`h-full px-2.5 text-[10px] font-mono transition-colors ${
                              mdViewMode === "source"
                                ? "bg-terminal-orange-subtle text-terminal-orange"
                                : "text-terminal-dim hover:text-terminal-text"
                            }`}
                          >
                            Source
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="p-4">
                      {mdViewMode === "preview" ? (
                        <div
                          className="prose-terminal text-xs leading-relaxed bg-terminal-bg rounded-lg border border-terminal-border-subtle p-4 overflow-x-auto"
                          dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
                        />
                      ) : (
                        <pre className="bg-terminal-bg rounded-lg border border-terminal-border-subtle p-3 text-[11px] font-mono text-terminal-dim leading-relaxed overflow-x-auto max-h-72 overflow-y-auto whitespace-pre-wrap">
                          {ghExportResult.markdown}
                        </pre>
                      )}
                    </div>

                    <div className="px-5 py-3 space-y-1.5 border-t border-terminal-border-subtle">
                      <FilePath label="File" path={ghExportResult.mdPath} />
                    </div>

                    {ghExportResult.warnings && ghExportResult.warnings.length > 0 && (
                      <div className="mx-5 mb-4 text-[11px] font-mono text-terminal-orange px-3 py-2 rounded-lg bg-terminal-orange-subtle/50 border border-terminal-orange/10">
                        <div className="font-semibold mb-1">Security warnings</div>
                        {ghExportResult.warnings.map((w, i) => (
                          <div key={i} className="text-terminal-dim">
                            {w}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Generate / Regenerate button */}
                <div className="flex items-center gap-3">
                  <button
                    onClick={handleExportGithub}
                    disabled={ghExporting || githubExporting}
                    className={`${btnBase} ${
                      ghExportResult
                        ? "bg-terminal-surface-hover text-terminal-orange hover:bg-terminal-orange-subtle border border-terminal-border"
                        : "bg-terminal-orange-subtle text-terminal-orange hover:bg-terminal-orange-emphasis border border-terminal-orange/20"
                    }`}
                  >
                    {ghExporting || githubExporting
                      ? "Generating..."
                      : ghExportResult
                        ? "Regenerate SVG + Markdown"
                        : "Generate SVG + Markdown"}
                  </button>
                  {ghError && (
                    <span className="text-[11px] font-mono text-terminal-red">{ghError}</span>
                  )}
                  {!ghExportResult && (
                    <span className="text-[11px] font-mono text-terminal-dim">
                      Creates an animated SVG preview and a Markdown summary for GitHub
                    </span>
                  )}
                </div>
              </>
            )}

            {/* HTML */}
            {isEditor && exportHtml && (
              <div className="bg-terminal-surface rounded-2xl border border-terminal-border-subtle shadow-layer-sm p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-mono font-semibold text-terminal-green mb-1">
                      HTML Replay
                    </div>
                    <p className="text-[11px] font-mono text-terminal-dim leading-relaxed">
                      Self-contained HTML file with zero external requests. Includes all scenes,
                      metadata, and annotations. Share via email, Slack, or host on any static
                      server.
                    </p>
                  </div>
                  <button
                    onClick={async () => {
                      setHtmlStatus(null);
                      try {
                        const path = await exportHtml();
                        setHtmlStatus({ type: "success", text: path });
                      } catch (e: any) {
                        setHtmlStatus({ type: "error", text: e.message });
                      }
                    }}
                    disabled={htmlExporting}
                    className={`${btnBase} bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis border border-terminal-green/20`}
                  >
                    {htmlExporting ? "Exporting..." : "Export HTML"}
                  </button>
                </div>
                {htmlStatus && (
                  <div
                    className={`mt-3 text-[11px] font-mono ${htmlStatus.type === "success" ? "text-terminal-green" : "text-terminal-red"}`}
                  >
                    {htmlStatus.type === "success" ? (
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-terminal-green shrink-0" />
                        Saved to {htmlStatus.text}
                      </span>
                    ) : (
                      htmlStatus.text
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Save HTML (non-editor) */}
            {!isEditor && canSaveHtml && (
              <div className="bg-terminal-surface rounded-2xl border border-terminal-border-subtle shadow-layer-sm p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-sm font-mono font-semibold text-terminal-green mb-1">
                      Save HTML
                    </div>
                    <p className="text-[11px] font-mono text-terminal-dim leading-relaxed">
                      Download a self-contained HTML replay file with your comments included.
                    </p>
                  </div>
                  <button
                    onClick={downloadHtml}
                    className={`${btnBase} bg-terminal-green-subtle text-terminal-green hover:bg-terminal-green-emphasis border border-terminal-green/20`}
                  >
                    Download HTML
                  </button>
                </div>
              </div>
            )}

            {/* JSON */}
            <div className="bg-terminal-surface rounded-2xl border border-terminal-border-subtle shadow-layer-sm p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-sm font-mono font-semibold text-terminal-blue mb-1">
                    JSON Data
                  </div>
                  <p className="text-[11px] font-mono text-terminal-dim leading-relaxed">
                    Raw replay data including all scenes, metadata, and annotations. Useful for
                    backup, re-import, or programmatic analysis.
                  </p>
                </div>
                <button
                  onClick={downloadJson}
                  className={`${btnBase} bg-terminal-blue-subtle text-terminal-blue hover:bg-terminal-blue-emphasis border border-terminal-blue/20`}
                >
                  Download JSON
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
