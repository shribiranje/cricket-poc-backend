-- 009_wallet_transactions.sql
-- Prediction-wallet ledger for purchases, stakes, payouts, refunds.
-- For existing DBs; fresh installs use schema.sql.

USE fantasy_poc;

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
