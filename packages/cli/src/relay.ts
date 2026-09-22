/**
 * `vibe-replay relay` — expose local sessions through the Cloudflare relay.
 *
 * The VM runs this process. It dials out (wss) to the relay and holds the
 * connection open; no inbound ports are needed. It prints one E2E-encrypted
 * share URL of the form:
 *
 *   https://<relay>/live/<boxId>#<content-key>
 *
 * Anyone opening the URL can issue a small allowlist of *read-only* commands
 * (`list`, `get`, `search`, `tail`, `ping`). Every payload is AES-256-GCM
 * encrypted with the content key from the URL fragment — the relay only ever
 * sees opaque `{t:"frame", iv, data}` envelopes and forwards them verbatim.
 * Killing this process invalidates the URL immediately (ephemeral by design:
 * a new share always mints a fresh box id and key, and old URLs never come
 * back).
 */

import { statSync } from "node:fs";
import { getAllProviders, deduplicateSessionsByProvider } from "./providers/index.js";
import {
  createRelayTransport,
  DEFAULT_RELAY_ORIGIN,
  RELAY_MAX_FRAME_BYTES,
  type RelayTransportHandle,
} from "./relay-transport.js";
import { transformToReplay } from "./transform.js";
import { CLI_VERSION } from "./version.js";
import type { SessionInfo } from "@vibe-replay/provider-contract";
import type { RelaySessionSummary } from "@vibe-replay/types";

export { DEFAULT_RELAY_ORIGIN };

/** Allowlisted read-only commands. Anything else is rejected. */
const ALLOWED_COMMANDS = new Set(["list", "get", "search", "tail", "untail", "ping"]);

const SEARCH_SESSION_CAP = 40;
const SEARCH_SNIPPET_CHARS = 160;
const TAIL_POLL_MS = 2000;
/** Max sessions with an active live-tail poll loop (shared by all viewers). */
const MAX_TAILS = 8;
/** Re-resolve a tailed session's files this often — /resume continuations
 *  land in a new file, and discovery is the only way to learn about it. */
const TAIL_REDISCOVER_EVERY = 15;

function summarize(info: SessionInfo): RelaySessionSummary {
  return {
    provider: info.provider,
    sessionId: info.sessionId,
    title: info.title,
    project: info.project,
    timestamp: info.timestamp,
    slug: info.slug,
    lineCount: info.lineCount,
    fileSize: info.fileSize,
    promptCount: info.promptCount,
    toolCallCount: info.toolCallCount,
    model: info.model,
    gitRepo: info.gitRepo,
    gitBranch: info.gitBranch,
    hasSqlite: info.hasSqlite,
    hasSdk: info.hasSdk,
    // Storage data source for the badge label. The scan's dataSource never
    // crosses the relay, so infer it from the same discovery facts the
    // dashboard scanner uses (see scanner.ts): SDK sessions pair with JSONL
    // transcripts, Cursor global-state markers are "global-state",
    // SQLite-backed sessions are "sqlite", Cursor agent-tools sidecars are
    // "jsonl+tools", everything else is JSONL.
    dataSource: info.hasSdk
      ? "jsonl"
      : (info.filePath ?? "").includes("#composerData:")
        ? "global-state"
        : info.hasSqlite
          ? "sqlite"
          : (info.toolPaths?.length ?? 0) > 0
            ? "jsonl+tools"
            : "jsonl",
    compactionCount: info.compactionCount,
    durationMsEst: info.durationMsEst,
    editCountEst: info.editCountEst,
    // Prompt previews for the live card; the relay never ships full transcripts.
    // Each preview is truncated: one huge pasted prompt must not push the
    // `list` response near the relay's 32 MiB frame ceiling.
    firstPrompts: info.prompts
      ?.slice(0, 2)
      .map((p) => (p.length > 300 ? `${p.slice(0, 300)}…` : p)),
  };
}

