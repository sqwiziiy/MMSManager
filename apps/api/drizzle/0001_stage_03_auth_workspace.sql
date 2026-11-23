CREATE TABLE `security_audit_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_user_id` text,
	`subject_user_id` text,
	`action` text NOT NULL,
	`outcome` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`subject_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "security_audit_events_outcome_check" CHECK("security_audit_events"."outcome" IN ('success', 'failure'))
);
--> statement-breakpoint
CREATE INDEX `security_audit_events_time_idx` ON `security_audit_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `security_audit_events_actor_idx` ON `security_audit_events` (`actor_user_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `auth_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`bootstrap_hash` text,
	`bootstrap_expires_at` text,
	`bootstrap_consumed_at` text,
	`initialized_at` text,
	CONSTRAINT "auth_state_singleton_check" CHECK("auth_state"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`csrf_hash` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_expiry_check" CHECK("sessions"."expires_at" > "sessions"."created_at")
);
--> statement-breakpoint
CREATE INDEX `sessions_user_active_idx` ON `sessions` (`user_id`,`revoked_at`,`expires_at`);--> statement-breakpoint
CREATE TABLE `user_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`compact_navigation` integer DEFAULT false NOT NULL,
	`default_landing` text DEFAULT 'dashboard' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "user_preferences_landing_check" CHECK("user_preferences"."default_landing" IN ('dashboard', 'machine'))
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`username_key` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`password_hash` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`avatar_key` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_login_at` text,
	`password_changed_at` text NOT NULL,
	CONSTRAINT "users_role_check" CHECK("users"."role" IN ('administrator', 'member')),
	CONSTRAINT "users_enabled_check" CHECK("users"."enabled" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_key_unique` ON `users` (`username_key`);--> statement-breakpoint
CREATE INDEX `users_enabled_role_idx` ON `users` (`enabled`,`role`);--> statement-breakpoint
CREATE TABLE `workspace_preferences` (
	`id` integer PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`default_landing` text DEFAULT 'dashboard' NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "workspace_preferences_singleton_check" CHECK("workspace_preferences"."id" = 1),
	CONSTRAINT "workspace_preferences_landing_check" CHECK("workspace_preferences"."default_landing" IN ('dashboard', 'machine'))
);
