import { useCallback, useEffect, useRef, useState } from "react";
import type { ReplaySession } from "../types";
import { parseReplaySession } from "../utils/replaySchema";

export type ViewerMode = "embedded" | "editor" | "readonly";

type LoadState =
  | { status: "loading" }
  | {
      status: "ready";
      session: ReplaySession;
      mode: ViewerMode;
      gistOwner?: string;
      live?: LiveStatus;
    }
  | { status: "dashboard" }
  | { status: "error"; message: string };

export interface LiveStatus {
  /** Connection state of the SSE stream */
  state: "connecting" | "open" | "error" | "closed";
  /** Total scenes in the latest payload */
  scenes: number;
  /** Time of the last received session payload */
  lastUpdate?: number;
  /** Last reported error, if any */
  error?: string;
  /**
   * Live session state surfaced by the server from
   * `~/.claude/sessions/<pid>.json`. `unknown` for non-Claude providers
   * (Cursor / Codex / Cowork) — they don't write that file, so we keep
   * the existing always-live UI rather than misreporting "stopped".
   */
  sessionState?: "busy" | "idle" | "stopped" | "unknown";
  /** Cursor-specific row-level probe of the durable SQLite/global-state source. */
  cursorDiagnostics?: LiveCursorDiagnostics;
  /** True when the latest Cursor probe changed session rows; false when only a DB/WAL event fired. */
  cursorRowsChanged?: boolean;
  /** Time of the last Cursor diagnostics probe received by the viewer. */
  lastCursorProbe?: number;
}

export interface LiveCursorDiagnostics {
  // Keep in sync with CursorLiveDiagnostics in packages/cli/src/providers/cursor/sqlite-reader.ts.
  source: "global-state";
  signature: string;
  probedAt: string;
  dbPath: string;
  dbMtimeMs: number;
  walMtimeMs: number;
  walSize: number;
  composerBytes: number;
  headerCount: number;
  composerLastUpdatedAt?: string;
  latestBubbleId?: string;
  latestBubbleCreatedAt?: string;
  latestBubbleUpdatedAt?: string;
  latestBubbleType?: number;
  latestTextPreview?: string;
  latestToolName?: string;
  latestToolHasResult?: boolean;
  latestToolResultLength?: number;
  bubbleCount: number;
  toolCallCount: number;
  toolResultCount: number;
  pendingToolCount: number;
  maxBubbleBytes: number;
  totalBubbleBytes: number;
}

interface LoadResult {
  session: ReplaySession;
  mode: ViewerMode;
  gistOwner?: string;
  live?: LiveStatus;
}

/**
 * Load session data from one of:
 * 1. window.__VIBE_REPLAY_DATA__ (embedded by CLI)
 * 2. Editor mode — with ?view=dashboard shows dashboard, with ?session=slug loads another session,
 *    or ?live=1&provider=<>&sessionId=<> streams a running session via SSE
 * 3. ?url=<jsonl-or-json-url> (fetch from URL, e.g., raw gist)
 * 4. ?file=<local-path> (dev mode, fetch from Vite public/)
 */
export function useSessionLoader(): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const liveSourceRef = useRef<EventSource | null>(null);

  const closeLive = useCallback(() => {
    if (liveSourceRef.current) {
      liveSourceRef.current.close();
      liveSourceRef.current = null;
    }
  }, []);

  const load = useCallback(() => {
    closeLive();
    setState({ status: "loading" });

    // Live mode is special — it streams updates rather than resolving once.
    const liveParams = readLiveParams();
    if (liveParams && isEditorMode()) {
      startLiveStream(liveParams, liveSourceRef, setState);
      return;
    }

    loadSession().then(
      (result) => {
        if (result === "dashboard") {
          setState({ status: "dashboard" });
        } else {
          setState({
            status: "ready",
            session: result.session,
            mode: result.mode,
            gistOwner: result.gistOwner,
          });
        }
      },
      (err) => setState({ status: "error", message: String(err.message || err) }),
    );
  }, [closeLive]);

  useEffect(() => {
    load();
    const onPopState = () => load();
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      closeLive();
    };
  }, [load, closeLive]);

  return state;
}

function isEditorMode(): boolean {
  return !!window.__VIBE_REPLAY_EDITOR__;
}

interface LiveParams {
  provider: string;
  sessionId: string;
}

