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

// PROJ-2: Podcast Subscriptions

export interface PodcastSubscription {
  id: string
  user_id: string
  feed_url: string
  title: string
  description: string | null
  cover_image_url: string | null
  created_at: string
  updated_at: string
}

export interface PodcastSubscriptionInsert {
  user_id: string
  feed_url: string
  title: string
  description?: string | null
  cover_image_url?: string | null
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

export interface Episode {
  id: string
  subscription_id: string
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
