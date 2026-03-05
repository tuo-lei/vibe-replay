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

    if (!/^[a-f0-9]+$/.test(body.gist_id)) {
      return Response.json({ error: "invalid gist_id" }, { status: 400 });
    }

    const db = drizzle(env.DB);

    await db
      .insert(replays)
      .values({
        gistId: body.gist_id,
        title: body.title || "Untitled",
        provider: body.provider || "claude-code",
        model: body.model || null,
        sceneCount: body.scene_count || 0,
        userPrompts: body.user_prompts || 0,
        durationMs: body.duration_ms || 0,
      })
      .onConflictDoUpdate({
        target: replays.gistId,
        set: {
          viewCount: sql`${replays.viewCount} + 1`,
          lastViewedAt: sql`datetime('now')`,
        },
      });

    return Response.json({ ok: true }, { headers: corsHeaders });
  } catch (e: any) {
    return Response.json({ error: e.message }, { status: 500 });
  }
};

// Handle CORS preflight
export const onRequestOptions: PagesFunction = async () => {
  return new Response(null, { headers: corsHeaders });
};
