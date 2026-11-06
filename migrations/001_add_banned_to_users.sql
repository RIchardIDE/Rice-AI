-- Add account suspension support to existing databases.
ALTER TABLE `users`
    ADD COLUMN IF NOT EXISTS `banned` tinyint(1) NOT NULL DEFAULT 0 AFTER `role`;
