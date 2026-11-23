CREATE TABLE `local_server_structured_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL REFERENCES `local_servers`(`id`) ON DELETE cascade,
	`console_entry_id` integer,
	`occurred_at` text NOT NULL,
	`category` text NOT NULL CHECK (`category` IN ('server', 'player', 'moderation')),
	`event_type` text NOT NULL,
	`description` text NOT NULL,
	`raw_message` text,
	`confidence` text NOT NULL CHECK (`confidence` IN ('high', 'medium')),
	`source` text NOT NULL CHECK (`source` IN ('owned-log', 'panel-process'))
);
--> statement-breakpoint
CREATE INDEX `local_server_structured_events_server_time_idx` ON `local_server_structured_events` (`server_id`, `occurred_at`);
--> statement-breakpoint
CREATE INDEX `local_server_structured_events_console_idx` ON `local_server_structured_events` (`console_entry_id`);
--> statement-breakpoint
CREATE TABLE `local_server_resource_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL REFERENCES `local_servers`(`id`) ON DELETE cascade,
	`minute_start` text NOT NULL,
	`sampled_at` text NOT NULL,
	`cpu_percent` real CHECK (`cpu_percent` IS NULL OR (`cpu_percent` >= 0 AND `cpu_percent` <= 100)),
	`memory_rss_bytes` integer CHECK (`memory_rss_bytes` IS NULL OR `memory_rss_bytes` >= 0),
	`players_online` integer CHECK (`players_online` IS NULL OR (`players_online` >= 0 AND (`players_max` IS NULL OR `players_max` >= `players_online`))),
	`players_max` integer,
	`uptime_seconds` integer CHECK (`uptime_seconds` IS NULL OR `uptime_seconds` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_server_resource_samples_server_minute_unique` ON `local_server_resource_samples` (`server_id`, `minute_start`);
--> statement-breakpoint
CREATE INDEX `local_server_resource_samples_minute_idx` ON `local_server_resource_samples` (`minute_start`);
--> statement-breakpoint
CREATE TABLE `local_server_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL REFERENCES `local_servers`(`id`) ON DELETE cascade,
	`started_at` text NOT NULL,
	`ended_at` text,
	`outcome` text NOT NULL CHECK (`outcome` IN ('running', 'stopped', 'crashed', 'interrupted')),
	`uptime_seconds` integer CHECK (`uptime_seconds` IS NULL OR `uptime_seconds` >= 0)
);
--> statement-breakpoint
CREATE INDEX `local_server_sessions_server_start_idx` ON `local_server_sessions` (`server_id`, `started_at`);
--> statement-breakpoint
CREATE INDEX `local_server_sessions_end_idx` ON `local_server_sessions` (`server_id`, `ended_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_server_sessions_active_unique` ON `local_server_sessions` (`server_id`) WHERE `ended_at` IS NULL;
