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
});
