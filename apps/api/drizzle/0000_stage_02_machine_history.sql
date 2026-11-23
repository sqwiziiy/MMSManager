CREATE TABLE `machine_day_rollups` (
	`machine_id` text NOT NULL,
	`time_zone` text NOT NULL,
	`local_date` text NOT NULL,
	`sample_count` integer NOT NULL,
	`cpu_sum` real,
	`cpu_count` integer NOT NULL,
	`cpu_minimum` real,
	`cpu_maximum` real,
	`memory_peak_used_bytes` integer,
	`memory_total_bytes` integer,
	`memory_peak_percent` real,
	`storage_snapshot_used_bytes` integer,
	`storage_peak_used_bytes` integer,
	`storage_total_bytes` integer,
	`network_received_bytes` real,
	`network_transmitted_bytes` real,
	`first_sample_at` text NOT NULL,
	`last_sample_at` text NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_day_rollups_key_unique` ON `machine_day_rollups` (`machine_id`,`time_zone`,`local_date`);--> statement-breakpoint
CREATE INDEX `machine_day_rollups_month_idx` ON `machine_day_rollups` (`machine_id`,`time_zone`,`local_date`);--> statement-breakpoint
CREATE TABLE `machine_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`machine_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	`time_zone` text NOT NULL,
	`local_date` text NOT NULL,
	`category` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `machine_events_date_idx` ON `machine_events` (`machine_id`,`time_zone`,`local_date`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `machine_minute_rollups` (
	`machine_id` text NOT NULL,
	`time_zone` text NOT NULL,
	`local_date` text NOT NULL,
	`minute_start` text NOT NULL,
	`sample_count` integer NOT NULL,
	`cpu_sum` real,
	`cpu_count` integer NOT NULL,
	`cpu_minimum` real,
	`cpu_maximum` real,
	`memory_peak_used_bytes` integer,
	`memory_total_bytes` integer,
	`memory_peak_percent` real,
	`storage_last_used_bytes` integer,
	`storage_peak_used_bytes` integer,
	`storage_total_bytes` integer,
	`network_rx_rate_sum` real,
	`network_tx_rate_sum` real,
	`network_rate_count` integer NOT NULL,
	`network_received_bytes` real,
	`network_transmitted_bytes` real,
	`first_sample_at` text NOT NULL,
	`last_sample_at` text NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_minute_rollups_key_unique` ON `machine_minute_rollups` (`machine_id`,`time_zone`,`minute_start`);--> statement-breakpoint
CREATE INDEX `machine_minute_rollups_date_idx` ON `machine_minute_rollups` (`machine_id`,`time_zone`,`local_date`,`minute_start`);--> statement-breakpoint
CREATE TABLE `machine_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`machine_id` text NOT NULL,
	`collected_at` text NOT NULL,
	`minute_start` text NOT NULL,
	`local_date` text NOT NULL,
	`time_zone` text NOT NULL,
	`cpu_percent` real,
	`core_count` integer,
	`load_one` real,
	`load_five` real,
	`load_fifteen` real,
	`memory_used_bytes` integer,
	`memory_available_bytes` integer,
	`memory_total_bytes` integer,
	`swap_used_bytes` integer,
	`swap_total_bytes` integer,
	`storage_device` text,
	`storage_mount` text,
	`storage_used_bytes` integer,
	`storage_available_bytes` integer,
	`storage_total_bytes` integer,
	`network_interface` text,
	`network_rx_bytes_per_second` real,
	`network_tx_bytes_per_second` real,
	`network_rx_transferred_bytes` real,
	`network_tx_transferred_bytes` real,
	`sample_status` text NOT NULL,
	`unavailable_fields` text NOT NULL,
	`source` text NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_samples_machine_collected_unique` ON `machine_samples` (`machine_id`,`collected_at`);--> statement-breakpoint
CREATE INDEX `machine_samples_machine_date_idx` ON `machine_samples` (`machine_id`,`local_date`,`collected_at`);--> statement-breakpoint
CREATE INDEX `machine_samples_machine_time_idx` ON `machine_samples` (`machine_id`,`collected_at`);--> statement-breakpoint
CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`hostname` text NOT NULL,
	`platform` text NOT NULL,
	`distro` text,
	`release` text,
	`architecture` text NOT NULL,
	`cpu_model` text,
	`core_count` integer,
	`uptime_seconds` real,
	`source` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL
);
