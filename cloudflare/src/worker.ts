import { drizzle } from "drizzle-orm/d1";
import { desc, eq, sql } from "drizzle-orm";
import { replays } from "./db/schema";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** GitHub App credentials for authenticated API access (5000 req/hr). */
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Cache TTL: skip GitHub re-fetch if viewed within this window */
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// GitHub App authentication — JWT + installation token
// ---------------------------------------------------------------------------

/** Cached installation token (valid for ~1 hour, we refresh at 50 min) */
let cachedInstallToken: { token: string; expiresAt: number } | null = null;

/** Base64url encode a buffer */
function base64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Parse PEM private key → CryptoKey for RS256 signing */
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

  // Try PKCS#8 first, fall back to PKCS#1
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      bytes.buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    // GitHub App keys are typically PKCS#1 — wrap in PKCS#8
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

/** Wrap a PKCS#1 RSAPrivateKey in a PKCS#8 PrivateKeyInfo envelope */
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
  // PKCS#8 header for RSA: SEQUENCE { version, AlgorithmIdentifier { rsaEncryption, NULL }, OCTET STRING { pkcs1 } }
  const rsaOid = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);

  // Encode OCTET STRING wrapping pkcs1
  const octetHeader = encodeDerLength(0x04, pkcs1.length);

  // Total inner length
  const innerLen = version.length + rsaOid.length + octetHeader.length + pkcs1.length;
  const seqHeader = encodeDerLength(0x30, innerLen);

  const result = new Uint8Array(seqHeader.length + innerLen);
  let offset = 0;
  result.set(seqHeader, offset); offset += seqHeader.length;
  result.set(version, offset); offset += version.length;
  result.set(rsaOid, offset); offset += rsaOid.length;
  result.set(octetHeader, offset); offset += octetHeader.length;
  result.set(pkcs1, offset);
  return result;
}

/** Encode a DER tag + length prefix */
function encodeDerLength(tag: number, length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([tag, length]);
  }
  if (length < 0x100) {
    return new Uint8Array([tag, 0x81, length]);
  }
  return new Uint8Array([tag, 0x82, (length >> 8) & 0xff, length & 0xff]);
}

