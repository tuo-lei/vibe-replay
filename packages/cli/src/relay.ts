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
 * Killing this process invalidates the URL immediately (ephemeral, like
 * termpair sessions and Excalidraw live rooms).
 */

import { statSync } from "node:fs";
import {
  decryptFrame,
  encryptFrame,
  exportKeyString,
  generateContentKey,
  randomBoxId,
  type EncryptedFrame,
} from "./relay-crypto.js";
import { getAllProviders, deduplicateSessionsByProvider } from "./providers/index.js";
import { transformToReplay } from "./transform.js";
import { CLI_VERSION } from "./version.js";
import type { SessionInfo } from "@vibe-replay/provider-contract";

export const DEFAULT_RELAY_ORIGIN = "https://vibe-replay.com";

/** Allowlisted read-only commands. Anything else is rejected. */
const ALLOWED_COMMANDS = new Set(["list", "get", "search", "tail", "untail", "ping"]);

const SEARCH_SESSION_CAP = 40;
const SEARCH_SNIPPET_CHARS = 160;
const TAIL_POLL_MS = 2000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** Plaintext bytes per chunk of a chunked command response. */
const CHUNK_PLAINTEXT_BYTES = 512 * 1024;
/** Hard cap: 64 chunks × 512 KiB = 32 MiB per command response. */
const MAX_CHUNKS = 64;
/** Max sessions with an active live-tail poll loop (shared by all viewers). */
const MAX_TAILS = 8;
/** Re-resolve a tailed session's files this often — /resume continuations
 *  land in a new file, and discovery is the only way to learn about it. */
const TAIL_REDISCOVER_EVERY = 15;

interface RelaySessionSummary {
  provider: string;
  sessionId: string;
  title?: string;
  project: string;
  timestamp: string;
  lineCount: number;
  fileSize: number;
  promptCount?: number;
  toolCallCount?: number;
  model?: string;
}

