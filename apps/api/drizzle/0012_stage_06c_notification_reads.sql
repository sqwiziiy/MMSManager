CREATE TABLE `user_notification_reads` (
	`user_id` text NOT NULL,
	`event_id` text NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `event_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_notification_reads_read_idx` ON `user_notification_reads` (`user_id`,`read_at`);