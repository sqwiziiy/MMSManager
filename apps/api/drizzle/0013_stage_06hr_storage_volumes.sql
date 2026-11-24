CREATE TABLE `machine_storage_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`machine_id` text NOT NULL,
	`volume_id` text NOT NULL,
	`name` text NOT NULL,
	`roles` text NOT NULL,
	`collected_at` text NOT NULL,
	`minute_start` text NOT NULL,
	`local_date` text NOT NULL,
	`time_zone` text NOT NULL,
	`used_bytes` integer,
	`available_bytes` integer,
	`total_bytes` integer,
	`used_percent` real,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machine_storage_samples_key_unique` ON `machine_storage_samples` (`machine_id`,`volume_id`,`collected_at`);--> statement-breakpoint
CREATE INDEX `machine_storage_samples_volume_time_idx` ON `machine_storage_samples` (`machine_id`,`volume_id`,`collected_at`);