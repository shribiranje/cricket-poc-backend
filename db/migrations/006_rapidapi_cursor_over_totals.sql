-- 006_rapidapi_cursor_over_totals.sql
-- Add running over totals used when settling OVER predictions mid-ingest.
ALTER TABLE `rapidapi_cursor`
  ADD COLUMN IF NOT EXISTS `curr_over_runs` int NOT NULL DEFAULT 0 AFTER `ball_number`,
  ADD COLUMN IF NOT EXISTS `curr_over_wicket` tinyint(1) NOT NULL DEFAULT 0 AFTER `curr_over_runs`;
