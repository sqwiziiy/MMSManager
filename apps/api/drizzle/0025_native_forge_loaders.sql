ALTER TABLE `local_servers` ADD `loader` text;--> statement-breakpoint
ALTER TABLE `server_install_operations` ADD `loader` text;--> statement-breakpoint
ALTER TABLE `server_install_operations` ADD `installer_log` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `server_install_operations` ADD `artifact_checksum_type` text;--> statement-breakpoint
ALTER TABLE `server_templates` ADD `loader` text;