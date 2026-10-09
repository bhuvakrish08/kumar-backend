-- Migration 003: Harden provenance structure and introduce contact_history for temporal reconciliation
-- Adds candidate_fact_id, target_type, target_id to fact_provenance.
-- Creates contact_history table to preserve historical facts without overwriting.

-- Step 1: Create contact_history table if not exists
CREATE TABLE IF NOT EXISTS `contact_history` (
  `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `owner_user_id` bigint(20) UNSIGNED NOT NULL,
  `contact_id` bigint(20) UNSIGNED NOT NULL,
  `fact_type` varchar(50) NOT NULL COMMENT 'employment, phone, email',
  `value_payload` json NOT NULL,
  `valid_from` datetime DEFAULT CURRENT_TIMESTAMP,
  `valid_to` datetime DEFAULT NULL,
  `is_current` tinyint(1) NOT NULL DEFAULT '1',
  `confidence_status` varchar(50) NOT NULL DEFAULT 'CONFIRMED' COMMENT 'CONFIRMED, HISTORICAL, FUTURE, UNCERTAIN',
  `source_input_event_id` bigint(20) UNSIGNED DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_history_owner` (`owner_user_id`),
  KEY `idx_history_contact` (`contact_id`),
  KEY `idx_history_event` (`source_input_event_id`),
  CONSTRAINT `fk_history_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_history_contact` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_history_event` FOREIGN KEY (`source_input_event_id`) REFERENCES `input_events` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 2: Alter fact_provenance table to support normalized target FK and type
ALTER TABLE `fact_provenance`
  ADD COLUMN `candidate_fact_id` bigint(20) UNSIGNED DEFAULT NULL AFTER `input_event_id`,
  ADD COLUMN `target_type` varchar(50) DEFAULT NULL AFTER `candidate_fact_id`,
  ADD COLUMN `target_id` bigint(20) UNSIGNED DEFAULT NULL AFTER `target_type`,
  ADD KEY `idx_provenance_candidate` (`candidate_fact_id`),
  ADD CONSTRAINT `fk_provenance_candidate` FOREIGN KEY (`candidate_fact_id`) REFERENCES `candidate_facts` (`id`) ON DELETE SET NULL;
