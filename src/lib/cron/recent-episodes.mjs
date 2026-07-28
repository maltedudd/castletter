export const RECENT_EPISODE_WINDOW_HOURS = 48

export function getRecentEpisodeCutoff(now = new Date()) {
  return new Date(now.getTime() - RECENT_EPISODE_WINDOW_HOURS * 60 * 60 * 1000).toISOString()
}

export function isWithinRecentEpisodeWindow(publishedAt, now = new Date()) {
  return new Date(publishedAt).getTime() >= new Date(getRecentEpisodeCutoff(now)).getTime()
}

export function sortNewestFirst(episodes) {
  return [...episodes].sort(
    (a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime()
  )
}
