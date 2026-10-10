/**
 * Email HTML template generator for daily newsletter digest
 * Uses inline styles for maximum email client compatibility
 */

import { digestSourceType, groupDigestItems, hasSummaryContent, isPodcastOnly, MIN_OVERVIEW_ITEMS, websiteSummary } from '../newsletter/digest.mjs'
import { safeHttpUrl, sanitizeSocialHtml, socialPostText } from '../social/sanitize.mjs'

/**
 * @typedef {Object} NewsletterItem
 * @property {string} podcastTitle
 * @property {string} episodeTitle
 * @property {string} intro
 * @property {string[]} bulletPoints
 * @property {string[]} keyTakeaways
 * @property {string[]} actionItems
 * @property {string[]} quotes
 * @property {string[]} speakers
 * @property {string | null} reflection
 * @property {string} audioUrl  Audio/video link, the article link for website sources, the post link for social posts
 * @property {'podcast' | 'youtube' | 'website' | 'social'} [sourceType]
 * @property {string} [id]
 * @property {string | null} [publishedAt]
 * @property {SocialPost} [social]  Social posts only: the original post, never summarised
 */

/**
 * @typedef {Object} SocialPost
 * @property {string} html  Sanitised post HTML (sanitised again when rendered)
 * @property {string | null} spoiler  Content warning
 * @property {{ type: string, url: string, previewUrl: string | null, description: string | null }[]} media
 */

/**
 * An item an overview point is drawn from, with its original link.
 * @typedef {Object} OverviewSource
 * @property {string | null} id
 * @property {string} sourceType
 * @property {string} sourceTitle
 * @property {string} title
 * @property {string} url
 */

/**
 * One key theme or connection of the overview and the items it is drawn from.
 * @typedef {Object} OverviewPoint
 * @property {string} text
 * @property {OverviewSource[]} sources
 */

/**
 * Integrated overview above the single summaries of a digest (see newsletter/digest.mjs).
 * @typedef {Object} DigestOverview
 * @property {OverviewPoint[]} themes
 * @property {OverviewPoint[]} connections
 * @property {string | null} reflection
 * @property {number} [itemCount]  How many summaries the overview is based on
 */


const COLORS = {
  primary: '#042940',
  secondary: '#005C53',
  accent: '#9FC131',
  highlight: '#DBF227',
  muted: '#D6D58E',
  bg: '#ffffff',
  border: '#eeeeee',
  textMuted: '#666666',
}



