ALTER TABLE `session_insights` ADD `machine_id` text;--> statement-breakpoint
ALTER TABLE `session_insights` ADD `machine_name` text;--> statement-breakpoint
CREATE INDEX `idx_insights_machine` ON `session_insights` (`user_id`,`machine_id`);