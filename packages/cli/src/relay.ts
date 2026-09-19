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
import { getAllProviders } from "./providers/index.js";
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
  const out: RelaySessionSummary[] = [];
  for (const provider of getAllProviders()) {
    try {
      for (const s of await provider.discover()) out.push(summarize(s));
    } catch {
      // best-effort across providers
    }
  }
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
  mtimeMs: number;
}

export interface RelayOptions {
  relayOrigin?: string;
}

export async function startRelay(options: RelayOptions = {}): Promise<void> {
  const origin = (options.relayOrigin ?? DEFAULT_RELAY_ORIGIN).replace(/\/$/, "");
  const boxId = randomBoxId();
  const { key, raw } = await generateContentKey();
  const keyString = exportKeyString(raw);
  const wsUrl = `${origin.replace(/^http/, "ws")}/live/${boxId}`;
  const shareUrl = `${origin}/live/${boxId}#${keyString}`;

  const tails = new Map<string, TailState>();
  let ws: WebSocket | null = null;
  let stopped = false;
  let reconnectDelayMs = 2000;

  const sendFrame = async (payload: unknown): Promise<void> => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame: EncryptedFrame = await encryptFrame(key, boxId, JSON.stringify(payload));
    const outer = JSON.stringify({ t: "frame", ...frame });
    if (outer.length > MAX_FRAME_BYTES) return;
    ws.send(outer);
  };

  const stopTail = (sessionId: string): void => {
    const tail = tails.get(sessionId);
    if (tail) {
      clearInterval(tail.timer);
      tails.delete(sessionId);
    }
  };

  const startTail = async (sessionId: string): Promise<number> => {
    stopTail(sessionId);
    const replay = await loadReplay(sessionId, 0, Number.MAX_SAFE_INTEGER);
    const info = await findSessionInfo(sessionId);
    const filePath = info?.filePath;
    let mtimeMs = 0;
    if (filePath) {
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        // file may vanish; tail still works off scene count
      }
    }
    const poll = async (): Promise<void> => {
      try {
        const tail = tails.get(sessionId);
        if (!tail) return;
        // Skip the re-parse when the underlying file hasn't changed.
        if (filePath) {
          try {
            const m = statSync(filePath).mtimeMs;
            if (m === tail.mtimeMs) return;
            tail.mtimeMs = m;
          } catch {
            // stat failed; fall through and re-parse anyway
          }
        }
        const current = await loadReplay(sessionId, 0, Number.MAX_SAFE_INTEGER);
        if (current.scenes.length > tail.sceneCount) {
          const newScenes = current.scenes.slice(tail.sceneCount);
          tail.sceneCount = current.scenes.length;
          await sendFrame({
            event: "tail",
            id: sessionId,
            newScenes,
            totalScenes: current.scenes.length,
          });
        }
      } catch {
        // session unreadable mid-tail; keep polling
      }
    };
    const timer = setInterval(() => void poll(), TAIL_POLL_MS);
    tails.set(sessionId, { timer, sceneCount: replay.scenes.length, mtimeMs });
    return replay.scenes.length;
  };

  const handleCommand = async (msg: Record<string, unknown>): Promise<Record<string, unknown>> => {
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
          const totalScenes = await startTail(id);
          return { seq, ok: true, data: { subscribed: true, totalScenes } };
        }
        case "untail": {
          const id = msg.id;
          if (typeof id !== "string") return { seq, ok: false, error: "missing id" };
          stopTail(id);
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

  const onMessage = async (event: MessageEvent): Promise<void> => {
    let outer: Record<string, unknown>;
    try {
      outer = JSON.parse(typeof event.data === "string" ? event.data : "{}");
    } catch {
      return;
    }
    if (outer.t !== "frame" || typeof outer.iv !== "string" || typeof outer.data !== "string")
      return;
    let inner: Record<string, unknown>;
    try {
      inner = JSON.parse(await decryptFrame(key, boxId, { iv: outer.iv, data: outer.data }));
    } catch {
      return; // not for us — ignore
    }
    await sendFrame(await handleCommand(inner));
  };

  const connect = (): void => {
    if (stopped) return;
    const socket = new WebSocket(wsUrl);
    ws = socket;
    socket.onopen = () => {
      reconnectDelayMs = 2000;
      socket.send(JSON.stringify({ t: "hello", role: "vm" }));
      console.log("  ✓ Connected to relay. Waiting for viewer…\n");
    };
    socket.onmessage = (event) => void onMessage(event);
    socket.onclose = () => {
      if (stopped) return;
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
    for (const id of tails.keys()) stopTail(id);
    try {
      ws?.close(1000, "shutdown");
    } catch {
      // ignore
    }
  };
  process.on("SIGINT", () => {
    console.log("\n  Relay stopped. The share URL is now dead.\n");
    shutdown();
    process.exit(0);
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
