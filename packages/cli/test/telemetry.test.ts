import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushTelemetry,
  getTelemetryNotice,
  getTelemetryStatus,
  recordTelemetry,
  setTelemetryEnabled,
} from "../src/telemetry.js";

describe("local telemetry", () => {
  let stateDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "vibe-replay-telemetry-"));
    process.env.VIBE_REPLAY_TELEMETRY_FILE = join(stateDir, "telemetry.json");
    delete process.env.VIBE_REPLAY_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    delete process.env.CI;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(stateDir, { recursive: true, force: true });
  });

  it("defaults on, shows one notice, and supports disable/enable", async () => {
    expect((await getTelemetryStatus()).enabled).toBe(true);
    expect(await getTelemetryNotice()).toContain("pseudonymous feature counts");
    expect(await getTelemetryNotice()).toBeNull();

    await setTelemetryEnabled(false);
    expect((await getTelemetryStatus()).enabled).toBe(false);
    await setTelemetryEnabled(true);
    expect((await getTelemetryStatus()).enabled).toBe(true);
  });

  it("sends only the allowlisted event envelope", async () => {
    recordTelemetry("scan.completed", {
      sessions: "10-99",
      duration: "1-9s",
    });
    await flushTelemetry();

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const payload = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(payload.event).toBe("scan.completed");
    expect(payload.version).toBeTruthy();
    expect(payload.platform).toBeTruthy();
    expect(payload.installationId).toMatch(/^[0-9a-f]{64}$/i);
    expect(payload.properties).toEqual({ sessions: "10-99", duration: "1-9s" });
    expect(JSON.stringify(payload)).not.toContain("prompt");
    expect(JSON.stringify(payload)).not.toContain("replay");

    const state = JSON.parse(await readFile(process.env.VIBE_REPLAY_TELEMETRY_FILE!, "utf8"));
    expect(state.installationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(payload.installationId).not.toBe(state.installationId);
  });

  it("does not send when explicitly disabled", async () => {
    await setTelemetryEnabled(false);
    recordTelemetry("cli.started");
    await flushTelemetry();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send from the pnpm dev launcher", async () => {
    process.env.VIBE_REPLAY_DEV_MENU = "1";
    recordTelemetry("cli.started");
    await flushTelemetry();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not send telemetry to a non-HTTPS collector", async () => {
    process.env.VIBE_REPLAY_API_URL = "http://collector.example";
    recordTelemetry("cli.started");
    await flushTelemetry();
    expect(fetch).not.toHaveBeenCalled();
  });
});
