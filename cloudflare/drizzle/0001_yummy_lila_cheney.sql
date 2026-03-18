CREATE INDEX IF NOT EXISTS `idx_replays_created` ON `replays` (`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_replays_views` ON `replays` (`view_count`);
