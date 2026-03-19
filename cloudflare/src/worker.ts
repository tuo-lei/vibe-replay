import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { nanoid } from "nanoid";
import { type AuthEnv, createAuth, DEV_ORIGINS, PROD_ORIGINS } from "./auth";
import { cloudReplays, replays } from "./db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Env = AuthEnv & {
  ASSETS: Fetcher;
  REPLAY_BUCKET: R2Bucket;
  /** GitHub App credentials for authenticated API access (5000 req/hr). */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
};

type HonoEnv = { Bindings: Env };

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<HonoEnv>();

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

app.use("/api/*", async (c, next) => {
  const isDev = c.env.BETTER_AUTH_URL?.startsWith("http://localhost");
  const mw = cors({
    origin: (origin) => {
      if (!origin) return PROD_ORIGINS[0];
      // Allow production origins
      if (PROD_ORIGINS.includes(origin)) return origin;
      // Allow any localhost origin (CLI dashboard uses random ports)
      if (origin.match(/^http:\/\/localhost(:\d+)?$/)) return origin;
      // In dev mode, allow additional dev origins
      if (isDev && DEV_ORIGINS.includes(origin)) return origin;
      return null;
    },
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });
  return mw(c, next);
});

// ---------------------------------------------------------------------------
// Better Auth — handles /api/auth/*
// ---------------------------------------------------------------------------

// Sign-out: Better Auth's CSRF middleware rejects same-origin POST requests
// that lack an Origin header (browsers omit it for same-origin fetch).
// Handle sign-out ourselves using the server-side API.
app.post("/api/auth/sign-out", async (c) => {
  const auth = createAuth(c.env);
  try {
    await auth.api.signOut({ headers: c.req.raw.headers });
  } catch {
    // Session may already be gone — still clear cookies
  }
  // Clear all Better Auth cookies
  const cookieNames = [
    "better-auth.session_token",
    "better-auth.session_data",
    "better-auth.dont_remember",
  ];
  const isDev = c.env.BETTER_AUTH_URL?.startsWith("http://localhost");
  const setCookies = cookieNames.map(
    (name) => `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isDev ? "" : "; Secure"}`,
  );
  return new Response(JSON.stringify({ success: true }), {
    headers: [
      ["Content-Type", "application/json"],
      ...setCookies.map((v): [string, string] => ["Set-Cookie", v]),
    ],
  });
});

app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  // Better Auth's CSRF middleware checks Origin against trusted origins.
  // Several issues can cause this to fail:
  // 1. Same-origin POST may omit Origin header entirely
  // 2. Referer fallback includes path+query which won't match
  // 3. Wrangler dev may rewrite Origin to the custom domain (http vs https)
  // Always set Origin to BETTER_AUTH_URL for POST requests.
  // Safe: CORS middleware already validated the request above.
  let req = c.req.raw;
  if (c.req.method === "POST") {
    const headers = new Headers(req.headers);
    headers.set("origin", c.env.BETTER_AUTH_URL);
    req = new Request(req.url, {
      method: req.method,
      headers,
      body: req.body,
      duplex: "half" as any,
    });
  }

  // Validate callbackURL on social sign-in to prevent open redirect
  if (c.req.path === "/api/auth/sign-in/social" && c.req.method === "POST") {
    const cloned = req.clone();
    try {
      const body = await cloned.json();
      if (body.callbackURL && typeof body.callbackURL === "string") {
        if (!body.callbackURL.startsWith("/") || body.callbackURL.startsWith("//")) {
          return c.json({ error: "Invalid callbackURL" }, 400);
        }
      }
    } catch {
      // Not JSON or parse error — let Better Auth handle it
    }
  }

  const auth = createAuth(c.env);
  return auth.handler(req);
});

// ---------------------------------------------------------------------------
// Login success page — shown after OAuth callback, auto-closes tab
// ---------------------------------------------------------------------------

app.get("/auth/success", (c) => {
  return c.html(`<!DOCTYPE html>
<html><head><title>vibe-replay - Logged in</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
.card{text-align:center;padding:3rem 2.5rem;border-radius:1rem;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.03);max-width:360px;width:100%}
.logo{font-weight:700;font-size:1.1rem;background:linear-gradient(to right,#00e5a0,#34d399,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1.5rem}
.icon{font-size:2rem;margin-bottom:.75rem;color:#00e5a0}
.title{font-size:1rem;font-weight:600;margin-bottom:.5rem;color:#00e5a0}
.msg{font-size:.875rem;color:#8b949e}
.countdown{font-size:.75rem;color:#484f58;margin-top:.75rem}
</style></head>
<body><div class="card">
<div class="logo">vibe-replay</div>
<div class="icon">&#10003;</div>
<p class="title">Logged in!</p>
<p class="msg">You can close this tab and return to the editor.</p>
<p class="countdown" id="cd"></p>
</div>
<script>
var s=5;
var cd=document.getElementById('cd');
cd.textContent='Auto-closing in '+s+'s...';
var t=setInterval(function(){s--;if(s<=0){clearInterval(t);window.close();}else{cd.textContent='Auto-closing in '+s+'s...';}},1000);
</script></body></html>`);
});

// ---------------------------------------------------------------------------
// CLI Login flow — browser-mediated OAuth for CLI tools
// ---------------------------------------------------------------------------

