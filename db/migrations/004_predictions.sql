-- 004_predictions.sql
-- Ball/over prediction game (virtual points) + RapidAPI ingest cursor.
-- Fresh installs get these tables from schema.sql; run this only on existing DBs.

USE fantasy_poc;

CREATE TABLE IF NOT EXISTS `prediction_wallets` (
  `user_id`    int NOT NULL,
  `balance`    int NOT NULL DEFAULT '1000',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `prediction_wallets_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `predictions` (
  `id`          int NOT NULL AUTO_INCREMENT,
  `user_id`     int NOT NULL,
  `match_id`    int NOT NULL,
  `scope`       enum('BALL','OVER') COLLATE utf8mb4_unicode_ci NOT NULL,
  `innings`     tinyint NOT NULL,
  `over_number` int NOT NULL,
  `ball_number` tinyint NOT NULL DEFAULT '0',  -- 1-6 for BALL, 0 for OVER scope
  `predicted`   varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `actual`      varchar(24) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `stake`       int NOT NULL,
  `payout`      int NOT NULL DEFAULT '0',
  `status`      enum('OPEN','WON','LOST','VOID') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'OPEN',
  `created_at`  datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `resolved_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_pred_target` (`user_id`,`match_id`,`scope`,`innings`,`over_number`,`ball_number`),
  KEY `idx_pred_open` (`match_id`,`status`,`innings`,`over_number`),
  CONSTRAINT `predictions_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `predictions_ibfk_2` FOREIGN KEY (`match_id`) REFERENCES `matches` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Last ingested delivery per external (RapidAPI) match + running totals for
-- the over currently in progress, so over-level predictions resolve exactly.
CREATE TABLE IF NOT EXISTS `rapidapi_cursor` (
  `match_id`         int NOT NULL,
  `innings`          tinyint NOT NULL DEFAULT '1',
  `over_number`      int NOT NULL DEFAULT '0',
  `ball_number`      tinyint NOT NULL DEFAULT '0',
  `curr_over_runs`   int NOT NULL DEFAULT '0',
  `curr_over_wicket` tinyint(1) NOT NULL DEFAULT '0',
  `updated_at`       datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`match_id`),
  CONSTRAINT `rapidapi_cursor_ibfk_1` FOREIGN KEY (`match_id`) REFERENCES `matches` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
