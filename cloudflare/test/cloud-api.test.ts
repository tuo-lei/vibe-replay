import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/cloudflare";
import worker, { createSentryOptions, scrubSentryRequest } from "../src/worker";
import { applyMigrations } from "./migration-utils";

const TEST_USER_ID = "user-test-1";
const OTHER_USER_ID = "user-test-2";

interface TestEnv {
  ASSETS: Fetcher;
  DB: D1Database;
  REPLAY_BUCKET: R2Bucket;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  TEST_AUTH_USER_ID: string;
  TEST_AUTH_USER_EMAIL: string;
  TEST_AUTH_USER_NAME: string;
}

interface TestExecutionContext extends ExecutionContext {
  promises: Promise<unknown>[];
}

let mf: Miniflare;
let env: TestEnv;

function createCtx(): TestExecutionContext {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    waitUntil(promise) {
      promises.push(Promise.resolve(promise));
    },
    passThroughOnException() {},
    props: {},
  } as TestExecutionContext;
}

async function waitOnCtx(ctx: TestExecutionContext) {
  await Promise.all(ctx.promises);
}

async function dispatch(path: string, init: RequestInit = {}, userId = TEST_USER_ID) {
  const headers = new Headers(init.headers);
  headers.set("x-vibe-replay-test-auth", "1");
  headers.set("x-vibe-replay-test-user-id", userId);
  const ctx = createCtx();
  const response = await worker.fetch(
    new Request(`http://localhost${path}`, { ...init, headers }),
    env,
    ctx,
  );
  await waitOnCtx(ctx);
  return response;
}

async function resetDb() {
  await env.DB.exec("PRAGMA foreign_keys = OFF");
  for (const table of [
    "cloud_replays",
    "user_files",
    "daily_insights",
    "insight_profiles",
    "account",
    "session",
    "verification",
    "replays",
    "user",
  ]) {
    await env.DB.exec(`DELETE FROM ${table}`);
  }
  await env.DB.exec("PRAGMA foreign_keys = ON");
  await env.DB.prepare(
    `INSERT INTO user (id, name, email, email_verified) VALUES (?, ?, ?, ?), (?, ?, ?, ?)`,
  )
    .bind(
      TEST_USER_ID,
      "Test User",
      "test@example.com",
      1,
      OTHER_USER_ID,
      "Other User",
      "other@example.com",
      1,
    )
    .run();
}

async function clearR2() {
  const listed = await env.REPLAY_BUCKET.list();
  await Promise.all(listed.objects.map((object) => env.REPLAY_BUCKET.delete(object.key)));
}

function sampleReplay() {
  return {
    meta: {
      sessionId: "session-cloud-api-e2e",
      provider: "claude-code",
      title: "Cloud API E2E",
      model: "claude-sonnet-4-5",
      stats: {
        sceneCount: 2,
        userPrompts: 1,
        toolCalls: 1,
        durationMs: 1234,
        costEstimate: 0.42,
      },
    },
    scenes: [
      { type: "user-prompt", content: "Cover the cloud API." },
      { type: "text-response", content: "Done." },
    ],
  };
}

async function uploadReplay(visibility = "unlisted") {
  const response = await dispatch("/api/cloud-replays", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ replay: sampleReplay(), visibility }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { id: string; url: string; expiresAt: string };
}