async function listSessions(): Promise<RelaySessionSummary[]> {
  const all: SessionInfo[] = [];
  for (const provider of getAllProviders()) {
    try {
      for (const s of await provider.discover()) all.push(s);
    } catch {
      // best-effort across providers
    }
  }
  // Same cross-provider dedup contract as the dashboard: one card per session.
  const out = deduplicateSessionsByProvider(all).map(summarize);
  out.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return out;
}

async function findSessionInfo(sessionId: string): Promise<SessionInfo | null> {
  for (const provider of getAllProviders()) {
    try {
      for (const s of await provider.discover()) {
        if (s.sessionId === sessionId || s.sessionIds?.includes(sessionId)) return s;
      }
    } catch {
      // best-effort
    }
  }
  return null;
}

async function loadReplay(sessionId: string, offset: number, limit: number) {
  const info = await findSessionInfo(sessionId);
  if (!info) throw new Error(`session not found: ${sessionId}`);
  const provider = getAllProviders().find((p) => p.name === info.provider);
  if (!provider) throw new Error(`provider not available: ${info.provider}`);
  const parsed = await provider.parse(info.filePaths, info);
  const replay = transformToReplay(parsed, info.provider, info.project, {
    generator: { name: "vibe-replay", version: CLI_VERSION, generatedAt: new Date().toISOString() },
    gitRepo: info.gitRepo,
    location: info.location,
  });
  const totalScenes = replay.scenes.length;
  const scenes = replay.scenes.slice(offset, offset + limit);
  return {
    meta: { ...replay.meta, stats: { ...replay.meta.stats, sceneCount: totalScenes } },
    scenes,
    offset,
    totalScenes,
  };
}

function sceneText(scenes: Array<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const s of scenes) {
    if (typeof s.content === "string") parts.push(s.content);
    if (typeof s.result === "string") parts.push(s.result);
    if (typeof s.prompt === "string") parts.push(s.prompt);
    if (typeof s.toolName === "string") parts.push(s.toolName);
  }
  return parts.join("\n");
}

async function searchSessions(query: string, limit: number) {
  const needle = query.toLowerCase();
  const hits: Array<{ sessionId: string; title?: string; provider: string; snippet: string }> = [];
  for (const s of (await listSessions()).slice(0, SEARCH_SESSION_CAP)) {
    try {
      const replay = await loadReplay(s.sessionId, 0, Number.MAX_SAFE_INTEGER);
      const text = sceneText(replay.scenes);
      const idx = text.toLowerCase().indexOf(needle);
      if (idx >= 0) {
        const start = Math.max(0, idx - 80);
        hits.push({
          sessionId: s.sessionId,
          title: s.title,
          provider: s.provider,
          snippet: text.slice(start, start + SEARCH_SNIPPET_CHARS),
        });
        if (hits.length >= limit) break;
      }
    } catch {
      // skip unreadable sessions
    }
  }
  return hits;
}

interface TailState {
  timer: NodeJS.Timeout;
  sceneCount: number;
  /** All files currently backing the session (multi-file: /resume). */
  filePaths: string[];
  mtimes: Map<string, number>;
  polls: number;
  polling: boolean;
  /** A batch failed to send (socket down): re-parse and retry next poll. */
  dirty: boolean;
  /** Relay-assigned ids of the viewers subscribed to this session. One poll
   *  loop serves every subscriber; new scenes fan out to each of them. */
  viewers: Set<string>;
}

export interface RelayOptions {
  relayOrigin?: string;
  /** CLI entrypoints install SIGINT/SIGTERM handlers; tests/embedders may opt out. */
  installSignalHandlers?: boolean;
}

