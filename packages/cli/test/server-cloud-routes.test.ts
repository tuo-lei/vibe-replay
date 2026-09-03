import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerCloudProxyRoutes } from "../src/server-routes/cloud.js";

function makeApp(
  fetchCloudApiWithLocalAuth: Parameters<
    typeof registerCloudProxyRoutes
  >[1]["fetchCloudApiWithLocalAuth"],
) {
  const app = new Hono();
  registerCloudProxyRoutes(app, { fetchCloudApiWithLocalAuth });
  return app;
}

describe("registerCloudProxyRoutes", () => {
  it("proxies JSON responses and preserves the cloud status", async () => {
    const fetchCloudApiWithLocalAuth = vi.fn().mockResolvedValue({
      unauthorized: false,
      response: new Response(JSON.stringify({ replay: "abc" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    });
    const app = makeApp(fetchCloudApiWithLocalAuth);

    const response = await app.request("/api/cloud-replays");

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ replay: "abc" });
    expect(fetchCloudApiWithLocalAuth).toHaveBeenCalledWith("/api/cloud-replays", undefined);
  });

  it("forwards request bodies and content types", async () => {
    const fetchCloudApiWithLocalAuth = vi.fn().mockResolvedValue({
      unauthorized: false,
      response: new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }),
    });
    const app = makeApp(fetchCloudApiWithLocalAuth);

    const response = await app.request("/api/gists", {
      method: "POST",
      headers: { "content-type": "application/custom+json" },
      body: '{"title":"Replay"}',
    });

    expect(response.status).toBe(200);
    expect(fetchCloudApiWithLocalAuth).toHaveBeenCalledWith("/api/gists", {
      method: "POST",
      headers: { "Content-Type": "application/custom+json" },
      body: '{"title":"Replay"}',
    });
  });

  it("returns unauthorized when the local auth session cannot proxy", async () => {
    const fetchCloudApiWithLocalAuth = vi.fn().mockResolvedValue({ unauthorized: true });
    const app = makeApp(fetchCloudApiWithLocalAuth);

    const response = await app.request("/api/files");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects invalid cloud resource ids before proxying", async () => {
    const fetchCloudApiWithLocalAuth = vi.fn();
    const app = makeApp(fetchCloudApiWithLocalAuth);

    const replayResponse = await app.request("/api/cloud-replays/short", { method: "DELETE" });
    const gistResponse = await app.request("/api/gists/not-a-gist", { method: "PATCH" });

    expect(replayResponse.status).toBe(400);
    expect(await replayResponse.json()).toEqual({ error: "Invalid replay ID" });
    expect(gistResponse.status).toBe(400);
    expect(await gistResponse.json()).toEqual({ error: "Invalid gist ID" });
    expect(fetchCloudApiWithLocalAuth).not.toHaveBeenCalled();
  });

  it("preserves non-JSON cloud responses", async () => {
    const fetchCloudApiWithLocalAuth = vi.fn().mockResolvedValue({
      unauthorized: false,
      response: new Response("created", {
        status: 202,
        headers: { "content-type": "text/plain" },
      }),
    });
    const app = makeApp(fetchCloudApiWithLocalAuth);

    const response = await app.request("/api/files");

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("created");
  });
});