/** Step 1: CLI opens browser here. Auto-initiates GitHub OAuth. */
app.get("/auth/cli-login", (c) => {
  const port = c.req.query("port");
  const nonce = c.req.query("nonce");
  const portNum = Number(port);
  if (!port || !Number.isInteger(portNum) || portNum < 1024 || portNum > 65535) {
    return c.text("Invalid port parameter", 400);
  }
  if (!nonce || !/^[0-9a-f-]{36}$/.test(nonce)) {
    return c.text("Invalid nonce parameter", 400);
  }
  const safeNonce = nonce.replace(/'/g, "");
  return c.html(`<!DOCTYPE html>
<html><head><title>vibe-replay - Sign in</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
.card{text-align:center;padding:3rem 2.5rem;border-radius:1rem;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.03);max-width:360px;width:100%}
.logo{font-weight:700;font-size:1.1rem;background:linear-gradient(to right,#00e5a0,#34d399,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1.5rem}
.spinner{width:24px;height:24px;border:2.5px solid rgba(255,255,255,0.1);border-top-color:#00e5a0;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto 1rem}
@keyframes spin{to{transform:rotate(360deg)}}
.msg{font-size:.875rem;color:#8b949e}
</style></head>
<body><div class="card">
<div class="logo">vibe-replay</div>
<div class="spinner"></div>
<p class="msg">Redirecting to GitHub...</p>
</div>
<script>
fetch('/api/auth/sign-in/social',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',
body:JSON.stringify({provider:'github',callbackURL:'/auth/cli-complete?port=${encodeURIComponent(port)}&nonce=${encodeURIComponent(safeNonce)}'})
}).then(r=>r.json()).then(d=>{if(d.url)window.location.href=d.url;else document.querySelector('.msg').textContent='Error: '+JSON.stringify(d);});
</script></body></html>`);
});

/** Step 2: After OAuth callback, send session to CLI's localhost server. */
app.get("/auth/cli-complete", async (c) => {
  const port = c.req.query("port");
  const nonce = c.req.query("nonce");
  const portNum = Number(port);
  if (!port || !Number.isInteger(portNum) || portNum < 1024 || portNum > 65535) {
    return c.text("Invalid port parameter", 400);
  }
  if (!nonce || !/^[0-9a-f-]{36}$/.test(nonce)) {
    return c.text("Invalid nonce parameter", 400);
  }
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.html(`<!DOCTYPE html>
<html><head><title>vibe-replay - Error</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
.card{text-align:center;padding:3rem 2.5rem;border-radius:1rem;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.03);max-width:360px;width:100%}
.logo{font-weight:700;font-size:1.1rem;background:linear-gradient(to right,#00e5a0,#34d399,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1.5rem}
.icon{font-size:2rem;margin-bottom:.75rem}
.title{font-size:1rem;font-weight:600;margin-bottom:.5rem;color:#ff5f57}
.msg{font-size:.875rem;color:#8b949e}
</style></head>
<body><div class="card">
<div class="logo">vibe-replay</div>
<div class="icon">&#10007;</div>
<p class="title">Authentication failed</p>
<p class="msg">Please close this window and try again.</p>
</div></body></html>`);
  }
  const payload = {
    nonce,
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      image: session.user.image,
    },
    token: session.session.token,
  };
  const payloadJson = JSON.stringify(payload);
  // Escape for embedding in <script> — browsers close <script> on </
  // Escape for embedding in a single-quoted JS string inside <script>:
  // 1. \\ → \\\\ : JSON.stringify produces \\, but JS parses \\ back to \ which
  //    corrupts JSON.parse (e.g. \b becomes backspace). Must double-escape first.
  // 2. < → \u003c : prevents </script> closing the tag
  // 3. ' → \u0027 : prevents breaking out of the single-quoted string
  const safePayload = payloadJson
    .replace(/\\/g, "\\\\")
    .replace(/</g, "\\u003c")
    .replace(/'/g, "\\u0027");
  // Prevent browser from caching a page that contains session token
  c.header("Cache-Control", "no-store");
  return c.html(`<!DOCTYPE html>
<html><head><title>vibe-replay - Sign in</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0f;color:#e6edf3;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh}
.card{text-align:center;padding:3rem 2.5rem;border-radius:1rem;border:1px solid rgba(255,255,255,0.06);background:rgba(255,255,255,0.03);max-width:360px;width:100%}
.logo{font-weight:700;font-size:1.1rem;background:linear-gradient(to right,#00e5a0,#34d399,#22d3ee);-webkit-background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:1.5rem}
.spinner{width:24px;height:24px;border:2.5px solid rgba(255,255,255,0.1);border-top-color:#00e5a0;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto .75rem}
@keyframes spin{to{transform:rotate(360deg)}}
.icon{font-size:2rem;margin-bottom:.75rem;display:none}
.title{font-size:1rem;font-weight:600;margin-bottom:.5rem;display:none}
.msg{font-size:.875rem;color:#8b949e}
.countdown{font-size:.75rem;color:#484f58;margin-top:.75rem;display:none}
</style></head>
<body><div class="card">
<div class="logo">vibe-replay</div>
<div class="spinner" id="spinner"></div>
<div class="icon" id="icon"></div>
<p class="title" id="title"></p>
<p class="msg" id="msg">Completing login...</p>
<p class="countdown" id="countdown"></p>
</div>
<script>
fetch('http://127.0.0.1:${encodeURIComponent(port)}/callback',{method:'POST',headers:{'Content-Type':'application/json'},body:'${safePayload}'})
.then(()=>{
  document.getElementById('spinner').style.display='none';
  document.getElementById('icon').style.display='block';
  document.getElementById('icon').textContent='\\u2713';
  document.getElementById('title').style.display='block';
  document.getElementById('title').style.color='#00e5a0';
  document.getElementById('title').textContent='Logged in!';
  document.getElementById('msg').textContent='This window will close automatically.';
  var cd=document.getElementById('countdown');cd.style.display='block';
  var s=5;cd.textContent='Closing in '+s+'s...';
  var t=setInterval(function(){s--;if(s<=0){clearInterval(t);window.close();}else{cd.textContent='Closing in '+s+'s...';}},1000);
})
.catch(()=>{
  document.getElementById('spinner').style.display='none';
  document.getElementById('icon').style.display='block';
  document.getElementById('icon').textContent='\\u2717';
  document.getElementById('title').style.display='block';
  document.getElementById('title').style.color='#ff5f57';
  document.getElementById('title').textContent='Connection failed';
  document.getElementById('msg').textContent='Could not reach the CLI. Please try again.';
});
</script></body></html>`);
});

