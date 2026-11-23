CREATE TABLE `server_install_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`server_id` text,
	`name` text NOT NULL,
	`directory_name` text NOT NULL,
	`software` text NOT NULL,
	`version` text NOT NULL,
	`request_json` text NOT NULL,
	`status` text NOT NULL,
	`progress` integer NOT NULL,
	`phase` text NOT NULL,
	`artifact_url` text,
	`artifact_size` integer,
	`artifact_sha1` text,
	`artifact_sha256` text,
	`error_code` text,
	`error_message` text,
	`partial_directory` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`server_id`) REFERENCES `local_servers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "server_install_operations_status_check" CHECK("server_install_operations"."status" IN ('pending', 'downloading', 'validating', 'completed', 'failed')),
	CONSTRAINT "server_install_operations_progress_check" CHECK("server_install_operations"."progress" >= 0 AND "server_install_operations"."progress" <= 100)
);
--> statement-breakpoint
CREATE INDEX `server_install_operations_time_idx` ON `server_install_operations` (`created_at`);
--> statement-breakpoint
CREATE INDEX `server_install_operations_status_idx` ON `server_install_operations` (`status`,`updated_at`);