const strings = {
  de: {
    subject: 'Deine neuen Podcast-Updates',
    headerTagline: 'Deine täglichen Podcast-Highlights',
    greeting: 'Hallo,',
    greetingBody: 'hier sind deine neuen Podcast-Zusammenfassungen:',
    immediateSubject: 'Neue Folge',
    immediateHeaderTagline: 'Neue Folge, frisch zusammengefasst',
    immediateGreetingBody: (podcast) => `gerade ist eine neue Folge von „${podcast}“ erschienen. Hier ist deine Zusammenfassung:`,
    footerSentTo: (email) => `Diese Email wurde an ${email} gesendet.`,
    footerChangeSettings: 'Einstellungen ändern',
    sectionTopics: 'Hauptthemen',
    sectionTakeaways: 'Wichtige Aussagen',
    sectionTips: 'Tipps & Methoden',
    sectionQuotes: 'Zitate & Begriffe',
    sectionSpeakers: 'Wer sagt was',
    sectionReflection: 'Einordnung',
    listenButton: 'Episode anhören',
    readButton: 'Artikel lesen',
    immediateArticleSubject: 'Neuer Artikel',
    immediateArticleHeaderTagline: 'Neuer Artikel, frisch zusammengefasst',
    immediateArticleGreetingBody: (source) => `gerade ist ein neuer Artikel von „${source}“ erschienen. Hier ist deine Zusammenfassung:`,
    settingsLink: 'Einstellungen ändern',
    digestSubject: 'Dein Castletter',
    digestHeaderTagline: 'Dein täglicher Überblick über deine Quellen',
    digestGreetingBody: 'hier ist das Neue aus deinen Quellen:',
    sections: { podcast: 'Podcasts', youtube: 'YouTube', website: 'Website (RSS)', other: 'Weitere Inhalte' },
    overviewSources: 'Quellen',
    overviewLabel: 'Überblick',
    overviewTitle: (count) => `Das Wichtigste aus ${count} Inhalten`,
    overviewThemes: 'Kernthemen',
    overviewConnections: 'Zusammenhänge & Spannungen',
    overviewReflection: 'Einordnung',
    overviewNote: (count) => `KI-Überblick auf Basis der ${count} Zusammenfassungen unten; Podcasts sind am stärksten gewichtet, dann YouTube, dann Website (RSS). Jeder Punkt verlinkt die Beiträge, aus denen er stammt.`,
    missingSummary: 'Für diesen Inhalt liegt keine Zusammenfassung vor.',
    immediateSocialSubject: 'Neuer Beitrag',
    immediateSocialHeaderTagline: 'Neuer Beitrag, unverändert weitergeleitet',
    immediateSocialGreetingBody: (source) => `„${source}“ hat einen neuen Beitrag veröffentlicht:`,
    socialSection: 'Social-Beiträge',
    socialSectionNote: 'Unverändert weitergeleitet, ohne Zusammenfassung.',
    contentWarning: 'Inhaltswarnung',
    viewPostButton: 'Beitrag ansehen',
    mediaLabels: { image: 'Bild', gifv: 'GIF', video: 'Video', audio: 'Audio', link: 'Link', unknown: 'Anhang' },
  },
  en: {
    subject: 'Your new podcast updates',
    headerTagline: 'Your daily podcast highlights',
    greeting: 'Hello,',
    greetingBody: 'here are your new podcast summaries:',
    immediateSubject: 'New episode',
    immediateHeaderTagline: 'New episode, freshly summarized',
    immediateGreetingBody: (podcast) => `a new episode of “${podcast}” just came out. Here is your summary:`,
    footerSentTo: (email) => `This email was sent to ${email}.`,
    footerChangeSettings: 'Change settings',
    sectionTopics: 'Main topics',
    sectionTakeaways: 'Key takeaways',
    sectionTips: 'Tips & methods',
    sectionQuotes: 'Quotes & terms',
    sectionSpeakers: 'Who says what',
    sectionReflection: 'Context',
    listenButton: 'Listen to episode',
    readButton: 'Read article',
    immediateArticleSubject: 'New article',
    immediateArticleHeaderTagline: 'New article, freshly summarized',
    immediateArticleGreetingBody: (source) => `a new article from “${source}” just came out. Here is your summary:`,
    settingsLink: 'Change settings',
    digestSubject: 'Your Castletter',
    digestHeaderTagline: 'Your daily overview of your sources',
    digestGreetingBody: 'here is what is new from your sources:',
    sections: { podcast: 'Podcasts', youtube: 'YouTube', website: 'Website (RSS)', other: 'More items' },
    overviewSources: 'Sources',
    overviewLabel: 'Overview',
    overviewTitle: (count) => `The essentials from ${count} items`,
    overviewThemes: 'Key themes',
    overviewConnections: 'Connections & tensions',
    overviewReflection: 'Context',
    overviewNote: (count) => `AI overview based on the ${count} summaries below; podcasts weigh most, then YouTube, then Website (RSS). Every point links the items it is drawn from.`,
    missingSummary: 'No summary is available for this item.',
    immediateSocialSubject: 'New post',
    immediateSocialHeaderTagline: 'New post, passed on unchanged',
    immediateSocialGreetingBody: (source) => `“${source}” published a new post:`,
    socialSection: 'Social posts',
    socialSectionNote: 'Passed on unchanged, without summary.',
    contentWarning: 'Content warning',
    viewPostButton: 'View post',
    mediaLabels: { image: 'Image', gifv: 'GIF', video: 'Video', audio: 'Audio', link: 'Link', unknown: 'Attachment' },
  },
}

export function getEmailSubject(locale = 'de') {
  return strings[locale].subject
}

/**
 * Title, header tagline and greeting text for the mail kind: a digest of podcasts only keeps
 * the "podcast highlights" wording, any other digest is source-neutral; an immediate mail
 * (exactly one episode) announces the new episode (or website article) instead. Texts are
 * raw; callers escape them for HTML.
 */
