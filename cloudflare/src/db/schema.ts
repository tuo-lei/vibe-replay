import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Replays (existing)
// ---------------------------------------------------------------------------

export const replays = sqliteTable(
  "replays",
  {
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
  },
  (table) => [
    index("idx_replays_created").on(table.createdAt),
    index("idx_replays_views").on(table.viewCount),
  ],
);

// ---------------------------------------------------------------------------
// Better Auth tables
// ---------------------------------------------------------------------------

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).default(false).notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

// ---------------------------------------------------------------------------
// User Files — generic R2-backed file storage (GIF, SVG, etc.)
// ---------------------------------------------------------------------------

export const userFiles = sqliteTable(
  "user_files",
  {
    id: text("id").primaryKey(), // nanoid, 12 chars
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    contentType: text("content_type").notNull(), // "image/gif" | "image/svg+xml"
    filename: text("filename"), // original filename, optional
    sizeBytes: integer("size_bytes").default(0).notNull(),
    visibility: text("visibility").default("unlisted").notNull(), // "public" | "unlisted" | "private"
    parentReplayId: text("parent_replay_id"), // optional link to cloud_replays.id
    viewCount: integer("view_count").default(0),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    expiresAt: text("expires_at"), // nullable — 7 days for free tier
  },
  (table) => [
    index("idx_user_files_user").on(table.userId),
    index("idx_user_files_expires").on(table.expiresAt),
  ],
);

// ---------------------------------------------------------------------------
// Cloud Replays — unified table for R2 and gist-backed replays
// ---------------------------------------------------------------------------

export const cloudReplays = sqliteTable(
  "cloud_replays",
  {
    id: text("id").primaryKey(), // nanoid, 12 chars
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    storageType: text("storage_type").default("r2").notNull(), // "r2" | "gist"
    // Gist fields (nullable — only set when storageType="gist")
    gistId: text("gist_id").unique(),
    gistUrl: text("gist_url"),
    gistOwner: text("gist_owner"),
    // Metadata
    title: text("title").notNull(),
    provider: text("provider").default("claude-code"),
    model: text("model"),
    sceneCount: integer("scene_count").default(0),
    userPrompts: integer("user_prompts").default(0),
    toolCalls: integer("tool_calls").default(0),
    durationMs: integer("duration_ms").default(0),
    costEstimate: text("cost_estimate"),
    firstMessage: text("first_message"),
    sizeBytes: integer("size_bytes").default(0).notNull(), // 0 for gist entries
    visibility: text("visibility").default("unlisted").notNull(), // "public" | "unlisted" | "private"
    viewCount: integer("view_count").default(0),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    expiresAt: text("expires_at"), // nullable — gists don't expire
  },
  (table) => [
    index("idx_cloud_replays_user").on(table.userId),
    index("idx_cloud_replays_expires").on(table.expiresAt),
    index("idx_cloud_replays_gist").on(table.gistId),
    index("idx_cloud_replays_public").on(table.visibility, table.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Insight Profiles — public sharing of aggregated insights
// ---------------------------------------------------------------------------

export const insightProfiles = sqliteTable(
  "insight_profiles",
  {
    id: text("id").primaryKey(), // nanoid(12)
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => user.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(), // URL-friendly identifier for /i/:slug
    displayName: text("display_name"), // optional display name override
    avatarUrl: text("avatar_url"), // GitHub avatar
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    // JSON config: which sections to show/hide
    // { showCost, showProjects, showModels, showProviders, showHeatmap, showStreak,
    //   showWeeklyTrend, showDayOfWeek, blurProjectNames }
    config: text("config").notNull(),
    viewCount: integer("view_count").default(0),
    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_insight_profiles_slug").on(table.slug),
    index("idx_insight_profiles_user").on(table.userId),
  ],
);

// ---------------------------------------------------------------------------
// Daily Insights — Prometheus-style time-series with (user, machine, date) labels
// ---------------------------------------------------------------------------

export const dailyInsights = sqliteTable(
  "daily_insights",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    // Labels (dimensions for WHERE/GROUP BY)
    machineId: text("machine_id").notNull(),
    machineName: text("machine_name"),
    date: text("date").notNull(), // "2026-04-08"

    // Counters (aggregated metrics)
    sessions: integer("sessions").default(0).notNull(),
    prompts: integer("prompts").default(0).notNull(),
    toolCalls: integer("tool_calls").default(0).notNull(),
    edits: integer("edits").default(0).notNull(),
    durationMs: integer("duration_ms").default(0).notNull(),
    cost: real("cost").default(0).notNull(),

    // JSON breakdowns (for charts, not filtering)
    projects: text("projects"), // {"~/Code/x": {sessions, cost, prompts, toolCalls, edits, durationMs}}
    models: text("models"), // {"claude-opus-4-6": {sessions, cost}}
    providers: text("providers"), // {"claude-code": {sessions, cost}}

    createdAt: text("created_at").default(sql`(datetime('now'))`).notNull(),
    updatedAt: text("updated_at").default(sql`(datetime('now'))`),
  },
  (table) => [
    unique("uq_daily").on(table.userId, table.machineId, table.date),
    index("idx_daily_user").on(table.userId),
    index("idx_daily_date").on(table.userId, table.date),
    index("idx_daily_machine").on(table.userId, table.machineId),
  ],
);
