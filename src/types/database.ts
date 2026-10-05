/**
 * Database types for Supabase tables
 * Auto-generated types can be created with: npx supabase gen types typescript
 */

export type NewsletterDeliveryMode = 'daily' | 'immediate'

export interface UserSettings {
  id: string
  user_id: string
  newsletter_email: string
  newsletter_delivery_hour: number // 0-23 (UTC), used for the daily digest
  /** @deprecated delivery mode is chosen per podcast (podcast_subscriptions.delivery_mode) */
  newsletter_delivery_mode: NewsletterDeliveryMode
  created_at: string
  updated_at: string
}

export interface UserSettingsInsert {
  user_id: string
  newsletter_email: string
  newsletter_delivery_hour: number
  newsletter_delivery_mode?: NewsletterDeliveryMode
  updated_at?: string
}

export interface UserSettingsUpdate {
  newsletter_email?: string
  newsletter_delivery_hour?: number
  newsletter_delivery_mode?: NewsletterDeliveryMode
  updated_at?: string
}

// PROJ-2: Podcast Subscriptions (Kanban #29: also YouTube channel sources)

export type SourceType = 'podcast' | 'youtube'

export interface PodcastSubscription {
  id: string
  user_id: string
  source_type: SourceType
  /** RSS feed for podcasts; for YouTube the channel's Atom feed (built from youtube_channel_id) */
  feed_url: string
  youtube_channel_id: string | null
  title: string
  description: string | null
  cover_image_url: string | null
  delivery_mode: NewsletterDeliveryMode
  enabled: boolean
  last_checked_at: string | null
  last_check_status: 'success' | 'error' | null
  last_check_error: string | null
  created_at: string
  updated_at: string
}

export interface PodcastSubscriptionInsert {
  user_id: string
  source_type?: SourceType
  feed_url: string
  youtube_channel_id?: string | null
  title: string
  description?: string | null
  cover_image_url?: string | null
  delivery_mode?: NewsletterDeliveryMode
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

export interface Episode {
  id: string
  subscription_id: string
  source_type: SourceType
  youtube_video_id: string | null
  transcript_source: 'captions' | 'audio_stt' | null
  error_code: YouTubeErrorCode | null
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

// PROJ-5: Episode Newsletters

export interface EpisodeNewsletter {
  id: string
  episode_id: string
  intro: string
  bullet_points: string[]
  key_takeaways: string[]
  created_at: string
}
