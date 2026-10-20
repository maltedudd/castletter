/**
 * Database types for Supabase tables
 * Auto-generated types can be created with: npx supabase gen types typescript
 */

export type NewsletterDeliveryMode = 'daily' | 'immediate'

/** Kanban #43: the two independent delivery targets of a source */
export type DeliveryTarget = 'immediate' | 'daily'

/** Kanban #38: tone of the AI summaries (UI: sachlich, prägnant, analytisch, warm). */
export type SummaryTone = 'neutral' | 'concise' | 'analytical' | 'warm'

export interface UserSettings {
  id: string
  user_id: string
  newsletter_email: string
  newsletter_delivery_hour: number // 0-23 (UTC), used for the daily digest
  /** @deprecated delivery mode is chosen per podcast (podcast_subscriptions.delivery_mode) */
  newsletter_delivery_mode: NewsletterDeliveryMode
  summary_tone: SummaryTone
  /** Optional style/perspective addition for the summaries, max. 500 characters */
  summary_prompt_addition: string | null
  created_at: string
  updated_at: string
}

export interface UserSettingsInsert {
  user_id: string
  newsletter_email: string
  newsletter_delivery_hour: number
  newsletter_delivery_mode?: NewsletterDeliveryMode
  summary_tone?: SummaryTone
  summary_prompt_addition?: string | null
  updated_at?: string
}

export interface UserSettingsUpdate {
  newsletter_email?: string
  newsletter_delivery_hour?: number
  newsletter_delivery_mode?: NewsletterDeliveryMode
  summary_tone?: SummaryTone
  summary_prompt_addition?: string | null
  updated_at?: string
}

// PROJ-2: Podcast Subscriptions (Kanban #29: also YouTube channel sources, #35: website RSS,
// #39: Mastodon accounts as social sources, #40: Bluesky accounts)

export type SourceType = 'podcast' | 'youtube' | 'website' | 'social'

export type SocialPlatform = 'mastodon' | 'bluesky'

export interface PodcastSubscription {
  id: string
  user_id: string
  source_type: SourceType
  /** RSS feed for podcasts, RSS/Atom feed for websites, the account's RSS feed for social sources; for YouTube the channel's Atom feed (built from youtube_channel_id) */
  feed_url: string
  youtube_channel_id: string | null
  /**
   * Social only: platform, handle and account ID for the public API. Mastodon: user@instance and
   * the instance's account ID (null: RSS only); Bluesky: current handle and the DID (stable ID).
   */
  social_platform: SocialPlatform | null
  social_handle: string | null
  social_account_id: string | null
  title: string
  description: string | null
  cover_image_url: string | null
  /** @deprecated since Kanban #43: derived from deliver_immediately/deliver_daily by a DB trigger */
  delivery_mode: NewsletterDeliveryMode
  /** Kanban #43: one mail per item as soon as it is ready (at least one target is on) */
  deliver_immediately: boolean
  /** Kanban #43: item is included in the daily digest */
  deliver_daily: boolean
  enabled: boolean
  /** Kanban #48: the user's category of this source (null = none, "Weitere Quellen" in the digest) */
  category_id: string | null
  last_checked_at: string | null
  last_check_status: 'success' | 'error' | null
  last_check_error: string | null
  created_at: string
  updated_at: string
}

/** Kanban #48: a private, named group of the user's sources; `position` is the user's order. */
export interface SourceCategory {
  id: string
  user_id: string
  /** Trimmed, 1–50 characters, unique per user (case-insensitive) */
  name: string
  position: number
  created_at: string
  updated_at: string
}

/** NIAS-61: role of a user in `user_roles` (granted by the service role only). */
export interface UserRole {
  user_id: string
  role: 'admin'
  created_at: string
}

/** NIAS-58: what an AI endpoint is used for; one endpoint per purpose. */
export type AiPurpose = 'transcription' | 'text_generation'

/** NIAS-58: OpenAI-compatible endpoint per purpose (service role only). */
export interface AiEndpoint {
  purpose: AiPurpose
  name: string
  /** http(s) URL without trailing slash, e.g. `https://openrouter.ai/api/v1` */
  base_url: string
  model: string
  /** `v1:<iv>:<tag>:<ciphertext>` (AES-256-GCM, AI_ENDPOINTS_ENCRYPTION_KEY); null = keyless */
  api_key_encrypted: string | null
  /** Last four characters for display, e.g. `…a1b2` */
  api_key_hint: string | null
  created_at: string
  updated_at: string
}

