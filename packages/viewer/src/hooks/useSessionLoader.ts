import { useCallback, useEffect, useState } from "react";
import type { ReplaySession } from "../types";

export type ViewerMode = "embedded" | "editor" | "readonly";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; session: ReplaySession; mode: ViewerMode; gistOwner?: string }
  | { status: "dashboard" }
  | { status: "error"; message: string };

interface LoadResult {
  session: ReplaySession;
  mode: ViewerMode;
  gistOwner?: string;
}

/**
 * Load session data from one of:
 * 1. window.__VIBE_REPLAY_DATA__ (embedded by CLI)
 * 2. Editor mode — with ?view=dashboard shows dashboard, with ?session=slug loads another session
 * 3. ?url=<jsonl-or-json-url> (fetch from URL, e.g., raw gist)
 * 4. ?file=<local-path> (dev mode, fetch from Vite public/)
 */
export function useSessionLoader(): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  const load = useCallback(() => {
    setState({ status: "loading" });
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
  }, []);

  useEffect(() => {
    load();
    const onPopState = () => load();
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [load]);

  return state;
}

function isEditorMode(): boolean {
  return !!window.__VIBE_REPLAY_EDITOR__;
}

async function loadSession(): Promise<LoadResult | "dashboard"> {
  // 1. Embedded data (from CLI generator)
  if (window.__VIBE_REPLAY_DATA__) {
    return { session: window.__VIBE_REPLAY_DATA__, mode: "embedded" };
  }

  const params = new URLSearchParams(window.location.search);

  // 2. Cloud replay parameter — always check first (works in any mode)
  const cloudId = params.get("cloud");
  if (cloudId) {
    if (!/^[a-zA-Z0-9_-]{10,16}$/.test(cloudId)) {
      throw new Error("Invalid cloud replay ID");
    }
    const cloudApiUrl = import.meta.env.VITE_CLOUD_API_URL || "";
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
    return { session: data as ReplaySession, mode: "readonly" };
  }

  // 3. Gist parameter — always check (works in any mode)
  const gistId = params.get("gist");
  if (gistId) {
    if (!/^[a-f0-9]{20,40}$/.test(gistId)) {
      throw new Error("Invalid gist ID");
    }
    const { rawUrl, owner } = await resolveGistUrl(gistId);
    const session = await fetchJson(rawUrl);
    registerReplay(gistId).catch(() => {});
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
      const session = (await resp.json()) as ReplaySession;
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

  // 5. Local file parameter — for dev mode
  const file = params.get("file");
  if (file) {
    const resp = await fetch(file);
    if (!resp.ok) throw new Error(`Failed to load file: ${resp.status}`);
    return { session: (await resp.json()) as ReplaySession, mode: "embedded" };
  }

  // No data source — show dashboard/landing page
  return "dashboard";
}

async function fetchJson(url: string): Promise<ReplaySession> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch: ${resp.status} ${resp.statusText}`);
  const text = await resp.text();
  if (text.trimStart().startsWith("{")) {
    return JSON.parse(text) as ReplaySession;
  }
  throw new Error("URL must point to a vibe-replay JSON replay file");
}

/** Register view with vibe-replay.com. Worker fetches metadata from gist directly. */
async function registerReplay(gistId: string): Promise<void> {
  await fetch("https://vibe-replay.com/api/replays", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gist_id: gistId }),
  });
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
