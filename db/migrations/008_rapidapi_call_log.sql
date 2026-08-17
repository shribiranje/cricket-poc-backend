-- 008_rapidapi_call_log.sql
-- Per-request RapidAPI analytics log (local DB only).
-- For existing DBs; fresh installs use schema.sql.

USE fantasy_poc;

CREATE TABLE IF NOT EXISTS `rapidapi_call_log` (
  `id`            bigint NOT NULL AUTO_INCREMENT,
  `path`          varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `endpoint_kind` varchar(32) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'other',
  `http_status`   int DEFAULT NULL,
  `ok`            tinyint(1) NOT NULL DEFAULT 0,
  `duration_ms`   int NOT NULL DEFAULT 0,
  `session_id`    bigint DEFAULT NULL,
  `error_message` varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_rapi_log_created` (`created_at`),
  KEY `idx_rapi_log_kind` (`endpoint_kind`),
  KEY `idx_rapi_log_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
