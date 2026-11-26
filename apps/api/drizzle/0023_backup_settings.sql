CREATE TABLE `backup_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`max_archive_bytes` integer NOT NULL,
	`storage_quota_bytes` integer,
	`max_entries` integer NOT NULL,
	`max_duration_minutes` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "backup_settings_singleton_check" CHECK("backup_settings"."id" = 1),
	CONSTRAINT "backup_settings_archive_check" CHECK("backup_settings"."max_archive_bytes" BETWEEN 1048576 AND 274877906944),
	CONSTRAINT "backup_settings_quota_check" CHECK("backup_settings"."storage_quota_bytes" IS NULL OR "backup_settings"."storage_quota_bytes" BETWEEN 1048576 AND 1099511627776),
	CONSTRAINT "backup_settings_entries_check" CHECK("backup_settings"."max_entries" BETWEEN 1 AND 250000),
	CONSTRAINT "backup_settings_duration_check" CHECK("backup_settings"."max_duration_minutes" BETWEEN 1 AND 360)
);
--> statement-breakpoint
INSERT INTO `backup_settings` (`id`, `max_archive_bytes`, `storage_quota_bytes`, `max_entries`, `max_duration_minutes`, `updated_at`) VALUES (1, 21474836480, 107374182400, 100000, 30, '2026-11-26T00:00:00.000Z');
