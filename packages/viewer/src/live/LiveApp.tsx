import { useCallback, useEffect, useRef, useState } from "react";
import ConversationView from "../components/ConversationView";
import type { EffectivePrefs } from "../hooks/useViewPrefs";
import type { Scene } from "../types";
import {
  boxIdFromPath,
  LiveClient,
  type LiveRelay,
  type RelaySearchHit,
  type RelaySessionSummary,
  type TailEvent,
} from "./protocol";

/** Full-fidelity transcript: same defaults as the local viewer's "all" mode. */
const FULL_PREFS: EffectivePrefs = {
  hideThinking: false,
  collapseAllTools: false,
  promptsOnly: false,
  compactAssistant: false,
};

const SCENE_PAGE = 5000;

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso || "";
  }
}

function friendlyError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  switch (m) {
    case "invalid-share-url":
      return "Invalid share URL: missing encryption key in #fragment.";
    case "connection-error":
    case "connection-timeout":
      return "Connection error — the shipper may be offline. Reload to retry.";
    case "disconnected":
      return "Disconnected — reload to retry.";
    case "timeout":
      return "Request timed out — the shipper may be busy. Reload to retry.";
    default:
      return `Error: ${m}`;
  }
}

type View = { name: "list" } | { name: "detail"; summary: RelaySessionSummary };

interface Props {
  /** Defaults to LiveClient.connect; tests inject a fake relay. */
  createClient?: (boxId: string) => Promise<LiveRelay>;
  /** Defaults to window.location.pathname; tests inject a path. */
  pathname?: string;
}

