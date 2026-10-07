-- Migration 002: Add input_events, candidate_facts, fact_provenance, and commitments tables
-- All tables include owner_user_id for multi-tenant isolation, foreign keys, indexes, and timestamps.

CREATE TABLE IF NOT EXISTS `input_events` (
  `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `owner_user_id` bigint(20) UNSIGNED NOT NULL,
  `input_type` varchar(50) NOT NULL DEFAULT 'text',
  `raw_content` text NOT NULL,
  `capture_time` datetime DEFAULT CURRENT_TIMESTAMP,
  `event_time_hint` datetime DEFAULT NULL,
  `processing_status` varchar(50) NOT NULL DEFAULT 'PENDING',
  `parser_version` varchar(50) NOT NULL DEFAULT '1.0.0',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_input_events_owner` (`owner_user_id`),
  CONSTRAINT `fk_input_events_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `candidate_facts` (
  `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `owner_user_id` bigint(20) UNSIGNED NOT NULL,
  `input_event_id` bigint(20) UNSIGNED NOT NULL,
  `candidate_type` varchar(100) NOT NULL,
  `structured_payload` json NOT NULL,
  `confidence` decimal(5,2) DEFAULT '0.00',
  `status` varchar(50) NOT NULL DEFAULT 'PENDING',
  `conflict_state` varchar(50) NOT NULL DEFAULT 'NONE',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_candidate_facts_owner` (`owner_user_id`),
  KEY `idx_candidate_facts_event` (`input_event_id`),
  CONSTRAINT `fk_candidate_facts_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_candidate_facts_event` FOREIGN KEY (`input_event_id`) REFERENCES `input_events` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `fact_provenance` (
  `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `owner_user_id` bigint(20) UNSIGNED NOT NULL,
  `input_event_id` bigint(20) UNSIGNED NOT NULL,
  `target_reference` varchar(255) NOT NULL,
  `fact_type` varchar(100) NOT NULL,
  `source_excerpt` text DEFAULT NULL,
  `confirmation_time` datetime DEFAULT CURRENT_TIMESTAMP,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_provenance_owner` (`owner_user_id`),
  KEY `idx_provenance_event` (`input_event_id`),
  CONSTRAINT `fk_provenance_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_provenance_event` FOREIGN KEY (`input_event_id`) REFERENCES `input_events` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `commitments` (
  `id` bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
  `owner_user_id` bigint(20) UNSIGNED NOT NULL,
  `contact_id` bigint(20) UNSIGNED DEFAULT NULL,
  `interaction_id` bigint(20) UNSIGNED DEFAULT NULL,
  `type` varchar(50) NOT NULL DEFAULT 'follow_up',
  `title` varchar(255) NOT NULL,
  `details` text DEFAULT NULL,
  `due_time` datetime DEFAULT NULL,
  `status` varchar(50) NOT NULL DEFAULT 'OPEN',
  `source_input_event_id` bigint(20) UNSIGNED DEFAULT NULL,
  `completion_time` datetime DEFAULT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_commitments_owner` (`owner_user_id`),
  KEY `idx_commitments_contact` (`contact_id`),
  KEY `idx_commitments_event` (`source_input_event_id`),
  CONSTRAINT `fk_commitments_owner` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_commitments_contact` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_commitments_event` FOREIGN KEY (`source_input_event_id`) REFERENCES `input_events` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
