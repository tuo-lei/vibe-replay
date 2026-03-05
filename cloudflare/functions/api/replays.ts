import { drizzle } from "drizzle-orm/d1";
import { desc, sql } from "drizzle-orm";
import { replays } from "../../src/db/schema";

interface Env {
  DB: D1Database;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// GET /api/replays — list recent replays
// ?sort=recent|popular&limit=50
export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  const db = drizzle(env.DB);
  const url = new URL(request.url);
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
      duration_ms: replays.durationMs,
      view_count: replays.viewCount,
      created_at: replays.createdAt,
    })
    .from(replays)
    .orderBy(orderCol)
    .limit(limit);

  return Response.json(results, { headers: corsHeaders });
};

// POST /api/replays — register/upsert a replay
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  try {
    // Basic size guard — reject bodies over 4KB
    const contentLength = request.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > 4096) {
      return Response.json({ error: "payload too large" }, { status: 413 });
    }

    const body = (await request.json()) as {
      gist_id: string;
      title?: string;
      provider?: string;
      model?: string;
      scene_count?: number;
      user_prompts?: number;
      duration_ms?: number;
    };

    if (!body.gist_id || typeof body.gist_id !== "string") {
      return Response.json({ error: "gist_id required" }, { status: 400 });
    }

    // gist_id: hex only, 20-40 chars (real GitHub gist IDs are 32 hex chars)
    if (!/^[a-f0-9]{20,40}$/.test(body.gist_id)) {
      return Response.json({ error: "invalid gist_id" }, { status: 400 });
    }

    // Truncate string fields to prevent oversized storage
    const title = (body.title || "Untitled").slice(0, 200);
    const provider = (body.provider || "claude-code").slice(0, 50);
    const model = body.model ? body.model.slice(0, 100) : null;

    // Clamp numeric fields to sane ranges
    const sceneCount = clamp(body.scene_count, 0, 100_000);
    const userPrompts = clamp(body.user_prompts, 0, 10_000);
    const durationMs = clamp(body.duration_ms, 0, 86_400_000); // max 24h

    const db = drizzle(env.DB);

    await db
      .insert(replays)
      .values({
        gistId: body.gist_id,
        title,
        provider,
        model,
        sceneCount,
        userPrompts,
        durationMs,
      })
      .onConflictDoUpdate({
        target: replays.gistId,
        set: {
          viewCount: sql`${replays.viewCount} + 1`,
          lastViewedAt: sql`datetime('now')`,
        },
      });

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch {
    return Response.json({ error: "internal error" }, { status: 500 });
  }
};

function clamp(val: number | undefined, min: number, max: number): number {
  const n = Number(val) || 0;
  return Math.max(min, Math.min(max, n));
}

// Handle CORS preflight
export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, { headers: corsHeaders });
};