export default function LiveApp({ createClient = LiveClient.connect, pathname }: Props) {
  const [status, setStatus] = useState("Starting…");
  const [fatal, setFatal] = useState<string | null>(null);
  const [sessions, setSessions] = useState<RelaySessionSummary[] | null>(null);
  const [hits, setHits] = useState<RelaySearchHit[] | null>(null);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<View>({ name: "list" });
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [loadingScenes, setLoadingScenes] = useState(false);
  const [watching, setWatching] = useState(false);
  const [gapNotice, setGapNotice] = useState<string | null>(null);
  const clientRef = useRef<LiveRelay | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  const refreshList = useCallback(async (client: LiveRelay, retried = false) => {
    setStatus("Loading sessions…");
    try {
      const list = await client.list();
      setSessions(list);
      setHits(null);
      setStatus(`E2E-encrypted · ${list.length} sessions`);
    } catch (e) {
      // The VM socket may be mid-reconnect when the page opens and the relay
      // drops the first frame — retry once before surfacing the error.
      if (!retried) {
        setStatus("Retrying…");
        await new Promise((r) => setTimeout(r, 2000));
        return refreshList(client, true);
      }
      setFatal(friendlyError(e));
    }
  }, []);

  useEffect(() => {
    const boxId = boxIdFromPath(pathname ?? window.location.pathname);
    if (!boxId) {
      setFatal("Invalid share URL: unrecognized /live/<id> path.");
      return;
    }
    let cancelled = false;
    let client: LiveRelay | null = null;
    (async () => {
      try {
        setStatus("Connecting…");
        client = await createClient(boxId);
        if (cancelled) {
          client.close();
          return;
        }
        clientRef.current = client;
        client.onTail((ev: TailEvent) => {
          const v = viewRef.current;
          if (v.name !== "detail" || ev.id !== v.summary.sessionId) return;
          if (ev.event === "tail-gap") {
            setGapNotice(
              `${ev.skipped} new scenes were too large to relay — reload the session to see them.`,
            );
            return;
          }
          setScenes((prev) => [...prev, ...ev.newScenes]);
        });
        await refreshList(client);
      } catch (e) {
        if (!cancelled) setFatal(friendlyError(e));
      }
    })();
    return () => {
      cancelled = true;
      client?.close();
      clientRef.current = null;
    };
  }, [createClient, pathname, refreshList]);

  const openSession = useCallback(async (summary: RelaySessionSummary) => {
    const client = clientRef.current;
    if (!client) return;
    setView({ name: "detail", summary });
    setScenes([]);
    setGapNotice(null);
    setWatching(false);
    setLoadingScenes(true);
    const loaded: Scene[] = [];
    let total = Infinity;
    let offset = 0;
    try {
      while (offset < total) {
        setStatus(`Loading scenes ${offset}/${total === Infinity ? "…" : total}…`);
        const res = await client.get(summary.sessionId, offset, SCENE_PAGE);
        total = res.totalScenes;
        if (!res.scenes.length) {
          total = loaded.length; // guard against stalls
          break;
        }
        loaded.push(...res.scenes);
        offset = loaded.length;
      }
      setScenes(loaded);
      setStatus(`E2E-encrypted · ${total} scenes`);
    } catch (e) {
      setFatal(friendlyError(e));
    } finally {
      setLoadingScenes(false);
    }
  }, []);

  const backToList = useCallback(() => {
    const client = clientRef.current;
    const v = viewRef.current;
    if (client && v.name === "detail") void client.untail(v.summary.sessionId);
    setWatching(false);
    setGapNotice(null);
    setView({ name: "list" });
    if (client) void refreshList(client);
  }, [refreshList]);

  const doSearch = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const q = query.trim();
    if (!q) {
      setHits(null);
      await refreshList(client);
      return;
    }
    setStatus("Searching…");
    try {
      const results = await client.search(q, 10);
      setHits(results);
      setStatus(`E2E-encrypted · ${results.length} hits`);
    } catch (e) {
      setFatal(friendlyError(e));
    }
  }, [query, refreshList]);

  const toggleWatch = useCallback(async () => {
    const client = clientRef.current;
    const v = viewRef.current;
    if (!client || v.name !== "detail") return;
    if (watching) {
      await client.untail(v.summary.sessionId);
      setWatching(false);
      setStatus("E2E-encrypted");
      return;
    }
    setStatus("Watching live…");
    try {
      const { totalScenes } = await client.tail(v.summary.sessionId);
      // Fetch anything added between page load and subscribe so no scenes
      // fall in the gap, then flip to live.
      const missing = totalScenes - scenes.length;
      if (missing > 0) {
        const res = await client.get(
          v.summary.sessionId,
          scenes.length,
          Math.min(SCENE_PAGE, missing),
        );
        if (res.scenes.length) setScenes((prev) => [...prev, ...res.scenes]);
      }
      setWatching(true);
      setStatus("E2E-encrypted · live — new turns appear below");
    } catch (e) {
      setFatal(friendlyError(e));
    }
  }, [watching, scenes.length]);

  const openHit = useCallback(
    (hit: RelaySearchHit) => {
      const summary =
        sessions?.find((s) => s.sessionId === hit.sessionId) ??
        ({
          sessionId: hit.sessionId,
          title: hit.title,
          provider: hit.provider,
          project: "",
          timestamp: "",
        } satisfies RelaySessionSummary);
      void openSession(summary);
    },
    [sessions, openSession],
  );

  if (fatal) {
    return (
      <div className="min-h-screen bg-terminal-bg px-4 py-6 font-sans text-terminal-text">
        <div className="mx-auto max-w-3xl">
          <Header query={query} setQuery={setQuery} onSearch={doSearch} />
          <div className="mt-8 rounded-xl border border-terminal-red/40 bg-terminal-red-subtle px-5 py-4 text-sm">
            {fatal}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-terminal-bg font-sans text-terminal-text">
      <div className="mx-auto max-w-5xl px-4 py-5">
        <Header query={query} setQuery={setQuery} onSearch={doSearch} />
        <div className="mb-4 text-xs text-terminal-dim">{status}</div>

        {view.name === "list" && (
          <SessionList sessions={sessions} hits={hits} onOpen={openSession} onOpenHit={openHit} />
        )}

        {view.name === "detail" && (
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={backToList}
                className="rounded-lg bg-terminal-surface px-3 py-1.5 text-xs text-terminal-dim ring-1 ring-terminal-border-subtle transition-colors hover:bg-terminal-surface-hover hover:text-terminal-text"
              >
                ← All sessions
              </button>
              <button
                type="button"
                onClick={() => void toggleWatch()}
                disabled={loadingScenes}
                className="rounded-lg bg-terminal-surface px-3 py-1.5 text-xs text-terminal-dim ring-1 ring-terminal-border-subtle transition-colors hover:bg-terminal-surface-hover hover:text-terminal-text disabled:opacity-50"
              >
                {watching ? "Stop watching" : "Watch live"}
              </button>
            </div>
            <h2 className="text-lg font-semibold">
              {view.summary.title || `${view.summary.sessionId.slice(0, 12)}…`}
            </h2>
            <div className="mb-4 mt-1 text-xs text-terminal-dim">
              {view.summary.provider}
              {view.summary.timestamp ? ` · ${fmtTime(view.summary.timestamp)}` : ""}
              {view.summary.model ? ` · ${view.summary.model}` : ""}
            </div>
            {gapNotice && (
              <div className="mb-3 rounded-lg border border-terminal-orange/40 bg-terminal-orange-subtle px-4 py-2 text-xs text-terminal-text">
                {gapNotice}
              </div>
            )}
            {scenes.length > 0 && (
              <ConversationView
                scenes={scenes}
                visibleCount={scenes.length}
                currentIndex={scenes.length - 1}
                effectivePrefs={FULL_PREFS}
                isLive={watching}
              />
            )}
          </div>
        )}

        <div className="mt-10 text-[11px] text-terminal-dimmer">
          🔒 End-to-end encrypted — the key stays in this page&apos;s URL fragment; the relay only
          forwards ciphertext.
        </div>
      </div>
    </div>
  );
}

