CREATE TABLE `user_files` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`content_type` text NOT NULL,
	`filename` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`visibility` text DEFAULT 'unlisted' NOT NULL,
	`parent_replay_id` text,
	`view_count` integer DEFAULT 0,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_user_files_user` ON `user_files` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_user_files_expires` ON `user_files` (`expires_at`);--> statement-breakpoint
ALTER TABLE `session_insights` ADD `machine_id` text;--> statement-breakpoint
ALTER TABLE `session_insights` ADD `machine_name` text;--> statement-breakpoint
CREATE INDEX `idx_insights_machine` ON `session_insights` (`user_id`,`machine_id`);