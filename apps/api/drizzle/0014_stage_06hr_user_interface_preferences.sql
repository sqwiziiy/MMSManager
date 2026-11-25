ALTER TABLE `user_preferences` ADD COLUMN `language` text NOT NULL DEFAULT 'en' CHECK (`language` IN ('en', 'ru'));
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD COLUMN `theme` text NOT NULL DEFAULT 'dark' CHECK (`theme` IN ('dark', 'light', 'system'));
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD COLUMN `accent` text NOT NULL DEFAULT 'moss' CHECK (`accent` IN ('moss', 'blue', 'clay'));
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD COLUMN `density` text NOT NULL DEFAULT 'comfortable' CHECK (`density` IN ('comfortable', 'compact'));
--> statement-breakpoint
ALTER TABLE `user_preferences` ADD COLUMN `reduced_motion` integer NOT NULL DEFAULT 0 CHECK (`reduced_motion` IN (0, 1));
