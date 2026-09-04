import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLI_VERSION } from "./version.js";

export const TELEMETRY_EVENTS = [
  "cli.started",
  "scan.completed",
  "session.query",
  "replay.generated",
  "dashboard.opened",
  "cloud.publish",
  "insights.sync",
  "auth.login",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENTS)[number];

export interface TelemetryStatus {
  enabled: boolean;
  configured: boolean;
  source: "default" | "config" | "environment" | "ci";
}

interface TelemetryState {
  version: 1;
  installationId: string;
  enabled: boolean;
  notified: boolean;
  createdAt: string;
}

const TELEMETRY_ENDPOINT_PATH = "/api/telemetry";
const TELEMETRY_TIMEOUT_MS = 500;
const pendingRequests = new Set<Promise<void>>();
let telemetryStatePromise: Promise<TelemetryState> | undefined;
let telemetryStatePath: string | undefined;

function telemetryFilePath(): string {
  return (
    process.env.VIBE_REPLAY_TELEMETRY_FILE || join(homedir(), ".vibe-replay", "telemetry.json")
  );
}

function telemetryDisabledByEnvironment(): boolean {
  return (
    process.env.VIBE_REPLAY_TELEMETRY === "0" ||
    process.env.DO_NOT_TRACK === "1" ||
    process.env.CI === "true" ||
    process.env.CI === "1"
  );
}

function telemetryForcedOnByEnvironment(): boolean {
  return process.env.VIBE_REPLAY_TELEMETRY === "1";
}

function getApiOrigin(): string {
  return (process.env.VIBE_REPLAY_API_URL || "https://vibe-replay.com").replace(/\/$/, "");
}

async function readTelemetryState(): Promise<TelemetryState | null> {
  try {
    const parsed = JSON.parse(
      await readFile(telemetryFilePath(), "utf8"),
    ) as Partial<TelemetryState>;
    if (
      parsed.version !== 1 ||
      typeof parsed.installationId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(parsed.installationId)
    ) {
      return null;
    }
    return {
      version: 1,
      installationId: parsed.installationId,
      enabled: parsed.enabled !== false,
      notified: parsed.notified === true,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function writeTelemetryState(state: TelemetryState): Promise<void> {
  const path = telemetryFilePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tempPath = `${path}.${process.pid}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(tempPath, 0o600);
  await rename(tempPath, path);
}

async function ensureTelemetryState(): Promise<TelemetryState> {
  const path = telemetryFilePath();
  if (telemetryStatePath !== path) {
    telemetryStatePath = path;
    telemetryStatePromise = undefined;
  }
  telemetryStatePromise ??= (async () => {
    const existing = await readTelemetryState();
    if (existing) return existing;
    const state: TelemetryState = {
      version: 1,
      installationId: randomUUID(),
      enabled: true,
      notified: false,
      createdAt: new Date().toISOString(),
    };
    await writeTelemetryState(state);
    return state;
  })();
  return telemetryStatePromise;
}

function effectiveTelemetryStatus(state: TelemetryState | null): TelemetryStatus {
  if (telemetryDisabledByEnvironment()) {
    return {
      enabled: false,
      configured: state !== null,
      source: process.env.CI ? "ci" : "environment",
    };
  }
  if (telemetryForcedOnByEnvironment()) {
    return { enabled: true, configured: state !== null, source: "environment" };
  }
  if (state) return { enabled: state.enabled, configured: true, source: "config" };
  return { enabled: true, configured: false, source: "default" };
}

export async function getTelemetryStatus(): Promise<TelemetryStatus> {
  return effectiveTelemetryStatus(await readTelemetryState());
}

export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  const state = await ensureTelemetryState();
  const nextState = { ...state, enabled, notified: true };
  await writeTelemetryState(nextState);
  telemetryStatePromise = Promise.resolve(nextState);
}

/** Returns the one-time notice for default-on telemetry, if it has not been shown. */
export async function getTelemetryNotice(): Promise<string | null> {
  if (telemetryDisabledByEnvironment() || telemetryForcedOnByEnvironment()) return null;
  const state = await ensureTelemetryState();
  if (state.notified) return null;
  const nextState = { ...state, notified: true };
  await writeTelemetryState(nextState);
  telemetryStatePromise = Promise.resolve(nextState);
  return (
    "vibe-replay collects anonymous feature counts and coarse scan-size buckets " +
    "to improve the CLI. It never sends replay content, prompts, paths, or IDs. " +
    "Disable with `vibe-replay telemetry disable`."
  );
}

function sanitizeProperties(
  properties?: Record<string, string>,
): Record<string, string> | undefined {
  if (!properties) return undefined;
  const entries = Object.entries(properties)
    .filter(
      ([key, value]) =>
        /^[a-z][a-z0-9_]{0,31}$/.test(key) &&
        typeof value === "string" &&
        /^[a-z0-9_.-]{1,32}$/i.test(value),
    )
    .slice(0, 8);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function telemetryPlatform(): "darwin" | "win32" | "linux" | "other" {
  if (process.platform === "darwin") return "darwin";
  if (process.platform === "win32") return "win32";
  if (process.platform === "linux") return "linux";
  return "other";
}

async function sendTelemetry(
  event: TelemetryEventName,
  properties?: Record<string, string>,
): Promise<void> {
  if (telemetryDisabledByEnvironment()) return;
  const state = await ensureTelemetryState();
  if (!effectiveTelemetryStatus(state).enabled) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
  try {
    await fetch(`${getApiOrigin()}${TELEMETRY_ENDPOINT_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installationId: state.installationId,
        event,
        version: CLI_VERSION,
        platform: telemetryPlatform(),
        properties: sanitizeProperties(properties),
      }),
      signal: controller.signal,
    });
  } catch {
    // Telemetry is strictly best-effort and must never affect the CLI.
  } finally {
    clearTimeout(timer);
  }
}

export function recordTelemetry(
  event: TelemetryEventName,
  properties?: Record<string, string>,
): void {
  const request = sendTelemetry(event, properties);
  pendingRequests.add(request);
  void request.finally(() => pendingRequests.delete(request));
}

export async function flushTelemetry(timeoutMs = TELEMETRY_TIMEOUT_MS): Promise<void> {
  if (pendingRequests.size === 0) return;
  await Promise.race([
    Promise.allSettled(pendingRequests),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

export function bucketCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 10) return "1-9";
  if (value < 100) return "10-99";
  if (value < 1_000) return "100-999";
  if (value < 10_000) return "1k-9k";
  return "10k+";
}

export function bucketBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1024 * 1024) return "<1mb";
  if (value < 10 * 1024 * 1024) return "1-9mb";
  if (value < 100 * 1024 * 1024) return "10-99mb";
  return "100mb+";
}

export function bucketDurationMs(value: number): string {
  if (!Number.isFinite(value) || value < 1_000) return "<1s";
  if (value < 10_000) return "1-9s";
  if (value < 60_000) return "10-59s";
  if (value < 300_000) return "1-4m";
  return "5m+";
}
