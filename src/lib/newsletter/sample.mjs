// Sample issue for the public page /beispiel: invented, neutral content (no real third-party
// names, decision 2026-10-26) in the shape of the real newsletter items, so the page renders
// the actual mail template. Links point to the reserved domain example.org.

const url = (path) => `https://example.org/beispiel/${path}`

const content = {
  de: {
    podcast: {
      source: 'Dein KI-Podcast',
      title: 'Vom Sprachmodell zur autonomen KI: was technologisch auf uns zukommt',
      intro: 'Die Folge erklärt, wie Sprachmodelle vom Antworten zum Handeln übergehen: Sie planen Schritte, nutzen Werkzeuge und prüfen ihre eigenen Ergebnisse.',
      bulletPoints: [
        'Agenten zerlegen Aufgaben in Teilschritte und rufen dafür Werkzeuge wie Suche oder Kalender auf.',
        'Der größte Engpass ist nicht die Rechenleistung, sondern verlässliche Selbstkontrolle.',
        'Unternehmen testen Agenten zuerst bei klar abgegrenzten Routineaufgaben.',
      ],
      keyTakeaways: ['Autonomie wächst schrittweise – mit Menschen, die Zwischenergebnisse freigeben.'],
      actionItems: ['Wiederkehrende Aufgaben notieren, die sich in klare Schritte zerlegen lassen.'],
      quotes: [],
      speakers: [],
      reflection: 'Spannend, aber vorsichtig erzählt: Die Folge trennt sauber zwischen Demo und Alltag.',
    },
    youtube: {
      source: 'Dein Lieblingskanal',
      title: 'Motion Graphics mit KI-Bildern kombinieren – ein Werkstattbericht',
      intro: 'Ein Werkstattbericht darüber, wie generierte Standbilder zu sauberen Animationen werden, ohne dass der Stil zerfällt.',
      bulletPoints: [
        'Erst Stilrahmen festlegen, dann Bilder erzeugen – nicht umgekehrt.',
        'Bewegung entsteht im Compositing, nicht im Bildgenerator.',
      ],
      actionItems: ['Für jedes Projekt eine kleine Stil-Referenztafel anlegen.'],
    },
    website: {
      source: 'Deine Lokalzeitung',
      title: 'Neue Radwege: Stadt legt Zeitplan für die Innenstadt vor',
      intro: 'Bis Ende des kommenden Jahres sollen vier Achsen durchgehende Radwege bekommen. Parkplätze fallen dafür teilweise weg. Die Bürgerbeteiligung startet im Frühjahr.',
    },
    social: {
      source: 'Dein Verein',
      html: '<p>Auswärtssieg am Wochenende! Danke an alle, die mitgefahren sind – die Stimmen nach dem Spiel gibt es in unserem Spielbericht.</p>',
    },
    overview: {
      themes: ['KI-Agenten übernehmen erste Routineaufgaben – mit Menschen als Kontrollinstanz.', 'Gestaltung mit KI gelingt, wenn der Stil vorher feststeht.'],
      connections: ['Podcast und Werkstattbericht kommen zum selben Schluss: Die Technik ist da, entscheidend ist der Prozess drumherum.'],
      reflection: 'Ein ruhiger Tag mit einem roten Faden: Werkzeuge werden mächtiger, der Plan davor wichtiger.',
    },
  },
  en: {
    podcast: {
      source: 'Your AI podcast',
      title: 'From language model to autonomous AI: what technology has in store for us',
      intro: 'The episode explains how language models move from answering to acting: they plan steps, use tools and check their own results.',
      bulletPoints: [
        'Agents break tasks into steps and call tools such as search or calendars.',
        'The biggest bottleneck is not computing power but reliable self-checking.',
        'Companies test agents first on clearly scoped routine tasks.',
      ],
      keyTakeaways: ['Autonomy grows step by step – with people approving intermediate results.'],
      actionItems: ['Write down recurring tasks that break into clear steps.'],
      quotes: [],
      speakers: [],
      reflection: 'Exciting but carefully told: the episode separates demos from everyday use.',
    },
    youtube: {
      source: 'Your favourite channel',
      title: 'Combining motion graphics with AI images – a workshop report',
      intro: 'A workshop report on turning generated stills into clean animations without the style falling apart.',
      bulletPoints: [
        'Fix the style frames first, then generate images – not the other way round.',
        'Motion is made in compositing, not in the image generator.',
      ],
      actionItems: ['Set up a small style reference board for every project.'],
    },
    website: {
      source: 'Your local paper',
      title: 'New cycle lanes: city presents timetable for the centre',
      intro: 'Four routes are to get continuous cycle lanes by the end of next year. Some parking spaces will go. Public consultation starts in spring.',
    },
    social: {
      source: 'Your club',
      html: '<p>Away win at the weekend! Thanks to everyone who travelled with us – the reactions after the match are in our match report.</p>',
    },
    overview: {
      themes: ['AI agents take on first routine tasks – with people in control.', 'Designing with AI works when the style is settled first.'],
      connections: ['Podcast and workshop report reach the same conclusion: the technology is there, the process around it decides.'],
      reflection: 'A quiet day with a common thread: tools get more powerful, the plan before them more important.',
    },
  },
}

function item(id, sourceType, data, extra = {}) {
  return {
    id,
    sourceType,
    podcastTitle: data.source,
    episodeTitle: data.title ?? data.source,
    intro: data.intro ?? '',
    bulletPoints: data.bulletPoints ?? [],
    keyTakeaways: data.keyTakeaways ?? [],
    actionItems: data.actionItems ?? [],
    quotes: data.quotes ?? [],
    speakers: data.speakers ?? [],
    reflection: data.reflection ?? null,
    audioUrl: url(id),
    publishedAt: null,
    category: null,
    ...extra,
  }
}

/**
 * The sample issue in the given locale: `{ items, overview }`, ready for generateEmailHTML
 * (mode 'daily'). Unknown locales fall back to German.
 */
export function sampleIssue(locale = 'de') {
  const c = content[locale] ?? content.de
  const items = [
    item('podcast', 'podcast', c.podcast),
    item('video', 'youtube', c.youtube),
    item('artikel', 'website', c.website),
    item('beitrag', 'social', { source: c.social.source }, { social: { html: c.social.html, spoiler: null, media: [] } }),
  ]
  const source = (index) => ({ id: items[index].id, sourceType: items[index].sourceType, sourceTitle: items[index].podcastTitle, title: items[index].episodeTitle, url: items[index].audioUrl })
  const overview = {
    themes: [{ text: c.overview.themes[0], sources: [source(0)] }, { text: c.overview.themes[1], sources: [source(1)] }],
    connections: [{ text: c.overview.connections[0], sources: [source(0), source(1)] }],
    reflection: c.overview.reflection,
    itemCount: 3,
  }
  return { items, overview }
}
