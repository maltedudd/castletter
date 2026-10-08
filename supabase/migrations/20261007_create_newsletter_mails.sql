-- Kanban #37: the newsletter archive shows the mails a user actually received – each daily
-- digest as one entry with all its episodes, each immediate mail on its own. Until now only
-- episodes were marked `newsletter_sent`; the mail itself was never stored.
-- Mails sent before this migration are not reconstructed. Idempotent: safe to run twice.

CREATE TABLE IF NOT EXISTS newsletter_mails (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('daily', 'immediate')),
  subject TEXT NOT NULL,
  episode_count INT NOT NULL CHECK (episode_count > 0),
  sent_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Archive list: newest mails of one user first.
CREATE INDEX IF NOT EXISTS idx_newsletter_mails_user_sent_at
  ON newsletter_mails(user_id, sent_at DESC);

-- Written by the worker / send cron with the service role only; users read their own mails.
ALTER TABLE newsletter_mails ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own newsletter mails" ON newsletter_mails;
CREATE POLICY "Users can view own newsletter mails"
  ON newsletter_mails FOR SELECT
  USING (auth.uid() = user_id);

-- Episodes point to the mail they were sent in.
ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS newsletter_mail_id UUID REFERENCES newsletter_mails(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_episodes_newsletter_mail_id
  ON episodes(newsletter_mail_id)
  WHERE newsletter_mail_id IS NOT NULL;

COMMENT ON TABLE newsletter_mails IS
  'One row per sent newsletter mail (daily digest or immediate mail); shown in the archive';
COMMENT ON COLUMN newsletter_mails.subject IS 'Subject line exactly as sent';
COMMENT ON COLUMN episodes.newsletter_mail_id IS
  'Mail this episode was sent in (null for episodes sent before Kanban #37 or not yet sent)';
