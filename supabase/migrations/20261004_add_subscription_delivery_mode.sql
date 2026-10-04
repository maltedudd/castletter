-- Kanban #25: the delivery mode (daily digest vs. immediate email) is chosen per podcast
-- subscription instead of globally per user.
ALTER TABLE podcast_subscriptions
  ADD COLUMN IF NOT EXISTS delivery_mode TEXT NOT NULL DEFAULT 'daily'
  CHECK (delivery_mode IN ('daily', 'immediate'));

-- Keep current behaviour: existing subscriptions inherit the user's previous global setting.
UPDATE podcast_subscriptions ps
SET delivery_mode = us.newsletter_delivery_mode
FROM user_settings us
WHERE us.user_id = ps.user_id
  AND us.newsletter_delivery_mode = 'immediate';

-- Users change the delivery mode of their own subscriptions from the subscriptions page.
DROP POLICY IF EXISTS "Users can update own subscriptions" ON podcast_subscriptions;
CREATE POLICY "Users can update own subscriptions"
  ON podcast_subscriptions FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

COMMENT ON COLUMN podcast_subscriptions.delivery_mode IS
  'daily = included in the daily digest at user_settings.newsletter_delivery_hour; immediate = one email per episode as soon as its newsletter is ready';
COMMENT ON COLUMN user_settings.newsletter_delivery_mode IS
  'Deprecated since Kanban #25: delivery mode is chosen per subscription (podcast_subscriptions.delivery_mode)';
