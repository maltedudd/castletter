-- Kanban #39: public Mastodon accounts as a fourth source type „Social“ next to podcasts,
-- YouTube channels and websites. Social sources live in the existing source table
-- (podcast_subscriptions) and their posts in the existing episodes table, so delivery, digest
-- and archive stay one pipeline. Posts are never transcribed or summarised: the feed check
-- stores them sanitised and unchanged as `newsletter_ready`.
-- Existing podcast, YouTube and website rows are not changed. Idempotent: safe to run twice.

-- ─── Replace the CHECK constraints on the type columns ──────────────
-- Same approach as 20261006: drop whatever single-column CHECK references source_type.

DO $$
DECLARE
  target RECORD;
  constraint_name TEXT;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('podcast_subscriptions', 'source_type'),
      ('episodes', 'source_type')
    ) AS t(table_name, column_name)
  LOOP
    FOR constraint_name IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'c'
        AND c.conrelid = format('public.%I', target.table_name)::regclass
        AND a.attname = target.column_name
        AND array_length(c.conkey, 1) = 1
    LOOP
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', target.table_name, constraint_name);
    END LOOP;
  END LOOP;
END $$;

-- ─── Sources ─────────────────────────────────────────────────────────

ALTER TABLE podcast_subscriptions
  ADD COLUMN IF NOT EXISTS social_platform TEXT,
  ADD COLUMN IF NOT EXISTS social_handle TEXT,
  ADD COLUMN IF NOT EXISTS social_account_id TEXT;

ALTER TABLE podcast_subscriptions
  ADD CONSTRAINT podcast_subscriptions_source_type_check
    CHECK (source_type IN ('podcast', 'youtube', 'website', 'social'));

-- Only YouTube sources carry a channel ID.
ALTER TABLE podcast_subscriptions
  DROP CONSTRAINT IF EXISTS podcast_subscriptions_youtube_channel_id_check;
ALTER TABLE podcast_subscriptions
  ADD CONSTRAINT podcast_subscriptions_youtube_channel_id_check CHECK (
    (source_type = 'youtube' AND youtube_channel_id ~ '^UC[A-Za-z0-9_-]{22}$')
    OR (source_type IN ('podcast', 'website', 'social') AND youtube_channel_id IS NULL)
  );

-- Social sources name their platform and account; every other type leaves the columns empty.
-- feed_url holds the account's public RSS feed (https://<instance>/@<user>.rss), so the
-- existing UNIQUE(user_id, feed_url) prevents adding the same account twice.
ALTER TABLE podcast_subscriptions
  DROP CONSTRAINT IF EXISTS podcast_subscriptions_social_columns_check;
ALTER TABLE podcast_subscriptions
  ADD CONSTRAINT podcast_subscriptions_social_columns_check CHECK (
    (source_type = 'social'
      AND social_platform = 'mastodon'
      AND social_handle ~ '^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+$'
      AND feed_url ~ '^https://')
    OR (source_type <> 'social'
      AND social_platform IS NULL AND social_handle IS NULL AND social_account_id IS NULL)
  );

-- ─── Episodes / posts ────────────────────────────────────────────────

ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS social_content TEXT,
  ADD COLUMN IF NOT EXISTS social_spoiler TEXT,
  ADD COLUMN IF NOT EXISTS social_media JSONB;

ALTER TABLE episodes
  ADD CONSTRAINT episodes_source_type_check
    CHECK (source_type IN ('podcast', 'youtube', 'website', 'social'));

-- Post columns belong to social rows only.
ALTER TABLE episodes
  DROP CONSTRAINT IF EXISTS episodes_social_columns_check;
ALTER TABLE episodes
  ADD CONSTRAINT episodes_social_columns_check CHECK (
    source_type = 'social'
    OR (social_content IS NULL AND social_spoiler IS NULL AND social_media IS NULL)
  );
ALTER TABLE episodes
  DROP CONSTRAINT IF EXISTS episodes_social_media_check;
ALTER TABLE episodes
  ADD CONSTRAINT episodes_social_media_check CHECK (
    social_media IS NULL OR jsonb_typeof(social_media) = 'array'
  );

COMMENT ON COLUMN podcast_subscriptions.source_type IS
  'podcast = RSS feed in feed_url; youtube = channel, feed built from youtube_channel_id; website = public RSS/Atom feed of a website in feed_url; social = public Mastodon account, its RSS feed in feed_url';
COMMENT ON COLUMN podcast_subscriptions.social_platform IS
  'Social only: platform of the account (currently mastodon)';
COMMENT ON COLUMN podcast_subscriptions.social_handle IS
  'Social only: account handle user@instance as entered/resolved';
COMMENT ON COLUMN podcast_subscriptions.social_account_id IS
  'Social only: Mastodon account ID for the public API; NULL when the account could only be resolved via RSS (then RSS is read)';
COMMENT ON COLUMN episodes.social_content IS
  'Social only: post HTML after the allowlist sanitizer (no scripts, no images, only http(s) links); never summarised';
COMMENT ON COLUMN episodes.social_spoiler IS
  'Social only: content warning of the post (spoiler_text)';
COMMENT ON COLUMN episodes.social_media IS
  'Social only: JSON array of {type, url, previewUrl, description} – media attachments and link preview (https only)';