function Header({
  query,
  setQuery,
  onSearch,
}: {
  query: string;
  setQuery: (q: string) => void;
  onSearch: () => void;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold tracking-tight">
        vibe-replay <span className="text-terminal-green">live</span>
      </span>
      <span className="flex-1" />
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSearch();
        }}
        placeholder="Search sessions…"
        className="min-w-40 flex-1 rounded-lg bg-terminal-surface px-3 py-1.5 text-sm text-terminal-text ring-1 ring-terminal-border-subtle placeholder:text-terminal-dimmer focus:outline-none focus:ring-terminal-green/40 sm:max-w-xs sm:flex-none"
      />
      <button
        type="button"
        onClick={onSearch}
        className="rounded-lg bg-terminal-surface px-3 py-1.5 text-xs text-terminal-dim ring-1 ring-terminal-border-subtle transition-colors hover:bg-terminal-surface-hover hover:text-terminal-text"
      >
        Search
      </button>
    </div>
  );
}

function SessionList({
  sessions,
  hits,
  onOpen,
  onOpenHit,
}: {
  sessions: RelaySessionSummary[] | null;
  hits: RelaySearchHit[] | null;
  onOpen: (s: RelaySessionSummary) => void;
  onOpenHit: (h: RelaySearchHit) => void;
}) {
  if (hits) {
    if (!hits.length)
      return <div className="py-10 text-center text-sm text-terminal-dimmer">No matches.</div>;
    return (
      <div className="space-y-2">
        {hits.map((h) => (
          <button
            key={h.sessionId}
            type="button"
            onClick={() => onOpenHit(h)}
            className="block w-full rounded-xl border border-terminal-border-subtle bg-terminal-surface px-4 py-3 text-left transition-colors hover:border-terminal-border hover:bg-terminal-surface-hover"
          >
            <div className="text-sm font-medium">{h.title || `${h.sessionId.slice(0, 12)}…`}</div>
            <div className="mt-0.5 text-xs text-terminal-dim">{h.provider}</div>
            <div className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-terminal-dim">
              {h.snippet}
            </div>
          </button>
        ))}
      </div>
    );
  }
  if (!sessions) return null;
  if (!sessions.length)
    return (
      <div className="py-10 text-center text-sm text-terminal-dimmer">
        No sessions found on this machine.
      </div>
    );
  return (
    <div className="space-y-2">
      {sessions.map((s) => (
        <button
          key={s.sessionId}
          type="button"
          onClick={() => onOpen(s)}
          className="block w-full rounded-xl border border-terminal-border-subtle bg-terminal-surface px-4 py-3 text-left transition-colors hover:border-terminal-border hover:bg-terminal-surface-hover"
        >
          <div className="flex items-baseline justify-between gap-3">
            <div className="truncate text-sm font-medium">
              {s.title || `${s.sessionId.slice(0, 12)}…`}
            </div>
            {s.promptCount != null && (
              <div className="shrink-0 text-[11px] text-terminal-dimmer">
                {s.promptCount} prompts
              </div>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-terminal-dim">
            <span className="rounded-full bg-terminal-surface-2 px-2 py-0.5 ring-1 ring-terminal-border-subtle">
              {s.provider}
            </span>
            {s.project && <span className="truncate">{s.project}</span>}
            {s.timestamp && <span>· {fmtTime(s.timestamp)}</span>}
            {s.model && <span>· {s.model}</span>}
          </div>
        </button>
      ))}
    </div>
  );
}
