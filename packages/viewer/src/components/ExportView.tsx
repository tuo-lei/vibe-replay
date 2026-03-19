import { marked } from "marked";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AnnotationActions } from "../hooks/useAnnotations";
import type { ViewerMode } from "../hooks/useSessionLoader";
import type { ReplaySession } from "../types";
import { sanitizeHtml, sanitizeSvg } from "../utils/sanitize";

// Sync with MAX_EXPORT_TURNS in packages/cli/src/formatters/github.ts
const MAX_EXPORT_TURNS = 8;

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
  gifContent: string | null;
  gifPath: string | null;
  gifGeneratedAt?: string;
  svgGeneratedAt?: string;
  mdGeneratedAt?: string;
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

function formatBytes(len: number, isBase64 = false): string {
  const bytes = isBase64 ? Math.round(len * 0.75) : len;
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(1)} KB` : `${(kb / 1024).toFixed(1)} MB`;
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
  const [cloudVisibility, setCloudVisibility] = useState<"private" | "unlisted" | "public">(
    "unlisted",
  );
  const [gistPublishingLocal, setGistPublishingLocal] = useState(false);
  const [cloudSharing, setCloudSharing] = useState(false);
  const [cloudStatus, setCloudStatus] = useState<Status>(null);
  const [cloudInfo, setCloudInfo] = useState<{
    id: string;
    url: string;
    expiresAt: string;
    visibility?: string;
  } | null>(null);
  const [storageUsed, setStorageUsed] = useState<number | null>(null);
  const [storageLimit, setStorageLimit] = useState<number | null>(null);

  const cloudApiUrl = import.meta.env.VITE_CLOUD_API_URL || "";

  // Compute replay JSON size
  const replaySize = useMemo(
    () => (session ? new TextEncoder().encode(JSON.stringify(session)).byteLength : 0),
    [session],
  );
  const CLOUD_MAX = 10 * 1024 * 1024;
  const GIST_MAX = 5 * 1024 * 1024;
  const cloudTooBig = replaySize > CLOUD_MAX;
  const gistTooBig = replaySize > GIST_MAX;

  // Fetch publish status, gist info, and existing export files
  // biome-ignore lint/correctness/useExhaustiveDependencies: session is stable after initial load; including it would cause infinite re-fetches
  useEffect(() => {
    if (!isEditor) return;
    if (publishGist) {
      // Check auth against Worker directly (browser cookie)
      fetch(`${cloudApiUrl}/api/auth/get-session`, { credentials: "include" })
        .then((r) => r.json())
        .then((data: any) => {
          const loggedIn = !!data?.session;
          setGhAvailable(loggedIn);
          // Fetch storage usage + cloud replays list (source of truth for visibility)
          if (loggedIn) {
            fetch(`${cloudApiUrl}/api/cloud-replays`, { credentials: "include" })
              .then((r2) => r2.json())
              .then((d: any) => {
                setStorageUsed(d.storage?.used ?? null);
                setStorageLimit(d.storage?.limit ?? null);
                // Find existing cloud share for this session
                if (session) {
                  // Try local cloud-info first (has exact ID), then fall back to title match
                  fetch(apiUrl("/api/cloud-info"))
                    .then((lr) => lr.json())
                    .then((ld: any) => {
                      const localId = ld?.cloud?.id;
                      const verify = localId
                        ? (d.replays || []).find((r: any) => r.id === localId)
                        : null;
                      const match =
                        verify ||
                        (d.replays || []).find(
                          (r: any) =>
                            r.storageType === "r2" &&
                            r.title === (session.meta.title || session.meta.slug),
                        );
                      if (match) {
                        const info = {
                          id: match.id,
                          url: `${cloudApiUrl}/r/${match.id}`,
                          expiresAt: match.expiresAt || "",
                          visibility: match.visibility,
                        };
                        setCloudInfo(info);
                        if (match.visibility) setCloudVisibility(match.visibility);
                        if (!verify) {
                          fetch(apiUrl("/api/cloud-info"), {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify(info),
                          }).catch(() => {});
                        }
                      }
                    })
                    .catch(() => {});
                }
              })
              .catch(() => {});
          }
        })
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

    // Load existing SVG/MD/GIF if previously exported
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
              gifContent: data.gifContent ?? null,
              gifPath: data.gifPath ?? null,
              gifGeneratedAt: data.gifGeneratedAt,
              svgGeneratedAt: data.svgGeneratedAt,
              mdGeneratedAt: data.mdGeneratedAt,
              replayUrl: data.replayUrl,
            });
          }
        })
        .catch(() => {});
    }
  }, [isEditor, publishGist, exportGithub]);

  const handlePublishGist = useCallback(async () => {
    if (!session) return;
    setGistPublishingLocal(true);
    setGistStatus(null);
    try {
      const content = JSON.stringify(session);
      const title = session.meta.title || session.meta.slug;
      const filename = `${title
        .replace(/[^a-zA-Z0-9_-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 60)}.json`;
      const endpoint = gistInfo
        ? `${cloudApiUrl}/api/gists/${gistInfo.gistId}`
        : `${cloudApiUrl}/api/gists`;
      const resp = await fetch(endpoint, {
        method: gistInfo ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          filename,
          content,
          description: `vibe-replay: ${title}`,
          public: true,
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error((data as any).error || "Gist publish failed");
      }
      const result = (await resp.json()) as {
        gistId: string;
        gistUrl: string;
        viewerUrl: string;
      };
      setGistInfo({
        gistId: result.gistId,
        gistUrl: result.gistUrl,
        viewerUrl: result.viewerUrl,
        updatedAt: new Date().toISOString(),
      });
      setGistStatus({ type: "success", text: "Published!" });
    } catch (e: any) {
      setGistStatus({ type: "error", text: e.message });
    } finally {
      setGistPublishingLocal(false);
    }
  }, [session, gistInfo]);

  const handleCloudShare = useCallback(async () => {
    if (!session) return;
    setCloudSharing(true);
    setCloudStatus(null);
    try {
      // Upload new replay first, then delete old one on success
      const oldCloudId = cloudInfo?.id;
      const resp = await fetch(`${cloudApiUrl}/api/cloud-replays`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ replay: session, visibility: cloudVisibility }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error((data as any).error || "Upload failed");
      }
      const result = (await resp.json()) as { id: string; url: string; expiresAt: string };
      // Delete old one after successful upload
      // Delete old replay first (await to ensure storage is accurate after)
      if (oldCloudId && oldCloudId !== result.id) {
        await fetch(`${cloudApiUrl}/api/cloud-replays/${oldCloudId}`, {
          method: "DELETE",
          credentials: "include",
        }).catch(() => {});
      }
      setCloudInfo(result);
      setCloudStatus({ type: "success", text: oldCloudId ? "Updated!" : "Shared!" });
      // Sync cloud info back to CLI server for local persistence
      fetch(apiUrl("/api/cloud-info"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...result, visibility: cloudVisibility }),
      }).catch(() => {});
      // Refresh storage usage (after delete completed)
      const storageResp = await fetch(`${cloudApiUrl}/api/cloud-replays`, {
        credentials: "include",
      }).catch(() => null);
      if (storageResp) {
        const storageData = (await storageResp.json().catch(() => null)) as any;
        if (storageData?.storage) {
          setStorageUsed(storageData.storage.used ?? null);
          setStorageLimit(storageData.storage.limit ?? null);
        }
      }
    } catch (e: any) {
      setCloudStatus({ type: "error", text: e.message });
    } finally {
      setCloudSharing(false);
    }
  }, [session, cloudVisibility, cloudInfo]);

  const handleCloudDelete = useCallback(async () => {
    if (!cloudInfo?.id) return;
    setCloudSharing(true);
    setCloudStatus(null);
    try {
      const resp = await fetch(`${cloudApiUrl}/api/cloud-replays/${cloudInfo.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error((data as any).error || "Delete failed");
      }
      setCloudInfo(null);
      setCloudStatus({ type: "success", text: "Removed from cloud" });
      // Clear local cloud info
      fetch(apiUrl("/api/cloud-info"), {
        method: "DELETE",
      }).catch(() => {});
      // Refresh storage
      fetch(`${cloudApiUrl}/api/cloud-replays`, { credentials: "include" })
        .then((r) => r.json())
        .then((d: any) => {
          setStorageUsed(d.storage?.used ?? null);
          setStorageLimit(d.storage?.limit ?? null);
        })
        .catch(() => {});
    } catch (e: any) {
      setCloudStatus({ type: "error", text: e.message });
    } finally {
      setCloudSharing(false);
    }
  }, [cloudInfo]);

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
        gifContent: result.gifContent ?? null,
        gifPath: result.gifPath ?? null,
        gifGeneratedAt: result.gifGeneratedAt,
        svgGeneratedAt: result.svgGeneratedAt,
        mdGeneratedAt: result.mdGeneratedAt,
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
    // Strip the image line — preview is shown separately (GIF or SVG)
    // Handles both plain images ![alt](path.gif) and clickable [![alt](path.gif)](url)
    const md = ghExportResult.markdown.replace(
      /\[?!\[[^\]]*\]\([^)]*\.(?:svg|gif)\)\]?(?:\([^)]*\))?\n*/g,
      "",
    );
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

  const btnBase =
    "px-4 py-2 text-xs font-mono rounded-lg transition-colors text-center disabled:opacity-50 shrink-0";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 max-w-3xl mx-auto">
        <div>
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
          {isEditor && (
            <div id="share" className="mb-12">
              <div className="flex items-center justify-between mb-4">
                <SectionHeader title="Share" color="text-terminal-purple" />
                {replaySize > 0 && (
                  <span
                    className={`text-[11px] font-mono px-2 py-0.5 rounded-md ${
                      replaySize > GIST_MAX
                        ? "bg-terminal-red-subtle text-terminal-red"
                        : "bg-terminal-surface-2 text-terminal-dimmer"
                    }`}
                  >
                    {formatBytes(replaySize)} replay
                  </span>
                )}
              </div>

              {ghAvailable === false ? (
                /* ─── Not logged in: sign-in CTA ─── */
                <div className="bg-terminal-surface rounded-xl border border-terminal-border shadow-layer-sm overflow-hidden">
                  <div className="p-6">
                    <h3 className="text-lg font-sans font-semibold text-terminal-text mb-5">
                      Share your session — free
                    </h3>

                    <div className="grid grid-cols-2 gap-4 mb-6">
                      <div className="rounded-xl bg-terminal-bg border border-terminal-border-subtle p-5">
                        <div className="flex items-center gap-2 mb-4">
                          <span className="text-xs font-sans font-bold text-terminal-purple">
                            Cloud Share
                          </span>
                          <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md bg-terminal-purple-subtle text-terminal-purple">
                            Private
                          </span>
                        </div>
                        <ul className="space-y-2.5 text-sm font-sans text-terminal-dim">
                          <li className="flex items-center gap-2">
                            <span className="text-terminal-green shrink-0">&#10003;</span>
                            20 MB free storage
                          </li>
                          <li className="flex items-center gap-2">
                            <span className="text-terminal-green shrink-0">&#10003;</span>
                            7-day shareable link
                          </li>
                        </ul>
                      </div>
                      <div className="rounded-xl bg-terminal-bg border border-terminal-border-subtle p-5">
                        <div className="flex items-center gap-2 mb-4">
                          <span className="text-xs font-sans font-bold text-terminal-dim">
                            GitHub Gist
                          </span>
                          <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dimmer">
                            Public
                          </span>
                        </div>
                        <ul className="space-y-2.5 text-sm font-sans text-terminal-dim">
                          <li className="flex items-center gap-2">
                            <span className="text-terminal-green shrink-0">&#10003;</span>
                            No storage limit
                          </li>
                          <li className="flex items-center gap-2">
                            <span className="text-terminal-green shrink-0">&#10003;</span>
                            Permanent — never expires
                          </li>
                          <li className="flex items-center gap-2">
                            <span className="text-terminal-green shrink-0">&#10003;</span>
                            Great for portfolios
                          </li>
                        </ul>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const res = await fetch(`${cloudApiUrl}/api/auth/sign-in/social`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            credentials: "include",
                            body: JSON.stringify({
                              provider: "github",
                              callbackURL: "/auth/success",
                            }),
                          });
                          const data = await res.json();
                          if (data.url) {
                            window.open(data.url, "_blank");
                            const poll = setInterval(async () => {
                              try {
                                const r = await fetch(`${cloudApiUrl}/api/auth/get-session`, {
                                  credentials: "include",
                                });
                                const s = await r.json();
                                if (s?.session) {
                                  clearInterval(poll);
                                  setGhAvailable(true);
                                }
                              } catch {}
                            }, 2000);
                            setTimeout(() => clearInterval(poll), 5 * 60 * 1000);
                          }
                        } catch {}
                      }}
                      className="group inline-flex items-center gap-2.5 px-6 py-3 rounded-xl bg-terminal-green-subtle hover:bg-terminal-green-emphasis text-terminal-green text-sm font-sans font-semibold transition-all duration-200 ease-material shadow-layer-sm hover:shadow-layer-md hover:-translate-y-0.5"
                    >
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 16 16"
                        fill="currentColor"
                        className="transition-transform group-hover:scale-110"
                      >
                        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                      </svg>
                      Sign in with GitHub
                    </button>
                  </div>
                </div>
              ) : ghAvailable === true ? (
                /* ─── Logged in: Cloud Share + Gist side by side ─── */
                <div className="grid grid-cols-2 gap-4">
                  {/* Cloud Share */}
                  <div className="bg-terminal-surface rounded-xl border border-terminal-border shadow-layer-sm overflow-hidden p-5 flex flex-col">
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-sm font-mono font-semibold text-terminal-purple">
                        Cloud Share
                      </span>
                    </div>

                    {/* Visibility selector */}
                    <div className="flex items-center h-7 rounded-md overflow-hidden bg-terminal-bg mb-3">
                      {[
                        {
                          value: "private" as const,
                          label: "Private",
                          icon: (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                            </svg>
                          ),
                        },
                        {
                          value: "unlisted" as const,
                          label: "Link only",
                          icon: (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                            </svg>
                          ),
                        },
                        {
                          value: "public" as const,
                          label: "Public",
                          icon: (
                            <svg
                              width="12"
                              height="12"
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
                          ),
                        },
                      ].map(({ value, label, icon }) => (
                        <button
                          key={value}
                          onClick={() => setCloudVisibility(value)}
                          className={`h-full flex-1 px-2.5 text-[11px] font-mono transition-colors flex items-center justify-center gap-1.5 whitespace-nowrap ${
                            cloudVisibility === value
                              ? "bg-terminal-purple-subtle text-terminal-purple"
                              : "text-terminal-dim hover:text-terminal-text hover:bg-terminal-surface-hover"
                          }`}
                        >
                          {icon}
                          {label}
                        </button>
                      ))}
                    </div>

                    {storageUsed != null && storageLimit != null && (
                      <div className="mb-3">
                        <div className="flex items-center justify-between text-[10px] font-mono text-terminal-dimmer mb-1.5">
                          <span>{formatBytes(storageUsed)} used</span>
                          <span>{formatBytes(storageLimit)} total</span>
                        </div>
                        {(() => {
                          const usedPct = (storageUsed / storageLimit) * 100;
                          // Don't show "+upload" when already shared (update replaces, no extra space)
                          const showUpload = !cloudInfo && replaySize > 0;
                          const uploadPct = showUpload ? (replaySize / storageLimit) * 100 : 0;
                          const wouldExceed = showUpload && storageUsed + replaySize > storageLimit;
                          return (
                            <>
                              <div className="h-2 rounded-full bg-terminal-surface-hover overflow-hidden">
                                <div className="h-full flex">
                                  {storageUsed > 0 && (
                                    <div
                                      className="h-full bg-terminal-purple transition-all"
                                      style={{ width: `${Math.max(usedPct, 1)}%` }}
                                    />
                                  )}
                                  {showUpload && (
                                    <div
                                      className={`h-full transition-all ${wouldExceed ? "bg-terminal-orange" : "bg-terminal-green"}`}
                                      style={{
                                        width: `${Math.max(Math.min(uploadPct, 100 - usedPct), 1)}%`,
                                      }}
                                    />
                                  )}
                                </div>
                              </div>
                              {showUpload && (
                                <div className="flex items-center gap-3 mt-1.5 text-[10px] font-mono text-terminal-dimmer">
                                  <span className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-sm bg-terminal-purple" />
                                    {formatBytes(storageUsed)} used
                                  </span>
                                  <span className="flex items-center gap-1">
                                    <span
                                      className={`w-1.5 h-1.5 rounded-sm ${wouldExceed ? "bg-terminal-orange" : "bg-terminal-green"}`}
                                    />
                                    +{formatBytes(replaySize)} this upload
                                  </span>
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    )}
                    <p className="text-[10px] font-mono text-terminal-dimmer flex items-center gap-1.5 mb-1">
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0 text-terminal-orange"
                      >
                        <circle cx="12" cy="12" r="10" />
                        <polyline points="12 6 12 12 16 14" />
                      </svg>
                      Free tier links expire after 7 days
                    </p>
                    {cloudTooBig && (
                      <p className="text-[11px] font-mono text-terminal-orange mt-1.5 flex items-center gap-1">
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                          <path d="M8 1a1 1 0 0 1 1 1v5.5a1 1 0 0 1-2 0V2a1 1 0 0 1 1-1zM8 11a1.25 1.25 0 1 1 0 2.5A1.25 1.25 0 0 1 8 11z" />
                        </svg>
                        Replay is {formatBytes(replaySize)} — exceeds 10MB limit
                      </p>
                    )}
                    {cloudInfo && (
                      <div className="mt-4 space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono font-semibold text-terminal-green px-2 py-0.5 rounded-full bg-terminal-green-subtle">
                            <span className="w-1.5 h-1.5 rounded-full bg-terminal-green" />
                            Shared
                          </span>
                          <span className="text-[10px] font-mono text-terminal-dimmer">
                            expires {new Date(`${cloudInfo.expiresAt}Z`).toLocaleDateString()}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 bg-terminal-bg rounded-lg px-3 py-2 border border-terminal-border-subtle">
                          <a
                            href={`${cloudApiUrl}/r/${cloudInfo.id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 text-xs font-mono text-terminal-purple hover:text-terminal-text transition-colors truncate"
                          >
                            {`${cloudApiUrl}/r/${cloudInfo.id}`}
                          </a>
                          <CopyButton text={`${cloudApiUrl}/r/${cloudInfo.id}`} />
                        </div>
                      </div>
                    )}
                    <div className="mt-4 flex items-center gap-3">
                      <button
                        onClick={handleCloudShare}
                        disabled={cloudSharing || cloudTooBig}
                        className={`${btnBase} ${
                          cloudTooBig
                            ? "bg-terminal-surface-2 text-terminal-dimmer border border-terminal-border cursor-not-allowed"
                            : cloudInfo
                              ? "bg-terminal-surface-hover text-terminal-purple hover:bg-terminal-purple-subtle border border-terminal-border"
                              : "bg-terminal-purple-subtle text-terminal-purple hover:bg-[rgba(168,85,247,0.25)] border border-[rgba(168,85,247,0.2)]"
                        }`}
                      >
                        {cloudSharing
                          ? "Uploading..."
                          : cloudTooBig
                            ? "Too large"
                            : cloudInfo
                              ? "Update"
                              : "Share to Cloud"}
                      </button>
                      {cloudInfo && (
                        <button
                          onClick={handleCloudDelete}
                          disabled={cloudSharing}
                          className={`${btnBase} bg-terminal-surface-hover text-terminal-red hover:bg-terminal-red-subtle border border-terminal-border`}
                        >
                          Delete
                        </button>
                      )}
                      {cloudStatus && (
                        <span
                          className={`text-[11px] font-mono ${cloudStatus.type === "success" ? "text-terminal-green" : "text-terminal-red"}`}
                        >
                          {cloudStatus.text}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* GitHub Gist */}
                  {isEditor && (
                    <div className="bg-terminal-surface rounded-xl border border-terminal-border shadow-layer-sm overflow-hidden p-5 flex flex-col">
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-sm font-mono font-semibold text-terminal-dim">
                          GitHub Gist
                        </span>
                        <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded-md bg-terminal-surface-2 text-terminal-dimmer">
                          Public
                        </span>
                      </div>
                      <ul className="space-y-1.5 text-xs font-sans text-terminal-dim mb-auto">
                        <li className="flex items-center gap-2">
                          <span className="text-terminal-green shrink-0">&#10003;</span>
                          Hosted on GitHub forever
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-terminal-green shrink-0">&#10003;</span>
                          Doesn&apos;t use your storage
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-terminal-orange shrink-0">!</span>
                          Visible to everyone on the internet
                        </li>
                      </ul>
                      {gistTooBig && (
                        <p className="text-[11px] font-mono text-terminal-red mt-1.5 flex items-center gap-1">
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                            <path d="M8 1a1 1 0 0 1 1 1v5.5a1 1 0 0 1-2 0V2a1 1 0 0 1 1-1zM8 11a1.25 1.25 0 1 1 0 2.5A1.25 1.25 0 0 1 8 11z" />
                          </svg>
                          Replay is {formatBytes(replaySize)} — exceeds 10MB gist limit
                        </p>
                      )}
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
                        </div>
                      )}
                      {gistInfoLoading && !gistInfo && (
                        <div className="mt-4 text-[11px] font-mono text-terminal-dimmer animate-pulse">
                          Checking...
                        </div>
                      )}
                      <div className="mt-4 flex items-center gap-3">
                        <button
                          onClick={handlePublishGist}
                          disabled={gistPublishingLocal || gistTooBig}
                          className={`${btnBase} ${
                            gistTooBig
                              ? "bg-terminal-surface-2 text-terminal-dimmer border border-terminal-border cursor-not-allowed"
                              : "bg-terminal-surface-hover text-terminal-dim hover:bg-terminal-surface-2 border border-terminal-border"
                          }`}
                        >
                          {gistPublishingLocal
                            ? "Publishing..."
                            : gistTooBig
                              ? "Too large"
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
                        {gistInfo && (
                          <a
                            href={gistInfo.gistUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] font-mono text-terminal-blue hover:text-terminal-text transition-colors"
                          >
                            Open on GitHub
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] font-mono text-terminal-dimmer animate-pulse p-2">
                  Checking login status...
                </div>
              )}
            </div>
          )}

          {/* ─── EXPORT ─────────────────────────────────────────── */}
          <div id="export">
            <SectionHeader title="Export" color="text-terminal-green" />
            <div className="space-y-4">
              {/* ─── SVG + Markdown (for GitHub PRs/READMEs) ─── */}
              {isEditor && exportGithub && (
                <>
                  {/* GIF Preview Card (preferred — works universally on GitHub) */}
                  {ghExportResult?.gifContent && (
                    <div className="bg-terminal-surface rounded-2xl border border-terminal-border-subtle shadow-layer-sm overflow-hidden">
                      <div className="px-5 py-3 flex items-center justify-between border-b border-terminal-border-subtle">
                        <div>
                          <div className="text-sm font-mono font-semibold text-terminal-green">
                            Animated GIF
                          </div>
                          <p className="text-[10px] font-mono text-terminal-dim mt-0.5">
                            Works everywhere: GitHub PRs, issues, READMEs, Slack, Discord. Shows up
                            to 8 turns.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {ghExportResult.gifGeneratedAt && (
                            <span className="text-[10px] font-mono text-terminal-dimmer">
                              {relativeTime(ghExportResult.gifGeneratedAt)}
                            </span>
                          )}
                          <button
                            onClick={handleExportGithub}
                            disabled={ghExporting || githubExporting}
                            className="text-[11px] font-mono text-terminal-dim hover:text-terminal-green transition-colors px-1.5 py-0.5 rounded bg-terminal-bg hover:bg-terminal-surface-hover border border-terminal-border-subtle"
                            title="Regenerate all exports"
                          >
                            {ghExporting || githubExporting ? (
                              <span className="animate-pulse">...</span>
                            ) : (
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                                <path d="M21 3v5h-5" />
                                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                                <path d="M8 16H3v5" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>

                      {/* GIF preview (auto-animates as <img>) */}
                      <div className="bg-terminal-bg p-2 flex justify-center border-y border-terminal-border-subtle">
                        <img
                          src={`data:image/gif;base64,${ghExportResult.gifContent}`}
                          alt="Session preview GIF"
                          className="w-full h-auto block"
                        />
                      </div>

                      <div className="px-5 py-3 space-y-1.5 border-t border-terminal-border-subtle">
                        {ghExportResult.gifPath && (
                          <FilePath
                            label="File"
                            path={`${ghExportResult.gifPath}  (${formatBytes(ghExportResult.gifContent?.length ?? 0, true)})`}
                          />
                        )}
                        <p className="text-[10px] font-mono text-terminal-dimmer leading-relaxed pt-1">
                          Usage:{" "}
                          <span className="text-terminal-text">
                            {"![Session](./session-preview.gif)"}
                          </span>
                        </p>
                      </div>
                    </div>
                  )}

                  {/* SVG Preview Card */}
                  {ghExportResult?.svgContent && (
                    <div className="bg-terminal-surface rounded-2xl border border-terminal-border-subtle shadow-layer-sm overflow-hidden">
                      <div className="px-5 py-3 flex items-center justify-between border-b border-terminal-border-subtle">
                        <div>
                          <div className="text-sm font-mono font-semibold text-terminal-orange">
                            Animated SVG
                          </div>
                          <p className="text-[10px] font-mono text-terminal-dim mt-0.5">
                            Embed in READMEs, PRs, or anywhere that renders SVG. Shows up to{" "}
                            {MAX_EXPORT_TURNS} turns.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {ghExportResult.svgGeneratedAt && (
                            <span className="text-[10px] font-mono text-terminal-dimmer">
                              {relativeTime(ghExportResult.svgGeneratedAt)}
                            </span>
                          )}
                          <button
                            onClick={handleExportGithub}
                            disabled={ghExporting || githubExporting}
                            className="text-[11px] font-mono text-terminal-dim hover:text-terminal-orange transition-colors px-1.5 py-0.5 rounded bg-terminal-bg hover:bg-terminal-surface-hover border border-terminal-border-subtle"
                            title="Regenerate all exports"
                          >
                            {ghExporting || githubExporting ? (
                              <span className="animate-pulse">...</span>
                            ) : (
                              <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
                                <path d="M21 3v5h-5" />
                                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
                                <path d="M8 16H3v5" />
                              </svg>
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Inline SVG render (scaled to fit) */}
                      <div
                        className="bg-terminal-bg p-2 border-y border-terminal-border-subtle [&>svg]:w-full [&>svg]:h-auto [&>svg]:block"
                        dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
                      />

                      <div className="px-5 py-3 space-y-1.5 border-t border-terminal-border-subtle">
                        <FilePath
                          label="File"
                          path={`${ghExportResult.svgPath}  (${formatBytes(ghExportResult.svgContent?.length ?? 0)})`}
                        />
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
                        <div className="flex items-center gap-2">
                          <div>
                            <div className="text-sm font-mono font-semibold text-terminal-orange">
                              Markdown Summary
                            </div>
                            <p className="text-[10px] font-mono text-terminal-dim mt-0.5">
                              Paste into GitHub PRs, issues, or README files.
                            </p>
                          </div>
                          {ghExportResult.mdGeneratedAt && (
                            <span className="text-[10px] font-mono text-terminal-dimmer self-start mt-0.5">
                              {relativeTime(ghExportResult.mdGeneratedAt)}
                            </span>
                          )}
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
                          ? "Regenerate GIF + SVG + Markdown"
                          : "Generate GIF + SVG + Markdown"}
                    </button>
                    {ghError && (
                      <span className="text-[11px] font-mono text-terminal-red">{ghError}</span>
                    )}
                    {!ghExportResult && (
                      <span className="text-[11px] font-mono text-terminal-dim">
                        For GitHub PRs, READMEs, websites, email, Slack, and more. Shows up to 8
                        turns.
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
    </div>
  );
}
