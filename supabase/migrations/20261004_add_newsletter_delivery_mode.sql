-- Kanban #22: users choose between one daily digest at their delivery hour (default,
-- previous behaviour) and an immediate email per episode.
ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS newsletter_delivery_mode TEXT NOT NULL DEFAULT 'daily'
  CHECK (newsletter_delivery_mode IN ('daily', 'immediate'));

COMMENT ON COLUMN user_settings.newsletter_delivery_mode IS
  'daily = one digest at newsletter_delivery_hour (UTC); immediate = one email per episode as soon as its newsletter is ready';
