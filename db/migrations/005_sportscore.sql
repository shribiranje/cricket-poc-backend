-- 005_sportscore.sql
-- SportScore identifies teams/players/matches by string slugs
-- (e.g. 'india-vs-australia', 'virat-kohli'), while the existing
-- external_id columns are BIGINT (SportMonks numeric ids).
-- Rather than mutating external_id (which would risk the working
-- SportMonks integration), add parallel external_slug columns.
-- Both data sources coexist: SPORTMONKS uses external_id,
-- SPORTSCORE uses external_slug.

ALTER TABLE `teams`
  ADD COLUMN `external_slug` VARCHAR(191) DEFAULT NULL AFTER `external_id`,
  ADD UNIQUE KEY `uk_teams_external_slug` (`external_slug`);

ALTER TABLE `players`
  ADD COLUMN `external_slug` VARCHAR(191) DEFAULT NULL AFTER `external_id`,
  ADD UNIQUE KEY `uk_players_external_slug` (`external_slug`);

ALTER TABLE `matches`
  ADD COLUMN `external_slug` VARCHAR(191) DEFAULT NULL AFTER `external_id`,
  ADD UNIQUE KEY `uk_matches_external_slug` (`external_slug`);
