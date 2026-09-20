/**
 * Live relay protocol client for `vibe-replay relay` share URLs.
 *
 * Mirrors the command set the VM shipper speaks (list/get/search/tail/
 * untail/ping). All frames are AES-256-GCM encrypted in the browser with the
 * key from the URL fragment (`location.hash`); the relay only forwards
 * ciphertext. Ported from the original hand-rolled viewer page so the React
 * live viewer reuses the exact same wire protocol.
 */
import type { Scene } from "../types";

export interface RelaySessionSummary {
  provider: string;
  sessionId: string;
  title?: string;
  project: string;
  timestamp: string;
  promptCount?: number;
  toolCallCount?: number;
  model?: string;
}

export interface RelayGetResult {
  scenes: Scene[];
  totalScenes: number;
  offset: number;
}

export interface RelaySearchHit {
  sessionId: string;
  title?: string;
  provider: string;
  snippet: string;
}

export type TailEvent =
  | { event: "tail"; id: string; newScenes: Scene[] }
  | { event: "tail-gap"; id: string; skipped: number };

export const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
export const BOX_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const COMMAND_TIMEOUT_MS = 30_000;

export function b64urlEncode(bytes: Uint8Array<ArrayBuffer>): string {
  const s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Extract the box id from a `/live/<boxId>` path. Returns null when invalid. */
export function boxIdFromPath(pathname: string): string | null {
  const seg = pathname.split("/").filter(Boolean).pop() ?? "";
  return BOX_ID_RE.test(seg) ? seg : null;
}

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

/**
 * Minimal surface LiveApp needs. LiveClient implements it; tests inject a
 * fake. Keeps the UI decoupled from the socket.
 */
export interface LiveRelay {
  list(): Promise<RelaySessionSummary[]>;
  get(sessionId: string, offset: number, limit: number): Promise<RelayGetResult>;
  search(q: string, limit?: number): Promise<RelaySearchHit[]>;
  tail(sessionId: string): Promise<{ totalScenes: number }>;
  untail(sessionId: string): Promise<void>;
  onTail(handler: (ev: TailEvent) => void): () => void;
  close(): void;
}

export class LiveClient implements LiveRelay {
  private ws: WebSocket;
  private key: CryptoKey;
  private boxId: string;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private tailHandlers = new Set<(ev: TailEvent) => void>();
  private closed = false;

  private constructor(ws: WebSocket, key: CryptoKey, boxId: string) {
    this.ws = ws;
    this.key = key;
    this.boxId = boxId;
  }

  /**
   * Connect as a viewer. Reads the content key from `location.hash`, opens
   * the WebSocket to the same host, and says hello. Throws on a missing or
   * malformed key, or when the socket cannot be established.
   */
  static async connect(boxId: string): Promise<LiveClient> {
    const keyB64 = (location.hash || "").replace(/^#/, "");
    if (!KEY_RE.test(keyB64)) throw new Error("invalid-share-url");
    const raw = b64urlDecode(keyB64);
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/live/${boxId}`);
    const client = new LiveClient(ws, key, boxId);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("connection-timeout")), 15_000);
      ws.onopen = () => {
        clearTimeout(timer);
        ws.send(JSON.stringify({ t: "hello", role: "viewer" }));
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("connection-error"));
      };
    });
    ws.onmessage = (e) => void client.handleMessage(e);
    ws.onclose = () => client.handleClose();
    ws.onerror = () => client.handleClose();
    return client;
  }

  private aad(): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(`vibe-replay-live:v1:${this.boxId}`);
  }

  private async encryptFrame(payload: Record<string, unknown>): Promise<void> {
    const pt = new TextEncoder().encode(JSON.stringify(payload));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: this.aad() },
      this.key,
      pt,
    );
    this.ws.send(
      JSON.stringify({ t: "frame", iv: b64urlEncode(iv), data: b64urlEncode(new Uint8Array(ct)) }),
    );
  }

  private async decryptFrame(ivB64: string, dataB64: string): Promise<Record<string, unknown>> {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(ivB64), additionalData: this.aad() },
      this.key,
      b64urlDecode(dataB64),
    );
    return JSON.parse(new TextDecoder().decode(pt)) as Record<string, unknown>;
  }

  private async handleMessage(e: MessageEvent): Promise<void> {
    let outer: Record<string, unknown>;
    try {
      outer = JSON.parse(String(e.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (outer.t !== "frame" || typeof outer.iv !== "string" || typeof outer.data !== "string")
      return;
    let inner: Record<string, unknown>;
    try {
      inner = await this.decryptFrame(outer.iv, outer.data);
    } catch {
      return; // not for us (or wrong key) — ignore
    }
    if (inner.event === "tail" || inner.event === "tail-gap") {
      const ev = inner as unknown as TailEvent;
      for (const h of this.tailHandlers) h(ev);
      return;
    }
    const p = this.pending.get(inner.seq as number);
    if (p) {
      this.pending.delete(inner.seq as number);
      p.resolve(inner);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error("disconnected");
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private cmd<T>(obj: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("disconnected"));
        return;
      }
      this.seq += 1;
      const seq = this.seq;
      obj.seq = seq;
      this.pending.set(seq, {
        resolve: (v) => resolve(v as unknown as T),
        reject,
      });
      this.encryptFrame(obj).catch(reject);
      setTimeout(() => {
        const p = this.pending.get(seq);
        if (p) {
          this.pending.delete(seq);
          p.reject(new Error("timeout"));
        }
      }, COMMAND_TIMEOUT_MS);
    });
  }

  async list(): Promise<RelaySessionSummary[]> {
    const res = await this.cmd<{
      ok: boolean;
      error?: string;
      data: { sessions: RelaySessionSummary[] };
    }>({
      cmd: "list",
    });
    if (!res.ok) throw new Error(res.error || "list failed");
    return res.data.sessions;
  }

  async get(sessionId: string, offset: number, limit: number): Promise<RelayGetResult> {
    const res = await this.cmd<{
      ok: boolean;
      error?: string;
      data: { scenes: Scene[]; totalScenes: number; offset: number };
    }>({ cmd: "get", id: sessionId, offset, limit });
    if (!res.ok) throw new Error(res.error || "get failed");
    return res.data;
  }

  async search(q: string, limit = 10): Promise<RelaySearchHit[]> {
    const res = await this.cmd<{ ok: boolean; error?: string; data: { hits: RelaySearchHit[] } }>({
      cmd: "search",
      q,
      limit,
    });
    if (!res.ok) throw new Error(res.error || "search failed");
    return res.data.hits;
  }

  /** Subscribe to live scene appends. Returns the shipper's scene count. */
  async tail(sessionId: string): Promise<{ totalScenes: number }> {
    const res = await this.cmd<{ ok: boolean; error?: string; data: { totalScenes: number } }>({
      cmd: "tail",
      id: sessionId,
    });
    if (!res.ok) throw new Error(res.error || "tail failed");
    return res.data;
  }

  async untail(sessionId: string): Promise<void> {
    try {
      await this.cmd<{ ok: boolean }>({ cmd: "untail", id: sessionId });
    } catch {
      // best-effort: the socket may already be gone
    }
  }

  onTail(handler: (ev: TailEvent) => void): () => void {
    this.tailHandlers.add(handler);
    return () => this.tailHandlers.delete(handler);
  }

  close(): void {
    this.handleClose();
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
