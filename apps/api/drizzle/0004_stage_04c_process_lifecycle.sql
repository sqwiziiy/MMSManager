CREATE TABLE `local_server_runtime` (
	`server_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`process_pid` integer,
	`process_start_marker` text,
	`process_boot_id` text,
	`started_at` text,
	`updated_at` text NOT NULL,
	`last_exit_code` integer,
	`error_message` text,
	`restart_required` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `local_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "local_server_runtime_status_check" CHECK("local_server_runtime"."status" IN ('stopped', 'starting', 'running', 'stopping', 'crashed', 'error', 'external/unmanaged')),
	CONSTRAINT "local_server_runtime_restart_check" CHECK("local_server_runtime"."restart_required" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `local_server_runtime_status_idx` ON `local_server_runtime` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `local_server_console_entries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`source` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `local_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "local_server_console_entries_source_check" CHECK("local_server_console_entries"."source" IN ('stdout', 'stderr', 'system', 'command')),
	CONSTRAINT "local_server_console_entries_severity_check" CHECK("local_server_console_entries"."severity" IN ('info', 'warn', 'error', 'debug'))
);
--> statement-breakpoint
CREATE INDEX `local_server_console_entries_order_idx` ON `local_server_console_entries` (`server_id`,`id`);
