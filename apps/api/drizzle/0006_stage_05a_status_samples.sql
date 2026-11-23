CREATE TABLE `local_server_status_samples` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `server_id` text NOT NULL REFERENCES `local_servers`(`id`) ON DELETE CASCADE,
  `checked_at` text NOT NULL,
  `state` text NOT NULL CHECK (`state` IN ('reachable', 'unreachable')),
  `players_online` integer,
  `players_max` integer,
  `version_name` text,
  `description` text,
  `latency_ms` integer,
  `error_code` text,
  `source` text NOT NULL DEFAULT 'local-status-ping'
);
--> statement-breakpoint
CREATE INDEX `local_server_status_samples_server_time_idx` ON `local_server_status_samples` (`server_id`, `checked_at`);
