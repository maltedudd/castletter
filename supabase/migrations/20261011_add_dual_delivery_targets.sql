-- Kanban #43: a source can deliver immediately, in the daily digest or both. The exclusive
-- `podcast_subscriptions.delivery_mode` becomes two independent flags, and the delivery state
-- is tracked per target (`newsletter_deliveries`), so an immediate mail never uses up the
-- digest entry of the same episode.
--
-- Expand step of an expand–contract change: `delivery_mode` stays and is kept in sync by a
-- trigger, so code that only knows `delivery_mode` keeps working until the contract step
-- removes it. Existing sources keep their behaviour: `immediate` → immediate only,
-- `daily` → daily only. Idempotent: safe to run twice (the backfill only runs when the flag
-- columns are added).

-- ─── Sources: two delivery targets ────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'podcast_subscriptions' AND column_name = 'deliver_immediately'
  ) THEN
    ALTER TABLE podcast_subscriptions
      ADD COLUMN deliver_immediately BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN deliver_daily BOOLEAN NOT NULL DEFAULT true;

    UPDATE podcast_subscriptions
    SET deliver_immediately = true, deliver_daily = false
    WHERE delivery_mode = 'immediate';
  END IF;
END $$;

ALTER TABLE podcast_subscriptions
  DROP CONSTRAINT IF EXISTS podcast_subscriptions_delivery_target_required;
ALTER TABLE podcast_subscriptions
  ADD CONSTRAINT podcast_subscriptions_delivery_target_required
  CHECK (deliver_immediately OR deliver_daily);

-- Keeps `delivery_mode` and the flags consistent while both exist:
--   * a write that only changes `delivery_mode` (code before #43) sets the flags from it,
--   * every other write derives `delivery_mode` from the flags. "Both" maps to `immediate`,
--     so code before #43 still mails immediately and nothing is lost.
CREATE OR REPLACE FUNCTION sync_subscription_delivery_targets()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.delivery_mode IS DISTINCT FROM OLD.delivery_mode
     AND NEW.deliver_immediately IS NOT DISTINCT FROM OLD.deliver_immediately
     AND NEW.deliver_daily IS NOT DISTINCT FROM OLD.deliver_daily THEN
    NEW.deliver_immediately := NEW.delivery_mode = 'immediate';
    NEW.deliver_daily := NEW.delivery_mode IS DISTINCT FROM 'immediate';
  ELSIF TG_OP = 'INSERT'
     AND NEW.delivery_mode = 'immediate'
     AND NOT NEW.deliver_immediately
     AND NEW.deliver_daily THEN
    -- Insert with `delivery_mode` only (flags at their defaults).
    NEW.deliver_immediately := true;
    NEW.deliver_daily := false;
  ELSE
    NEW.delivery_mode := CASE
      WHEN NEW.deliver_daily AND NOT NEW.deliver_immediately THEN 'daily'
      ELSE 'immediate'
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sync_subscription_delivery_targets ON podcast_subscriptions;
CREATE TRIGGER sync_subscription_delivery_targets
  BEFORE INSERT OR UPDATE ON podcast_subscriptions
  FOR EACH ROW EXECUTE FUNCTION sync_subscription_delivery_targets();

COMMENT ON COLUMN podcast_subscriptions.deliver_immediately IS
  'Kanban #43: one email per episode as soon as it is ready';
COMMENT ON COLUMN podcast_subscriptions.deliver_daily IS
  'Kanban #43: episode is included in the daily digest at user_settings.newsletter_delivery_hour';
COMMENT ON COLUMN podcast_subscriptions.delivery_mode IS
  'Deprecated since Kanban #43: derived from deliver_immediately/deliver_daily by trigger (both → immediate); to be removed in the contract step';

-- ─── Delivery state per episode and target ────────────────────────────

CREATE TABLE IF NOT EXISTS newsletter_deliveries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  target TEXT NOT NULL CHECK (target IN ('immediate', 'daily')),
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent')),
  claimed_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  mail_id UUID REFERENCES newsletter_mails(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The claim: one delivery per episode and target, ever.
  CONSTRAINT newsletter_deliveries_episode_target_key UNIQUE (episode_id, target)
);

-- Archive: the episodes of a mail.
CREATE INDEX IF NOT EXISTS idx_newsletter_deliveries_mail_id
  ON newsletter_deliveries(mail_id)
  WHERE mail_id IS NOT NULL;

-- Send sweep: claims of crashed runs.
CREATE INDEX IF NOT EXISTS idx_newsletter_deliveries_sending
  ON newsletter_deliveries(claimed_at)
  WHERE status = 'sending';

-- Written by the worker / send cron with the service role only; users read their own rows.
ALTER TABLE newsletter_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own newsletter deliveries" ON newsletter_deliveries;
CREATE POLICY "Users can view own newsletter deliveries"
  ON newsletter_deliveries FOR SELECT
  USING (auth.uid() = user_id);

COMMENT ON TABLE newsletter_deliveries IS
  'Kanban #43: delivery of one episode to one target (immediate mail or daily digest); the unique (episode_id, target) row is the send claim';
COMMENT ON COLUMN newsletter_deliveries.status IS
  'sending = claimed by a run (claimed_at is the lease start); sent = mailed in mail_id';

-- Episodes already mailed before this migration: one sent row for the mail they point to, so
-- the archive can list every mail through newsletter_deliveries.
INSERT INTO newsletter_deliveries (user_id, episode_id, target, status, claimed_at, sent_at, mail_id)
SELECT m.user_id, e.id, m.mode, 'sent', COALESCE(e.newsletter_sent_at, m.sent_at), COALESCE(e.newsletter_sent_at, m.sent_at), m.id
FROM episodes e
JOIN newsletter_mails m ON m.id = e.newsletter_mail_id
ON CONFLICT (episode_id, target) DO NOTHING;

COMMENT ON COLUMN episodes.newsletter_mail_id IS
  'Last mail this episode was sent in (legacy pointer; since Kanban #43 newsletter_deliveries holds every mail per target)';
