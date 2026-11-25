ALTER TABLE `local_server_console_entries`
  ADD COLUMN `session_id` text REFERENCES `local_server_sessions`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `local_server_console_entries_session_order_idx`
  ON `local_server_console_entries` (`session_id`, `id`);