function summarize(info: SessionInfo): RelaySessionSummary {
  return {
    provider: info.provider,
    sessionId: info.sessionId,
    title: info.title,
    project: info.project,
    timestamp: info.timestamp,
    lineCount: info.lineCount,
    fileSize: info.fileSize,
    promptCount: info.promptCount,
    toolCallCount: info.toolCallCount,
    model: info.model,
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
}

export async function startRelay(options: RelayOptions = {}): Promise<void> {
  const origin = (options.relayOrigin ?? DEFAULT_RELAY_ORIGIN).replace(/\/$/, "");
  // The viewer page is the trust anchor for browser-side E2EE: the content key
  // lives in the URL fragment, so a cleartext non-loopback origin would let an
  // on-path attacker swap the viewer page and steal the key before AES-GCM
  // ever protects the relay frames.
  {
    const u = new URL(origin);
    const loopback =
      u.hostname === "localhost" ||
      u.hostname === "127.0.0.1" ||
      u.hostname === "[::1]" ||
      u.hostname === "::1";
    if (u.protocol === "http:" && !loopback) {
      throw new Error(
        `refusing cleartext relay origin ${origin}: use https (http://localhost is allowed for local testing)`,
      );
    }
  }
  const boxId = randomBoxId();
  const { key, raw } = await generateContentKey();
  const keyString = exportKeyString(raw);
  const wsUrl = `${origin.replace(/^http/, "ws")}/live/${boxId}`;
  const shareUrl = `${origin}/live/${boxId}#${keyString}`;

  const tails = new Map<string, TailState>();
  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectDelayMs = 2000;
  /**
   * Whether the shipper ever held a working relay connection. The relay
   * declares a shipperless box dead after 90 s, so an outage far past that
   * means this box id can never come back: retrying it forever is
   * pointless. Past the threshold the shipper exits so the
   * supervisor/watchdog mints a fresh URL. A shipper that never connected
   * keeps retrying — the relay may simply not be up yet.
   *
   * The outage clock starts when a live connection DROPS, not when it was
   * established: a transient blip (deploy restart, proxy hiccup) on a
   * long-lived connection must ride the normal reconnect/backoff path,
   * not exit immediately because the connection was old.
   */
  let everConnected = false;
  /** When the current outage began (0 = connected or never dropped). */
  let outageBeganAt = 0;
  const DEAD_BOX_RETRY_EXIT_MS = 150_000;

  /** Returns false when the socket is down or the frame is oversized — the
   *  caller decides whether to retry or send a smaller correlated error.
   *  `via` is the relay-visible routing tag: the relay attaches the
   *  requesting viewer's id to inbound frames, the shipper echoes it back,
   *  and the relay routes the reply to that viewer. Omitted for
   *  viewer-independent traffic (keepalive), which the relay broadcasts. */
  const sendFrame = async (payload: unknown, via?: string): Promise<boolean> => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const frame: EncryptedFrame = await encryptFrame(key, boxId, JSON.stringify(payload));
    const outer = JSON.stringify({ t: "frame", ...frame, ...(via ? { via } : {}) });
    // Measured in UTF-8 bytes like the relay does: outer.length counts
    // UTF-16 code units and would let multi-byte text slip a >4MiB frame
    // past this gate (the relay would then kill the socket with 1009).
    if (Buffer.byteLength(outer, "utf8") > MAX_FRAME_BYTES) return false;
    try {
      ws.send(outer);
    } catch {
      return false;
    }
    return true;
  };

  /**
   * Split a command response that doesn't fit one frame into individually
   * encrypted chunks. Each chunk carries `{seq, chunk, chunks, data}` inside
   * its encrypted payload (the relay strips any outer plaintext beyond
   * iv/data/via, so chunk metadata must live inside the ciphertext); the
   * viewer reassembles by seq. Chunks are measured in UTF-8 bytes and split
   * on code-point boundaries, so multi-byte text is never torn
   * mid-character. Keeps every frame far under MAX_FRAME_BYTES
   * no matter how large a session is.
   */
  const sendChunked = async (payload: Record<string, unknown>, via?: string): Promise<boolean> => {
    const json = JSON.stringify(payload);
    // Measured in UTF-8 bytes (not UTF-16 code units) and split on
    // code-point boundaries, so multi-byte text is never torn mid-character
    // and the documented size cap holds for non-ASCII transcripts too.
    const parts: string[] = [];
    let cur = "";
    let curBytes = 0;
    for (const ch of json) {
      // UTF-8 byte length of one code point via arithmetic (far cheaper
      // than Buffer.byteLength per character on multi-MB payloads).
      const cp = ch.codePointAt(0) as number;
      const b = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      if (curBytes + b > CHUNK_PLAINTEXT_BYTES && cur.length > 0) {
        parts.push(cur);
        cur = "";
        curBytes = 0;
      }
      cur += ch;
      curBytes += b;
    }
    if (cur.length > 0) parts.push(cur);
    if (parts.length === 0 || parts.length > MAX_CHUNKS) return false;
    for (let i = 0; i < parts.length; i++) {
      const ok = await sendFrame(
        { seq: payload.seq, chunk: i, chunks: parts.length, data: parts[i] },
        via,
      );
      if (!ok) return false;
    }
    return true;
  };

  /**
   * Deliver a command response: one frame when it fits, chunked when it
   * doesn't, and a small correlated error only when even chunking can't
   * deliver it — so the viewer never waits out the full timeout on a
   * dropped reply.
   */
  const sendResponse = async (payload: Record<string, unknown>, via?: string): Promise<void> => {
    if (await sendFrame(payload, via)) return;
    if (await sendChunked(payload, via)) return;
    await sendFrame({ seq: payload.seq, ok: false, error: "response too large to relay" }, via);
  };

  /**
   * Idle WebSocket connections get reaped by middleboxes (the egress proxy
   * kills ours after ~5 minutes of silence), which makes every viewer that
   * loads during the reconnect window hang until its command times out.
   * Send a tiny encrypted no-op frame on a timer to keep the path alive.
   * The relay drops it when no viewer is attached; a connected viewer
   * decrypts it and ignores the unknown payload. Never goes through cmd()
   * (no seq, no pending entry) — it is one-way traffic, not a request.
   */
  const KEEPALIVE_MS = 45_000;
  const keepaliveTimer = setInterval(() => {
    void sendFrame({ keepalive: true });
  }, KEEPALIVE_MS);
  // Don't hold the process open for the timer alone (Ctrl+C path aside).
  keepaliveTimer.unref?.();

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
          } else if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_FRAME_BYTES) {
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

  // Serialize command handling: concurrent parse/discovery work from
  // several viewers has no backpressure otherwise.
  let commandChain: Promise<void> = Promise.resolve();

  const onMessage = async (event: MessageEvent): Promise<void> => {
    let outer: Record<string, unknown>;
    try {
      outer = JSON.parse(typeof event.data === "string" ? event.data : "{}");
    } catch {
      return;
    }
    // Plaintext relay control: a viewer left. Drop its id from every tail
    // fan-out; tails with no subscribers left stop their poll loop.
    if (outer.t === "viewer-left" && typeof outer.via === "string") {
      for (const id of tails.keys()) stopTail(id, outer.via);
      return;
    }
    // The relay declared this box dead (we were swept as a ghost, or a
    // duplicate shipper took over). This URL will never work again —
    // exit so the supervisor/watchdog restarts with a fresh URL instead
    // of sitting on a dead box id.
    if (outer.t === "session-ended") {
      console.log("\n  ✕ The relay ended this session (box expired). This URL is dead.");
      console.log("  Exiting — restart `vibe-relay relay` to mint a new URL.\n");
      stopped = true;
      try {
        ws?.close(1000, "box ended");
      } catch {
        // ignore
      }
      process.exit(0);
    }
    if (outer.t !== "frame" || typeof outer.iv !== "string" || typeof outer.data !== "string")
      return; // Relay-visible routing tag: which viewer sent this frame. Echoed back on
    // the response so the relay can route it to the right viewer.
    const via = typeof outer.via === "string" ? outer.via : undefined;
    let inner: Record<string, unknown>;
    try {
      inner = JSON.parse(await decryptFrame(key, boxId, { iv: outer.iv, data: outer.data }));
    } catch {
      return; // not for us — ignore
    }
    const run = commandChain.then(async () => {
      const response = await handleCommand(inner, via);
      await sendResponse(response, via);
    });
    commandChain = run.catch(() => {});
    await run;
  };

  const connect = (): void => {
    if (stopped) return;
    const socket = new WebSocket(wsUrl);
    ws = socket;
    socket.onopen = () => {
      reconnectDelayMs = 2000;
      everConnected = true;
      outageBeganAt = 0;
      socket.send(JSON.stringify({ t: "hello", role: "vm" }));
      console.log("  ✓ Connected to relay. Waiting for viewer…\n");
    };
    socket.onmessage = (event) => void onMessage(event);
    socket.onclose = (ev) => {
      if (stopped) return;
      // The relay ended the box (goodbye raced a zombie, or the sweep
      // declared us a ghost): reconnecting with this box id can never work.
      // Exit instead of retrying so the supervisor restarts with a new URL.
      const reason = typeof ev?.reason === "string" ? ev.reason : "";
      if (reason === "session ended" || reason === "box ended") {
        console.log("\n  ✕ The relay ended this session. This URL is dead.");
        console.log("  Exiting — restart `vibe-relay relay` to mint a new URL.\n");
        stopped = true;
        process.exit(0);
      }
      // We once had this box, but the relay has been unreachable far past
      // its 90 s end grace: this box id is dead for good. Exit so the
      // supervisor restarts with a fresh URL instead of pointlessly
      // retrying a box id the relay will only ever reject as a zombie.
      // The outage clock starts when the connection DROPS: a transient blip
      // on a long-lived connection rides the normal retry path below.
      if (everConnected) {
        if (outageBeganAt === 0) outageBeganAt = Date.now();
        if (Date.now() - outageBeganAt > DEAD_BOX_RETRY_EXIT_MS) {
          const goneSec = Math.round((Date.now() - outageBeganAt) / 1000);
          console.log(`\n  ✕ Relay unreachable for ${goneSec}s — this box id is dead.`);
          console.log("  Exiting — restart `vibe-relay relay` to mint a new URL.\n");
          stopped = true;
          process.exit(0);
        }
      }
      console.log(`  ↻ Relay connection lost — retrying in ${reconnectDelayMs / 1000}s…`);
      setTimeout(connect, reconnectDelayMs);
      reconnectDelayMs = Math.min(30000, reconnectDelayMs * 2);
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {
        // handled by onclose
      }
    };
  };

  const shutdown = (): void => {
    stopped = true;
    clearInterval(keepaliveTimer);
    for (const id of tails.keys()) stopTail(id);
    // Tell the relay the box is dead so viewers see "session ended"
    // immediately instead of waiting for the end grace. Best-effort: the
    // grace path covers a lost goodbye.
    try {
      ws?.send(JSON.stringify({ t: "goodbye", role: "vm" }));
    } catch {
      // socket not open — the grace path covers this
    }
  };
  const exitAfterFlush = (): void => {
    // Give the goodbye a beat to flush before the socket closes.
    setTimeout(() => {
      try {
        ws?.close(1000, "shutdown");
      } catch {
        // ignore
      }
      process.exit(0);
    }, 300);
  };
  process.on("SIGINT", () => {
    console.log("\n  Relay stopped. The share URL is now dead.\n");
    shutdown();
    exitAfterFlush();
  });
  process.on("SIGTERM", () => {
    console.log("\n  Relay stopping (SIGTERM). The share URL is now dead.\n");
    shutdown();
    exitAfterFlush();
  });

  console.log(`\n  ${"vibe-replay relay"} — E2E-encrypted live session sharing\n`);
  console.log("  Share this URL (it contains the encryption key — treat it like a password):");
  console.log(`\n  ${shareUrl}\n`);
  console.log("  The relay only forwards ciphertext; it can never read your sessions.");
  console.log("  Press Ctrl+C to stop — the URL dies immediately.\n");
  connect();
  // Keep the process alive; the WS + timers hold the event loop.
  await new Promise(() => {});
}
