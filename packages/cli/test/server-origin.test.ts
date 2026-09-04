import { Hono } from "hono";
import type { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testables } from "../src/server.js";

const API_URL = "http://127.0.0.1:13456/api/assistant/chat";

function context(headers: Record<string, string>): Context {
  return {
    req: {
      url: API_URL,
      header(name: string) {
        return headers[name.toLowerCase()];
      },
    },
  } as unknown as Context;
}

describe("same-origin API protection", () => {
  let previousDevMenu: string | undefined;

  beforeEach(() => {
    previousDevMenu = process.env.VIBE_REPLAY_DEV_MENU;
  });

  afterEach(() => {
    if (previousDevMenu === undefined) delete process.env.VIBE_REPLAY_DEV_MENU;
    else process.env.VIBE_REPLAY_DEV_MENU = previousDevMenu;
  });

  it("accepts a direct same-origin request", () => {
    delete process.env.VIBE_REPLAY_DEV_MENU;

    expect(
      __testables.isSameOriginSettingsRequest(
        context({
          origin: "http://127.0.0.1:13456",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toBe(true);
  });

  it("accepts localhost and 127.0.0.1 aliases on the same API port", () => {
    delete process.env.VIBE_REPLAY_DEV_MENU;

    expect(
      __testables.isSameOriginSettingsRequest(
        context({
          origin: "http://localhost:13456",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toBe(true);
  });

  it("keeps different loopback ports isolated without the dev proxy", () => {
    delete process.env.VIBE_REPLAY_DEV_MENU;

    expect(
      __testables.isSameOriginSettingsRequest(
        context({
          origin: "http://localhost:13457",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).toBe(false);
  });

  it("rejects an unmarked cross-origin request", () => {
    process.env.VIBE_REPLAY_DEV_MENU = "1";

    expect(
      __testables.isSameOriginSettingsRequest(
        context({
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
        }),
      ),
    ).toBe(false);
  });

  it("accepts the marked Vite dev proxy hop only in same-origin fetch mode", () => {
    process.env.VIBE_REPLAY_DEV_MENU = "1";

    expect(
      __testables.isSameOriginSettingsRequest(
        context({
          origin: "http://127.0.0.1:5173",
          "sec-fetch-site": "same-origin",
          "x-vibe-replay-dev-proxy": "1",
        }),
      ),
    ).toBe(true);

    expect(
      __testables.isSameOriginSettingsRequest(
        context({
          origin: "https://attacker.example",
          "sec-fetch-site": "cross-site",
          "x-vibe-replay-dev-proxy": "1",
        }),
      ),
    ).toBe(false);
  });

  it("blocks cross-origin mutations while allowing read-only requests", async () => {
    const app = new Hono();
    __testables.registerSameOriginMutationGuard(app);
    app.get("/api/replay", (c) => c.json({ ok: true }));
    app.post("/api/replay", (c) => c.json({ ok: true }));

    const crossOrigin = {
      Origin: "https://attacker.example",
      "Sec-Fetch-Site": "cross-site",
    };
    const read = await app.request("http://127.0.0.1:13456/api/replay", {
      headers: crossOrigin,
    });
    const write = await app.request("http://127.0.0.1:13456/api/replay", {
      method: "POST",
      headers: crossOrigin,
    });

    expect(read.status).toBe(200);
    expect(write.status).toBe(403);
    await expect(write.json()).resolves.toEqual({ error: "API requests must be same-origin" });
  });
});
