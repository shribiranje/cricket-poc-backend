-- poc_v2 schema deltas for existing DBs (safe ALTER / CREATE IF NOT EXISTS).
-- Fresh installs get these from schema.sql; run this only on DBs created from poc_v1 schema.

USE fantasy_poc;

-- matches: IANA timezone + auto-start flag for admin/scheduler
SET @col_tz := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'matches' AND COLUMN_NAME = 'timezone'
);
SET @sql_tz := IF(@col_tz = 0,
  'ALTER TABLE `matches` ADD COLUMN `timezone` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT ''UTC'' AFTER `start_time`',
  'SELECT 1');
PREPARE stmt_tz FROM @sql_tz; EXECUTE stmt_tz; DEALLOCATE PREPARE stmt_tz;

SET @col_as := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'matches' AND COLUMN_NAME = 'auto_start'
);
SET @sql_as := IF(@col_as = 0,
  'ALTER TABLE `matches` ADD COLUMN `auto_start` tinyint(1) NOT NULL DEFAULT 1 AFTER `timezone`',
  'SELECT 1');
PREPARE stmt_as FROM @sql_as; EXECUTE stmt_as; DEALLOCATE PREPARE stmt_as;

-- Engine scoreboard row per match
CREATE TABLE IF NOT EXISTS `match_state` (
  `match_id` int NOT NULL,
  `innings` tinyint NOT NULL DEFAULT '1',
  `batting_team_id` int NOT NULL,
  `bowling_team_id` int NOT NULL,
  `runs` int NOT NULL DEFAULT '0',
  `wickets` int NOT NULL DEFAULT '0',
  `legal_balls` int NOT NULL DEFAULT '0',
  `target` int DEFAULT NULL,
  `innings1_runs` int DEFAULT NULL,
  `innings1_wickets` int DEFAULT NULL,
  `innings1_balls` int DEFAULT NULL,
  `striker_id` int DEFAULT NULL,
  `non_striker_id` int DEFAULT NULL,
  `bowler_id` int DEFAULT NULL,
  `finished` tinyint(1) NOT NULL DEFAULT '0',
  `result` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `meta` json DEFAULT NULL,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`match_id`),
  CONSTRAINT `match_state_ibfk_1` FOREIGN KEY (`match_id`) REFERENCES `matches` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
