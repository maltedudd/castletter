-- Kanban #35: public websites (RSS/Atom feeds) as a third source type „Website (RSS)“ next
-- to podcast RSS feeds and YouTube channels. Websites live in the existing source table
-- (podcast_subscriptions) and their articles in the existing episodes table, so newsletter
-- generation, review and delivery stay one pipeline. Articles need no audio: the worker takes
-- the complete text from the feed or the linked public article page.
-- Existing podcast and YouTube rows are not changed. Idempotent: safe to run twice.

-- ─── Replace the CHECK constraints on the type columns ──────────────
-- The constraints from 20261005 were declared inline and got generated names; drop whatever
-- CHECK constraint references the column instead of guessing the name.

DO $$
DECLARE
  target RECORD;
  constraint_name TEXT;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('podcast_subscriptions', 'source_type'),
      ('episodes', 'source_type'),
      ('episodes', 'transcript_source')
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
  ADD CONSTRAINT podcast_subscriptions_source_type_check
    CHECK (source_type IN ('podcast', 'youtube', 'website'));

-- Only YouTube sources carry a channel ID; podcasts and websites are identified by feed_url
-- (unique per user as before).
ALTER TABLE podcast_subscriptions
  DROP CONSTRAINT IF EXISTS podcast_subscriptions_youtube_channel_id_check;
ALTER TABLE podcast_subscriptions
  ADD CONSTRAINT podcast_subscriptions_youtube_channel_id_check CHECK (
    (source_type = 'youtube' AND youtube_channel_id ~ '^UC[A-Za-z0-9_-]{22}$')
    OR (source_type IN ('podcast', 'website') AND youtube_channel_id IS NULL)
  );

-- ─── Episodes / articles ─────────────────────────────────────────────

ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS article_url TEXT,
  ADD COLUMN IF NOT EXISTS feed_content TEXT;

ALTER TABLE episodes
  ADD CONSTRAINT episodes_source_type_check
    CHECK (source_type IN ('podcast', 'youtube', 'website'));

ALTER TABLE episodes
  ADD CONSTRAINT episodes_transcript_source_check
    CHECK (transcript_source IN ('captions', 'audio_stt', 'feed_content', 'article'));

-- Article columns belong to website rows only.
ALTER TABLE episodes
  DROP CONSTRAINT IF EXISTS episodes_website_columns_check;
ALTER TABLE episodes
  ADD CONSTRAINT episodes_website_columns_check CHECK (
    source_type = 'website' OR (article_url IS NULL AND feed_content IS NULL)
  );

COMMENT ON COLUMN podcast_subscriptions.source_type IS
  'podcast = RSS feed in feed_url; youtube = channel, feed built from youtube_channel_id; website = public RSS/Atom feed of a website in feed_url';
COMMENT ON COLUMN episodes.article_url IS
  'Website only: public article link from the feed item (audio_url holds the same link, or the feed URL when the item has none)';
COMMENT ON COLUMN episodes.feed_content IS
  'Website only: cleaned text of the feed item; used as-is when complete, otherwise the public article is fetched';
COMMENT ON COLUMN episodes.transcript_source IS
  'captions / audio_stt (YouTube); feed_content = complete text from the feed, article = text of the public article page (website)';
COMMENT ON COLUMN episodes.error_code IS
  'Machine-readable failure reason. YouTube: video_unavailable, video_not_yet_available, youtube_blocked, youtube_fetch_failed, youtube_tool_missing, audio_download_failed, stt_failed, transcription_failed. Website: paywalled, access_restricted, content_incomplete, article_unavailable, article_fetch_failed';