export interface PodcastSubscriptionInsert {
  user_id: string
  source_type?: SourceType
  feed_url: string
  youtube_channel_id?: string | null
  social_platform?: SocialPlatform | null
  social_handle?: string | null
  social_account_id?: string | null
  title: string
  description?: string | null
  cover_image_url?: string | null
  /** @deprecated since Kanban #43: use deliver_immediately/deliver_daily */
  delivery_mode?: NewsletterDeliveryMode
  deliver_immediately?: boolean
  deliver_daily?: boolean
  enabled?: boolean
}

/** Resolved channel returned by the /api/youtube/resolve endpoint */
export interface YouTubeChannelMeta {
  channelId: string
  title: string
  description: string | null
  thumbnailUrl: string | null
  feedUrl: string
}

/** Validated website feed returned by the /api/websites/validate endpoint */
export interface WebsiteFeedMeta {
  title: string
  description: string | null
  imageUrl: string | null
  feedUrl: string
  feedFormat: 'rss' | 'atom'
  /** full_text = complete articles in the feed; excerpt = articles are loaded from the website */
  contentMode: 'full_text' | 'excerpt' | 'empty'
}

/** Resolved Mastodon or Bluesky account returned by the /api/social/resolve endpoint */
export interface SocialAccountMeta {
  title: string
  description: string | null
  imageUrl: string | null
  /** The account's public RSS feed (Bluesky: built from the DID); identifies the source */
  feedUrl: string
  handle: string
  /** Mastodon: null when the instance API is not public and the account was resolved via RSS; Bluesky: the DID */
  accountId: string | null
  platform: SocialPlatform
}

/** A media attachment or link preview of a social post (https URLs only) */
export interface SocialMedia {
  type: string
  url: string
  previewUrl: string | null
  description: string | null
}

/** Parsed podcast metadata returned by the /api/podcasts/validate endpoint */
export interface PodcastFeedMeta {
  title: string
  description: string | null
  coverImageUrl: string | null
  feedUrl: string
}

// PROJ-3 & PROJ-4: Episodes

export type EpisodeStatus =
  | 'pending_transcription'
  | 'transcribing'
  | 'transcribed'
  | 'failed'
  | 'generating_newsletter'
  | 'newsletter_ready'
  | 'newsletter_sending'
  | 'newsletter_failed'
  | 'newsletter_sent'

export type YouTubeErrorCode =
  | 'video_unavailable'
  | 'video_not_yet_available'
  | 'youtube_blocked'
  | 'youtube_fetch_failed'
  | 'youtube_tool_missing'
  | 'audio_download_failed'
  | 'stt_failed'
  | 'transcription_failed'

/** Why a website article was not summarised (no complete public text). */
export type WebsiteErrorCode =
  | 'paywalled'
  | 'access_restricted'
  | 'content_incomplete'
  | 'article_unavailable'
  | 'article_fetch_failed'

export interface Episode {
  id: string
  subscription_id: string
  source_type: SourceType
  youtube_video_id: string | null
  transcript_source: 'captions' | 'audio_stt' | 'feed_content' | 'article' | null
  error_code: YouTubeErrorCode | WebsiteErrorCode | null
  /** Website only: public article link from the feed */
  article_url: string | null
  /** Website only: cleaned text of the feed item */
  feed_content: string | null
  /** Social only: sanitised post HTML, content warning and media (never summarised) */
  social_content: string | null
  social_spoiler: string | null
  social_media: SocialMedia[] | null
  /** Latest mail this episode was sent in (Kanban #37; legacy pointer – since #43 see NewsletterDelivery) */
  newsletter_mail_id: string | null
  guid: string
  title: string
  description: string | null
  audio_url: string
  duration_seconds: number | null
  published_at: string
  status: EpisodeStatus
  transcript: string | null
  error_message: string | null
  created_at: string
}

export interface FeedCheckLog {
  id: string
  subscription_id: string
  status: 'success' | 'error'
  error_message: string | null
  episodes_found: number
  checked_at: string
}

// Kanban #37: sent mails (newsletter archive)

export type NewsletterMailMode = 'daily' | 'immediate'

export interface NewsletterMail {
  id: string
  user_id: string
  mode: NewsletterMailMode
  /** Subject line exactly as sent */
  subject: string
  episode_count: number
  sent_at: string
  created_at: string
}

// Kanban #43: delivery of one episode to one target; the unique (episode_id, target) row is the send claim

export interface NewsletterDelivery {
  id: string
  user_id: string
  episode_id: string
  target: DeliveryTarget
  /** sending = claimed by a run (claimed_at starts the lease); sent = mailed in mail_id */
  status: 'sending' | 'sent'
  claimed_at: string
  sent_at: string | null
  mail_id: string | null
  created_at: string
}

// PROJ-5: Episode Newsletters

export interface EpisodeNewsletter {
  id: string
  episode_id: string
  intro: string
  bullet_points: string[]
  key_takeaways: string[]
  created_at: string
}
