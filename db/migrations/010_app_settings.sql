-- Key/value app settings (admin-editable; env values remain fallback defaults).
CREATE TABLE IF NOT EXISTS `app_settings` (
  `setting_key`   varchar(64) COLLATE utf8mb4_unicode_ci NOT NULL,
  `setting_value` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `updated_at`    datetime NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed RapidAPI runtime defaults (ignore if already set).
INSERT IGNORE INTO `app_settings` (`setting_key`, `setting_value`) VALUES
  ('rapidapi.poll_live_ms', '120000'),
  ('rapidapi.min_gap_ms', '2500'),
  ('rapidapi.scorecard_every_n', '4'),
  ('rapidapi.sync_fixture_limit', '20');
