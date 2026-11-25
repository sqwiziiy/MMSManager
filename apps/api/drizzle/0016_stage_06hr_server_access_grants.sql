CREATE TABLE `server_access_grants` (
	`server_id` text NOT NULL,
	`user_id` text NOT NULL,
	`view_server` integer NOT NULL DEFAULT 0,
	`view_logs` integer NOT NULL DEFAULT 0,
	`send_console_commands` integer NOT NULL DEFAULT 0,
	`control_lifecycle` integer NOT NULL DEFAULT 0,
	`view_players` integer NOT NULL DEFAULT 0,
	`moderate_players` integer NOT NULL DEFAULT 0,
	`view_mods` integer NOT NULL DEFAULT 0,
	`manage_mods` integer NOT NULL DEFAULT 0,
	`view_files` integer NOT NULL DEFAULT 0,
	`manage_files` integer NOT NULL DEFAULT 0,
	`view_settings` integer NOT NULL DEFAULT 0,
	`manage_settings` integer NOT NULL DEFAULT 0,
	`view_worlds` integer NOT NULL DEFAULT 0,
	`view_backups` integer NOT NULL DEFAULT 0,
	`create_backups` integer NOT NULL DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text,
	PRIMARY KEY(`server_id`, `user_id`),
	FOREIGN KEY (`server_id`) REFERENCES `local_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `server_access_grants_boolean_check` CHECK (`view_server` IN (0, 1) AND `view_logs` IN (0, 1) AND `send_console_commands` IN (0, 1) AND `control_lifecycle` IN (0, 1) AND `view_players` IN (0, 1) AND `moderate_players` IN (0, 1) AND `view_mods` IN (0, 1) AND `manage_mods` IN (0, 1) AND `view_files` IN (0, 1) AND `manage_files` IN (0, 1) AND `view_settings` IN (0, 1) AND `manage_settings` IN (0, 1) AND `view_worlds` IN (0, 1) AND `view_backups` IN (0, 1) AND `create_backups` IN (0, 1)),
	CONSTRAINT `server_access_grants_dependencies_check` CHECK ((`view_server` = 1 OR (`view_logs` = 0 AND `send_console_commands` = 0 AND `control_lifecycle` = 0 AND `view_players` = 0 AND `moderate_players` = 0 AND `view_mods` = 0 AND `manage_mods` = 0 AND `view_files` = 0 AND `manage_files` = 0 AND `view_settings` = 0 AND `manage_settings` = 0 AND `view_worlds` = 0 AND `view_backups` = 0 AND `create_backups` = 0)) AND (`moderate_players` = 0 OR `view_players` = 1) AND (`manage_mods` = 0 OR `view_mods` = 1) AND (`manage_files` = 0 OR `view_files` = 1) AND (`manage_settings` = 0 OR `view_settings` = 1) AND (`create_backups` = 0 OR `view_backups` = 1))
);
--> statement-breakpoint
CREATE INDEX `server_access_grants_user_idx` ON `server_access_grants` (`user_id`, `view_server`, `view_players`);
--> statement-breakpoint
INSERT INTO `server_access_grants` (`server_id`, `user_id`, `view_server`, `view_logs`, `view_players`, `view_mods`, `created_at`, `updated_at`)
SELECT servers.`id`, users.`id`, 1, 1, 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `local_servers` AS servers CROSS JOIN `users` AS users
WHERE users.`role` = 'member';