function readLiveParams(): LiveParams | null {
  const params = new URLSearchParams(window.location.search);
  if (params.get("live") !== "1") return null;
  // ?view=dashboard wins over ?live=1 — without this, navigating from the
  // live viewer back to the dashboard via the in-app link (which sets
  // view=dashboard but leaves the live params intact in popstate) would
  // re-open the SSE stream instead of showing the dashboard.
  if (params.get("view") === "dashboard") return null;
  // ?session=<slug> also wins over ?live=1. The reverse navigation from
  // live → a specific replay can leave stale `live=1` in the URL; an
  // explicit session request should always resolve to that replay rather
  // than re-opening the SSE stream.
  if (params.get("session")) return null;
  const provider = params.get("provider");
  const sessionId = params.get("sessionId");
  if (!provider || !sessionId) return null;
  // Tighten input — these go straight onto a server query string and into a
  // file-watcher path, so reject anything that doesn't look like a normal id.
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(provider)) return null;
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(sessionId)) return null;
  return { provider, sessionId };
}

function startLiveStream(
  params: LiveParams,
  ref: React.MutableRefObject<EventSource | null>,
  setState: (s: LoadState) => void,
): void {
  const url = `/api/live?provider=${encodeURIComponent(params.provider)}&sessionId=${encodeURIComponent(params.sessionId)}`;
  const source = new EventSource(url);
  ref.current = source;

  let lastSession: ReplaySession | null = null;
  let liveStatus: LiveStatus = { state: "connecting", scenes: 0 };

  // Guard against stale handlers from a closed-but-not-yet-cleaned-up
  // EventSource overwriting state owned by a fresher stream. closeLive()
  // calls .close() and clears ref.current, but events queued on the JS
  // event loop before the close may still fire afterwards. Without this
  // guard, those late events would call setState with stale `lastSession`
  // / `liveStatus` from this closed-over scope, clobbering the new view
  // (or surfacing an "error" toast that no longer applies).
  const emit = () => {
    if (ref.current !== source) return;
    if (lastSession) {
      setState({
        status: "ready",
        session: lastSession,
        mode: "editor",
        live: liveStatus,
      });
    } else if (liveStatus.state === "error" && liveStatus.error) {
      setState({ status: "error", message: liveStatus.error });
    }
  };

  source.onopen = () => {
    liveStatus = { ...liveStatus, state: "open", error: undefined };
    emit();
  };

  source.onmessage = (ev) => {
    let payload: {
      type?: string;
      session?: ReplaySession;
      message?: string;
      state?: LiveStatus["sessionState"];
      cursorDiagnostics?: LiveCursorDiagnostics;
      cursorRowsChanged?: boolean;
    };
    try {
      payload = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (payload.type === "session" && payload.session) {
      try {
        lastSession = parseReplaySession(payload.session);
      } catch (error) {
        liveStatus = {
          ...liveStatus,
          state: "error",
          error: error instanceof Error ? error.message : "Invalid live replay payload",
        };
        emit();
        return;
      }
      liveStatus = {
        state: "open",
        scenes: payload.session.scenes.length,
        lastUpdate: Date.now(),
        error: undefined,
        sessionState: payload.state ?? liveStatus.sessionState,
        cursorDiagnostics: payload.cursorDiagnostics ?? liveStatus.cursorDiagnostics,
        cursorRowsChanged: payload.cursorRowsChanged ?? liveStatus.cursorRowsChanged,
        lastCursorProbe: payload.cursorDiagnostics ? Date.now() : liveStatus.lastCursorProbe,
      };
      emit();
    } else if (payload.type === "diagnostics" && payload.cursorDiagnostics) {
      liveStatus = {
        ...liveStatus,
        state: "open",
        cursorDiagnostics: payload.cursorDiagnostics,
        cursorRowsChanged: payload.cursorRowsChanged,
        lastCursorProbe: Date.now(),
      };
      emit();
    } else if (payload.type === "state" && payload.state) {
      // Standalone state-only event: server detected busy↔idle or
      // idle→stopped without a JSONL change. Update sessionState in place
      // so the viewer can swap the bottom card without re-rendering scenes.
      liveStatus = { ...liveStatus, sessionState: payload.state };
      emit();
    } else if (payload.type === "error") {
      liveStatus = {
        ...liveStatus,
        state: "error",
        error: payload.message || "Live stream error",
      };
      emit();
    }
  };

  source.onerror = () => {
    // EventSource auto-reconnects; surface the disconnected state until then.
    liveStatus = { ...liveStatus, state: "error", error: liveStatus.error || "Disconnected" };
    emit();
  };
}

async function loadSession(): Promise<LoadResult | "dashboard"> {
  // 1. Embedded data (from CLI generator)
  if (window.__VIBE_REPLAY_DATA__) {
    return { session: parseReplaySession(window.__VIBE_REPLAY_DATA__), mode: "embedded" };
  }

  const params = new URLSearchParams(window.location.search);

  // 2. Cloud replay parameter — always check first (works in any mode)
  const cloudId = params.get("cloud");
  if (cloudId) {
    if (!/^[a-zA-Z0-9_-]{10,16}$/.test(cloudId)) {
      throw new Error("Invalid cloud replay ID");
    }
    const cloudApiUrl = __CLOUD_API_URL__;
    const resp = await fetch(`${cloudApiUrl}/api/cloud-replays/${cloudId}`, {
      credentials: "include",
    });
    if (!resp.ok) {
      if (resp.status === 404) throw new Error("Replay not found");
      if (resp.status === 410) throw new Error("This replay has expired");
      throw new Error(`Failed to load replay: ${resp.status}`);
    }
    const data = await resp.json();
    // Handle gist-backed cloud replays (redirect response)
    if ((data as any).redirect && (data as any).gistId) {
      const { rawUrl } = await resolveGistUrl((data as any).gistId);
      return { session: await fetchJson(rawUrl), mode: "readonly" };
    }
    return { session: parseReplaySession(data), mode: "readonly" };
  }

  // 3. Gist parameter — always check (works in any mode)
  const gistId = params.get("gist");
  if (gistId) {
    if (!/^[a-f0-9]{20,40}$/.test(gistId)) {
      throw new Error("Invalid gist ID");
    }
    const { rawUrl, owner } = await resolveGistUrl(gistId);
    const session = await fetchJson(rawUrl);
    // Track view count in cloud_replays (fire-and-forget)
    const api = __CLOUD_API_URL__;
    fetch(`${api}/api/cloud-replays/view-gist/${gistId}`, { method: "POST" }).catch(() => {});
    return { session, mode: "readonly", gistOwner: owner };
  }

  // 4. Editor mode (served by CLI local server)
  if (isEditorMode()) {
    // Dashboard view within editor
    if (params.get("view") === "dashboard") {
      return "dashboard";
    }

    // Load a specific session by slug (from dashboard navigation)
    const slug = params.get("session");
    if (slug) {
      const resp = await fetch(`/api/session?slug=${encodeURIComponent(slug)}`);
      if (!resp.ok) throw new Error(`Session not found: ${slug}`);
      const session = parseReplaySession(await resp.json());
      return { session, mode: "editor" };
    }

    // No slug specified — show dashboard
    return "dashboard";
  }

  // 5. URL parameter — fetch JSON from a remote URL (read-only)
  const url = params.get("url");
  if (url) {
    return { session: await fetchJson(url), mode: "readonly" };
  }

  // 6. Local file parameter — for dev mode
  const file = params.get("file");
  if (file) {
    const resp = await fetch(file);
    if (!resp.ok) throw new Error(`Failed to load file: ${resp.status}`);
    return { session: parseReplaySession(await resp.json()), mode: "embedded" };
  }

  // No data source — show dashboard/landing page
  return "dashboard";
}

async function fetchJson(url: string): Promise<ReplaySession> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch: ${resp.status} ${resp.statusText}`);
  const text = await resp.text();
  if (text.trimStart().startsWith("{")) {
    return parseReplaySession(JSON.parse(text));
  }
  throw new Error("URL must point to a vibe-replay JSON replay file");
}

async function resolveGistUrl(gistId: string): Promise<{ rawUrl: string; owner?: string }> {
  const resp = await fetch(`https://api.github.com/gists/${gistId}`);
  if (!resp.ok) throw new Error(`Gist not found: ${resp.status}`);
  const data = await resp.json();
  const files = data.files as Record<string, { raw_url: string; filename: string }>;
  const jsonFile = Object.values(files).find((f) => f.filename.endsWith(".json"));
  if (!jsonFile) throw new Error("No JSON file found in gist");
  const owner = (data.owner as { login?: string } | undefined)?.login;
  return { rawUrl: jsonFile.raw_url, owner };
}
