import { useState, useEffect } from "react";
import type { ReplaySession } from "../types";

export type ViewerMode = "embedded" | "editor" | "readonly";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; session: ReplaySession; mode: ViewerMode }
  | { status: "error"; message: string };

interface LoadResult {
  session: ReplaySession;
  mode: ViewerMode;
}

/**
 * Load session data from one of:
 * 1. window.__VIBE_REPLAY_DATA__ (embedded by CLI)
 * 2. Editor mode (served by local CLI server)
 * 3. ?url=<jsonl-or-json-url> (fetch from URL, e.g., raw gist)
 * 4. ?file=<local-path> (dev mode, fetch from Vite public/)
 */
export function useSessionLoader(): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    loadSession().then(
      (result) => setState({ status: "ready", session: result.session, mode: result.mode }),
      (err) => setState({ status: "error", message: String(err.message || err) }),
    );
  }, []);

  return state;
}

function isEditorMode(): boolean {
  return !!window.__VIBE_REPLAY_EDITOR__;
}

async function loadSession(): Promise<LoadResult> {
  // 1. Embedded data (from CLI generator)
  if (window.__VIBE_REPLAY_DATA__) {
    return { session: window.__VIBE_REPLAY_DATA__, mode: "embedded" };
  }

  // 2. Editor mode (served by CLI local server)
  if (isEditorMode()) {
    const resp = await fetch("/api/session");
    if (!resp.ok) throw new Error(`Editor API error: ${resp.status}`);
    const session = (await resp.json()) as ReplaySession;
    return { session, mode: "editor" };
  }

  const params = new URLSearchParams(window.location.search);

  // 3. Gist parameter — resolve gist ID to raw JSON URL via GitHub API
  const gistId = params.get("gist");
  if (gistId) {
    // Only allow hex gist IDs (GitHub gist IDs are 32 hex chars)
    if (!/^[a-f0-9]{20,40}$/.test(gistId)) {
      throw new Error("Invalid gist ID");
    }
    const rawUrl = await resolveGistUrl(gistId);
    const session = await fetchJson(rawUrl);
    // Register replay in gallery (fire-and-forget)
    registerReplay(gistId, session).catch(() => {});
    return { session, mode: "readonly" };
  }

  // 4. URL parameter — fetch JSON from a remote URL (read-only)
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

  throw new Error(
    "No session data found. Use embedded mode (CLI) or pass ?gist=<id> or ?url=<replay-json-url>",
  );
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

async function registerReplay(gistId: string, session: ReplaySession): Promise<void> {
  const { meta } = session;
  await fetch("https://vibe-replay.com/api/replays", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      gist_id: gistId,
      title: meta.title || meta.project || "Untitled",
      provider: meta.provider,
      model: meta.model,
      scene_count: meta.stats.sceneCount,
      user_prompts: meta.stats.userPrompts,
      duration_ms: meta.stats.durationMs,
    }),
  });
}

async function resolveGistUrl(gistId: string): Promise<string> {
  const resp = await fetch(`https://api.github.com/gists/${gistId}`);
  if (!resp.ok) throw new Error(`Gist not found: ${resp.status}`);
  const data = await resp.json();
  const files = data.files as Record<string, { raw_url: string; filename: string }>;
  // Find the first .json file
  const jsonFile = Object.values(files).find((f) => f.filename.endsWith(".json"));
  if (!jsonFile) throw new Error("No JSON file found in gist");
  return jsonFile.raw_url;
}
