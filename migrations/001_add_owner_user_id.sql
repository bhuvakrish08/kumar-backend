-- Migration 001: Add owner_user_id column to contacts and sources tables
-- Backfill owner_user_id from created_by (falling back to verified Kumar production user ID if NULL), FK constraints, and indexes.

-- Step 1: Add owner_user_id column to contacts table if not exists
ALTER TABLE `contacts` ADD COLUMN `owner_user_id` bigint(20) UNSIGNED DEFAULT NULL AFTER `photo_url`;

-- Backfill contacts.owner_user_id from created_by (fallback to verified Kumar production user ID)
UPDATE `contacts` SET `owner_user_id` = COALESCE(`created_by`, (SELECT `id` FROM `users` WHERE `username` = 'kumar' LIMIT 1)) WHERE `owner_user_id` IS NULL;

-- Enforce NOT NULL constraint on contacts.owner_user_id
ALTER TABLE `contacts` MODIFY COLUMN `owner_user_id` bigint(20) UNSIGNED NOT NULL;

-- Add index and foreign key constraint for contacts.owner_user_id
ALTER TABLE `contacts` ADD KEY `idx_contacts_owner` (`owner_user_id`);
ALTER TABLE `contacts` ADD CONSTRAINT `fk_contacts_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;

-- Step 2: Add owner_user_id column to sources table if not exists
ALTER TABLE `sources` ADD COLUMN `owner_user_id` bigint(20) UNSIGNED DEFAULT NULL AFTER `created_by`;

-- Backfill sources.owner_user_id from created_by (fallback to verified Kumar production user ID)
UPDATE `sources` SET `owner_user_id` = COALESCE(`created_by`, (SELECT `id` FROM `users` WHERE `username` = 'kumar' LIMIT 1)) WHERE `owner_user_id` IS NULL;

-- Enforce NOT NULL constraint on sources.owner_user_id
ALTER TABLE `sources` MODIFY COLUMN `owner_user_id` bigint(20) UNSIGNED NOT NULL;

-- Add index, unique constraint, and foreign key constraint for sources.owner_user_id
ALTER TABLE `sources` ADD KEY `idx_sources_owner` (`owner_user_id`);
ALTER TABLE `sources` ADD CONSTRAINT `fk_sources_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE;
