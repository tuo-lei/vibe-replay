import { drizzle } from "drizzle-orm/d1";
import { desc, sql } from "drizzle-orm";
import { replays } from "./db/schema";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // API routes
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
      return Response.json({ error: "method not allowed" }, { status: 405 });
    }

    // Everything else: static assets
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

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
      duration_ms: replays.durationMs,
      view_count: replays.viewCount,
      created_at: replays.createdAt,
    })
    .from(replays)
    .orderBy(orderCol)
    .limit(limit);

  return Response.json(results, { headers: corsHeaders });
}

async function handlePostReplay(
  request: Request,
  env: Env,
): Promise<Response> {
  try {
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

    if (!/^[a-f0-9]{20,40}$/.test(body.gist_id)) {
      return Response.json({ error: "invalid gist_id" }, { status: 400 });
    }

    const title = (body.title || "Untitled").slice(0, 200);
    const provider = (body.provider || "claude-code").slice(0, 50);
    const model = body.model ? body.model.slice(0, 100) : null;
    const sceneCount = clamp(body.scene_count, 0, 100_000);
    const userPrompts = clamp(body.user_prompts, 0, 10_000);
    const durationMs = clamp(body.duration_ms, 0, 86_400_000);

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
}

function clamp(val: number | undefined, min: number, max: number): number {
  const n = Number(val) || 0;
  return Math.max(min, Math.min(max, n));
}
