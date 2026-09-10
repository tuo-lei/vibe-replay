/**
 * Featured public Explore gallery entries.
 *
 * `/explore/` reads D1 `replays`. Homepage/blog gist URLs work via `/view/?gist=`
 * without a D1 row, so an empty gallery still looks broken. These IDs are the
 * known public demos; the worker upserts them on GET /api/replays instead of a
 * one-off curl. INSERT OR IGNORE keeps user-registered view counts intact.
 */

export interface FeaturedExploreGist {
  gistId: string;
  title: string;
  provider: string;
  model: string | null;
  sceneCount: number;
  userPrompts: number;
  toolCalls: number;
  durationMs: number;
  costEstimate: string | null;
  firstMessage: string;
  gistOwner: string;
  /** SQLite UTC datetime (`YYYY-MM-DD HH:MM:SS`) matching gist created_at. */
  createdAt: string;
}

/** Pin order: homepage demo, English Eng+GTM group, Chinese original. */
export const FEATURED_EXPLORE_GISTS: readonly FeaturedExploreGist[] = [
  {
    gistId: "c40137e4c224dc883fe2eaa668e2d8ba",
    title: "Comment feature in Vibe Replay",
    provider: "claude-code",
    model: "claude-opus-4-6",
    sceneCount: 668,
    userPrompts: 14,
    toolCalls: 408,
    durationMs: 3502172,
    costEstimate: "27.12781945",
    firstMessage:
      "# Prompt: Add Annotation/Comment Feature to vibe-replay\n\n## Context\nvibe-replay is a CLI tool that turns AI coding sessions into animated, interactive web replays. Currently it outputs self-contained HTML files.",
    gistOwner: "tuo-lei",
    createdAt: "2026-03-06 09:30:49",
  },
  {
    gistId: "de4b16545915ce7ae9a50ca53f58df92",
    title: "Group: Tuo Lei, Vibe Replay GTM, Vibe Replay Eng (EN)",
    provider: "grok-bot",
    model: null,
    sceneCount: 834,
    userPrompts: 51,
    toolCalls: 400,
    durationMs: 16312175,
    costEstimate: null,
    firstMessage: "https://github.com/tuo-lei/vibe-replay",
    gistOwner: "tuo-lei",
    createdAt: "2026-09-05 01:45:18",
  },
  {
    gistId: "acad9ab8e8ab9a4510fb765684f2d60c",
    title: "Group: Tuo Lei, Vibe Replay GTM, Vibe Replay Eng",
    provider: "grok-bot",
    model: null,
    sceneCount: 834,
    userPrompts: 51,
    toolCalls: 400,
    durationMs: 16312175,
    costEstimate: null,
    firstMessage: "https://github.com/tuo-lei/vibe-replay 这个是我的repo，我们开发和维护这个",
    gistOwner: "tuo-lei",
    createdAt: "2026-09-05 01:15:07",
  },
];

export const FEATURED_EXPLORE_GIST_IDS: readonly string[] = FEATURED_EXPLORE_GISTS.map(
  (gist) => gist.gistId,
);

interface ExploreSeedDb {
  prepare(query: string): {
    bind(...values: (string | number | null)[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

/** Insert missing featured gists. Existing rows (including view counts) are left alone. */
export async function ensureFeaturedExploreReplays(db: ExploreSeedDb): Promise<number> {
  let inserted = 0;
  for (const gist of FEATURED_EXPLORE_GISTS) {
    const existing = await db
      .prepare("SELECT gist_id FROM replays WHERE gist_id = ?")
      .bind(gist.gistId)
      .first<{ gist_id: string }>();
    if (existing) continue;
    await db
      .prepare(
        `INSERT OR IGNORE INTO replays (
          gist_id, title, provider, model, scene_count, user_prompts, tool_calls,
          duration_ms, cost_estimate, first_message, gist_owner, view_count, created_at, last_viewed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        gist.gistId,
        gist.title,
        gist.provider,
        gist.model,
        gist.sceneCount,
        gist.userPrompts,
        gist.toolCalls,
        gist.durationMs,
        gist.costEstimate,
        gist.firstMessage,
        gist.gistOwner,
        gist.createdAt,
        gist.createdAt,
      )
      .run();
    inserted += 1;
  }
  return inserted;
}

/** Keep featured demos at the front of Explore, in seed order, for both sort modes. */
export function pinFeaturedExploreReplays<T extends { gist_id?: string | null }>(items: T[]): T[] {
  const featured = new Map<string, T>();
  const rest: T[] = [];
  for (const item of items) {
    const id = item.gist_id;
    if (id && FEATURED_EXPLORE_GIST_IDS.includes(id) && !featured.has(id)) {
      featured.set(id, item);
    } else {
      rest.push(item);
    }
  }
  const pinned = FEATURED_EXPLORE_GIST_IDS.flatMap((id) => {
    const item = featured.get(id);
    return item ? [item] : [];
  });
  return [...pinned, ...rest];
}