function getIntro(s, newsletters, mode) {
  if (mode === 'immediate' && newsletters.length === 1) {
    const podcast = newsletters[0].podcastTitle
    if (isSocial(newsletters[0])) {
      return {
        title: `${s.immediateSocialSubject}: ${podcast}`,
        tagline: s.immediateSocialHeaderTagline,
        body: s.immediateSocialGreetingBody(podcast),
      }
    }
    if (isArticle(newsletters[0])) {
      return {
        title: `${s.immediateArticleSubject}: ${podcast}`,
        tagline: s.immediateArticleHeaderTagline,
        body: s.immediateArticleGreetingBody(podcast),
      }
    }
    return {
      title: `${s.immediateSubject}: ${podcast}`,
      tagline: s.immediateHeaderTagline,
      body: s.immediateGreetingBody(podcast),
    }
  }
  if (isPodcastOnly(newsletters)) return { title: s.subject, tagline: s.headerTagline, body: s.greetingBody }
  return { title: s.digestSubject, tagline: s.digestHeaderTagline, body: s.digestGreetingBody }
}

/** Website articles link to the article ("read"), podcast episodes and videos to the audio/video. */
function isArticle(item) {
  return item.sourceType === 'website'
}

/** Social posts are passed on unchanged in a block (and digest section) of their own. */
function isSocial(item) {
  return item.sourceType === 'social'
}

function linkLabel(item, s) {
  if (isSocial(item)) return s.viewPostButton
  return isArticle(item) ? s.readButton : s.listenButton
}

/** Every mail except a single immediate one is a digest. */
function isDigest(newsletters, mode) {
  return !(mode === 'immediate' && newsletters.length === 1)
}

/** Overview points with text and at least one linked source; others are not shown. */
function linkedPoints(points) {
  return (points ?? [])
    .map((point) => ({ text: point?.text?.trim() ?? '', sources: (point?.sources ?? []).filter((source) => source?.url) }))
    .filter((point) => point.text && point.sources.length > 0)
}

/** The overview is shown for digests of at least MIN_OVERVIEW_ITEMS items with linked key themes. */
function visibleOverview(newsletters, mode, overview) {
  if (!overview || !isDigest(newsletters, mode) || newsletters.length < MIN_OVERVIEW_ITEMS) return null
  const themes = linkedPoints(overview.themes)
  if (themes.length === 0) return null
  return {
    themes,
    connections: linkedPoints(overview.connections),
    reflection: overview.reflection?.trim() || null,
    count: overview.itemCount ?? newsletters.length,
  }
}

/** Link text of an overview source: "Source – Title". */
function sourceLabel(source) {
  return [source.sourceTitle, source.title].filter((part) => part?.trim()).join(' – ') || source.url
}

/**
 * The single items of the mail: a digest in sections (podcasts, YouTube, Website (RSS),
 * Social, others), an immediate mail as its one item without a section.
 */
function itemSections(newsletters, mode) {
  return isDigest(newsletters, mode)
    ? groupDigestItems(newsletters)
    : [{ type: null, items: newsletters }]
}


export function generateEmailHTML(
  userEmail,
  newsletters,
  settingsUrl,
  locale = 'de',
  mode = 'daily',
  overview = null
) {
  const s = strings[locale]
  const intro = getIntro(s, newsletters, mode)
  const overviewBlock = generateOverviewBlock(visibleOverview(newsletters, mode, overview), s)
  const episodeBlocks = itemSections(newsletters, mode)
    .map(({ type, items }) => sectionHeading(type, s) + items.map((item) => generateItemBlock(item, s)).join(''))
    .join('')

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(intro.title)}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f9f9f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: ${COLORS.bg};">

    <!-- Header -->
    <tr>
      <td style="padding: 40px 30px 20px; text-align: center; background-color: ${COLORS.primary};">
        <h1 style="margin: 0; color: ${COLORS.bg}; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Castletter</h1>
        <p style="margin: 8px 0 0; color: ${COLORS.muted}; font-size: 14px;">${escapeHtml(intro.tagline)}</p>
      </td>
    </tr>

    <!-- Greeting -->
    <tr>
      <td style="padding: 30px 30px 10px;">
        <p style="margin: 0; color: ${COLORS.primary}; font-size: 16px; line-height: 1.6;">
          ${s.greeting}<br>${escapeHtml(intro.body)}
        </p>
      </td>
    </tr>

    ${overviewBlock}

    <!-- Episode Blocks -->
    ${episodeBlocks}

    <!-- Footer -->
    <tr>
      <td style="padding: 30px; border-top: 1px solid ${COLORS.border};">
        <p style="margin: 0 0 10px; color: ${COLORS.textMuted}; font-size: 12px; text-align: center;">
          ${s.footerSentTo(userEmail)}
        </p>
        <p style="margin: 0; text-align: center;">
          <a href="${settingsUrl}" style="color: ${COLORS.secondary}; font-size: 12px; text-decoration: underline;">${s.footerChangeSettings}</a>
        </p>
      </td>
    </tr>

  </table>
