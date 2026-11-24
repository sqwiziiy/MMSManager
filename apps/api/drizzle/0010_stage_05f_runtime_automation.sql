ALTER TABLE `local_servers` ADD `required_java_major` integer;
--> statement-breakpoint
ALTER TABLE `local_servers` ADD `jvm_options_json` text NOT NULL DEFAULT '{"collector":"default","maxGCPauseMs":null,"parallelGcThreads":null,"alwaysPreTouch":false,"disableExplicitGc":false}';
--> statement-breakpoint
ALTER TABLE `local_servers` ADD `start_script_sha256` text;
--> statement-breakpoint
ALTER TABLE `local_server_backups` ADD `origin` text NOT NULL DEFAULT 'manual' CHECK (`origin` IN ('manual', 'scheduled', 'system'));
--> statement-breakpoint
CREATE TABLE `local_server_automation` (
	`server_id` text PRIMARY KEY NOT NULL REFERENCES `local_servers`(`id`) ON DELETE cascade,
	`backup_enabled` integer DEFAULT false NOT NULL,
	`frequency` text DEFAULT 'daily' NOT NULL,
	`local_time` text DEFAULT '03:00' NOT NULL,
	`weekday` integer,
	`time_zone` text NOT NULL,
	`next_run_at` text,
	`last_run_at` text,
	`last_status` text,
	`last_error` text,
	`updated_by` text REFERENCES `users`(`id`) ON DELETE set null,
	`updated_at` text NOT NULL,
	CONSTRAINT `local_server_automation_enabled_check` CHECK (`backup_enabled` IN (0, 1)),
	CONSTRAINT `local_server_automation_frequency_check` CHECK (`frequency` IN ('daily', 'weekly')),
	CONSTRAINT `local_server_automation_time_check` CHECK (`local_time` GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(`local_time`, 1, 2) BETWEEN '00' AND '23'),
	CONSTRAINT `local_server_automation_weekday_check` CHECK (`weekday` IS NULL OR (`weekday` >= 0 AND `weekday` <= 6)),
	CONSTRAINT `local_server_automation_frequency_weekday_check` CHECK ((`frequency` = 'daily' AND `weekday` IS NULL) OR (`frequency` = 'weekly' AND `weekday` IS NOT NULL)),
	CONSTRAINT `local_server_automation_status_check` CHECK (`last_status` IS NULL OR `last_status` IN ('completed', 'failed', 'missed'))
);
--> statement-breakpoint
CREATE TABLE `local_server_automation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL REFERENCES `local_servers`(`id`) ON DELETE cascade,
	`kind` text NOT NULL,
	`scheduled_for` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`backup_id` text REFERENCES `local_server_backups`(`id`) ON DELETE set null,
	`error_message` text,
	`acknowledged_at` text,
	`created_at` text NOT NULL,
	CONSTRAINT `local_server_automation_jobs_kind_check` CHECK (`kind` = 'backup'),
	CONSTRAINT `local_server_automation_jobs_status_check` CHECK (`status` IN ('running', 'completed', 'failed', 'missed')),
	CONSTRAINT `local_server_automation_jobs_schedule_unique` UNIQUE (`server_id`, `kind`, `scheduled_for`)
);
--> statement-breakpoint
CREATE INDEX `local_server_automation_jobs_time_idx` ON `local_server_automation_jobs` (`server_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `local_server_automation_jobs_status_idx` ON `local_server_automation_jobs` (`status`, `created_at`);
