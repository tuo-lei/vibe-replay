CREATE TABLE IF NOT EXISTS replays (
  gist_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  provider TEXT DEFAULT 'claude-code',
  model TEXT,
  scene_count INTEGER DEFAULT 0,
  user_prompts INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  view_count INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  last_viewed_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_replays_created ON replays(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_replays_views ON replays(view_count DESC);
