import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import worker from "../src/worker";

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

async function applyMigrations(db: D1Database) {
  const migrationsDir = join(process.cwd(), "drizzle");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), "utf-8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await db.prepare(statement).run();
    }
  }
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

    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "0 */6 * * *", noRetry() {} } as ScheduledEvent,
      env,
    );

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
