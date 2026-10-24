-- Migration 006: Add is_demo_account, make interactions.occurred_at nullable, and add raw_time_expression
-- Sprint 3A.1 Surgical Correction & Safety Isolation

-- 1. Add is_demo_account to users table (default FALSE)
ALTER TABLE `users` 
  ADD COLUMN IF NOT EXISTS `is_demo_account` BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Make interactions.occurred_at nullable to support unknown/approximate dates
ALTER TABLE `interactions` 
  MODIFY COLUMN `occurred_at` DATETIME DEFAULT NULL;

-- 3. Add raw_time_expression to interactions table to store expressions like 'years ago', 'recently'
ALTER TABLE `interactions` 
  ADD COLUMN IF NOT EXISTS `raw_time_expression` VARCHAR(255) DEFAULT NULL AFTER `occurred_at`;

-- 4. Ensure index on is_demo_account for fast authorization verification
CREATE INDEX IF NOT EXISTS `idx_users_is_demo` ON `users` (`is_demo_account`);