// ---------------------------------------------------------------------------
// Auth helper — require authenticated session
// ---------------------------------------------------------------------------

async function requireAuth(
  c: Context<HonoEnv>,
): Promise<{ userId: string; user: { id: string; name: string; email: string } } | Response> {
  const auth = createAuth(c.env);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return { userId: session.user.id, user: session.user };
}

// ---------------------------------------------------------------------------
// Cloud Replays API — R2-backed replay storage
// ---------------------------------------------------------------------------

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_TOTAL_STORAGE = 20 * 1024 * 1024; // 20 MB
const RETENTION_DAYS = 7;

/** Upload a replay to R2 */
app.post("/api/cloud-replays", async (c) => {
  const authResult = await requireAuth(c);
  if (authResult instanceof Response) return authResult;
  const { userId } = authResult;

  const body = await c.req.json();
  if (!body.replay || typeof body.replay !== "object") {
    return c.json({ error: "replay object required" }, 400);
  }
  const replayError = validateReplaySchema(body.replay);
  if (replayError) {
    return c.json({ error: replayError }, 400);
  }

  const visibility = body.visibility || "unlisted";
  if (!["public", "unlisted", "private"].includes(visibility)) {
    return c.json({ error: "Invalid visibility" }, 400);
  }

  const replayJson = JSON.stringify(body.replay);
  const sizeBytes = new TextEncoder().encode(replayJson).byteLength;
  if (sizeBytes > MAX_FILE_SIZE) {
    return c.json({ error: "File too large (max 10MB)" }, 413);
  }

  const db = drizzle(c.env.DB);
  // Only count R2 storage (gist entries have sizeBytes=0 but shouldn't pollute accounting)
  const userStorage = await db
    .select({ total: sql<number>`coalesce(sum(${cloudReplays.sizeBytes}), 0)` })
    .from(cloudReplays)
    .where(and(eq(cloudReplays.userId, userId), eq(cloudReplays.storageType, "r2")));
  if ((userStorage[0]?.total || 0) + sizeBytes > MAX_TOTAL_STORAGE) {
    return c.json({ error: "Storage quota exceeded (max 20MB)" }, 413);
  }

  const id = nanoid(12);
  const r2Key = `replays/${id}.json`;
  await c.env.REPLAY_BUCKET.put(r2Key, replayJson, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { userId },
  });

  const meta = body.replay.meta || {};
  const stats = meta.stats || {};
  const expiresAt = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);

  try {
    await db.insert(cloudReplays).values({
      id,
      userId,
      storageType: "r2",
      title: String(meta.title || meta.slug || "Untitled").slice(0, 200),
      provider: String(meta.provider || "unknown").slice(0, 50),
      model: meta.model ? String(meta.model).slice(0, 100) : null,
      sceneCount: clamp(stats.sceneCount, 0, 100_000),
      userPrompts: clamp(stats.userPrompts, 0, 10_000),
      toolCalls: clamp(stats.toolCalls, 0, 100_000),
      durationMs: clamp(stats.durationMs, 0, 86_400_000),
      costEstimate:
        stats.costEstimate != null
          ? String(Math.max(0, Math.min(Number(stats.costEstimate) || 0, 100_000)))
          : null,
      firstMessage: extractFirstUserPrompt(body.replay),
      sizeBytes,
      visibility,
      expiresAt,
    });
  } catch (e) {
    // D1 insert failed — clean up R2 object to prevent orphaning
    await c.env.REPLAY_BUCKET.delete(r2Key).catch(() => {});
    throw e;
  }

  const baseUrl = getBaseUrl(c);
  return c.json({ id, url: `${baseUrl}/r/${id}`, expiresAt });
});

/** Download a cloud replay */
app.get("/api/cloud-replays/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^[a-zA-Z0-9_-]{10,16}$/.test(id)) {
    return c.json({ error: "Invalid ID" }, 400);
  }

  const db = drizzle(c.env.DB);
  const [record] = await db.select().from(cloudReplays).where(eq(cloudReplays.id, id)).limit(1);
  if (!record) return c.json({ error: "Not found" }, 404);

  // expiresAt is stored as UTC without Z suffix (e.g. "2026-03-26 08:00:00")
  // Append Z to parse as UTC consistently with SQLite's datetime('now')
  if (
    record.expiresAt &&
    new Date(record.expiresAt.endsWith("Z") ? record.expiresAt : `${record.expiresAt}Z`) <
      new Date()
  ) {
    return c.json({ error: "Expired" }, 410);
  }

  if (record.visibility === "private") {
    const authResult = await requireAuth(c);
    if (authResult instanceof Response) return authResult;
    if (authResult.userId !== record.userId) {
      return c.json({ error: "Not found" }, 404);
    }
  }

  // Gist-backed replays: redirect to gist viewer
  if (record.storageType === "gist" && record.gistId) {
    await db
      .update(cloudReplays)
      .set({ viewCount: sql`${cloudReplays.viewCount} + 1` })
      .where(eq(cloudReplays.id, id));
    return c.json({
      redirect: true,
      gistId: record.gistId,
      viewerUrl: `/view/?gist=${record.gistId}`,
    });
  }

  const obj = await c.env.REPLAY_BUCKET.get(`replays/${id}.json`);
  if (!obj) return c.json({ error: "Not found" }, 404);

  await db
    .update(cloudReplays)
    .set({ viewCount: sql`${cloudReplays.viewCount} + 1` })
    .where(eq(cloudReplays.id, id));

  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control":
        record.visibility === "private" ? "private, no-store" : "public, max-age=300",
    },
  });
});

