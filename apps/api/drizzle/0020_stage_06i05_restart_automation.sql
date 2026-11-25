CREATE TABLE `local_server_restart_schedules` (
	`server_id` text PRIMARY KEY NOT NULL REFERENCES `local_servers`(`id`) ON DELETE cascade,
	`enabled` integer DEFAULT false NOT NULL,
	`frequency` text DEFAULT 'daily' NOT NULL,
	`local_time` text DEFAULT '03:00' NOT NULL,
	`weekday` integer,
	`time_zone` text NOT NULL,
	`only_when_empty` integer DEFAULT true NOT NULL,
	`wait_policy` text DEFAULT 'skip' NOT NULL,
	`retry_interval_minutes` integer DEFAULT 5 NOT NULL,
	`wait_deadline_minutes` integer DEFAULT 30 NOT NULL,
	`next_run_at` text,
	`last_run_at` text,
	`last_status` text,
	`last_outcome` text,
	`updated_by` text REFERENCES `users`(`id`) ON DELETE set null,
	`updated_at` text NOT NULL,
	CONSTRAINT `local_server_restart_schedule_enabled_check` CHECK (`enabled` IN (0, 1)),
	CONSTRAINT `local_server_restart_schedule_frequency_check` CHECK (`frequency` IN ('daily', 'weekly')),
	CONSTRAINT `local_server_restart_schedule_time_check` CHECK (`local_time` GLOB '[0-2][0-9]:[0-5][0-9]' AND substr(`local_time`, 1, 2) BETWEEN '00' AND '23'),
	CONSTRAINT `local_server_restart_schedule_weekday_check` CHECK (`weekday` IS NULL OR (`weekday` >= 0 AND `weekday` <= 6)),
	CONSTRAINT `local_server_restart_schedule_weekday_required_check` CHECK ((`frequency` = 'daily' AND `weekday` IS NULL) OR (`frequency` = 'weekly' AND `weekday` IS NOT NULL)),
	CONSTRAINT `local_server_restart_schedule_empty_check` CHECK (`only_when_empty` IN (0, 1)),
	CONSTRAINT `local_server_restart_schedule_wait_check` CHECK (`wait_policy` IN ('skip', 'retry')),
	CONSTRAINT `local_server_restart_schedule_retry_bounds_check` CHECK (`retry_interval_minutes` BETWEEN 1 AND 30 AND `wait_deadline_minutes` BETWEEN 1 AND 180 AND `retry_interval_minutes` <= `wait_deadline_minutes`),
	CONSTRAINT `local_server_restart_schedule_status_check` CHECK (`last_status` IS NULL OR `last_status` IN ('executed', 'skipped', 'deferred', 'failed', 'interrupted', 'missed'))
);
--> statement-breakpoint
CREATE TABLE `local_server_restart_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL REFERENCES `local_servers`(`id`) ON DELETE cascade,
	`scheduled_for` text NOT NULL,
	`status` text NOT NULL,
	`outcome` text NOT NULL,
	`started_at` text,
	`finished_at` text,
	`next_attempt_at` text,
	`deadline_at` text NOT NULL,
	`error_message` text,
	`acknowledged_at` text,
	`created_at` text NOT NULL,
	CONSTRAINT `local_server_restart_jobs_status_check` CHECK (`status` IN ('running', 'executed', 'skipped', 'deferred', 'failed', 'interrupted', 'missed')),
	CONSTRAINT `local_server_restart_jobs_outcome_check` CHECK (`outcome` IN ('pending', 'completed', 'players-online', 'player-count-unknown', 'server-offline', 'unmanaged', 'conflict', 'pending-restore', 'pending-removal', 'deadline-reached', 'missed', 'interrupted', 'restart-failed', 'schedule-changed')),
	CONSTRAINT `local_server_restart_jobs_slot_unique` UNIQUE (`server_id`, `scheduled_for`)
);
--> statement-breakpoint
CREATE INDEX `local_server_restart_jobs_server_time_idx` ON `local_server_restart_jobs` (`server_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `local_server_restart_jobs_due_idx` ON `local_server_restart_jobs` (`status`, `next_attempt_at`);