describe("Cloud API integration", () => {
  beforeAll(async () => {
    mf = new Miniflare({
      // The real worker is imported above. Miniflare only provides local D1/R2 bindings here.
      script: "export default { fetch() { return new Response('ok'); } }",
      modules: true,
      compatibilityDate: "2024-12-01",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      r2Buckets: ["REPLAY_BUCKET"],
      bindings: {
        BETTER_AUTH_SECRET: "test-secret",
        BETTER_AUTH_URL: "http://localhost",
        GITHUB_CLIENT_ID: "test-client",
        GITHUB_CLIENT_SECRET: "test-secret",
        TEST_AUTH_USER_ID: TEST_USER_ID,
        TEST_AUTH_USER_EMAIL: "test@example.com",
        TEST_AUTH_USER_NAME: "Test User",
      },
    });
    env = {
      ...(await mf.getBindings()),
      ASSETS: {
        fetch: async () => new Response("Not Found", { status: 404 }),
      } as unknown as Fetcher,
    } as TestEnv;
    await applyMigrations(env.DB);
  });

  afterAll(async () => {
    await mf.dispose();
  });

  beforeEach(async () => {
    await resetDb();
    await clearR2();
  });

  it("disables sensitive request data in Sentry events", () => {
    const options = createSentryOptions({
      SENTRY_DSN: "https://example.invalid/1",
      CF_VERSION_METADATA: { id: "version-test" },
    } as Parameters<typeof createSentryOptions>[0]);
    expect(options.release).toBe("version-test");
    expect(options.sendDefaultPii).toBe(false);
    expect(options.enableLogs).toBe(true);
    expect(options.enableMetrics).toBe(true);
    expect(options.tracesSampleRate).toBe(0.1);
    expect(options.traceLifecycle).toBe("stream");
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    });

    const event = scrubSentryRequest({
      request: {
        url: "https://example.test/api?query=sentinel",
        headers: { Authorization: "authorization-sentinel" },
        cookies: "cookie-sentinel",
        query_string: "query-sentinel",
        data: "body-sentinel",
      },
    } as Sentry.ErrorEvent);

    expect(event.request?.url).toBe("https://example.test/api");
    expect(event.request?.headers).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.query_string).toBeUndefined();
    expect(event.request?.data).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("sentinel");
  });

  it("keeps Better Auth account writes compatible with the issuer migration", async () => {
    await env.DB.prepare(
      `INSERT INTO account (id, account_id, provider_id, user_id) VALUES (?, ?, ?, ?)`,
    )
      .bind("account-test-1", "github-user-1", "github", TEST_USER_ID)
      .run();

    const row = await env.DB.prepare("SELECT issuer FROM account WHERE id = ?")
      .bind("account-test-1")
      .first<{ issuer: string }>();
    expect(row?.issuer).toBe("local:oauth:github");
  });

  it("completes a GitHub OAuth callback against the migrated account schema", async () => {
    const start = await worker.fetch(
      new Request("http://localhost/api/auth/sign-in/social", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ provider: "github", callbackURL: "/auth/success" }),
      }),
      env,
      createCtx(),
    );
    expect(start.status).toBe(200);

    const startBody = (await start.json()) as { url: string };
    const state = new URL(startBody.url).searchParams.get("state");
    const stateCookie = start.headers.get("set-cookie")?.split(";", 1)[0];
    expect(state).toBeTruthy();
    expect(stateCookie).toMatch(/^better-auth\.state=/);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
      if (url === "https://github.com/login/oauth/access_token") {
        return new Response(
          JSON.stringify({
            access_token: "fake-access-token",
            token_type: "bearer",
            scope: "read:user, user:email, gist",
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://api.github.com/user") {
        return new Response(
          JSON.stringify({
            id: 424242,
            login: "demo-user",
            name: "Demo User",
            email: "github-test-user",
            avatar_url: "https://avatars.example/demo",
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "https://api.github.com/user/emails") {
        return new Response(
          JSON.stringify([
            { email: "github-test-user", primary: true, verified: true, visibility: "private" },
          ]),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      const callback = await worker.fetch(
        new Request(
          `http://localhost/api/auth/callback/github?code=fake-code&state=${encodeURIComponent(state!)}`,
          { headers: { Cookie: stateCookie!, Origin: "http://localhost" } },
        ),
        env,
        createCtx(),
      );
      expect(callback.status).toBe(302);
      expect(callback.headers.get("location")).toBe("/auth/success");
      const sessionCookie = callback.headers
        .get("set-cookie")
        ?.split(/,\s*(?=[^;=]+=[^;]+)/)
        .map((cookie) => cookie.split(";", 1)[0])
        .find((cookie) => cookie.startsWith("better-auth.session_token="));
      expect(sessionCookie).toMatch(/^better-auth\.session_token=/);

      const authenticatedApi = await worker.fetch(
        new Request("http://localhost/api/cloud-replays", {
          headers: { Cookie: sessionCookie!, Origin: "http://localhost" },
        }),
        env,
        createCtx(),
      );
      expect(authenticatedApi.status).toBe(200);
      await expect(authenticatedApi.json()).resolves.toMatchObject({
        replays: [],
        storage: { used: 0, limit: 20 * 1024 * 1024 },
      });

      const accountRow = await env.DB.prepare(
        "SELECT issuer, account_id, provider_id FROM account WHERE account_id = ?",
      )
        .bind("424242")
        .first<{ issuer: string; account_id: string; provider_id: string }>();
      expect(accountRow).toEqual({
        issuer: "local:oauth:github",
        account_id: "424242",
        provider_id: "github",
      });
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("uploads, reads, lists, updates, and deletes an R2-backed replay", async () => {
    const uploaded = await uploadReplay();
    expect(uploaded.id).toMatch(/^[a-zA-Z0-9_-]{12}$/);
    expect(uploaded.url).toBe(`http://localhost/r/${uploaded.id}`);

    const read = await dispatch(`/api/cloud-replays/${uploaded.id}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toContain("application/json");
    const readBody = (await read.json()) as ReturnType<typeof sampleReplay>;
    expect(readBody.meta.sessionId).toBe("session-cloud-api-e2e");
    expect(readBody.scenes[0]).toMatchObject({ type: "user-prompt" });

    const list = await dispatch("/api/cloud-replays");
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as {
      replays: { id: string }[];
      storage: { used: number };
    };
    expect(listBody.replays.map((replay) => replay.id)).toEqual([uploaded.id]);
    expect(listBody.storage.used).toBeGreaterThan(0);

    const patch = await dispatch(`/api/cloud-replays/${uploaded.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(patch.status).toBe(200);
    await expect(patch.json()).resolves.toMatchObject({ ok: true, visibility: "private" });

    const deleted = await dispatch(`/api/cloud-replays/${uploaded.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await env.REPLAY_BUCKET.get(`replays/${uploaded.id}.json`)).toBeNull();
  });

  it("rejects malformed JSON bodies with 400 responses", async () => {
    const uploaded = await uploadReplay();
    const invalidJson = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    };

    const cloudReplay = await dispatch("/api/cloud-replays", invalidJson);
    expect(cloudReplay.status).toBe(400);
    await expect(cloudReplay.json()).resolves.toEqual({ error: "Invalid JSON body" });

    const patchReplay = await dispatch(`/api/cloud-replays/${uploaded.id}`, {
      ...invalidJson,
      method: "PATCH",
    });
    expect(patchReplay.status).toBe(400);
    await expect(patchReplay.json()).resolves.toEqual({ error: "Invalid JSON body" });

    const insightsSync = await dispatch("/api/insights/sync", invalidJson);
    expect(insightsSync.status).toBe(400);
    await expect(insightsSync.json()).resolves.toEqual({ error: "Invalid JSON body" });

    const fileUpload = await dispatch("/api/files", invalidJson);
    expect(fileUpload.status).toBe(400);
    await expect(fileUpload.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("rejects JSON primitives where an object body is required", async () => {
    const cloudReplay = await dispatch("/api/cloud-replays", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    const fileUpload = await dispatch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });

    expect(cloudReplay.status).toBe(400);
    await expect(cloudReplay.json()).resolves.toEqual({
      error: "Request body must be an object",
    });
    expect(fileUpload.status).toBe(400);
    await expect(fileUpload.json()).resolves.toEqual({
      error: "Request body must be an object",
    });
  });

  it("rejects oversized JSON bodies before parsing them", async () => {
    const response = await dispatch("/api/cloud-replays", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: " ".repeat(24 * 1024 * 1024 + 1),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "Request body too large" });
  });

  it("rejects malformed scenes anywhere in an uploaded replay", async () => {
    const replay = sampleReplay();
    replay.scenes = [
      ...replay.scenes,
      { type: "text-response", content: "still valid" },
      null as never,
    ];
    const response = await dispatch("/api/cloud-replays", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ replay }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid scene at index 3: missing type",
    });
    expect((await env.REPLAY_BUCKET.list()).objects).toHaveLength(0);
  });

  it("rejects unsafe browser login callbacks before starting OAuth", async () => {
    for (const callback of [
      "javascript:alert(1)",
      "profile",
      "//evil.example/callback",
      "/\\evil.example/callback",
    ]) {
      const response = await dispatch(`/auth/login?callback=${encodeURIComponent(callback)}`);
      expect(response.status).toBe(400);
      await expect(response.text()).resolves.toBe("Invalid callback URL");
    }
  });

  it("rejects malformed insight profile JSON with a 400 response", async () => {
    const response = await dispatch("/api/insights/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid JSON body" });
  });

  it("hides private replays from other authenticated users", async () => {
    const uploaded = await uploadReplay("private");

    const otherRead = await dispatch(`/api/cloud-replays/${uploaded.id}`, {}, OTHER_USER_ID);
    expect(otherRead.status).toBe(404);

    const ownerRead = await dispatch(`/api/cloud-replays/${uploaded.id}`);
    expect(ownerRead.status).toBe(200);
  });

  it("uploads and serves SVG files through the short file URL", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="20"><text x="0" y="15">ok</text></svg>`;
    const upload = await dispatch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: btoa(svg),
        contentType: "image/svg+xml",
        filename: "preview.svg",
        visibility: "unlisted",
      }),
    });
    expect(upload.status).toBe(200);
    const body = (await upload.json()) as { id: string; url: string; sizeBytes: number };
    expect(body.url).toBe(`http://localhost/f/${body.id}`);
    expect(body.sizeBytes).toBeGreaterThan(0);

    const file = await dispatch(`/f/${body.id}.svg`);
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("image/svg+xml");
    expect(file.headers.get("content-security-policy")).toContain("default-src 'none'");
    await expect(file.text()).resolves.toContain("<svg");

    const files = await dispatch("/api/files");
    expect(files.status).toBe(200);
    await expect(files.json()).resolves.toMatchObject({ files: [{ id: body.id }] });

    const deleted = await dispatch(`/api/files/${body.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(await env.REPLAY_BUCKET.get(`files/${body.id}.svg`)).toBeNull();
  });

  it("syncs daily insights and returns aggregate summary data", async () => {
    const sync = await dispatch("/api/insights/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        machineId: "machine-a",
        machineName: "Work Laptop",
        days: [
          {
            date: "2026-05-01",
            sessions: 2,
            prompts: 5,
            toolCalls: 12,
            edits: 3,
            durationMs: 10_000,
            cost: 1.25,
            projects: JSON.stringify({
              "/repo": {
                sessions: 2,
                cost: 1.25,
                prompts: 5,
                toolCalls: 12,
                edits: 3,
                durationMs: 10_000,
              },
            }),
            models: JSON.stringify({ "claude-sonnet-4-5": { sessions: 2, cost: 1.25 } }),
            providers: JSON.stringify({ "claude-code": { sessions: 2, cost: 1.25 } }),
          },
        ],
      }),
    });
    expect(sync.status).toBe(200);
    await expect(sync.json()).resolves.toEqual({ synced: 1 });

    const dates = await dispatch("/api/insights/dates?machineId=machine-a");
    expect(dates.status).toBe(200);
    await expect(dates.json()).resolves.toEqual({ dates: ["2026-05-01"] });

    const summary = await dispatch("/api/insights/summary");
    expect(summary.status).toBe(200);
    await expect(summary.json()).resolves.toMatchObject({
      totalSessions: 2,
      totalProjects: 1,
      totalPrompts: 5,
      totalToolCalls: 12,
      totalEdits: 3,
      providers: { "claude-code": 2 },
      models: { "claude-sonnet-4-5": 2 },
      sessionsPerDay: { "2026-05-01": 2 },
      topProjects: [{ project: "/repo", sessions: 2 }],
    });
  });

  it("rejects malformed insight sync input instead of throwing", async () => {
    const invalidMachine = await dispatch("/api/insights/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId: 42, days: [{ date: "2026-05-01" }] }),
    });
    expect(invalidMachine.status).toBe(400);
    await expect(invalidMachine.json()).resolves.toEqual({ error: "machineId required" });

    const invalidDate = await dispatch("/api/insights/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId: "machine-a", days: [{ date: "2026-02-30" }] }),
    });
    expect(invalidDate.status).toBe(400);
    await expect(invalidDate.json()).resolves.toEqual({
      error: "Each day must have a valid YYYY-MM-DD date",
    });
  });

  it("accepts calendar years below 100 without Date.UTC remapping", async () => {
    const response = await dispatch("/api/insights/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ machineId: "machine-early", days: [{ date: "0001-01-01" }] }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ synced: 1 });
  });

  it("preserves insight profile privacy config when updating metadata only", async () => {
    const create = await dispatch("/api/insights/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "privacy-profile",
        config: {
          showCost: true,
          showProjects: false,
          showModels: false,
          blurProjectNames: true,
          unknownFlag: true,
        },
      }),
    });
    expect(create.status).toBe(200);
    const createdProfile = (await create.json()) as {
      profile: { config: Record<string, unknown> };
    };
    expect(createdProfile).toMatchObject({
      profile: {
        config: {
          showCost: true,
          showProjects: false,
          showModels: false,
          blurProjectNames: true,
        },
      },
    });
    expect(createdProfile.profile.config).not.toHaveProperty("unknownFlag");

    const update = await dispatch("/api/insights/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false, displayName: "Private Profile" }),
    });
    expect(update.status).toBe(200);
    const updatedProfile = (await update.json()) as {
      profile: { config: Record<string, unknown> };
    };
    expect(updatedProfile).toMatchObject({
      profile: {
        enabled: false,
        config: {
          showCost: true,
          showProjects: false,
          showModels: false,
          blurProjectNames: true,
        },
      },
    });
    expect(updatedProfile.profile.config).not.toHaveProperty("unknownFlag");
  });

  it("scheduled cleanup removes expired R2 objects and frees quota", async () => {
    const replay = await uploadReplay();
    const fileUpload = await dispatch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: btoa("GIF89a-test"),
        contentType: "image/gif",
        filename: "preview.gif",
      }),
    });
    expect(fileUpload.status).toBe(200);
    const file = (await fileUpload.json()) as { id: string };

    await env.DB.prepare(
      "UPDATE cloud_replays SET expires_at = datetime('now', '-15 days') WHERE id = ?",
    )
      .bind(replay.id)
      .run();
    await env.DB.prepare(
      "UPDATE user_files SET expires_at = datetime('now', '-15 days') WHERE id = ?",
    )
      .bind(file.id)
      .run();

    const ctx = createCtx();
    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "0 */6 * * *", noRetry() {} },
      env,
      ctx,
    );
    await waitOnCtx(ctx);

    expect(await env.REPLAY_BUCKET.get(`replays/${replay.id}.json`)).toBeNull();
    expect(await env.REPLAY_BUCKET.get(`files/${file.id}.gif`)).toBeNull();

    const replayRow = await env.DB.prepare("SELECT size_bytes FROM cloud_replays WHERE id = ?")
      .bind(replay.id)
      .first<{ size_bytes: number }>();
    const fileRow = await env.DB.prepare("SELECT size_bytes FROM user_files WHERE id = ?")
      .bind(file.id)
      .first<{ size_bytes: number }>();
    expect(replayRow?.size_bytes).toBe(0);
    expect(fileRow?.size_bytes).toBe(0);
  });

  it("ignores the test auth bypass outside localhost dev mode", async () => {
    const prodMf = new Miniflare({
      script: "export default { fetch() { return new Response('ok'); } }",
      modules: true,
      compatibilityDate: "2024-12-01",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      r2Buckets: ["REPLAY_BUCKET"],
      bindings: {
        BETTER_AUTH_SECRET: "test-secret",
        BETTER_AUTH_URL: "https://vibe-replay.com",
        GITHUB_CLIENT_ID: "test-client",
        GITHUB_CLIENT_SECRET: "test-secret",
        TEST_AUTH_USER_ID: TEST_USER_ID,
      },
    });

    try {
      const prodEnv = {
        ...(await prodMf.getBindings()),
        ASSETS: {
          fetch: async () => new Response("Not Found", { status: 404 }),
        } as unknown as Fetcher,
      } as TestEnv;
      const ctx = createCtx();
      const response = await worker.fetch(
        new Request("https://vibe-replay.com/api/cloud-replays", {
          headers: { "x-vibe-replay-test-auth": "1" },
        }),
        prodEnv,
        ctx,
      );
      await waitOnCtx(ctx);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    } finally {
      await prodMf.dispose();
    }
  });
});