/** List current user's cloud replays */
app.get("/api/cloud-replays", async (c) => {
  const authResult = await requireAuth(c);
  if (authResult instanceof Response) return authResult;
  const { userId } = authResult;

  const db = drizzle(c.env.DB);
  const results = await db
    .select({
      id: cloudReplays.id,
      storageType: cloudReplays.storageType,
      gistId: cloudReplays.gistId,
      gistUrl: cloudReplays.gistUrl,
      title: cloudReplays.title,
      provider: cloudReplays.provider,
      model: cloudReplays.model,
      sceneCount: cloudReplays.sceneCount,
      userPrompts: cloudReplays.userPrompts,
      toolCalls: cloudReplays.toolCalls,
      durationMs: cloudReplays.durationMs,
      sizeBytes: cloudReplays.sizeBytes,
      visibility: cloudReplays.visibility,
      viewCount: cloudReplays.viewCount,
      createdAt: cloudReplays.createdAt,
      expiresAt: cloudReplays.expiresAt,
    })
    .from(cloudReplays)
    .where(eq(cloudReplays.userId, userId))
    .orderBy(desc(cloudReplays.createdAt))
    .limit(100);

  const storage = await db
    .select({ total: sql<number>`coalesce(sum(${cloudReplays.sizeBytes}), 0)` })
    .from(cloudReplays)
    .where(and(eq(cloudReplays.userId, userId), eq(cloudReplays.storageType, "r2")));

  return c.json({
    replays: results,
    storage: { used: storage[0]?.total || 0, limit: MAX_TOTAL_STORAGE },
  });
});

/** Update cloud replay visibility */
app.patch("/api/cloud-replays/:id", async (c) => {
  const authResult = await requireAuth(c);
  if (authResult instanceof Response) return authResult;
  const { userId } = authResult;

  const id = c.req.param("id");
  if (!/^[a-zA-Z0-9_-]{10,16}$/.test(id)) {
    return c.json({ error: "Invalid ID" }, 400);
  }

  const body = await c.req.json();
  const { visibility } = body;
  if (!visibility || !["public", "unlisted", "private"].includes(visibility)) {
    return c.json({ error: "Invalid visibility (must be public, unlisted, or private)" }, 400);
  }

  const db = drizzle(c.env.DB);
  const [record] = await db
    .select({ userId: cloudReplays.userId })
    .from(cloudReplays)
    .where(eq(cloudReplays.id, id))
    .limit(1);
  if (!record || record.userId !== userId) {
    return c.json({ error: "Not found" }, 404);
  }

  await db.update(cloudReplays).set({ visibility }).where(eq(cloudReplays.id, id));

  return c.json({ ok: true, visibility });
});

/** Delete a cloud replay */
app.delete("/api/cloud-replays/:id", async (c) => {
  const authResult = await requireAuth(c);
  if (authResult instanceof Response) return authResult;
  const { userId } = authResult;

  const id = c.req.param("id");
  if (!/^[a-zA-Z0-9_-]{10,16}$/.test(id)) {
    return c.json({ error: "Invalid ID" }, 400);
  }

  const db = drizzle(c.env.DB);
  const [record] = await db
    .select({ userId: cloudReplays.userId, storageType: cloudReplays.storageType })
    .from(cloudReplays)
    .where(eq(cloudReplays.id, id))
    .limit(1);
  if (!record || record.userId !== userId) {
    return c.json({ error: "Not found" }, 404);
  }

  const deletes: Promise<unknown>[] = [db.delete(cloudReplays).where(eq(cloudReplays.id, id))];
  if (record.storageType === "r2") {
    deletes.push(c.env.REPLAY_BUCKET.delete(`replays/${id}.json`));
  }
  await Promise.all(deletes);

  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Gist API — create/update gists using user's GitHub OAuth token
// ---------------------------------------------------------------------------

const MAX_GIST_CONTENT = 10 * 1024 * 1024; // 10 MB (GitHub allows up to 100MB per file)

/** Create a gist via GitHub API + register in cloud_replays */
app.post("/api/gists", async (c) => {
  const authResult = await requireAuth(c);
  if (authResult instanceof Response) return authResult;
  const { userId } = authResult;

  const body = await c.req.json();
  if (!body.filename || typeof body.filename !== "string" || body.filename.length > 255) {
    return c.json({ error: "filename required (max 255 chars)" }, 400);
  }
  if (/[/\\]/.test(body.filename)) {
    return c.json({ error: "Invalid filename" }, 400);
  }
  if (!body.content || typeof body.content !== "string") {
    return c.json({ error: "content required" }, 400);
  }
  if (new TextEncoder().encode(body.content).byteLength > MAX_GIST_CONTENT) {
    return c.json({ error: "Content too large" }, 413);
  }

  // Get GitHub access token via Better Auth
  const auth = createAuth(c.env);
  let accessToken: string;
  try {
    const result = await auth.api.getAccessToken({
      headers: c.req.raw.headers,
      body: { providerId: "github" },
    });
    if (!result?.accessToken) {
      return c.json({ error: "GitHub account not linked" }, 400);
    }
    accessToken = result.accessToken;
  } catch {
    return c.json({ error: "Failed to retrieve GitHub token" }, 500);
  }

  // Create gist via GitHub API
  const isPublic = body.public !== false;
  const gistResp = await fetch("https://api.github.com/gists", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "vibe-replay",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      description: body.description || `vibe-replay: ${body.filename}`,
      public: isPublic,
      files: { [body.filename]: { content: body.content } },
    }),
  });

  if (!gistResp.ok) {
    const err = await gistResp.text();
    console.error(`GitHub Gist API error (create): ${gistResp.status} ${err}`);
    const status = gistResp.status as number;
    const msg =
      status === 403
        ? "GitHub rejected the request (check OAuth permissions)"
        : status === 422
          ? "GitHub rejected the request (content too large?)"
          : `GitHub API error (${status})`;
    return c.json({ error: msg }, status as any);
  }

  const gistData = (await gistResp.json()) as {
    id: string;
    html_url: string;
    owner?: { login?: string };
  };
  const gistId = gistData.id;
  const gistUrl = gistData.html_url;
  const gistOwner = gistData.owner?.login || null;
  const viewerUrl = `${getBaseUrl(c)}/view/?gist=${gistId}`;

  // Extract replay metadata from content and write to cloud_replays
  const db = drizzle(c.env.DB);
  const replayMeta = extractMetaFromJson(body.content);
  // Migrate viewCount from legacy replays table if this gist was previously visited
  const [legacyRow] = await db
    .select({ viewCount: replays.viewCount })
    .from(replays)
    .where(eq(replays.gistId, gistId))
    .limit(1);
  const id = nanoid(12);

  await db.insert(cloudReplays).values({
    id,
    userId,
    storageType: "gist",
    gistId,
    gistUrl,
    gistOwner,
    title: replayMeta.title,
    provider: replayMeta.provider,
    model: replayMeta.model,
    sceneCount: replayMeta.sceneCount,
    userPrompts: replayMeta.userPrompts,
    toolCalls: replayMeta.toolCalls,
    durationMs: replayMeta.durationMs,
    costEstimate: replayMeta.costEstimate,
    firstMessage: replayMeta.firstMessage,
    sizeBytes: 0,
    visibility: isPublic ? "public" : "unlisted",
    viewCount: legacyRow?.viewCount || 0,
  });

  return c.json({ gistId, gistUrl, viewerUrl });
});

