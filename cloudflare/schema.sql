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
