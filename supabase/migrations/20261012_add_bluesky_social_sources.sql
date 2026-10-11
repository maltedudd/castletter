-- Kanban #40: public Bluesky accounts as a second platform of the social source type (#39).
-- Bluesky sources live in the same columns as Mastodon sources; only the social column
-- constraint learns the new platform. The DID is the stable identity of a Bluesky account:
-- it is stored in social_account_id and builds feed_url (https://bsky.app/profile/<did>/rss),
-- so the existing UNIQUE(user_id, feed_url) prevents adding the same account twice – also
-- under an old or new handle. social_handle is only the current handle for display.
-- Posts use the existing social columns of episodes; nothing changes there.
-- Existing rows are not changed (the Mastodon condition is identical to 20261009).
-- Idempotent: safe to run twice.

ALTER TABLE podcast_subscriptions
  DROP CONSTRAINT IF EXISTS podcast_subscriptions_social_columns_check;
ALTER TABLE podcast_subscriptions
  ADD CONSTRAINT podcast_subscriptions_social_columns_check CHECK (
    (source_type = 'social'
      AND social_platform = 'mastodon'
      AND social_handle ~ '^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+$'
      AND feed_url ~ '^https://')
    OR (source_type = 'social'
      AND social_platform = 'bluesky'
      AND social_account_id ~ '^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$'
      AND social_handle ~ '^[a-z0-9.:-]+$'
      AND feed_url = 'https://bsky.app/profile/' || social_account_id || '/rss')
    OR (source_type <> 'social'
      AND social_platform IS NULL AND social_handle IS NULL AND social_account_id IS NULL)
  );

COMMENT ON COLUMN podcast_subscriptions.source_type IS
  'podcast = RSS feed in feed_url; youtube = channel, feed built from youtube_channel_id; website = public RSS/Atom feed of a website in feed_url; social = public Mastodon or Bluesky account, its RSS feed in feed_url';
COMMENT ON COLUMN podcast_subscriptions.social_platform IS
  'Social only: platform of the account (mastodon or bluesky)';
COMMENT ON COLUMN podcast_subscriptions.social_handle IS
  'Social only: Mastodon handle user@instance as entered/resolved; Bluesky: current handle (the DID when no verified handle is known), updated by the feed check';
COMMENT ON COLUMN podcast_subscriptions.social_account_id IS
  'Social only: Mastodon account ID for the public API (NULL when the account could only be resolved via RSS); Bluesky: the DID (required, stable across handle changes)';
