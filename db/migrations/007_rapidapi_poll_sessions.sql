-- 007_rapidapi_poll_sessions.sql
-- Timed RapidAPI auto-poll sessions (admin-controlled) + per-session API call counts.
-- For existing DBs; fresh installs use schema.sql.

USE fantasy_poc;

CREATE TABLE IF NOT EXISTS `rapidapi_poll_sessions` (
  `id`               bigint NOT NULL AUTO_INCREMENT,
  `duration_minutes` int NOT NULL,
  `started_at`       datetime NOT NULL,
  `ends_at`          datetime NOT NULL,
  `stopped_at`       datetime DEFAULT NULL,
  `status`           enum('ACTIVE','EXPIRED','STOPPED') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'ACTIVE',
  `api_calls`        int NOT NULL DEFAULT 0,
  `started_by`       int DEFAULT NULL,
  `created_at`       datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_poll_status_ends` (`status`,`ends_at`),
  CONSTRAINT `rapidapi_poll_sessions_ibfk_1`
    FOREIGN KEY (`started_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
