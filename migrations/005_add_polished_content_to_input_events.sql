-- Migration 005: Add polished_content to input_events table for Sprint 3A
-- Preserves immutable raw input while tracking verified polished natural-language memory.

ALTER TABLE `input_events` 
ADD COLUMN IF NOT EXISTS `polished_content` TEXT DEFAULT NULL AFTER `raw_content`;
