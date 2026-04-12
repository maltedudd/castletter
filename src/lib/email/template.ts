/**
 * Email HTML template generator for daily newsletter digest
 * Uses inline styles for maximum email client compatibility
 */

interface NewsletterItem {
  podcastTitle: string
  episodeTitle: string
  intro: string
  bulletPoints: string[]
  keyTakeaways: string[]
  actionItems: string[]
  quotes: string[]
  speakers: string[]
  reflection: string | null
  audioUrl: string
}

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

type Locale = 'de' | 'en'

interface EmailStrings {
  subject: string
  headerTagline: string
  greeting: string
  greetingBody: string
  footerSentTo: (email: string) => string
  footerChangeSettings: string
  sectionTopics: string
  sectionTakeaways: string
  sectionTips: string
  sectionQuotes: string
  sectionSpeakers: string
  sectionReflection: string
  listenButton: string
  settingsLink: string
}

const strings: Record<Locale, EmailStrings> = {
  de: {
    subject: 'Deine neuen Podcast-Updates',
    headerTagline: 'Deine täglichen Podcast-Highlights',
    greeting: 'Hallo,',
    greetingBody: 'hier sind deine neuen Podcast-Zusammenfassungen:',
    footerSentTo: (email) => `Diese Email wurde an ${email} gesendet.`,
    footerChangeSettings: 'Einstellungen ändern',
    sectionTopics: 'Hauptthemen',
    sectionTakeaways: 'Wichtige Aussagen',
    sectionTips: 'Tipps & Methoden',
    sectionQuotes: 'Zitate & Begriffe',
    sectionSpeakers: 'Wer sagt was',
    sectionReflection: 'Einordnung',
    listenButton: 'Episode anhören',
    settingsLink: 'Einstellungen ändern',
  },
  en: {
    subject: 'Your new podcast updates',
    headerTagline: 'Your daily podcast highlights',
    greeting: 'Hello,',
    greetingBody: 'here are your new podcast summaries:',
    footerSentTo: (email) => `This email was sent to ${email}.`,
    footerChangeSettings: 'Change settings',
    sectionTopics: 'Main topics',
    sectionTakeaways: 'Key takeaways',
    sectionTips: 'Tips & methods',
    sectionQuotes: 'Quotes & terms',
    sectionSpeakers: 'Who says what',
    sectionReflection: 'Context',
    listenButton: 'Listen to episode',
    settingsLink: 'Change settings',
  },
}

export function getEmailSubject(locale: Locale = 'de'): string {
  return strings[locale].subject
}

export function generateEmailHTML(
  userEmail: string,
  newsletters: NewsletterItem[],
  settingsUrl: string,
  locale: Locale = 'de'
): string {
  const s = strings[locale]
  const episodeBlocks = newsletters
    .map((item) => generateEpisodeBlock(item, s))
    .join('')

  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${s.subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f9f9f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: ${COLORS.bg};">

    <!-- Header -->
    <tr>
      <td style="padding: 40px 30px 20px; text-align: center; background-color: ${COLORS.primary};">
        <h1 style="margin: 0; color: ${COLORS.bg}; font-size: 28px; font-weight: 700; letter-spacing: -0.5px;">Castletter</h1>
        <p style="margin: 8px 0 0; color: ${COLORS.muted}; font-size: 14px;">${s.headerTagline}</p>
      </td>
    </tr>

    <!-- Greeting -->
    <tr>
      <td style="padding: 30px 30px 10px;">
        <p style="margin: 0; color: ${COLORS.primary}; font-size: 16px; line-height: 1.6;">
          ${s.greeting}<br>${s.greetingBody}
        </p>
      </td>
    </tr>

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

function generateBulletList(items: string[]): string {
  return items
    .map((item) => `<li style="margin-bottom: 6px; color: ${COLORS.primary}; font-size: 14px; line-height: 1.5;">${escapeHtml(item)}</li>`)
    .join('')
}

function generateSection(title: string, items: string[], titleColor: string): string {
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

function generateEpisodeBlock(item: NewsletterItem, s: EmailStrings): string {
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
              <p style="margin: 0; color: ${COLORS.primary}; font-size: 15px; line-height: 1.6;">${escapeHtml(item.intro)}</p>
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
                &#9654; ${escapeHtml(s.listenButton)}
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`
}

/** Generate plain text version as fallback */
export function generateEmailPlainText(
  newsletters: NewsletterItem[],
  settingsUrl: string,
  locale: Locale = 'de'
): string {
  const s = strings[locale]

  const blocks = newsletters.map((item) => {
    const sections: string[] = []

    sections.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    sections.push(`${item.podcastTitle}`)
    sections.push(`${item.episodeTitle}`)
    sections.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
    sections.push('')
    sections.push(item.intro)

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
    sections.push(`→ ${s.listenButton}: ${item.audioUrl}`)

    return sections.join('\n')
  })

  return `${s.subject}
===========================

${s.greeting}
${s.greetingBody}

${blocks.join('\n\n')}
---
${s.settingsLink}: ${settingsUrl}
`
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