/** Create a signed JWT for GitHub App authentication */
async function createAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = base64url(
    new TextEncoder().encode(
      JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const key = await importPrivateKey(privateKeyPem);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${base64url(sig)}`;
}

/** Get an installation access token, with caching */
async function getInstallationToken(env: Env): Promise<string | null> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_INSTALLATION_ID) {
    return null;
  }

  // Return cached token if still valid (refresh 10 min before expiry)
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/replays") {
      if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
      }
      if (request.method === "GET") {
        return handleGetReplays(url, env);
      }
      if (request.method === "POST") {
        return handlePostReplay(request, env);
      }
      // Legacy PUT — treat as POST for backwards compatibility
      if (request.method === "PUT") {
        return handlePostReplay(request, env);
      }
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// GET /api/replays — list public replays
// ---------------------------------------------------------------------------
async function handleGetReplays(url: URL, env: Env): Promise<Response> {
  const db = drizzle(env.DB);
  const sort = url.searchParams.get("sort") || "recent";
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);

  const orderCol =
    sort === "popular" ? desc(replays.viewCount) : desc(replays.createdAt);

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

  return Response.json(results, { headers: corsHeaders });
}

// ---------------------------------------------------------------------------
// POST /api/replays — register or refresh a replay
//
// Body: { gist_id: string }
// Nothing else — worker fetches metadata from GitHub gist content.
//
// - New gist_id → fetch from GitHub, INSERT
// - Existing + lastViewedAt within 1h → just bump viewCount (cached)
// - Existing + stale → re-fetch from GitHub, UPDATE metadata + bump viewCount
// ---------------------------------------------------------------------------
async function handlePostReplay(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
    const body = (await request.json()) as { gist_id: string };

    if (!body.gist_id || typeof body.gist_id !== "string") {
      return Response.json({ error: "gist_id required" }, { status: 400 });
    }
    if (!/^[a-f0-9]{20,40}$/.test(body.gist_id)) {
      return Response.json({ error: "invalid gist_id" }, { status: 400 });
    }

    const db = drizzle(env.DB);
    const gistId = body.gist_id;

    // Check if row exists and whether cache is still fresh
    const existing = await db
      .select({
        lastViewedAt: replays.lastViewedAt,
      })
      .from(replays)
      .where(eq(replays.gistId, gistId))
      .limit(1);

    if (existing.length > 0) {
      const lastViewed = existing[0].lastViewedAt;
      const isFresh =
        lastViewed &&
        Date.now() - new Date(lastViewed + "Z").getTime() < CACHE_TTL_MS;

      if (isFresh) {
        // Cache hit — just bump view count, skip GitHub fetch
        await db
          .update(replays)
          .set({
            viewCount: sql`${replays.viewCount} + 1`,
            lastViewedAt: sql`datetime('now')`,
          })
          .where(eq(replays.gistId, gistId));

        return Response.json({ ok: true, cached: true }, { headers: corsHeaders });
      }

      // Stale — re-fetch from GitHub and update
      const meta = await fetchGistMeta(gistId, await getInstallationToken(env));
      if (!meta) {
        // Gist gone or not a valid replay — still bump view count
        await db
          .update(replays)
          .set({
            viewCount: sql`${replays.viewCount} + 1`,
            lastViewedAt: sql`datetime('now')`,
          })
          .where(eq(replays.gistId, gistId));

        return Response.json({ ok: true, cached: true }, { headers: corsHeaders });
      }

      await db
        .update(replays)
        .set({
          ...meta,
          viewCount: sql`${replays.viewCount} + 1`,
          lastViewedAt: sql`datetime('now')`,
        })
        .where(eq(replays.gistId, gistId));

      return Response.json({ ok: true, updated: true }, { headers: corsHeaders });
    }

    // New — fetch from GitHub and insert
    const meta = await fetchGistMeta(gistId, await getInstallationToken(env));
    if (!meta) {
      return Response.json({ error: "not a valid vibe-replay gist" }, { status: 400 });
    }

    await db.insert(replays).values({
      gistId,
      ...meta,
    });

    return Response.json({ ok: true, created: true }, { headers: corsHeaders });
  } catch {
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// Fetch gist from GitHub public API and extract replay metadata.
// Returns null if gist not found or doesn't contain valid replay JSON.
// Only parses the "meta" object — does NOT load the full scenes array.
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

async function fetchGistMeta(gistId: string, installToken?: string | null): Promise<GistMeta | null> {
  // 1. Fetch gist metadata from GitHub API
  const headers: Record<string, string> = {
    "User-Agent": "vibe-replay-worker",
    Accept: "application/vnd.github+json",
  };
  if (installToken) {
    headers.Authorization = `token ${installToken}`;
  }
  let gistResp = await fetch(`https://api.github.com/gists/${gistId}`, { headers });
  // If authenticated request fails (App may lack Gists permission), retry unauthenticated
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

  // 2. Find the JSON file
  const jsonFile = Object.values(gistData.files || {}).find((f) =>
    f.filename?.endsWith(".json"),
  );
  if (!jsonFile) return null;

  // 3. Get content — prefer inline content (even if truncated, since we only
  //    need the first few KB for meta + first message), fall back to raw_url.
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

  // 4. Extract meta without parsing the full JSON.
  //    replay.json structure: {"meta":{...},"scenes":[...]}
  //    We find the meta object boundary and parse just that.
  const meta = extractMeta(content);
  if (!meta) return null;

  // 5. Extract first user prompt (scan for first "user-prompt" scene)
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

/**
 * Extract the "meta" object from replay JSON without parsing the full file.
 * Looks for `"meta":` near the start and tracks brace depth to find its end.
 */
function extractMeta(json: string): any | null {
  const metaKey = '"meta"';
  const idx = json.indexOf(metaKey);
  if (idx === -1 || idx > 100) return null; // meta should be near the top

  // Find the opening brace after "meta":
  const colonIdx = json.indexOf(":", idx + metaKey.length);
  if (colonIdx === -1) return null;
  const braceStart = json.indexOf("{", colonIdx);
  if (braceStart === -1) return null;

  // Track brace depth to find the matching close
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

/**
 * Extract the first user-prompt content from replay JSON without full parse.
 * Scans for `"type":"user-prompt"` and extracts the nearby "content" field.
 */
function extractFirstMessage(json: string): string | null {
  const marker = '"user-prompt"';
  const idx = json.indexOf(marker);
  if (idx === -1) return null;

  // Look backwards for the opening brace of this scene object
  let objStart = json.lastIndexOf("{", idx);
  if (objStart === -1) return null;

  // Find the matching closing brace
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = objStart; i < json.length && i < objStart + 5000; i++) {
    const ch = json[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
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
        } catch { /* fall through */ }
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
