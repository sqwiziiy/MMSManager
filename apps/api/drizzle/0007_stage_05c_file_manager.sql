CREATE TABLE `local_server_file_recoveries` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL REFERENCES `local_servers`(`id`) ON DELETE cascade,
	`actor_user_id` text REFERENCES `users`(`id`) ON DELETE set null,
	`original_path` text NOT NULL,
	`file_name` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `local_server_file_recoveries_server_time_idx` ON `local_server_file_recoveries` (`server_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `local_server_file_trash` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL REFERENCES `local_servers`(`id`) ON DELETE cascade,
	`actor_user_id` text REFERENCES `users`(`id`) ON DELETE set null,
	`name` text NOT NULL,
	`original_path` text NOT NULL,
	`stored_name` text NOT NULL,
	`kind` text NOT NULL CHECK (`kind` IN ('file', 'folder')),
	`size_bytes` integer,
	`deleted_at` text NOT NULL,
	`restored_at` text
);
--> statement-breakpoint
CREATE INDEX `local_server_file_trash_server_time_idx` ON `local_server_file_trash` (`server_id`, `deleted_at`);