export async function startRelay(options: RelayOptions = {}): Promise<void> {
  const tails = new Map<string, TailState>();
  /**
   * Viewer presence as the relay reports it. A current relay sends an
   * absolute `viewers` count on every hello-ok / viewer-joined /
   * viewer-left, and the CLI displays that authoritative count directly —
   * it never does its own base+delta arithmetic, so a stale viewer reaped
   * after a shipper reconnect can never make the displayed count drift.
   * Older relays omit the count and only ever send viewer-left: such a
   * leave is still reported (and still clears tail state), but without a
   * count, so the console never presents a fabricated "0 watching".
   * `viewerVias` only dedupes join prints. Viewer display names travel as
   * AES-GCM ciphertext; this multi-session relay intentionally does not
   * decrypt or display them, so its operator UI remains count-only.
   */
  const viewerVias = new Set<string>();
  let viewerCount = 0;
  /**
   * Whether the relay has ever sent an authoritative absolute count (on
   * hello-ok or any presence notice). A legacy relay omits `viewers` and
   * only ever sends viewer-left — in that case we have no honest count to
   * display, so the leave notice is printed without one rather than
   * presenting a fabricated "0 watching".
   */
  let hasAuthoritativeCount = false;
  const pluralViewers = (n: number): string => `${n} viewer${n === 1 ? "" : "s"}`;
  let transport: RelayTransportHandle | null = null;
  const sendFrame = (payload: unknown, via?: string): Promise<boolean> =>
    transport ? transport.sendFrame(payload, via) : Promise.resolve(false);

  /** Unsubscribe one viewer (or everyone when `via` is omitted, e.g. shutdown). */
  const stopTail = (sessionId: string, via?: string): void => {
    const tail = tails.get(sessionId);
    if (!tail) return;
    if (via) tail.viewers.delete(via);
    if (!via || tail.viewers.size === 0) {
      clearInterval(tail.timer);
      tails.delete(sessionId);
    }
  };

  const statAll = (paths: string[]): Map<string, number> => {
    const mtimes = new Map<string, number>();
    for (const p of paths) {
      try {
        mtimes.set(p, statSync(p).mtimeMs);
      } catch {
        // file may vanish mid-tail; treat as unchanged
      }
    }
    return mtimes;
  };

  const startTail = async (sessionId: string, via?: string): Promise<number> => {
    const subscriber = via ?? "legacy";
    const existing = tails.get(sessionId);
    if (existing) {
      // Already polling this session: just add the viewer to the fan-out.
      existing.viewers.add(subscriber);
      return existing.sceneCount;
    }
    const replay = await loadReplay(sessionId, 0, Number.MAX_SAFE_INTEGER);
    const info = await findSessionInfo(sessionId);
    const filePaths = info?.filePaths ?? [];
    const poll = async (): Promise<void> => {
      const tail = tails.get(sessionId);
      if (!tail || tail.polling) return; // no overlapping polls
      tail.polling = true;
      try {
        tail.polls += 1;
        // /resume continuations land in a NEW file: periodically re-resolve
        // the session so the tail follows it instead of going quiet.
        if (tail.polls % TAIL_REDISCOVER_EVERY === 0) {
          const fresh = await findSessionInfo(sessionId);
          if (fresh) {
            for (const p of fresh.filePaths) {
              if (!tail.filePaths.includes(p)) tail.filePaths.push(p);
            }
          }
        }
        let changed = false;
        const mtimes = statAll(tail.filePaths);
        for (const [p, m] of mtimes) {
          if (tail.mtimes.get(p) !== m) {
            changed = true;
            tail.mtimes.set(p, m);
          }
        }
        // DB-backed providers (OpenCode, Hermes) expose synthetic `#session:`
        // markers instead of stat-able files: with no mtimes to compare, never
        // skip the re-parse or the tail would go permanently quiet.
        if (!changed && !tail.dirty && mtimes.size > 0) return; // skip the re-parse
        const current = await loadReplay(sessionId, 0, Number.MAX_SAFE_INTEGER);
        if (current.scenes.length > tail.sceneCount) {
          const newScenes = current.scenes.slice(tail.sceneCount);
          const payload = {
            event: "tail",
            id: sessionId,
            newScenes,
            totalScenes: current.scenes.length,
          };
          const fanOut = (p: unknown) =>
            Promise.all([...tail.viewers].map((v) => sendFrame(p, v === "legacy" ? undefined : v)));
          const results = await fanOut(payload);
          if (results.every(Boolean)) {
            tail.sceneCount = current.scenes.length;
            tail.dirty = false;
          } else if (Buffer.byteLength(JSON.stringify(payload), "utf8") > RELAY_MAX_FRAME_BYTES) {
            // Oversized batches can never be delivered; skip with a visible
            // gap marker instead of retrying forever.
            tail.sceneCount = current.scenes.length;
            tail.dirty = false;
            await fanOut({
              event: "tail-gap",
              id: sessionId,
              skipped: newScenes.length,
              totalScenes: current.scenes.length,
            });
          } else {
            // Socket down mid-poll: retry the same delta next poll instead
            // of advancing past it.
            tail.dirty = true;
          }
        } else if (current.scenes.length < tail.sceneCount) {
          tail.sceneCount = current.scenes.length; // session rewritten; resync
        }
      } catch {
        // session unreadable mid-tail; keep polling
      } finally {
        tail.polling = false;
      }
    };
    const timer = setInterval(() => void poll(), TAIL_POLL_MS);
    tails.set(sessionId, {
      timer,
      sceneCount: replay.scenes.length,
      filePaths,
      mtimes: statAll(filePaths),
      polls: 0,
      polling: false,
      dirty: false,
      viewers: new Set([subscriber]),
    });
    return replay.scenes.length;
  };

  const handleCommand = async (
    msg: Record<string, unknown>,
    via?: string,
  ): Promise<Record<string, unknown>> => {
    const { seq, cmd } = msg;
    if (typeof cmd !== "string" || !ALLOWED_COMMANDS.has(cmd)) {
      return { seq, ok: false, error: `unknown command: ${String(cmd)}` };
    }
    try {
      switch (cmd) {
        case "list":
          return { seq, ok: true, data: { sessions: await listSessions() } };
        case "get": {
          const id = msg.id;
          if (typeof id !== "string") return { seq, ok: false, error: "missing id" };
          const offset = Math.max(0, Number(msg.offset) || 0);
          const limit = Math.min(5000, Math.max(1, Number(msg.limit) || 5000));
          return { seq, ok: true, data: await loadReplay(id, offset, limit) };
        }
        case "search": {
          const q = msg.q;
          if (typeof q !== "string" || q.length === 0 || q.length > 200) {
            return { seq, ok: false, error: "missing q" };
          }
          const limit = Math.min(25, Math.max(1, Number(msg.limit) || 10));
          return { seq, ok: true, data: { hits: await searchSessions(q, limit) } };
        }
        case "tail": {
          const id = msg.id;
          if (typeof id !== "string") return { seq, ok: false, error: "missing id" };
          if (!tails.has(id) && tails.size >= MAX_TAILS) {
            return { seq, ok: false, error: "too many live tails" };
          }
          const totalScenes = await startTail(id, via);
          return { seq, ok: true, data: { subscribed: true, totalScenes } };
        }
        case "untail": {
          const id = msg.id;
          if (typeof id !== "string") return { seq, ok: false, error: "missing id" };
          stopTail(id, via);
          return { seq, ok: true, data: { subscribed: false } };
        }
        case "ping":
          return { seq, ok: true, data: { t: Date.now() } };
        default:
          return { seq, ok: false, error: `unknown command: ${cmd}` };
      }
    } catch (err) {
      return { seq, ok: false, error: err instanceof Error ? err.message : "command failed" };
    }
  };

  const handleControl = (message: Record<string, unknown>): void => {
    if (message.t === "hello-ok") {
      if (typeof message.viewers === "number" && Number.isFinite(message.viewers)) {
        viewerVias.clear();
        viewerCount = Math.max(0, Math.floor(message.viewers));
        hasAuthoritativeCount = true;
        if (viewerCount > 0) {
          console.log(`  → ${pluralViewers(viewerCount)} already watching`);
        }
      } else {
        viewerVias.clear();
        viewerCount = 0;
        hasAuthoritativeCount = false;
      }
      return;
    }

    if (message.t === "viewer-joined" && typeof message.via === "string") {
      const via = message.via;
      if (typeof message.viewers === "number" && Number.isFinite(message.viewers)) {
        viewerCount = Math.max(0, Math.floor(message.viewers));
        hasAuthoritativeCount = true;
      } else if (!viewerVias.has(via)) {
        viewerCount += 1;
      }
      if (!viewerVias.has(via)) {
        viewerVias.add(via);
        console.log(`  → viewer connected (${viewerCount} watching)`);
      }
      return;
    }

    if (message.t === "viewer-left" && typeof message.via === "string") {
      const via = message.via;
      for (const id of tails.keys()) stopTail(id, via);
      const tracked = viewerVias.delete(via);
      if (typeof message.viewers === "number" && Number.isFinite(message.viewers)) {
        viewerCount = Math.max(0, Math.floor(message.viewers));
        hasAuthoritativeCount = true;
        console.log(`  → viewer left (${viewerCount} watching)`);
      } else if (tracked) {
        viewerCount = Math.max(0, viewerCount - 1);
        console.log(`  → viewer left (${viewerCount} watching)`);
      } else if (hasAuthoritativeCount) {
        console.log(`  → viewer left (${viewerCount} watching)`);
      } else {
        console.log("  → viewer left");
      }
    }
  };

  const stopTails = (): void => {
    for (const id of tails.keys()) stopTail(id);
  };

  const exitForDeadBox = (reason: string): void => {
    stopTails();
    if (reason.startsWith("relay unreachable for ")) {
      const seconds = reason.slice("relay unreachable for ".length);
      console.log(`\n  ✕ Relay unreachable for ${seconds} — this box id is dead.`);
    } else {
      console.log("\n  ✕ The relay ended this session. This URL is dead.");
    }
    console.log("  Exiting — restart `vibe-relay relay` to mint a new URL.\n");
    process.exit(0);
  };

  console.log(`\n  ${"vibe-replay relay"} — E2E-encrypted live session sharing\n`);
  console.log("  Connecting to relay…");
  transport = await createRelayTransport({
    relayOrigin: options.relayOrigin ?? DEFAULT_RELAY_ORIGIN,
    handleCommand,
    onControl: handleControl,
    onPermanentEnd: exitForDeadBox,
    onConnectionChange: (state, detail) => {
      if (state === "connected") {
        console.log("  ✓ Connected to relay. Waiting for viewer…\n");
      } else if (state === "retrying") {
        console.log(`  ↻ Relay connection lost — retrying in ${Number(detail) / 1000}s…`);
      }
    },
    // The relay CLI historically keeps trying until its first successful
    // connection. Only Quick Share uses a bounded startup timeout.
    startupTimeoutMs: null,
    goodbyeFlushMs: 300,
  });

  let shuttingDown = false;
  const shutdown = (message: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(message);
    stopTails();
    void transport?.stop().finally(() => process.exit(0));
  };
  if (options.installSignalHandlers !== false) {
    process.once("SIGINT", () => shutdown("\n  Relay stopped. The share URL is now dead.\n"));
    process.once("SIGTERM", () =>
      shutdown("\n  Relay stopping (SIGTERM). The share URL is now dead.\n"),
    );
  }

  // The URL is only real once the relay has acked our hello: until then no
  // viewer could reach this box anyway, and printing earlier would let a
  // fast opener race the shipper's first hello.
  try {
    await transport.ready;
  } catch {
    // Permanent-end handling above exits the relay process. Keep the wrapper
    // from surfacing a second unhandled readiness rejection while that exit
    // path is running (tests replace process.exit with a throwing stub).
    return;
  }
  console.log("  Share this URL (it contains the encryption key — treat it like a password):");
  console.log(`\n  ${transport.shareUrl}\n`);
  console.log("  The relay only forwards ciphertext; it can never read your sessions.");
  console.log("  Press Ctrl+C to stop — the URL dies immediately.\n");
  // Keep the process alive; the WS + timers hold the event loop.
  await new Promise(() => {});
}