/** Update an existing gist */
app.patch("/api/gists/:gistId", async (c) => {
  const authResult = await requireAuth(c);
  if (authResult instanceof Response) return authResult;
  const { userId } = authResult;

  const gistId = c.req.param("gistId");
  if (!/^[a-f0-9]{20,40}$/.test(gistId)) {
    return c.json({ error: "Invalid gist ID" }, 400);
  }

  const body = await c.req.json();
  if (!body.filename || !body.content) {
    return c.json({ error: "filename and content required" }, 400);
  }

  const auth = createAuth(c.env);
  let accessToken: string;
  try {
    const result = await auth.api.getAccessToken({
      headers: c.req.raw.headers,
      body: { providerId: "github" },
    });
    if (!result?.accessToken) {
      return c.json({ error: "GitHub account not linked" }, 400);
    }
    accessToken = result.accessToken;
  } catch {
    return c.json({ error: "Failed to retrieve GitHub token" }, 500);
  }

  // Verify ownership — check cloud_replays record
  const db = drizzle(c.env.DB);
  const [existing] = await db
    .select({ userId: cloudReplays.userId })
    .from(cloudReplays)
    .where(eq(cloudReplays.gistId, gistId))
    .limit(1);

  if (existing && existing.userId !== userId) {
    return c.json({ error: "Not found" }, 404);
  }

  // Update gist on GitHub first (confirms ownership before any D1 writes)
  const gistResp = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "vibe-replay",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      description: body.description,
      files: { [body.filename]: { content: body.content } },
    }),
  });

  if (!gistResp.ok) {
    const err = await gistResp.text();
    console.error(`GitHub Gist API error: ${gistResp.status} ${err}`);
    const status = gistResp.status as number;
    const msg =
      status === 403
        ? "You don't have permission to edit this gist"
        : status === 404
          ? "Gist not found on GitHub"
          : status === 422
            ? "GitHub rejected the update (content too large?)"
            : `GitHub API error (${status})`;
    return c.json({ error: msg }, status as any);
  }

  const gistData = (await gistResp.json()) as {
    id: string;
    html_url: string;
    owner?: { login?: string };
  };

  // Backfill D1 record for legacy gists (only after GitHub confirms ownership via PATCH success)
  if (!existing) {
    const replayMeta = extractMetaFromJson(body.content);
    // Migrate viewCount from legacy replays table if available
    const [legacyRow] = await db
      .select({ viewCount: replays.viewCount })
      .from(replays)
      .where(eq(replays.gistId, gistId))
      .limit(1);
    const id = nanoid(12);
    await db.insert(cloudReplays).values({
      id,
      userId,
      storageType: "gist",
      gistId,
      gistUrl: gistData.html_url,
      gistOwner: gistData.owner?.login || null,
      title: replayMeta.title || "Untitled",
      provider: replayMeta.provider || "unknown",
      model: replayMeta.model || null,
      sceneCount: replayMeta.sceneCount || 0,
      userPrompts: replayMeta.userPrompts || 0,
      toolCalls: replayMeta.toolCalls || 0,
      durationMs: replayMeta.durationMs || 0,
      costEstimate: replayMeta.costEstimate || null,
      firstMessage: replayMeta.firstMessage || null,
      sizeBytes: 0,
      visibility: "public",
      viewCount: legacyRow?.viewCount || 0,
    });
  }

  // Update metadata only for pre-existing records (backfill already sets all fields)
  if (existing) {
    const replayMeta = extractMetaFromJson(body.content);
    await db
      .update(cloudReplays)
      .set({
        title: replayMeta.title,
        provider: replayMeta.provider,
        model: replayMeta.model,
        sceneCount: replayMeta.sceneCount,
        userPrompts: replayMeta.userPrompts,
        toolCalls: replayMeta.toolCalls,
        durationMs: replayMeta.durationMs,
        costEstimate: replayMeta.costEstimate,
        firstMessage: replayMeta.firstMessage,
      })
      .where(and(eq(cloudReplays.gistId, gistId), eq(cloudReplays.userId, userId)));
  }

  return c.json({
    gistId: gistData.id,
    gistUrl: gistData.html_url,
    viewerUrl: `${getBaseUrl(c)}/view/?gist=${gistData.id}`,
  });
});

// ---------------------------------------------------------------------------
// Replay API — existing endpoints (kept for backward compat)
// ---------------------------------------------------------------------------

/** Cache TTL: skip GitHub re-fetch if viewed within this window */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

