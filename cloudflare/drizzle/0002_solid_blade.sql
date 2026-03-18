CREATE TABLE `cloud_replays` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`storage_type` text DEFAULT 'r2' NOT NULL,
	`gist_id` text,
	`gist_url` text,
	`gist_owner` text,
	`title` text NOT NULL,
	`provider` text DEFAULT 'claude-code',
	`model` text,
	`scene_count` integer DEFAULT 0,
	`user_prompts` integer DEFAULT 0,
	`tool_calls` integer DEFAULT 0,
	`duration_ms` integer DEFAULT 0,
	`cost_estimate` text,
	`first_message` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`visibility` text DEFAULT 'unlisted' NOT NULL,
	`view_count` integer DEFAULT 0,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cloud_replays_gist_id_unique` ON `cloud_replays` (`gist_id`);--> statement-breakpoint
CREATE INDEX `idx_cloud_replays_user` ON `cloud_replays` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_cloud_replays_expires` ON `cloud_replays` (`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_cloud_replays_gist` ON `cloud_replays` (`gist_id`);