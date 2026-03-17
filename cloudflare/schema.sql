CREATE TABLE IF NOT EXISTS replays (
  gist_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider TEXT DEFAULT 'claude-code',
  model TEXT,
  scene_count INTEGER DEFAULT 0,
  user_prompts INTEGER DEFAULT 0,
  tool_calls INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  cost_estimate TEXT,
  first_message TEXT,
  gist_owner TEXT,
  view_count INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_viewed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_replays_created ON replays(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_replays_views ON replays(view_count DESC);

-- Migration: add new columns to existing table
-- ALTER TABLE replays ADD COLUMN tool_calls INTEGER DEFAULT 0;
-- ALTER TABLE replays ADD COLUMN cost_estimate TEXT;
-- ALTER TABLE replays ADD COLUMN first_message TEXT;
-- ALTER TABLE replays ADD COLUMN gist_owner TEXT;

-- ---------------------------------------------------------------------------
-- Better Auth tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL DEFAULT 0,
  "image" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" TEXT NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" TEXT,
  "refreshTokenExpiresAt" TEXT,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" TEXT NOT NULL DEFAULT (datetime('now')),
  "updatedAt" TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "createdAt" TEXT DEFAULT (datetime('now')),
  "updatedAt" TEXT DEFAULT (datetime('now'))
);