app.get("/api/replays", async (c) => {
  const db = drizzle(c.env.DB);
  const url = new URL(c.req.url);
  const sort = url.searchParams.get("sort") || "recent";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);

  const orderCol = sort === "popular" ? desc(replays.viewCount) : desc(replays.createdAt);

  // Legacy gist replays
  const gistResults = await db
    .select({
      gist_id: replays.gistId,
      title: replays.title,
      provider: replays.provider,
      model: replays.model,
      scene_count: replays.sceneCount,
      user_prompts: replays.userPrompts,
      tool_calls: replays.toolCalls,
      duration_ms: replays.durationMs,
      cost_estimate: replays.costEstimate,
      first_message: replays.firstMessage,
      gist_owner: replays.gistOwner,
      view_count: replays.viewCount,
      created_at: replays.createdAt,
    })
    .from(replays)
    .orderBy(orderCol)
    .limit(limit);

  // Public cloud replays (not expired)
  const cloudOrderCol =
    sort === "popular" ? desc(cloudReplays.viewCount) : desc(cloudReplays.createdAt);
  const cloudResults = await db
    .select({
      id: cloudReplays.id,
      storageType: cloudReplays.storageType,
      gistId: cloudReplays.gistId,
      gistOwner: cloudReplays.gistOwner,
      title: cloudReplays.title,
      provider: cloudReplays.provider,
      model: cloudReplays.model,
      scene_count: cloudReplays.sceneCount,
      user_prompts: cloudReplays.userPrompts,
      tool_calls: cloudReplays.toolCalls,
      duration_ms: cloudReplays.durationMs,
      cost_estimate: cloudReplays.costEstimate,
      first_message: cloudReplays.firstMessage,
      view_count: cloudReplays.viewCount,
      created_at: cloudReplays.createdAt,
    })
    .from(cloudReplays)
    .where(
      and(
        eq(cloudReplays.visibility, "public"),
        sql`(${cloudReplays.expiresAt} IS NULL OR ${cloudReplays.expiresAt} > datetime('now'))`,
      ),
    )
    .orderBy(cloudOrderCol)
    .limit(limit);

  // Merge and sort
  const merged = [
    ...gistResults.map((r) => ({ ...r, type: "gist" as const })),
    ...cloudResults.map((r) => ({
      gist_id: r.gistId || null,
      title: r.title,
      provider: r.provider,
      model: r.model,
      scene_count: r.scene_count,
      user_prompts: r.user_prompts,
      tool_calls: r.tool_calls,
      duration_ms: r.duration_ms,
      cost_estimate: r.cost_estimate,
      first_message: r.first_message,
      gist_owner: r.gistOwner || null,
      view_count: r.view_count,
      created_at: r.created_at,
      type: (r.storageType === "gist" ? "gist" : "cloud") as "gist" | "cloud",
      cloud_id: r.storageType === "r2" ? r.id : undefined,
    })),
  ];

  // Deduplicate: if a gist exists in cloud_replays, skip the legacy replays entry
  const cloudGistIds = new Set(cloudResults.filter((r) => r.gistId).map((r) => r.gistId));
  const deduped = merged.filter((r, i) => {
    // Keep all cloud_replays entries (they come after gistResults in the array)
    if (i >= gistResults.length) return true;
    // For legacy gist entries, skip if already in cloud_replays
    return !r.gist_id || !cloudGistIds.has(r.gist_id);
  });

  // Sort
  deduped.sort((a, b) => {
    if (sort === "popular") return (b.view_count || 0) - (a.view_count || 0);
    return (b.created_at || "").localeCompare(a.created_at || "");
  });

  return c.json(deduped.slice(0, limit));
});

/** Increment view count for a gist-backed cloud replay (by gist ID, no auth required) */
app.post("/api/cloud-replays/view-gist/:gistId", async (c) => {
  const gistId = c.req.param("gistId");
  if (!/^[a-f0-9]{20,40}$/.test(gistId)) {
    return c.json({ ok: false }, 400);
  }
  const db = drizzle(c.env.DB);
  await db
    .update(cloudReplays)
    .set({ viewCount: sql`${cloudReplays.viewCount} + 1` })
    .where(eq(cloudReplays.gistId, gistId));
  return c.json({ ok: true });
});

/** @deprecated Legacy endpoint — kept for backward compat with old viewer builds.
 * New gist publishes go through POST /api/gists (authenticated). */
app.post("/api/replays", async (c) => {
  return handlePostReplay(c);
});

