PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_server_access_grants` (
	`server_id` text NOT NULL,
	`user_id` text NOT NULL,
	`view_server` integer DEFAULT false NOT NULL,
	`view_logs` integer DEFAULT false NOT NULL,
	`send_console_commands` integer DEFAULT false NOT NULL,
	`control_lifecycle` integer DEFAULT false NOT NULL,
	`start_server` integer DEFAULT false NOT NULL,
	`stop_server` integer DEFAULT false NOT NULL,
	`restart_server` integer DEFAULT false NOT NULL,
	`view_players` integer DEFAULT false NOT NULL,
	`moderate_players` integer DEFAULT false NOT NULL,
	`view_mods` integer DEFAULT false NOT NULL,
	`manage_mods` integer DEFAULT false NOT NULL,
	`view_files` integer DEFAULT false NOT NULL,
	`manage_files` integer DEFAULT false NOT NULL,
	`view_settings` integer DEFAULT false NOT NULL,
	`manage_settings` integer DEFAULT false NOT NULL,
	`view_worlds` integer DEFAULT false NOT NULL,
	`view_backups` integer DEFAULT false NOT NULL,
	`create_backups` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text,
	PRIMARY KEY(`server_id`, `user_id`),
	FOREIGN KEY (`server_id`) REFERENCES `local_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "server_access_grants_boolean_check" CHECK("__new_server_access_grants"."view_server" IN (0, 1) AND "__new_server_access_grants"."view_logs" IN (0, 1) AND "__new_server_access_grants"."send_console_commands" IN (0, 1) AND "__new_server_access_grants"."control_lifecycle" IN (0, 1) AND "__new_server_access_grants"."start_server" IN (0, 1) AND "__new_server_access_grants"."stop_server" IN (0, 1) AND "__new_server_access_grants"."restart_server" IN (0, 1) AND "__new_server_access_grants"."view_players" IN (0, 1) AND "__new_server_access_grants"."moderate_players" IN (0, 1) AND "__new_server_access_grants"."view_mods" IN (0, 1) AND "__new_server_access_grants"."manage_mods" IN (0, 1) AND "__new_server_access_grants"."view_files" IN (0, 1) AND "__new_server_access_grants"."manage_files" IN (0, 1) AND "__new_server_access_grants"."view_settings" IN (0, 1) AND "__new_server_access_grants"."manage_settings" IN (0, 1) AND "__new_server_access_grants"."view_worlds" IN (0, 1) AND "__new_server_access_grants"."view_backups" IN (0, 1) AND "__new_server_access_grants"."create_backups" IN (0, 1)),
	CONSTRAINT "server_access_grants_dependencies_check" CHECK(("__new_server_access_grants"."send_console_commands" = 0 AND "__new_server_access_grants"."control_lifecycle" = 0) AND ("__new_server_access_grants"."view_server" = 1 OR ("__new_server_access_grants"."view_logs" = 0 AND "__new_server_access_grants"."start_server" = 0 AND "__new_server_access_grants"."stop_server" = 0 AND "__new_server_access_grants"."restart_server" = 0 AND "__new_server_access_grants"."view_players" = 0 AND "__new_server_access_grants"."moderate_players" = 0 AND "__new_server_access_grants"."view_mods" = 0 AND "__new_server_access_grants"."manage_mods" = 0 AND "__new_server_access_grants"."view_files" = 0 AND "__new_server_access_grants"."manage_files" = 0 AND "__new_server_access_grants"."view_settings" = 0 AND "__new_server_access_grants"."manage_settings" = 0 AND "__new_server_access_grants"."view_worlds" = 0 AND "__new_server_access_grants"."view_backups" = 0 AND "__new_server_access_grants"."create_backups" = 0)) AND ("__new_server_access_grants"."moderate_players" = 0 OR "__new_server_access_grants"."view_players" = 1) AND ("__new_server_access_grants"."manage_mods" = 0 OR "__new_server_access_grants"."view_mods" = 1) AND ("__new_server_access_grants"."manage_files" = 0 OR "__new_server_access_grants"."view_files" = 1) AND ("__new_server_access_grants"."manage_settings" = 0 OR "__new_server_access_grants"."view_settings" = 1) AND ("__new_server_access_grants"."create_backups" = 0 OR "__new_server_access_grants"."view_backups" = 1))
);
--> statement-breakpoint
INSERT INTO `__new_server_access_grants`("server_id", "user_id", "view_server", "view_logs", "send_console_commands", "control_lifecycle", "start_server", "stop_server", "restart_server", "view_players", "moderate_players", "view_mods", "manage_mods", "view_files", "manage_files", "view_settings", "manage_settings", "view_worlds", "view_backups", "create_backups", "created_at", "updated_at", "updated_by") SELECT "server_id", "user_id", "view_server", "view_logs", 0, 0, "control_lifecycle", "control_lifecycle", "control_lifecycle", "view_players", "moderate_players", "view_mods", "manage_mods", "view_files", "manage_files", "view_settings", "manage_settings", "view_worlds", "view_backups", "create_backups", "created_at", "updated_at", "updated_by" FROM `server_access_grants`;--> statement-breakpoint
DROP TABLE `server_access_grants`;--> statement-breakpoint
ALTER TABLE `__new_server_access_grants` RENAME TO `server_access_grants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `server_access_grants_user_idx` ON `server_access_grants` (`user_id`,`view_server`,`view_players`);