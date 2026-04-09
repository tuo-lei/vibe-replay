CREATE TABLE `insight_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`slug` text NOT NULL,
	`display_name` text,
	`avatar_url` text,
	`enabled` integer DEFAULT true NOT NULL,
	`config` text NOT NULL,
	`view_count` integer DEFAULT 0,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `insight_profiles_user_id_unique` ON `insight_profiles` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `insight_profiles_slug_unique` ON `insight_profiles` (`slug`);
--> statement-breakpoint
CREATE INDEX `idx_insight_profiles_slug` ON `insight_profiles` (`slug`);
--> statement-breakpoint
CREATE INDEX `idx_insight_profiles_user` ON `insight_profiles` (`user_id`);
