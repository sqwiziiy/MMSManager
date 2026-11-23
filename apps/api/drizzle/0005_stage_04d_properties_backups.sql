CREATE TABLE `local_server_properties_backups` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`actor_user_id` text,
	`file_name` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `local_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `local_server_properties_backups_server_time_idx` ON `local_server_properties_backups` (`server_id`,`created_at`);
