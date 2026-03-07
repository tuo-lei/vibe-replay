import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const replays = sqliteTable("replays", {
  gistId: text("gist_id").primaryKey(),
  title: text("title").notNull(),
  provider: text("provider").default("claude-code"),
  model: text("model"),
  sceneCount: integer("scene_count").default(0),
  userPrompts: integer("user_prompts").default(0),
  toolCalls: integer("tool_calls").default(0),
  durationMs: integer("duration_ms").default(0),
  costEstimate: text("cost_estimate"),
  firstMessage: text("first_message"),
  gistOwner: text("gist_owner"),
  viewCount: integer("view_count").default(1),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
  lastViewedAt: text("last_viewed_at").default(sql`(datetime('now'))`),
});
