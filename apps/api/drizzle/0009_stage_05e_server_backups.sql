CREATE TABLE `local_server_backups` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL REFERENCES `local_servers`(`id`) ON DELETE cascade,
	`actor_user_id` text REFERENCES `users`(`id`) ON DELETE set null,
	`kind` text NOT NULL CHECK (`kind` IN ('manual', 'pre-restore')),
	`directory_name` text NOT NULL,
	`created_at` text NOT NULL,
	`archive_size_bytes` integer NOT NULL CHECK (`archive_size_bytes` >= 0),
	`manifest_size_bytes` integer NOT NULL CHECK (`manifest_size_bytes` >= 0),
	`world_paths_json` text NOT NULL,
	`archive_sha256` text NOT NULL CHECK (length(`archive_sha256`) = 64),
	`manifest_sha256` text NOT NULL CHECK (length(`manifest_sha256`) = 64),
	`entry_count` integer NOT NULL CHECK (`entry_count` >= 0),
	`file_count` integer NOT NULL CHECK (`file_count` >= 0),
	`total_file_bytes` integer NOT NULL CHECK (`total_file_bytes` >= 0),
	`excluded_count` integer NOT NULL CHECK (`excluded_count` >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_server_backups_directory_unique` ON `local_server_backups` (`server_id`,`directory_name`);
--> statement-breakpoint
CREATE INDEX `local_server_backups_server_time_idx` ON `local_server_backups` (`server_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `local_server_backup_restores` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL REFERENCES `local_servers`(`id`) ON DELETE cascade,
	`backup_id` text NOT NULL REFERENCES `local_server_backups`(`id`),
	`safety_backup_id` text NOT NULL REFERENCES `local_server_backups`(`id`),
	`actor_user_id` text REFERENCES `users`(`id`) ON DELETE set null,
	`started_at` text NOT NULL,
	`completed_at` text,
	`status` text NOT NULL CHECK (`status` IN ('prepared', 'completed', 'rolled-back', 'recovery-required')),
	`staging_name` text NOT NULL,
	`rollback_name` text NOT NULL,
	`error_code` text
);
--> statement-breakpoint
CREATE INDEX `local_server_backup_restores_server_time_idx` ON `local_server_backup_restores` (`server_id`,`started_at`);
--> statement-breakpoint
CREATE INDEX `local_server_backup_restores_status_idx` ON `local_server_backup_restores` (`status`,`started_at`);