/** @deprecated Legacy PUT — treat as POST for backwards compatibility */
app.put("/api/replays", async (c) => {
  return handlePostReplay(c);
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Short URL for cloud replays — redirect to viewer
// ---------------------------------------------------------------------------

app.get("/r/:id", (c) => {
  const id = c.req.param("id");
  if (!/^[a-zA-Z0-9_-]{10,16}$/.test(id)) {
    return c.text("Not Found", 404);
  }
  const baseUrl = getBaseUrl(c);
  return c.redirect(`${baseUrl}/view/?cloud=${id}`);
});

// ---------------------------------------------------------------------------
// Fallback — serve static assets (Astro website)
// ---------------------------------------------------------------------------

app.all("*", (c) => {
  if (!c.env.ASSETS) {
    return c.text("Not Found", 404);
  }
  return c.env.ASSETS.fetch(c.req.raw);
});

// ---------------------------------------------------------------------------
// Fallback helpers
// ---------------------------------------------------------------------------

function getBaseUrl(c: Context<HonoEnv>): string {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}`;
}

/**
 * Validate that an uploaded replay has the minimum required structure.
 * Returns an error message string or null if valid.
 * Intentionally loose — only checks fields the viewer needs to render.
 */
function validateReplaySchema(replay: any): string | null {
  if (!replay.meta || typeof replay.meta !== "object") {
    return "Missing meta object";
  }
  if (!replay.meta.sessionId || typeof replay.meta.sessionId !== "string") {
    return "Missing meta.sessionId";
  }
  if (!replay.meta.provider || typeof replay.meta.provider !== "string") {
    return "Missing meta.provider";
  }
  if (!Array.isArray(replay.scenes)) {
    return "Missing scenes array";
  }
  // Validate scenes have a type field (don't enforce specific types — future-proof)
  for (let i = 0; i < Math.min(replay.scenes.length, 5); i++) {
    const scene = replay.scenes[i];
    if (!scene || typeof scene.type !== "string") {
      return `Invalid scene at index ${i}: missing type`;
    }
  }
  return null;
}

function extractFirstUserPrompt(replay: any): string | null {
  const scenes = replay?.scenes;
  if (!Array.isArray(scenes)) return null;
  const first = scenes.find((s: any) => s.type === "user-prompt");
  return first?.content ? String(first.content).slice(0, 300) : null;
}

interface ReplayMetaSummary {
  title: string;
  provider: string;
  model: string | null;
  sceneCount: number;
  userPrompts: number;
  toolCalls: number;
  durationMs: number;
  costEstimate: string | null;
  firstMessage: string | null;
}

/** Extract replay metadata from raw JSON string (used by gist endpoints) */
function extractMetaFromJson(json: string): ReplayMetaSummary {
  const meta = extractMeta(json);
  const firstMessage = extractFirstMessage(json);
  if (!meta) {
    return {
      title: "Untitled",
      provider: "claude-code",
      model: null,
      sceneCount: 0,
      userPrompts: 0,
      toolCalls: 0,
      durationMs: 0,
      costEstimate: null,
      firstMessage,
    };
  }
  const stats = meta.stats || {};
  return {
    title: String(meta.title || meta.project || "Untitled").slice(0, 200),
    provider: String(meta.provider || "unknown").slice(0, 50),
    model: meta.model ? String(meta.model).slice(0, 100) : null,
    sceneCount: clamp(stats.sceneCount, 0, 100_000),
    userPrompts: clamp(stats.userPrompts, 0, 10_000),
    toolCalls: clamp(stats.toolCalls, 0, 100_000),
    durationMs: clamp(stats.durationMs, 0, 86_400_000),
    costEstimate:
      stats.costEstimate != null
        ? String(Math.max(0, Math.min(Number(stats.costEstimate) || 0, 100_000)))
        : null,
    firstMessage,
  };
}

// ---------------------------------------------------------------------------
// Export — fetch + scheduled (cron for expired replay cleanup)
// ---------------------------------------------------------------------------

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env) {
    const db = drizzle(env.DB);
    const BATCH = 50;
    // R2 grace period: keep data 7 days after expiry for potential recovery.
    // GET already returns 410 once expiresAt passes (soft delete).
    // Cron deletes R2 objects after grace period, zeros sizeBytes to free quota.
    // D1 rows are kept permanently for history/analytics.
    const GRACE_DAYS = 7;
    for (;;) {
      const expired = await db
        .select({ id: cloudReplays.id })
        .from(cloudReplays)
        .where(
          sql`${cloudReplays.expiresAt} IS NOT NULL AND ${cloudReplays.expiresAt} < datetime('now', '-${GRACE_DAYS} days') AND ${cloudReplays.sizeBytes} > 0`,
        )
        .limit(BATCH);

      if (expired.length === 0) break;

      const expiredIds = expired.map(({ id }) => id);
      for (const id of expiredIds) {
        await env.REPLAY_BUCKET.delete(`replays/${id}.json`);
      }
      // Zero out sizeBytes in bulk (frees quota, marks as cleaned)
      await db
        .update(cloudReplays)
        .set({ sizeBytes: 0 })
        .where(inArray(cloudReplays.id, expiredIds));

      if (expired.length < BATCH) break;
    }
  },
};

// ---------------------------------------------------------------------------
// POST /api/replays — register or refresh a replay
// ---------------------------------------------------------------------------

async function handlePostReplay(c: { env: Env; req: { json: () => Promise<any> } }) {
  try {
    const body = await c.req.json();

    if (!body.gist_id || typeof body.gist_id !== "string") {
      return Response.json({ error: "gist_id required" }, { status: 400 });
    }
    if (!/^[a-f0-9]{20,40}$/.test(body.gist_id)) {
      return Response.json({ error: "invalid gist_id" }, { status: 400 });
    }

    const db = drizzle(c.env.DB);
    const gistId = body.gist_id;

    // Check if row exists and whether cache is still fresh
    const existing = await db
      .select({ lastViewedAt: replays.lastViewedAt })
      .from(replays)
      .where(eq(replays.gistId, gistId))
      .limit(1);

    if (existing.length > 0) {
      const lastViewed = existing[0].lastViewedAt;
      const isFresh =
        lastViewed && Date.now() - new Date(`${lastViewed}Z`).getTime() < CACHE_TTL_MS;

      if (isFresh) {
        await db
          .update(replays)
          .set({
            viewCount: sql`${replays.viewCount} + 1`,
            lastViewedAt: sql`datetime('now')`,
          })
          .where(eq(replays.gistId, gistId));

        return Response.json({ ok: true, cached: true });
      }

      // Stale — re-fetch from GitHub and update
      const meta = await fetchGistMeta(gistId, await getInstallationToken(c.env));
      if (!meta) {
        await db
          .update(replays)
          .set({
            viewCount: sql`${replays.viewCount} + 1`,
            lastViewedAt: sql`datetime('now')`,
          })
          .where(eq(replays.gistId, gistId));

        return Response.json({ ok: true, cached: true });
      }

      await db
        .update(replays)
        .set({
          ...meta,
          viewCount: sql`${replays.viewCount} + 1`,
          lastViewedAt: sql`datetime('now')`,
        })
        .where(eq(replays.gistId, gistId));

      return Response.json({ ok: true, updated: true });
    }

    // New — fetch from GitHub and insert
    const meta = await fetchGistMeta(gistId, await getInstallationToken(c.env));
    if (!meta) {
      return Response.json({ error: "not a valid vibe-replay gist" }, { status: 400 });
    }

    await db.insert(replays).values({ gistId, ...meta });

    return Response.json({ ok: true, created: true });
  } catch {
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// GitHub App authentication — JWT + installation token
// ---------------------------------------------------------------------------

/** Cached installation token (valid for ~1 hour, we refresh at 50 min) */
let cachedInstallToken: { token: string; expiresAt: number } | null = null;

function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binaryStr = atob(pemBody);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);

  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      bytes.buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    const pkcs8 = wrapPkcs1InPkcs8(bytes);
    return await crypto.subtle.importKey(
      "pkcs8",
      pkcs8.buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
}

function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  const rsaOid = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const octetHeader = encodeDerLength(0x04, pkcs1.length);
  const innerLen = version.length + rsaOid.length + octetHeader.length + pkcs1.length;
  const seqHeader = encodeDerLength(0x30, innerLen);
  const result = new Uint8Array(seqHeader.length + innerLen);
  let offset = 0;
  result.set(seqHeader, offset);
  offset += seqHeader.length;
  result.set(version, offset);
  offset += version.length;
  result.set(rsaOid, offset);
  offset += rsaOid.length;
  result.set(octetHeader, offset);
  offset += octetHeader.length;
  result.set(pkcs1, offset);
  return result;
}

function encodeDerLength(tag: number, length: number): Uint8Array {
  if (length < 0x80) return new Uint8Array([tag, length]);
  if (length < 0x100) return new Uint8Array([tag, 0x81, length]);
  return new Uint8Array([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
}

async function createAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(
    new TextEncoder().encode(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })),
  );
  const signingInput = `${header}.${payload}`;
  const key = await importPrivateKey(privateKeyPem);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(sig)}`;
}

async function getInstallationToken(env: Env): Promise<string | null> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_INSTALLATION_ID) {
    return null;
  }

  if (cachedInstallToken && Date.now() < cachedInstallToken.expiresAt - 10 * 60 * 1000) {
    return cachedInstallToken.token;
  }

  try {
    const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
    const resp = await fetch(
      `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "vibe-replay-worker",
        },
      },
    );

    if (!resp.ok) {
      const body = await resp.text();
      console.error(`GitHub App token exchange failed: ${resp.status} ${body}`);
      return null;
    }

    const data = (await resp.json()) as { token: string; expires_at: string };
    cachedInstallToken = {
      token: data.token,
      expiresAt: new Date(data.expires_at).getTime(),
    };
    return data.token;
  } catch (err) {
    console.error(`GitHub App auth error: ${err}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fetch gist metadata from GitHub
// ---------------------------------------------------------------------------

interface GistMeta {
  title: string;
  provider: string;
  model: string | null;
  sceneCount: number;
  userPrompts: number;
  toolCalls: number;
  durationMs: number;
  costEstimate: string | null;
  firstMessage: string | null;
  gistOwner: string | null;
}

async function fetchGistMeta(
  gistId: string,
  installToken?: string | null,
): Promise<GistMeta | null> {
  const headers: Record<string, string> = {
    "User-Agent": "vibe-replay-worker",
    Accept: "application/vnd.github+json",
  };
  if (installToken) {
    headers.Authorization = `token ${installToken}`;
  }
  let gistResp = await fetch(`https://api.github.com/gists/${gistId}`, { headers });
  if (!gistResp.ok && installToken && (gistResp.status === 404 || gistResp.status === 403)) {
    delete headers.Authorization;
    gistResp = await fetch(`https://api.github.com/gists/${gistId}`, { headers });
  }
  if (!gistResp.ok) return null;

  const gistData = (await gistResp.json()) as {
    owner?: { login?: string };
    files?: Record<
      string,
      {
        filename?: string;
        raw_url?: string;
        truncated?: boolean;
        content?: string;
        size?: number;
      }
    >;
  };

  const jsonFile = Object.values(gistData.files || {}).find((f) => f.filename?.endsWith(".json"));
  if (!jsonFile) return null;

  let content: string;
  if (jsonFile.content) {
    content = jsonFile.content;
  } else if (jsonFile.raw_url) {
    const rawResp = await fetch(jsonFile.raw_url, {
      headers: { "User-Agent": "vibe-replay-worker" },
    });
    if (!rawResp.ok) return null;
    content = await rawResp.text();
  } else {
    return null;
  }

  const meta = extractMeta(content);
  if (!meta) return null;

  const firstMessage = extractFirstMessage(content);
  const stats = meta.stats || {};
  const gistOwner = gistData.owner?.login || null;

  return {
    title: String(meta.title || meta.project || "Untitled").slice(0, 200),
    provider: String(meta.provider || "unknown").slice(0, 50),
    model: meta.model ? String(meta.model).slice(0, 100) : null,
    sceneCount: clamp(stats.sceneCount, 0, 100_000),
    userPrompts: clamp(stats.userPrompts, 0, 10_000),
    toolCalls: clamp(stats.toolCalls, 0, 100_000),
    durationMs: clamp(stats.durationMs, 0, 86_400_000),
    costEstimate:
      stats.costEstimate != null
        ? String(Math.max(0, Math.min(Number(stats.costEstimate) || 0, 100_000)))
        : null,
    firstMessage,
    gistOwner,
  };
}

function extractMeta(json: string): any | null {
  const metaKey = '"meta"';
  const idx = json.indexOf(metaKey);
  if (idx === -1 || idx > 100) return null;

  const colonIdx = json.indexOf(":", idx + metaKey.length);
  if (colonIdx === -1) return null;
  const braceStart = json.indexOf("{", colonIdx);
  if (braceStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = braceStart; i < json.length; i++) {
    const ch = json[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(json.slice(braceStart, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function extractFirstMessage(json: string): string | null {
  const marker = '"user-prompt"';
  const idx = json.indexOf(marker);
  if (idx === -1) return null;

  const objStart = json.lastIndexOf("{", idx);
  if (objStart === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = objStart; i < json.length && i < objStart + 5000; i++) {
    const ch = json[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const scene = JSON.parse(json.slice(objStart, i + 1));
          if (scene.type === "user-prompt" && typeof scene.content === "string") {
            return scene.content.slice(0, 300);
          }
        } catch {
          /* fall through */
        }
        return null;
      }
    }
  }
  return null;
}

function clamp(val: number | undefined, min: number, max: number): number {
  const n = Number(val) || 0;
  return Math.max(min, Math.min(max, n));
}
