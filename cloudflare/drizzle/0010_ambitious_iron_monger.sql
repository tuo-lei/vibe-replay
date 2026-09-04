CREATE TABLE `telemetry_daily` (
	`day` text NOT NULL,
	`event` text NOT NULL,
	`version` text NOT NULL,
	`platform` text NOT NULL,
	`dimensions` text DEFAULT '' NOT NULL,
	`count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_telemetry_daily_day` ON `telemetry_daily` (`day`);--> statement-breakpoint
CREATE INDEX `idx_telemetry_daily_event` ON `telemetry_daily` (`event`,`day`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_telemetry_daily` ON `telemetry_daily` (`day`,`event`,`version`,`platform`,`dimensions`);--> statement-breakpoint
CREATE TABLE `telemetry_monthly_users` (
	`month` text NOT NULL,
	`event` text NOT NULL,
	`installation_hash` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_telemetry_monthly_event` ON `telemetry_monthly_users` (`event`,`month`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_telemetry_monthly_user` ON `telemetry_monthly_users` (`month`,`event`,`installation_hash`);