</body>
</html>`
}

function generateBulletList(items) {
  return items
    .map((item) => `<li style="margin-bottom: 6px; color: ${COLORS.primary}; font-size: 14px; line-height: 1.5;">${escapeHtml(item)}</li>`)
    .join('')
}

function generateSection(title, items, titleColor) {
  if (!items || items.length === 0) return ''
  return `
          <tr>
            <td style="padding: 10px 20px;">
              <h3 style="margin: 0 0 8px; color: ${titleColor}; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHtml(title)}</h3>
              <ul style="margin: 0; padding-left: 20px;">
                ${generateBulletList(items)}
              </ul>
            </td>
          </tr>`
}

function generateSourceLinks(sources, s) {
  const links = sources
    .map((source) => `<a href="${escapeHtml(source.url)}" style="color: ${COLORS.secondary}; text-decoration: underline;">${escapeHtml(sourceLabel(source))}</a>`)
    .join(' · ')
  return `<br><span style="color: ${COLORS.textMuted}; font-size: 13px;">${escapeHtml(s.overviewSources)}: ${links}</span>`
}

function generatePointList(points, s) {
  return points
    .map((point) => `<li style="margin-bottom: 10px; color: ${COLORS.primary}; font-size: 14px; line-height: 1.5;">${escapeHtml(point.text)}${generateSourceLinks(point.sources, s)}</li>`)
    .join('')
}

function generateOverviewBlock(overview, s) {
  if (!overview) return ''
  const list = (title, points) => points.length === 0 ? '' : `
              <h3 style="margin: 16px 0 8px; color: ${COLORS.secondary}; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHtml(title)}</h3>
              <ul style="margin: 0; padding-left: 20px;">
                ${generatePointList(points, s)}
              </ul>`
  return `<!-- Overview -->
    <tr>
      <td style="padding: 20px 30px 10px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f6f9ec; border: 1px solid ${COLORS.accent}; border-left: 6px solid ${COLORS.accent}; border-radius: 8px;">
          <tr>
            <td style="padding: 20px;">
              <p style="margin: 0 0 4px; color: ${COLORS.secondary}; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHtml(s.overviewLabel)}</p>
              <h2 style="margin: 0; color: ${COLORS.primary}; font-size: 20px; font-weight: 700;">${escapeHtml(s.overviewTitle(overview.count))}</h2>${list(s.overviewThemes, overview.themes)}${list(s.overviewConnections, overview.connections)}
              ${overview.reflection ? `<h3 style="margin: 16px 0 8px; color: ${COLORS.secondary}; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHtml(s.overviewReflection)}</h3>
              <p style="margin: 0; color: ${COLORS.primary}; font-size: 14px; line-height: 1.5; font-style: italic;">${escapeHtml(overview.reflection)}</p>` : ''}
              <p style="margin: 16px 0 0; color: ${COLORS.textMuted}; font-size: 12px; line-height: 1.5;">${escapeHtml(s.overviewNote(overview.count))}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>`
}

function generateSectionHeading(title) {
  return `
    <!-- Section: ${escapeHtml(title)} -->
    <tr>
      <td style="padding: 30px 30px 0;">
        <h2 style="margin: 0; padding-bottom: 6px; border-bottom: 3px solid ${COLORS.accent}; color: ${COLORS.primary}; font-size: 20px; font-weight: 700;">${escapeHtml(title)}</h2>
      </td>
    </tr>`
}

/** Intro paragraph, or a notice when the item has no summary at all. */
function generateIntroHtml(item, s) {
  if (!hasSummaryContent(item)) {
    return `<p style="margin: 0; color: ${COLORS.textMuted}; font-size: 14px; line-height: 1.6; font-style: italic;">${escapeHtml(s.missingSummary)}</p>`
  }
  return item.intro ? `<p style="margin: 0; color: ${COLORS.primary}; font-size: 15px; line-height: 1.6;">${escapeHtml(item.intro)}</p>` : ''
}

/** Section heading of a digest section; Social keeps its heading with the "unchanged" note (#39). */
function sectionHeading(type, s) {
  if (!type) return ''
  return type === 'social' ? generateSocialSectionHeading(s) : generateSectionHeading(s.sections[type])
}

/** Website articles compact, social posts unchanged, podcasts and videos in full. */
function generateItemBlock(item, s) {
  if (isSocial(item)) return generateSocialBlock(item, s)
  return digestSourceType(item) === 'website' ? generateWebsiteBlock(item, s) : generateEpisodeBlock(item, s)
}

/** Website (RSS) article: source, linked title and at most three sentences (Kanban #42). */
function generateWebsiteBlock(item, s) {
  const summary = websiteSummary(item)
  return `
    <tr>
      <td style="padding: 20px 30px 10px;">
        <p style="margin: 0 0 4px; color: ${COLORS.textMuted}; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHtml(item.podcastTitle)}</p>
        <h3 style="margin: 0 0 8px; font-size: 17px; font-weight: 600; line-height: 1.4;"><a href="${escapeHtml(item.audioUrl)}" style="color: ${COLORS.primary}; text-decoration: none;">${escapeHtml(item.episodeTitle)}</a></h3>
        ${summary
          ? `<p style="margin: 0 0 8px; color: ${COLORS.primary}; font-size: 15px; line-height: 1.6;">${escapeHtml(summary)}</p>`
          : `<p style="margin: 0 0 8px; color: ${COLORS.textMuted}; font-size: 14px; line-height: 1.6; font-style: italic;">${escapeHtml(s.missingSummary)}</p>`}
        <a href="${escapeHtml(item.audioUrl)}" style="color: ${COLORS.secondary}; font-size: 14px; text-decoration: underline;">&#8594; ${escapeHtml(s.readButton)}</a>
      </td>
    </tr>`
}

function generateEpisodeBlock(item, s) {
  return `
    <tr>
      <td style="padding: 20px 30px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid ${COLORS.border}; border-radius: 8px; overflow: hidden;">
          <!-- Episode Header -->
          <tr>
            <td style="padding: 20px; background-color: ${COLORS.primary};">
              <p style="margin: 0 0 4px; color: ${COLORS.muted}; font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHtml(item.podcastTitle)}</p>
              <h2 style="margin: 0; color: ${COLORS.bg}; font-size: 18px; font-weight: 600;">${escapeHtml(item.episodeTitle)}</h2>
            </td>
          </tr>

          <!-- Intro -->
          <tr>
            <td style="padding: 20px 20px 10px;">
              ${generateIntroHtml(item, s)}
            </td>
          </tr>

          ${generateSection(s.sectionTopics, item.bulletPoints, COLORS.secondary)}
          ${generateSection(s.sectionTakeaways, item.keyTakeaways, COLORS.secondary)}
          ${generateSection(s.sectionTips, item.actionItems, COLORS.accent)}
          ${generateSection(s.sectionQuotes, item.quotes, COLORS.accent)}
          ${generateSection(s.sectionSpeakers, item.speakers, COLORS.secondary)}

          ${item.reflection ? `
          <!-- Reflection -->
          <tr>
            <td style="padding: 10px 20px;">
              <h3 style="margin: 0 0 8px; color: ${COLORS.secondary}; font-size: 14px; text-transform: uppercase; letter-spacing: 0.5px;">${escapeHtml(s.sectionReflection)}</h3>
              <p style="margin: 0; color: ${COLORS.textMuted}; font-size: 14px; line-height: 1.5; font-style: italic;">${escapeHtml(item.reflection)}</p>
            </td>
          </tr>` : ''}

          <!-- CTA Button -->
          <tr>
            <td style="padding: 15px 20px 20px;">
              <a href="${escapeHtml(item.audioUrl)}" style="display: inline-block; background-color: ${COLORS.secondary}; color: ${COLORS.bg}; padding: 10px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 500;">
                ${isArticle(item) ? '&#8594;' : '&#9654;'} ${escapeHtml(linkLabel(item, s))}
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`
}

function generateSocialSectionHeading(s) {
  return `
    <!-- Section: Social -->
    <tr>
      <td style="padding: 30px 30px 0;">
        <h2 style="margin: 0; padding-bottom: 6px; border-bottom: 3px solid ${COLORS.accent}; color: ${COLORS.primary}; font-size: 20px; font-weight: 700;">${escapeHtml(s.socialSection)}</h2>
        <p style="margin: 6px 0 0; color: ${COLORS.textMuted}; font-size: 13px;">${escapeHtml(s.socialSectionNote)}</p>
      </td>
    </tr>`
}

/** Media and link previews as plain links – no remote images (no tracking pixels). */
function socialMediaLinks(item) {
  return (item.social?.media ?? [])
    .map((media) => ({ ...media, url: safeHttpUrl(media?.url ?? '') }))
    .filter((media) => media.url)
}

function mediaLabel(media, s) {
  const type = s.mediaLabels[media.type] ? media.type : 'unknown'
  return media.description ? `${s.mediaLabels[type]}: ${media.description}` : s.mediaLabels[type]
}

function generateSocialBlock(item, s) {
  const spoiler = item.social?.spoiler?.trim()
  const media = socialMediaLinks(item)
  const link = safeHttpUrl(item.audioUrl ?? '')
  return `
    <tr>
      <td style="padding: 20px 30px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid ${COLORS.border}; border-radius: 8px; overflow: hidden;">
          <!-- Post Header -->
          <tr>
            <td style="padding: 14px 20px; background-color: ${COLORS.secondary};">
              <p style="margin: 0; color: ${COLORS.bg}; font-size: 14px; font-weight: 600;">${escapeHtml(item.podcastTitle)}</p>
            </td>
          </tr>
          ${spoiler ? `
          <!-- Content Warning -->
          <tr>
            <td style="padding: 16px 20px 0;">
              <p style="margin: 0; padding: 10px 12px; background-color: #fff6e0; border-left: 4px solid #e0a100; color: ${COLORS.primary}; font-size: 14px; font-weight: 600;">${escapeHtml(s.contentWarning)}: ${escapeHtml(spoiler)}</p>
            </td>
          </tr>` : ''}
          <!-- Post -->
          <tr>
            <td style="padding: 16px 20px 6px; color: ${COLORS.primary}; font-size: 15px; line-height: 1.6;">
              ${sanitizeSocialHtml(item.social?.html ?? '')}
            </td>
          </tr>
          ${media.length > 0 ? `
          <tr>
            <td style="padding: 4px 20px;">
              <ul style="margin: 0; padding-left: 20px;">
                ${media.map((m) => `<li style="margin-bottom: 4px; font-size: 14px;"><a href="${escapeHtml(m.url)}" style="color: ${COLORS.secondary};">${escapeHtml(mediaLabel(m, s))}</a></li>`).join('')}
              </ul>
            </td>
          </tr>` : ''}
          ${link ? `
          <!-- CTA Button -->
          <tr>
            <td style="padding: 15px 20px 20px;">
              <a href="${escapeHtml(link)}" style="display: inline-block; background-color: ${COLORS.secondary}; color: ${COLORS.bg}; padding: 10px 24px; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 500;">
                &#8594; ${escapeHtml(s.viewPostButton)}
              </a>
            </td>
          </tr>` : ''}
        </table>
      </td>
    </tr>`
}

/** Generate plain text version as fallback */
export function generateEmailPlainText(
  newsletters,
  settingsUrl,
  locale = 'de',
  mode = 'daily',
  overview = null
) {
  const s = strings[locale]
  const intro = getIntro(s, newsletters, mode)
  const overviewText = generateOverviewPlainText(visibleOverview(newsletters, mode, overview), s)

  const blocks = itemSections(newsletters, mode).flatMap(({ type, items }) => [
    ...(type === 'social' ? [`▬▬ ${s.socialSection.toUpperCase()} ▬▬\n(${s.socialSectionNote})`] : type ? [`▬▬ ${s.sections[type].toUpperCase()} ▬▬`] : []),
    ...items.map((item) => generatePlainTextItem(item, s)),
  ])

  return `${intro.title}
