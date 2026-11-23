CREATE TABLE `local_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`directory` text NOT NULL,
	`source` text NOT NULL,
	`software` text NOT NULL,
	`version` text,
	`jar_name` text,
	`java_path` text,
	`java_major` integer,
	`min_memory_mb` integer NOT NULL,
	`max_memory_mb` integer NOT NULL,
	`port` integer,
	`eula` text NOT NULL,
	`managed` integer DEFAULT false NOT NULL,
	`world_folders` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "local_servers_source_check" CHECK("local_servers"."source" IN ('created', 'imported')),
	CONSTRAINT "local_servers_software_check" CHECK("local_servers"."software" IN ('vanilla', 'fabric', 'paper', 'unknown')),
	CONSTRAINT "local_servers_memory_check" CHECK("local_servers"."min_memory_mb" >= 512 AND "local_servers"."max_memory_mb" >= "local_servers"."min_memory_mb"),
	CONSTRAINT "local_servers_port_check" CHECK("local_servers"."port" IS NULL OR ("local_servers"."port" >= 1 AND "local_servers"."port" <= 65535)),
	CONSTRAINT "local_servers_eula_check" CHECK("local_servers"."eula" IN ('accepted', 'not-accepted', 'unknown')),
	CONSTRAINT "local_servers_managed_check" CHECK("local_servers"."managed" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_servers_directory_unique` ON `local_servers` (`directory`);
--> statement-breakpoint
CREATE INDEX `local_servers_created_at_idx` ON `local_servers` (`created_at`);
--> statement-breakpoint
CREATE TABLE `local_server_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` text,
	`actor_user_id` text,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`occurred_at` text NOT NULL,
	`detail` text NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `local_servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "local_server_events_outcome_check" CHECK("local_server_events"."outcome" IN ('success', 'failure'))
);
--> statement-breakpoint
CREATE INDEX `local_server_events_time_idx` ON `local_server_events` (`occurred_at`);
--> statement-breakpoint
CREATE INDEX `local_server_events_server_idx` ON `local_server_events` (`server_id`,`occurred_at`);
