DROP TABLE IF EXISTS `session_insights`;
--> statement-breakpoint
CREATE TABLE `daily_insights` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`machine_id` text NOT NULL,
	`machine_name` text,
	`date` text NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`prompts` integer DEFAULT 0 NOT NULL,
	`tool_calls` integer DEFAULT 0 NOT NULL,
	`edits` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`cost` real DEFAULT 0 NOT NULL,
	`projects` text,
	`models` text,
	`providers` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_daily` ON `daily_insights` (`user_id`,`machine_id`,`date`);
--> statement-breakpoint
CREATE INDEX `idx_daily_user` ON `daily_insights` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_daily_date` ON `daily_insights` (`user_id`,`date`);
--> statement-breakpoint
CREATE INDEX `idx_daily_machine` ON `daily_insights` (`user_id`,`machine_id`);
