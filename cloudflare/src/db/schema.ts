import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
  ],
);
