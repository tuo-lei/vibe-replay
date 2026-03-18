import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { type AuthEnv, createAuth } from "./auth";
import { replays } from "./db/schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Env = AuthEnv & {
  ASSETS: Fetcher;
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

const PROD_ORIGINS = ["https://vibe-replay.com"];
const DEV_ORIGINS = ["http://localhost:8787", "http://localhost:4321", "http://localhost:5173"];

app.use("/api/*", async (c, next) => {
  const isDev = c.env.BETTER_AUTH_URL?.startsWith("http://localhost");
  const allowed = isDev ? [...PROD_ORIGINS, ...DEV_ORIGINS] : PROD_ORIGINS;
  const mw = cors({
    origin: allowed,
    allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
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
  const setCookies = cookieNames.map(
    (name) => `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
  );
  return new Response(JSON.stringify({ success: true }), {
    headers: [
      ["Content-Type", "application/json"],
      ...setCookies.map((v): [string, string] => ["Set-Cookie", v]),
    ],
  });
});

app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  // Validate callbackURL on social sign-in to prevent open redirect
  if (c.req.path === "/api/auth/sign-in/social" && c.req.method === "POST") {
    const cloned = c.req.raw.clone();
    try {
      const body = await cloned.json();
      if (body.callbackURL && typeof body.callbackURL === "string") {
        // Only allow relative paths starting with /
        if (!body.callbackURL.startsWith("/") || body.callbackURL.startsWith("//")) {
          return c.json({ error: "Invalid callbackURL" }, 400);
        }
      }
    } catch {
      // Not JSON or parse error — let Better Auth handle it
    }
  }
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
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
<html><head><title>vibe-replay login</title></head>
<body style="background:#0a0a0f;color:#e6edf3;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>Redirecting to GitHub...</p>
<script>
fetch('/api/auth/sign-in/social',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',
body:JSON.stringify({provider:'github',callbackURL:'/auth/cli-complete?port=${encodeURIComponent(port)}&nonce=${encodeURIComponent(safeNonce)}'})
}).then(r=>r.json()).then(d=>{if(d.url)window.location.href=d.url;else document.body.textContent='Error: '+JSON.stringify(d);});
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
<html><head><title>vibe-replay login</title></head>
<body style="background:#0a0a0f;color:#ff5f57;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>Authentication failed. Please try again.</p></body></html>`);
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
  const safePayload = payloadJson.replace(/</g, "\\u003c").replace(/'/g, "\\u0027");
  // Prevent browser from caching a page that contains session token
  c.header("Cache-Control", "no-store");
  return c.html(`<!DOCTYPE html>
<html><head><title>vibe-replay login</title></head>
<body style="background:#0a0a0f;color:#e6edf3;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p id="msg">Completing login...</p>
<script>
fetch('http://127.0.0.1:${encodeURIComponent(port)}/callback',{method:'POST',headers:{'Content-Type':'application/json'},body:'${safePayload}'})
.then(()=>{document.getElementById('msg').textContent='Logged in! You can close this window.';document.getElementById('msg').style.color='#00e5a0';})
.catch(()=>{document.getElementById('msg').textContent='Failed to connect to CLI. Please try again.';document.getElementById('msg').style.color='#ff5f57';});
</script></body></html>`);
});

// ---------------------------------------------------------------------------
// Replay API — existing endpoints
// ---------------------------------------------------------------------------

/** Cache TTL: skip GitHub re-fetch if viewed within this window */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

app.get("/api/replays", async (c) => {
  const db = drizzle(c.env.DB);
  const url = new URL(c.req.url);
  const sort = url.searchParams.get("sort") || "recent";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);

  const orderCol = sort === "popular" ? desc(replays.viewCount) : desc(replays.createdAt);

  const results = await db
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

  return c.json(results);
});

app.post("/api/replays", async (c) => {
  return handlePostReplay(c);
});

// Legacy PUT — treat as POST for backwards compatibility
app.put("/api/replays", async (c) => {
  return handlePostReplay(c);
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
// Export
// ---------------------------------------------------------------------------

export default app;

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
    provider: String(meta.provider || "claude-code").slice(0, 50),
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
