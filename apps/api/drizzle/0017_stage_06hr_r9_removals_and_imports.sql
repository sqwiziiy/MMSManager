CREATE TABLE `local_server_removal_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`mode` text NOT NULL,
	`state` text NOT NULL,
	`actor_user_id` text,
	`server_name` text NOT NULL,
	`directory` text NOT NULL,
	`source` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `local_servers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `local_server_removal_operations_mode_check` CHECK (`mode` IN ('unregister', 'permanent')),
	CONSTRAINT `local_server_removal_operations_state_check` CHECK (`state` IN ('prepared', 'quarantined', 'purging', 'unregistered', 'purged', 'failed', 'recovery-required'))
);
--> statement-breakpoint
CREATE INDEX `local_server_removal_operations_server_time_idx` ON `local_server_removal_operations` (`server_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `local_server_removal_operations_state_idx` ON `local_server_removal_operations` (`state`, `created_at`);
--> statement-breakpoint
CREATE TABLE `server_zip_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`upload_name` text NOT NULL,
	`compressed_bytes` integer NOT NULL,
	`preview_json` text NOT NULL,
	`state` text NOT NULL,
	`server_id` text,
	`error_code` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`server_id`) REFERENCES `local_servers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `server_zip_imports_size_check` CHECK (`compressed_bytes` >= 0),
	CONSTRAINT `server_zip_imports_state_check` CHECK (`state` IN ('ready', 'importing', 'published', 'expired', 'failed'))
);
--> statement-breakpoint
CREATE INDEX `server_zip_imports_actor_time_idx` ON `server_zip_imports` (`actor_user_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `server_zip_imports_state_expiry_idx` ON `server_zip_imports` (`state`, `expires_at`);
--> statement-breakpoint
DROP INDEX `local_servers_directory_unique`;
--> statement-breakpoint
ALTER TABLE `local_servers` ADD `removed_at` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `local_servers_directory_unique` ON `local_servers` (`directory`) WHERE `removed_at` IS NULL;
