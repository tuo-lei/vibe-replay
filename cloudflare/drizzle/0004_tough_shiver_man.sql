CREATE TABLE `session_insights` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`provider` text NOT NULL,
	`slug` text NOT NULL,
	`title` text,
	`project` text,
	`model` text,
	`start_time` text,
	`duration_ms` integer,
	`prompt_count` integer DEFAULT 0,
	`tool_call_count` integer DEFAULT 0,
	`edit_count` integer DEFAULT 0,
	`cost_estimate` real,
	`has_pr` integer DEFAULT false,
	`sub_agent_count` integer DEFAULT 0,
	`api_error_count` integer DEFAULT 0,
	`metadata` text,
	`captured_at` text NOT NULL,
	`captured_by_version` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_insights_user` ON `session_insights` (`user_id`);--> statement-breakpoint
CREATE INDEX `idx_insights_project` ON `session_insights` (`user_id`,`project`);--> statement-breakpoint
CREATE INDEX `idx_insights_start` ON `session_insights` (`user_id`,`start_time`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_user_session` ON `session_insights` (`user_id`,`session_id`);