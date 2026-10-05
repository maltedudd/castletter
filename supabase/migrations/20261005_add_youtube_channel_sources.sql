-- Kanban #29: public YouTube channels as a source type next to podcast RSS feeds.
-- Channels live in the existing source table (podcast_subscriptions) and their uploads in
-- the existing episodes table, so transcription, newsletter generation, review and delivery
-- stay one pipeline. Existing rows become source_type 'podcast' and behave as before.

-- ─── Sources ─────────────────────────────────────────────────────────

ALTER TABLE podcast_subscriptions
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'podcast'
    CHECK (source_type IN ('podcast', 'youtube')),
  ADD COLUMN IF NOT EXISTS youtube_channel_id TEXT,
  ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_check_status TEXT
    CHECK (last_check_status IN ('success', 'error')),
  ADD COLUMN IF NOT EXISTS last_check_error TEXT;

-- A YouTube source always carries a stable channel ID (UC + 22 chars), never a handle.
ALTER TABLE podcast_subscriptions
  DROP CONSTRAINT IF EXISTS podcast_subscriptions_youtube_channel_id_check;
ALTER TABLE podcast_subscriptions
  ADD CONSTRAINT podcast_subscriptions_youtube_channel_id_check CHECK (
    (source_type = 'youtube' AND youtube_channel_id ~ '^UC[A-Za-z0-9_-]{22}$')
    OR (source_type = 'podcast' AND youtube_channel_id IS NULL)
  );

-- One subscription per channel and user (feed_url is unique per user as well, this makes
-- the rule explicit on the stable ID).
CREATE UNIQUE INDEX IF NOT EXISTS idx_podcast_subscriptions_user_youtube_channel
  ON podcast_subscriptions(user_id, youtube_channel_id)
  WHERE source_type = 'youtube';

-- ─── Episodes / videos ───────────────────────────────────────────────

ALTER TABLE episodes
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'podcast'
    CHECK (source_type IN ('podcast', 'youtube')),
  ADD COLUMN IF NOT EXISTS youtube_video_id TEXT,
  ADD COLUMN IF NOT EXISTS transcript_source TEXT
    CHECK (transcript_source IN ('captions', 'audio_stt')),
  ADD COLUMN IF NOT EXISTS error_code TEXT;

-- Each video is processed at most once per source, independent of the guid format.
CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_subscription_youtube_video
  ON episodes(subscription_id, youtube_video_id)
  WHERE youtube_video_id IS NOT NULL;

COMMENT ON COLUMN podcast_subscriptions.source_type IS
  'podcast = RSS feed in feed_url; youtube = channel, feed built from youtube_channel_id';
COMMENT ON COLUMN podcast_subscriptions.youtube_channel_id IS
  'Stable YouTube channel ID (UC…) resolved from the entered channel URL/handle';
COMMENT ON COLUMN podcast_subscriptions.enabled IS
  'Disabled sources are skipped by the feed check; existing episodes are kept';
COMMENT ON COLUMN podcast_subscriptions.last_check_status IS
  'Result of the latest feed check (currently written for YouTube sources); details in last_check_error';
COMMENT ON COLUMN episodes.youtube_video_id IS
  'YouTube video ID for source_type = youtube (guid is yt:video:<id>, audio_url the watch URL)';
COMMENT ON COLUMN episodes.transcript_source IS
  'YouTube only: captions = complete YouTube captions, audio_stt = full audio via OpenRouter STT';
COMMENT ON COLUMN episodes.error_code IS
  'YouTube only: machine-readable failure reason (video_unavailable, video_not_yet_available, youtube_blocked, youtube_fetch_failed, youtube_tool_missing, audio_download_failed, stt_failed, transcription_failed)';
