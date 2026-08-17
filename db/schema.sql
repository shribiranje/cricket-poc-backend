-- Fantasy POC schema — DDL from poc_v1.sql + deltas from poc_v2.sql
-- (matches.timezone / matches.auto_start / match_state).
-- Seed/reference data lives in seed.sql; demo users are created by dbInit.
CREATE DATABASE IF NOT EXISTS fantasy_poc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE fantasy_poc;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- users
CREATE TABLE IF NOT EXISTS `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `password_hash` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `display_name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `avatar_url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `is_admin` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- teams
CREATE TABLE IF NOT EXISTS `teams` (
  `id` int NOT NULL AUTO_INCREMENT,
  `external_id` bigint DEFAULT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `short_name` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL,
  `logo_url` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `external_id` (`external_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- players
CREATE TABLE IF NOT EXISTS `players` (
  `id` int NOT NULL AUTO_INCREMENT,
  `external_id` bigint DEFAULT NULL,
  `team_id` int NOT NULL,
  `name` varchar(100) COLLATE utf8mb4_unicode_ci NOT NULL,
  `role` enum('BATSMAN','BOWLER','ALL_ROUNDER','WICKET_KEEPER') COLLATE utf8mb4_unicode_ci NOT NULL,
  `credit` decimal(4,1) NOT NULL DEFAULT '8.0',
  PRIMARY KEY (`id`),
  UNIQUE KEY `external_id` (`external_id`),
  KEY `idx_players_team` (`team_id`),
  CONSTRAINT `players_ibfk_1` FOREIGN KEY (`team_id`) REFERENCES `teams` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- matches
CREATE TABLE IF NOT EXISTS `matches` (
  `id` int NOT NULL AUTO_INCREMENT,
  `external_id` bigint DEFAULT NULL,
  `team_a_id` int NOT NULL,
  `team_b_id` int NOT NULL,
  `format` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'T20',
  `venue` varchar(200) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `start_time` datetime NOT NULL,
  `timezone` varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UTC',
  `auto_start` tinyint(1) NOT NULL DEFAULT '1',
  `status` enum('UPCOMING','LIVE','COMPLETED') COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'UPCOMING',
  `external_status` varchar(50) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `external_id` (`external_id`),
  KEY `team_a_id` (`team_a_id`),
  KEY `team_b_id` (`team_b_id`),
  KEY `idx_matches_status` (`status`),
  KEY `idx_matches_start` (`start_time`),
  CONSTRAINT `matches_ibfk_1` FOREIGN KEY (`team_a_id`) REFERENCES `teams` (`id`),
  CONSTRAINT `matches_ibfk_2` FOREIGN KEY (`team_b_id`) REFERENCES `teams` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- match_state (live engine scoreboard; from poc_v2.sql)
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

-- match_players
CREATE TABLE IF NOT EXISTS `match_players` (
  `match_id` int NOT NULL,
  `player_id` int NOT NULL,
  PRIMARY KEY (`match_id`,`player_id`),
  KEY `player_id` (`player_id`),
  CONSTRAINT `match_players_ibfk_1` FOREIGN KEY (`match_id`) REFERENCES `matches` (`id`) ON DELETE CASCADE,
  CONSTRAINT `match_players_ibfk_2` FOREIGN KEY (`player_id`) REFERENCES `players` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- player_match_stats
CREATE TABLE IF NOT EXISTS `player_match_stats` (
  `match_id` int NOT NULL,
  `player_id` int NOT NULL,
  `runs` int NOT NULL DEFAULT '0',
  `balls_faced` int NOT NULL DEFAULT '0',
  `fours` int NOT NULL DEFAULT '0',
  `sixes` int NOT NULL DEFAULT '0',
  `wickets` int NOT NULL DEFAULT '0',
  `balls_bowled` int NOT NULL DEFAULT '0',
  `runs_conceded` int NOT NULL DEFAULT '0',
  `catches` int NOT NULL DEFAULT '0',
  `run_outs` int NOT NULL DEFAULT '0',
  `stumpings` int NOT NULL DEFAULT '0',
  `points` decimal(8,2) NOT NULL DEFAULT '0.00',
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`match_id`,`player_id`),
  KEY `player_id` (`player_id`),
  CONSTRAINT `player_match_stats_ibfk_1` FOREIGN KEY (`match_id`) REFERENCES `matches` (`id`) ON DELETE CASCADE,
  CONSTRAINT `player_match_stats_ibfk_2` FOREIGN KEY (`player_id`) REFERENCES `players` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- match_events
CREATE TABLE IF NOT EXISTS `match_events` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `match_id` int NOT NULL,
  `player_id` int NOT NULL,
  `event_type` varchar(30) COLLATE utf8mb4_unicode_ci NOT NULL,
  `value` int NOT NULL DEFAULT '0',
  `meta` json DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `player_id` (`player_id`),
  KEY `idx_events_match` (`match_id`,`created_at`),
  CONSTRAINT `match_events_ibfk_1` FOREIGN KEY (`match_id`) REFERENCES `matches` (`id`) ON DELETE CASCADE,
  CONSTRAINT `match_events_ibfk_2` FOREIGN KEY (`player_id`) REFERENCES `players` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- user_teams
CREATE TABLE IF NOT EXISTS `user_teams` (
  `id` int NOT NULL AUTO_INCREMENT,
  `user_id` int NOT NULL,
  `match_id` int NOT NULL,
  `captain_player_id` int NOT NULL,
  `vice_captain_player_id` int NOT NULL,
  `total_credits_used` decimal(5,1) NOT NULL,
  `total_points` decimal(8,2) NOT NULL DEFAULT '0.00',
  `is_locked` tinyint(1) NOT NULL DEFAULT '0',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_match` (`user_id`,`match_id`),
  KEY `captain_player_id` (`captain_player_id`),
  KEY `vice_captain_player_id` (`vice_captain_player_id`),
  KEY `idx_user_teams_match_points` (`match_id`,`total_points` DESC),
  CONSTRAINT `user_teams_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`),
  CONSTRAINT `user_teams_ibfk_2` FOREIGN KEY (`match_id`) REFERENCES `matches` (`id`),
  CONSTRAINT `user_teams_ibfk_3` FOREIGN KEY (`captain_player_id`) REFERENCES `players` (`id`),
  CONSTRAINT `user_teams_ibfk_4` FOREIGN KEY (`vice_captain_player_id`) REFERENCES `players` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- user_team_players
CREATE TABLE IF NOT EXISTS `user_team_players` (
  `user_team_id` int NOT NULL,
  `player_id` int NOT NULL,
  PRIMARY KEY (`user_team_id`,`player_id`),
  KEY `player_id` (`player_id`),
  CONSTRAINT `user_team_players_ibfk_1` FOREIGN KEY (`user_team_id`) REFERENCES `user_teams` (`id`) ON DELETE CASCADE,
  CONSTRAINT `user_team_players_ibfk_2` FOREIGN KEY (`player_id`) REFERENCES `players` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;


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

-- Admin-timed RapidAPI auto-poll windows; api_calls counts every outbound RapidAPI HTTP hit.
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

-- Per-request RapidAPI analytics (every outbound call via raFetch).
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

-- Prediction-wallet ledger (purchases, stakes, payouts, refunds).
CREATE TABLE IF NOT EXISTS `wallet_transactions` (
  `id`            bigint NOT NULL AUTO_INCREMENT,
  `user_id`       int NOT NULL,
  `type`          enum('PURCHASE','STAKE','PAYOUT','REFUND','STARTING_GRANT')
                    COLLATE utf8mb4_unicode_ci NOT NULL,
  `amount`        int NOT NULL COMMENT 'Signed: credits positive, debits negative',
  `balance_after` int NOT NULL,
  `prediction_id` bigint DEFAULT NULL,
  `note`          varchar(255) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_wtx_user_created` (`user_id`,`created_at`),
  KEY `idx_wtx_type` (`type`),
  CONSTRAINT `wallet_transactions_ibfk_1`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Key/value app settings (admin-editable; env values remain fallback defaults).
CREATE TABLE IF NOT EXISTS `app_settings` (
  `setting_key`   varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `setting_value` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated_at`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
