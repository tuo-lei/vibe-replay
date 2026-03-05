import { useState, useEffect } from "react";
import type { ReplaySession } from "../types";

type LoadState =
  | { status: "loading" }
  | { status: "ready"; session: ReplaySession }
  | { status: "error"; message: string };

/**
 * Load session data from one of:
 * 1. window.__VIBE_REPLAY_DATA__ (embedded by CLI)
 * 2. ?url=<jsonl-or-json-url> (fetch from URL, e.g., raw gist)
 * 3. ?file=<local-path> (dev mode, fetch from Vite public/)
 */
export function useSessionLoader(): LoadState {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    loadSession().then(
      (session) => setState({ status: "ready", session }),
      (err) => setState({ status: "error", message: String(err.message || err) }),
    );
  }, []);

  return state;
}

async function loadSession(): Promise<ReplaySession> {
  // 1. Embedded data (from CLI generator)
  if (window.__VIBE_REPLAY_DATA__) {
    return window.__VIBE_REPLAY_DATA__;
  }

  const params = new URLSearchParams(window.location.search);

  // 2. Gist parameter — resolve gist ID to raw JSON URL via GitHub API
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
    return session;
  }

  // 3. URL parameter — fetch JSON from a remote URL
  const url = params.get("url");
  if (url) {
    return await fetchJson(url);
  }

  // 3. Local file parameter — for dev mode
  const file = params.get("file");
  if (file) {
    const resp = await fetch(file);
    if (!resp.ok) throw new Error(`Failed to load file: ${resp.status}`);
    return (await resp.json()) as ReplaySession;
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
