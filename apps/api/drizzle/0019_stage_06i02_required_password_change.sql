ALTER TABLE `users` ADD COLUMN `must_change_password` integer NOT NULL DEFAULT 0 CHECK (`must_change_password` IN (0, 1));
