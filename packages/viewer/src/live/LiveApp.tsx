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

/**
 * Backoff between connection attempts when the relay or the VM shipper is
 * briefly unreachable (the shipper reconnects in ~2s after a drop, so the
 * first retries usually succeed). After the last delay the error surfaces.
 */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

/** Failures that will never succeed on retry — surface immediately. */
const FATAL_CONNECT_ERRORS = new Set(["invalid-share-url"]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
      return "Request timed out — the shipper may be offline or this link may have expired.";
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
  const watchingRef = useRef(watching);
  watchingRef.current = watching;
  /** The share path (prop in tests, window.location in production). */
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  /** True while a disconnect-triggered re-establish is in flight. */
  const reconnectingRef = useRef(false);
  /**
   * Remote scene cursor: how many scenes the shipper has for the open
   * session. Stays ahead of `scenes.length` when a tail-gap skips scenes we
   * never rendered, so resume offsets never duplicate or omit ranges.
   */
  const remoteCountRef = useRef(0);
  /** Bumps on every new load so a superseded session fetch cannot commit. */
  const loadGenRef = useRef(0);
  /** Non-null while watch-live catch-up pages the backlog; tail events that
   * arrive in that window are buffered and replayed in order afterwards. */
  const catchupRef = useRef<TailEvent[] | null>(null);

  const applyTailEvent = useCallback((ev: TailEvent) => {
    if (ev.event === "tail-gap") {
      // Advance the remote cursor past the skipped range even though we never
      // rendered those scenes.
      remoteCountRef.current += ev.skipped;
      setGapNotice(
        `${ev.skipped} new scenes were too large to relay — reload the session to see them.`,
      );
      return;
    }
    remoteCountRef.current += ev.newScenes.length;
    setScenes((prev) => [...prev, ...ev.newScenes]);
  }, []);

  /**
   * Fetch the session list once. Throws on failure — callers decide whether
   * to retry (initial connect) or surface (user-initiated refresh).
   */
  const refreshList = useCallback(async (client: LiveRelay) => {
    setStatus("Loading sessions…");
    const list = await client.list();
    setSessions(list);
    setHits(null);
    setStatus(`E2E-encrypted · ${list.length} sessions`);
  }, []);

  /**
   * Connect to the relay and fetch the session list, retrying with backoff
   * through transient outages (shipper reconnect windows, relay hiccups).
   * Resolves with a validated client; throws only when cancelled or when the
   * attempts are exhausted (or the failure is known-fatal, e.g. a bad URL).
   */
  const connectAndList = useCallback(
    async (
      boxId: string,
      isCancelled: () => boolean,
    ): Promise<{ client: LiveRelay; sessions: RelaySessionSummary[] }> => {
      let lastError: unknown = new Error("unreachable");
      for (let attempt = 0; ; attempt++) {
        if (isCancelled()) throw new Error("cancelled");
        let client: LiveRelay | null = null;
        try {
          setStatus(attempt === 0 ? "Connecting…" : `Retrying… (attempt ${attempt + 1})`);
          client = await createClient(boxId);
          if (isCancelled()) {
            client.close();
            throw new Error("cancelled");
          }
          const sessions = await client.list();
          return { client, sessions };
        } catch (e) {
          try {
            client?.close();
          } catch {
            // ignore cleanup failures
          }
          lastError = e;
          const fatalNow = e instanceof Error && FATAL_CONNECT_ERRORS.has(e.message);
          if (fatalNow || attempt >= RETRY_DELAYS_MS.length || isCancelled()) break;
          await sleep(RETRY_DELAYS_MS[attempt]);
        }
      }
      throw lastError;
    },
    [createClient],
  );

  /**
   * Surface a user-action failure. An action that races a reconnect in
   * progress must not kill the page — the reconnect flow owns surfacing.
   */
  const handleActionError = useCallback((e: unknown) => {
    if (reconnectingRef.current) {
      setStatus("Reconnecting…");
      return;
    }
    setFatal(friendlyError(e));
  }, []);

  /**
   * Load (or reload) a session's scenes into the detail view. Extracted from
   * openSession so a reconnect can restore the open session the same way.
   * Throws on failure; superseded loads return silently via the generation.
   */
  const loadScenes = useCallback(async (client: LiveRelay, summary: RelaySessionSummary) => {
    const gen = ++loadGenRef.current;
    setView({ name: "detail", summary });
    setScenes([]);
    setGapNotice(null);
    setWatching(false);
    setLoadingScenes(true);
    remoteCountRef.current = 0;
    const loaded: Scene[] = [];
    let total = Infinity;
    let offset = 0;
    try {
      while (offset < total) {
        setStatus(`Loading scenes ${offset}/${total === Infinity ? "…" : total}…`);
        const res = await client.get(summary.sessionId, offset, SCENE_PAGE);
        if (loadGenRef.current !== gen) return; // superseded by a newer load
        total = res.totalScenes;
        if (!res.scenes.length) {
          total = loaded.length; // guard against stalls
          break;
        }
        loaded.push(...res.scenes);
        offset = loaded.length;
      }
      if (loadGenRef.current !== gen) return;
      setScenes(loaded);
      remoteCountRef.current = total;
      setStatus(`E2E-encrypted · ${total} scenes`);
    } catch (e) {
      if (loadGenRef.current !== gen) return;
      throw e;
    } finally {
      if (loadGenRef.current === gen) setLoadingScenes(false);
    }
  }, []);

  /**
   * Subscribe to live turns and backfill everything added since the session
   * was opened. Extracted from toggleWatch so a reconnect can resume
   * watch-live the same way. Throws on failure.
   */
  const startWatching = useCallback(
    async (client: LiveRelay, summary: RelaySessionSummary) => {
      setStatus("Watching live…");
      // Buffer tail events that arrive while we page the backlog, then replay
      // them in arrival order so scenes never land out of order.
      const buffered: TailEvent[] = [];
      catchupRef.current = buffered;
      try {
        const { totalScenes } = await client.tail(summary.sessionId);
        // Fixed starting offset: fetch everything added between page load and
        // subscribe. Page through: one `get` caps at SCENE_PAGE scenes.
        let cursor = remoteCountRef.current;
        while (cursor < totalScenes) {
          const res = await client.get(
            summary.sessionId,
            cursor,
            Math.min(SCENE_PAGE, totalScenes - cursor),
          );
          if (!res.scenes.length) break; // guard against stalls
          setScenes((prev) => [...prev, ...res.scenes]);
          cursor += res.scenes.length;
        }
        catchupRef.current = null;
        if (viewRef.current.name !== "detail") return; // user navigated away
        remoteCountRef.current = cursor;
        for (const ev of buffered) applyTailEvent(ev);
        setWatching(true);
        setStatus("E2E-encrypted · live — new turns appear below");
      } catch (e) {
        catchupRef.current = null;
        throw e;
      }
    },
    [applyTailEvent],
  );

  // Latest-ref indirection: attachClient and handleDisconnect reference each
  // other, so they call through refs instead of closing over one another.
  const handleDisconnectRef = useRef<() => Promise<void>>(async () => {});
  const attachClientRef = useRef<(client: LiveRelay) => void>(() => {});

  const attachClient = useCallback(
    (client: LiveRelay) => {
      clientRef.current = client;
      client.onTail((ev: TailEvent) => {
        const v = viewRef.current;
        if (v.name !== "detail" || ev.id !== v.summary.sessionId) return;
        // During watch-live catch-up, buffer events and replay them in
        // arrival order after pagination so scenes never land out of order.
        if (catchupRef.current) {
          catchupRef.current.push(ev);
          return;
        }
        applyTailEvent(ev);
      });
      client.onDisconnect((info) => {
        if (info.code === 1000 && info.reason === "replaced") {
          // The same link was opened in another tab/device and the relay
          // displaced this viewer. Reconnecting would just evict the other
          // side back and forth forever — go terminal instead.
          setFatal("This link was opened in another tab or device — this view is now inactive.");
          return;
        }
        void handleDisconnectRef.current();
      });
    },
    [applyTailEvent],
  );
  attachClientRef.current = attachClient;

  /**
   * The socket dropped mid-session (not via close()). Re-establish with the
   * same retry loop as the initial connect, then restore whatever the user
   * was looking at — list, open session, or watch-live. Only surfaces a
   * fatal error when re-establishing itself is impossible.
   */
  const handleDisconnect = useCallback(async () => {
    if (reconnectingRef.current) return;
    reconnectingRef.current = true;
    // Park user actions: the old client is dead, the new one isn't ready.
    clientRef.current = null;
    loadGenRef.current++; // invalidate any in-flight scene load
    const summary = viewRef.current.name === "detail" ? viewRef.current.summary : null;
    const wasWatching = watchingRef.current;
    const boxId = boxIdFromPath(pathnameRef.current ?? window.location.pathname);
    try {
      setWatching(false);
      setLoadingScenes(false);
      if (!boxId) throw new Error("invalid-share-url");
      const { client, sessions } = await connectAndList(boxId, () => false);
      attachClientRef.current(client);
      setSessions(sessions);
      setHits(null);
      if (summary) {
        const v = viewRef.current;
        if (v.name === "detail" && v.summary.sessionId === summary.sessionId) {
          await loadScenes(client, summary);
          if (wasWatching && viewRef.current.name === "detail") {
            await startWatching(client, summary);
          }
        } else {
          // The user navigated away during the outage (e.g. back to the
          // list) — don't drag them back into the old session.
          setStatus(`E2E-encrypted · ${sessions.length} sessions`);
        }
      } else {
        setStatus(`E2E-encrypted · ${sessions.length} sessions`);
      }
    } catch (e) {
      setFatal(friendlyError(e));
    } finally {
      reconnectingRef.current = false;
    }
  }, [connectAndList, loadScenes, startWatching]);
  handleDisconnectRef.current = handleDisconnect;

  useEffect(() => {
    const boxId = boxIdFromPath(pathnameRef.current ?? window.location.pathname);
    if (!boxId) {
      setFatal("Invalid share URL: unrecognized /live/<id> path.");
      return;
    }
    let cancelled = false;
    let client: LiveRelay | null = null;
    (async () => {
      try {
        const established = await connectAndList(boxId, () => cancelled);
        if (cancelled) {
          established.client.close();
          return;
        }
        client = established.client;
        attachClientRef.current(client);
        setSessions(established.sessions);
        setHits(null);
        setStatus(`E2E-encrypted · ${established.sessions.length} sessions`);
      } catch (e) {
        if (!cancelled) setFatal(friendlyError(e));
      }
    })();
    return () => {
      cancelled = true;
      client?.close();
      clientRef.current = null;
    };
  }, [connectAndList]);

  const openSession = useCallback(
    async (summary: RelaySessionSummary) => {
      const client = clientRef.current;
      if (!client) return;
      try {
        await loadScenes(client, summary);
      } catch (e) {
        handleActionError(e);
      }
    },
    [loadScenes, handleActionError],
  );

  const backToList = useCallback(() => {
    const client = clientRef.current;
    const v = viewRef.current;
    loadGenRef.current++; // invalidate any in-flight session load
    if (client && v.name === "detail") void client.untail(v.summary.sessionId);
    setWatching(false);
    setGapNotice(null);
    setView({ name: "list" });
    if (client) void refreshList(client).catch(handleActionError);
  }, [refreshList, handleActionError]);

  const doSearch = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    const q = query.trim();
    if (!q) {
      setHits(null);
      try {
        await refreshList(client);
      } catch (e) {
        handleActionError(e);
      }
      return;
    }
    setStatus("Searching…");
    try {
      const results = await client.search(q, 10);
      setHits(results);
      setStatus(`E2E-encrypted · ${results.length} hits`);
    } catch (e) {
      handleActionError(e);
    }
  }, [query, refreshList, handleActionError]);

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
    try {
      await startWatching(client, v.summary);
    } catch (e) {
      handleActionError(e);
    }
  }, [watching, startWatching, handleActionError]);

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
