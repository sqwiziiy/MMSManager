CREATE TABLE `server_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`software` text NOT NULL,
	`version` text NOT NULL,
	`min_memory_mb` integer NOT NULL,
	`max_memory_mb` integer NOT NULL,
	`created_by` text,
	`updated_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `server_templates_software_check` CHECK (`software` IN ('vanilla', 'fabric', 'paper')),
	CONSTRAINT `server_templates_memory_check` CHECK (`min_memory_mb` >= 512 AND `max_memory_mb` >= `min_memory_mb` AND `max_memory_mb` <= 131072)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `server_templates_name_unique` ON `server_templates` (lower(`name`));
--> statement-breakpoint
CREATE INDEX `server_templates_updated_idx` ON `server_templates` (`updated_at`);