===========================

${s.greeting}
${intro.body}

${overviewText}${blocks.join('\n\n')}
---
${s.settingsLink}: ${settingsUrl}
`
}

function generateOverviewPlainText(overview, s) {
  if (!overview) return ''
  const points = (title, list) => list.length === 0 ? [] : [
    '', `${title.toUpperCase()}:`,
    ...list.flatMap((point) => [`  • ${point.text}`, ...point.sources.map((source) => `    → ${sourceLabel(source)}: ${source.url}`)]),
  ]
  const lines = [
    `${s.overviewLabel.toUpperCase()} – ${s.overviewTitle(overview.count)}`,
    ...points(s.overviewThemes, overview.themes),
    ...points(s.overviewConnections, overview.connections),
  ]
  if (overview.reflection) lines.push('', `${s.overviewReflection.toUpperCase()}: ${overview.reflection}`)
  lines.push('', `(${s.overviewNote(overview.count)})`)
  return `${lines.join('\n')}\n\n`
}

function generatePlainTextItem(item, s) {
  if (isSocial(item)) return generateSocialPlainTextBlock(item, s)
  return digestSourceType(item) === 'website' ? generateWebsitePlainText(item, s) : generatePlainTextBlock(item, s)
}

function generateWebsitePlainText(item, s) {
  return [
    item.podcastTitle,
    item.episodeTitle,
    `→ ${s.readButton}: ${item.audioUrl}`,
    websiteSummary(item) || s.missingSummary,
  ].join('\n')
}

function generatePlainTextBlock(item, s) {
  const sections = []

  sections.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  sections.push(`${item.podcastTitle}`)
  sections.push(`${item.episodeTitle}`)
  sections.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
  sections.push('')
  sections.push(hasSummaryContent(item) ? item.intro : s.missingSummary)

  if (item.bulletPoints.length > 0) {
    sections.push('')
    sections.push(`${s.sectionTopics.toUpperCase()}:`)
    sections.push(item.bulletPoints.map((bp) => `  • ${bp}`).join('\n'))
  }

  if (item.keyTakeaways.length > 0) {
    sections.push('')
    sections.push(`${s.sectionTakeaways.toUpperCase()}:`)
    sections.push(item.keyTakeaways.map((kt) => `  ★ ${kt}`).join('\n'))
  }

  if (item.actionItems.length > 0) {
    sections.push('')
    sections.push(`${s.sectionTips.toUpperCase()}:`)
    sections.push(item.actionItems.map((ai) => `  → ${ai}`).join('\n'))
  }

  if (item.quotes.length > 0) {
    sections.push('')
    sections.push(`${s.sectionQuotes.toUpperCase()}:`)
    sections.push(item.quotes.map((q) => `  „${q}"`).join('\n'))
  }

  if (item.speakers.length > 0) {
    sections.push('')
    sections.push(`${s.sectionSpeakers.toUpperCase()}:`)
    sections.push(item.speakers.map((sp) => `  • ${sp}`).join('\n'))
  }

  if (item.reflection) {
    sections.push('')
    sections.push(`${s.sectionReflection.toUpperCase()}: ${item.reflection}`)
  }

  sections.push('')
  sections.push(`→ ${linkLabel(item, s)}: ${item.audioUrl}`)

  return sections.join('\n')
}

function generateSocialPlainTextBlock(item, s) {
  const lines = ['━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', item.podcastTitle, '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', '']
  const spoiler = item.social?.spoiler?.trim()
  if (spoiler) lines.push(`${s.contentWarning}: ${spoiler}`, '')
  const text = socialPostText(item.social?.html ?? '')
  if (text) lines.push(text)
  const media = socialMediaLinks(item)
  if (media.length > 0) lines.push('', ...media.map((m) => `  • ${mediaLabel(m, s)} – ${m.url}`))
  const link = safeHttpUrl(item.audioUrl ?? '')
  if (link) lines.push('', `→ ${s.viewPostButton}: ${link}`)
  return lines.join('\n')
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
