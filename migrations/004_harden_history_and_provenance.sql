-- Migration 004: Harden History, Provenance, and User Phone Region
-- Adds candidate_fact_id, temporal_precision, and raw_time_expression to contact_history
-- Adds phone_region to users table
-- Adds composite index for contact_history (owner_user_id, contact_id, fact_type, is_current)
-- Adds composite index for fact_provenance (owner_user_id, target_type, target_id)
-- Safely backfills legacy fact_provenance target_reference values

-- Step 1: Add phone_region to users table if not exists
ALTER TABLE `users`
  ADD COLUMN IF NOT EXISTS `phone_region` varchar(2) DEFAULT NULL COMMENT 'ISO 3166-1 alpha-2 country code';

-- Step 2: Alter contact_history table to add candidate_fact_id, temporal_precision, raw_time_expression
ALTER TABLE `contact_history`
  ADD COLUMN IF NOT EXISTS `candidate_fact_id` bigint(20) UNSIGNED DEFAULT NULL AFTER `source_input_event_id`,
  ADD COLUMN IF NOT EXISTS `temporal_precision` varchar(50) NOT NULL DEFAULT 'unknown' COMMENT 'exact, day, month, year, relative, unknown' AFTER `confidence_status`,
  ADD COLUMN IF NOT EXISTS `raw_time_expression` varchar(255) DEFAULT NULL AFTER `temporal_precision`;

-- Add foreign key constraint for candidate_fact_id in contact_history if not exists
-- (Handled safely in migrate_db.js to ensure idempotency across MySQL versions)

-- Step 3: Add composite indexes
-- Key on contact_history for rapid owner/contact/fact_type current queries
-- Key on fact_provenance for owner/target lookups
ALTER TABLE `contact_history`
  ADD KEY IF NOT EXISTS `idx_history_owner_contact_type_current` (`owner_user_id`, `contact_id`, `fact_type`, `is_current`);

ALTER TABLE `fact_provenance`
  ADD KEY IF NOT EXISTS `idx_provenance_owner_target` (`owner_user_id`, `target_type`, `target_id`);

-- Step 4: Safely backfill legacy target_reference values in fact_provenance
UPDATE `fact_provenance`
SET `target_type` = 'contact',
    `target_id` = CAST(SUBSTRING(`target_reference`, 10) AS UNSIGNED)
WHERE (`target_type` IS NULL OR `target_id` IS NULL)
  AND `target_reference` LIKE 'contacts:%'
  AND SUBSTRING(`target_reference`, 10) REGEXP '^[0-9]+$';

UPDATE `fact_provenance`
SET `target_type` = 'interaction',
    `target_id` = CAST(SUBSTRING(`target_reference`, 14) AS UNSIGNED)
WHERE (`target_type` IS NULL OR `target_id` IS NULL)
  AND `target_reference` LIKE 'interactions:%'
  AND SUBSTRING(`target_reference`, 14) REGEXP '^[0-9]+$';
