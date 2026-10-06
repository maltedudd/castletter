# Castletter Worker

Eigenständiger Docker-Worker, der Podcast-Episoden ohne das Zeitlimit von Vercel
transkribiert (Website-Artikel ohne Audio aufbereitet) und – wenn zugeschaltet – neue
Episoden und Artikel aus den Feeds holt sowie die
Newsletter erzeugt und verschickt. Er ersetzt die Cron-Aufrufe von
`/api/cron/check-new-episodes`, `/api/cron/transcribe-episodes`,
`/api/cron/generate-newsletters` und `/api/cron/send-newsletters`.

## Ablauf

Jede Minute (`TRANSCRIPTION_POLL_INTERVAL_SECONDS`) läuft eine Iteration:

1. `transcribing`-Episoden mit abgelaufener Lease (15 min ohne Fortschritt) gehen zurück auf
   `pending_transcription`.
2. Die **älteste** `pending_transcription`-Episode, die höchstens
   `TRANSCRIPTION_MAX_EPISODE_AGE_DAYS` alt ist, wird statusgeschützt beansprucht.
3. Die Episode wird vollständig transkribiert:
   - Das Audio wird komplett in ein temporäres Verzeichnis geladen und mit ffmpeg auf eine
     sprachtaugliche MP3 umgerechnet (Mono, 16 kHz, 32 kbit/s – Whisper rechnet intern
     ohnehin so). Eine 46-Minuten-Folge schrumpft so von ~44 MB auf ~11 MB.
   - Passt das Ergebnis unter das Upload-Limit der Transkriptions-API (25 MB, entspricht
     knapp 1 h 45 min), geht es in **einem** Upload raus.
   - Längeres Audio wird per ffmpeg **nach Zeit** in eigenständige MP3-Segmente (≤ 20 MB)
     geteilt und in Reihenfolge transkribiert – nie blind nach Bytes, denn solche Schnitte
     treffen MP3-Frames und werden vom Anbieter abgelehnt.
   - Die Lease wird nach Download, Umrechnung und jedem Segment erneuert. `transcribed` wird
     nur mit dem vollständig zusammengesetzten Transkript gespeichert; das temporäre
     Verzeichnis wird immer gelöscht.
4. Gibt es weitere Arbeit, startet die nächste Iteration sofort.

Fehler:

- Permanente Fehler (Audio nicht erreichbar, Datei nicht dekodierbar, keine Sprache) → `failed`.
- Bei Ablehnung durch den Anbieter steht dessen Originalmeldung mit im Fehlertext
  (statt nur „Provider returned 400“).
- Temporäre Fehler → zurück auf `pending_transcription` mit
  „Temporärer Fehler (Versuch n/max)“.
- Nach `TRANSCRIPTION_MAX_ATTEMPTS` Versuchen → `failed` mit dem letzten Fehlertext.

Konfiguration der Transkription (optional, Standardwerte; je höchstens 840 s, damit die
15-min-Lease zwischen den Schritten nie abläuft):

- `TRANSCRIPTION_DOWNLOAD_TIMEOUT_SECONDS=600` – Download der kompletten Audiodatei
  (bis Kanban #30: 120 s je 20-MB-Range-Request).
- `TRANSCRIPTION_TRANSCODE_TIMEOUT_SECONDS=600` – ffmpeg-Umrechnung bzw. Segmentierung.
- `FFMPEG_PATH=ffmpeg` – ffmpeg ist im Image installiert.

Die Vercel-Route `/api/cron/transcribe-episodes` nutzt weiterhin die alte Range-Variante.

Der Worker braucht nur ausgehende Verbindungen (Supabase, OpenRouter, Podcast-Feeds und Audio-Hosts, YouTube, Websites mit RSS-Feed, Resend).

## Feed-Check (`WORKER_FEED_CHECK_ENABLED=true`)

Beim Start und danach alle `FEED_CHECK_INTERVAL_MINUTES` (Standard 30) liest der Worker
alle Abo-Feeds und legt neue Episoden als `pending_transcription` an (gleiche Regeln wie
bisher: nur mit Audio, nach Abo-Start bzw. max. 30 Tage zurück, max. 50 je Feed). Jeder
Feed wird in `feed_check_logs` protokolliert. Ein fehlgeschlagener Lauf wird beim nächsten
Durchlauf wiederholt; neue Episoden werden direkt danach transkribiert.

Umschalten: in Vercel `FEED_CHECK_CRON_DISABLED=true` setzen und neu deployen, den Job für
`/api/cron/check-new-episodes` auf cron-job.org deaktivieren, dann in `worker/.env`
`WORKER_FEED_CHECK_ENABLED=true` setzen und `docker compose up -d --build`.

## YouTube-Kanäle (Kanban #29)

YouTube-Kanäle sind Quellen wie Podcast-Feeds: Sie werden auf der Abo-Seite der App über
Channel-ID (`UC…`), Kanal-URL (`/channel/…`, `/@handle`, `/c/…`, `/user/…`) oder `@Handle`
angelegt. Gespeichert wird immer die aufgelöste, stabile Channel-ID
(`podcast_subscriptions.source_type = 'youtube'`, `youtube_channel_id`). Kanäle lassen sich
umbenennen, auf „Sofort“/„Täglich“ stellen, deaktivieren und löschen.

1. **Feed-Check:** Für jeden aktiven Kanal wird der offizielle Atom-Feed
   `https://www.youtube.com/feeds/videos.xml?channel_id=<ID>` gelesen (immer aus der
   Channel-ID gebaut). Jedes Video wird höchstens einmal als Episode angelegt
   (`guid = yt:video:<videoId>`, Unique-Index auf `(subscription_id, youtube_video_id)`),
   mit denselben Regeln wie bei Podcasts (nach Abo-Start bzw. max. 30 Tage, max. 50 je
   Lauf). **Shorts werden nie importiert:** Der Feed kennzeichnet sie nicht, daher wird je
   neuem Video `https://www.youtube.com/shorts/<id>` per HEAD geprüft (200 = Short,
   Weiterleitung auf `/watch` = normales Video). Ist die Prüfung nicht eindeutig (z. B.
   HTTP 429), wird das Video in diesem Lauf zurückgehalten, am Kanal als Fehler angezeigt und
   beim nächsten Lauf erneut geprüft. Ergebnis und Fehler stehen in `feed_check_logs` und
   direkt am Kanal (`last_checked_at`, `last_check_status`, `last_check_error`).

   **Ausweichabruf bei gestörtem Feed:** YouTubes Feed-Endpunkt liefert phasenweise für alle
   Kanäle HTTP 404 (zuletzt 05./06.10.2026 rund zwölf Stunden). Scheitert der Feed (HTTP-Fehler,
   Netzwerk, kein gültiger Feed), liest der Worker die 15 neuesten Uploads per yt-dlp vom
   Reiter „Videos“ des Kanals (ohne Shorts und Livestreams). Die Daten dort sind nur
   ungefähr („vor 2 Tagen“); liegt ein noch nicht importiertes Video bis zu 48 h um den
   Stichtag, wird das exakte Veröffentlichungsdatum nachgefragt, sonst wird das Video bis zum
   nächsten Lauf zurückgehalten. Sonst gelten dieselben Regeln wie beim Feed. Ein erfolgreicher
   Ausweichabruf zählt als erfolgreicher Check (Hinweis in `feed_check_logs.error_message` und
   im Log); scheitern beide, stehen beide Gründe am Kanal. Der Vercel-Cron hat keinen
   Ausweichabruf.

   Der Log-Eintrag `feed_check` nennt unter `issues` jede betroffene Quelle mit Grund
   (`error`) bzw. Hinweis (`note`).
2. **Transkription** (nur im Worker; die Vercel-Route überspringt YouTube-Episoden):
   - Zuerst vollständige YouTube-Untertitel: manuelle Untertitel (Originalsprache, dann
     `YOUTUBE_CAPTION_LANGUAGES`), sonst automatische Untertitel nur in der gesprochenen
     Originalsprache – nie maschinelle Übersetzungen. Untertitel gelten nur als brauchbar,
     wenn sie bis zum Videoende reichen (max. 60 s bzw. 5 % Lücke) und genug Text enthalten.
   - Sonst wird die **komplette** Tonspur per yt-dlp geladen und wie Podcast-Audio
     umgerechnet und über den OpenRouter-STT-Weg (alles oder nichts)
     transkribiert. Teil- oder Timeout-Ergebnisse werden nie gespeichert.
   - `episodes.transcript_source` hält `captions` bzw. `audio_stt` fest.
3. Danach laufen YouTube-Episoden durch dieselbe Newsletter-Generierung und denselben
   Versand wie Podcast-Episoden (`transcribed` → `newsletter_ready` → …).

Fehler werden mit Code in `episodes.error_code` und Klartext in `error_message`
gespeichert und in der App (Abo-Seite, Admin-Seite) angezeigt:

| Code | Bedeutung | Behandlung |
| --- | --- | --- |
| `video_unavailable` | privat, gelöscht, nur für Mitglieder, Altersfreigabe | sofort `failed` |
| `video_not_yet_available` | Livestream läuft / Premiere steht bevor | temporär, nach `TRANSCRIPTION_MAX_ATTEMPTS` `failed` |
| `youtube_blocked` | Bot-Check oder HTTP 429 | temporär |
| `youtube_fetch_failed` | Metadaten nicht ladbar | temporär |
| `youtube_tool_missing` | yt-dlp nicht installiert / `YTDLP_PATH` falsch | temporär |
| `audio_download_failed` | keine brauchbaren Untertitel und Audio-Download fehlgeschlagen (inkl. Timeout) | temporär |
| `stt_failed` | keine brauchbaren Untertitel und STT fehlgeschlagen (z. B. keine Sprache) | wie der STT-Fehler |

Eine fehlgeschlagene Episode wird erneut versucht, indem man in Supabase `status` auf
`pending_transcription` und `transcription_attempts` auf `0` setzt.

Konfiguration (optional, Standardwerte):

- `YTDLP_PATH=yt-dlp` – yt-dlp ist im Image installiert (offizielles Release mit
  Prüfsummen-Check, dazu ffmpeg; nutzt Node als JS-Runtime über `/etc/yt-dlp.conf`).
  Update: `docker compose build --no-cache`; feste Version per
  `docker compose build --build-arg YTDLP_VERSION=2026.08.19`.
- `YOUTUBE_DOWNLOAD_TIMEOUT_SECONDS=600` – je yt-dlp-Schritt; höchstens 840, damit die
  Transkriptions-Lease (15 min, zwischen den Schritten erneuert) nie abläuft.
- `YOUTUBE_CAPTION_LANGUAGES=de,en` – bevorzugte Untertitelsprachen nach der Originalsprache.

Es werden keine YouTube-Zugangsdaten oder Cookies benötigt oder gespeichert. Grenzen:
Playlists und nicht öffentliche Videos werden nicht unterstützt.

## Websites per RSS (Kanban #35)

Öffentliche Websites mit RSS- oder Atom-Feed sind der dritte Quelltyp **„Website (RSS)“**
(`podcast_subscriptions.source_type = 'website'`). Angelegt werden sie auf der Quellen-Seite
über die Feed-URL oder die Adresse der Website, sofern diese ihren Feed per
`<link rel="alternate" type="application/rss+xml|atom+xml">` angibt
(`POST /api/websites/validate`). Podcast-Feeds (Audio-Enclosures) und YouTube-Adressen werden
abgelehnt, mit Vorschlag des passenden Quelltyps. Die Vorschau zeigt Feed-Format und den
erkannten Inhalt (vollständige Artikel im Feed bzw. Kurzfassungen).

1. **Feed-Check** (Worker und Vercel-Cron): neue Einträge werden als `pending_transcription`
   mit `source_type = 'website'` angelegt – gleiche Regeln wie bei Podcasts (nach Abo-Start
   bzw. max. 30 Tage, max. 50 je Lauf), aber ohne Audio. Schlüssel ist `guid` › Atom-`id` ›
   Link › Hash, Duplikate im Feed und bereits importierte Einträge werden übersprungen.
   Gespeichert werden der bereinigte Feed-Text (`feed_content`) und der Artikel-Link
   (`article_url`; `audio_url` hält denselben Link, weil die Spalte Pflicht ist).
2. **Text statt Transkription** (nur im Worker; die Vercel-Route überspringt
   Website-Einträge) – kein Audio, kein ffmpeg, kein STT:
   - Ist der Feed-Text vollständig (≥ 1500 Zeichen, ohne Kürzungsmarker wie „…“, „[…]“,
     „Weiterlesen“, „Read more“), wird er verwendet (`transcript_source = 'feed_content'`).
   - Sonst wird **ausschließlich** der verlinkte Artikel geladen (nur öffentliche Hosts,
     jede Weiterleitung geprüft, max. 5 Weiterleitungen, 15 s, 3 MB) und sein Hauptinhalt
     bereinigt (`articleBody` › `<article>` › `<main>`; Navigation, Kopf-/Fußzeile,
     Seitenleisten, Formulare und Skripte entfernt; `transcript_source = 'article'`).
     Enthält die Seite nicht mehr Text als ein ungekürzter Feed-Text von mindestens 800
     Zeichen, gilt dieser als vollständiger kurzer Beitrag (`feed_content`).
   - Paywall, Anmeldung oder fehlender Volltext werden nicht umgangen: Der Eintrag wird
     `failed` mit Grund und es entsteht kein Newsletter. Markiert eine Seite ihren Artikel
     per schema.org als nicht frei (`isAccessibleForFree: false`), wird auch im HTML
     mitgelieferter Text nicht verwendet.
3. Danach dieselbe Newsletter-Generierung (mit einem Prompt für Artikel, der nur den
   vorliegenden Text zusammenfasst) und derselbe Versand. In der Mail steht „Artikel lesen“
   statt „Episode anhören“.

| Code | Bedeutung | Behandlung |
| --- | --- | --- |
| `paywalled` | Paywall erkannt (schema.org-Markierung oder Paywall-Container ohne Volltext) | sofort `failed` |
| `access_restricted` | HTTP 401/402/403 oder Weiterleitung auf Anmelde-/Abo-Seite | sofort `failed` |
| `content_incomplete` | nur Kurzfassung im Feed und kein vollständiger Text auf der Seite (oder kein Link) | sofort `failed` |
| `article_unavailable` | Artikel gelöscht (HTTP 404/410) oder Adresse nicht erlaubt | sofort `failed` |
| `article_fetch_failed` | Serverfehler, HTTP 429, Timeout oder Netzwerk | temporär, nach `TRANSCRIPTION_MAX_ATTEMPTS` `failed` |

Grund und Klartext stehen auf der Quellen-Seite unter „Nicht zusammengefasste Artikel“.
Nicht unterstützt: Websites ohne Feed, E-Mail-Postfächer als Quelle, Inhalte hinter
Anmeldung oder Paywall.

## Newsletter-Pipeline (`WORKER_NEWSLETTERS_ENABLED=true`)

Nach der Transkription läuft in jeder Iteration zusätzlich:

1. **Generierung:** Die älteste `transcribed`-Episode innerhalb von
   `TRANSCRIPTION_MAX_EPISODE_AGE_DAYS` wird per Claim (`generating_newsletter` + Marker)
   zusammengefasst und auf `newsletter_ready` gesetzt. Hängende Claims (> 15 min) gehen
   zurück auf `transcribed`. Permanente Fehler → `newsletter_failed`.
2. **Sofortversand:** Hat die Besitzerin/der Besitzer „Sofort“ gewählt, geht die Mail
   direkt danach raus.
3. **Versand-Sweep, einmal pro UTC-Stunde:** tägliche Sammelmails für alle mit passender
   Stunde, Sofort-Mails als Fallback, Reset hängender Versand-Claims. Ein fehlgeschlagener
   Sweep wird beim nächsten Durchlauf wiederholt.

Das Alters-Limit gilt für die ganze Pipeline (statt der 48 h der Vercel-Crons).

Benötigt zusätzlich `RESEND_API_KEY` und `APP_URL` (für den Einstellungs-Link in der Mail).

## Voraussetzungen

1. Migrationen `supabase/migrations/20261003_add_episode_transcription_attempts.sql` und
   `supabase/migrations/20261005_add_youtube_channel_sources.sql` sind auf der Datenbank
   angewendet – **vor** dem Deployment dieser Worker- bzw. App-Version. Fehlen die Spalten,
   loggt jede Iteration `iteration_failed` und der Feed-Check schlägt fehl.
2. Docker mit Compose v2 und BuildKit (Standard bei aktuellen Docker-Versionen).

## Betrieb auf der Docker-VM

```bash
git clone ssh://192.168.0.18:2222/malte/castletter.git   # oder: git pull
cd castletter/worker
cp .env.example .env && chmod 600 .env                   # Werte eintragen
docker compose up -d --build
docker compose logs -f                                    # JSON-Logzeilen
docker compose ps                                         # Healthcheck-Status
```

Update: `git pull && docker compose up -d --build`.
Stoppen: `docker compose down`. Eine laufende Episode wird dabei zurück in die
Warteschlange gegeben, ohne dass der Versuch zählt.

## Newsletter-Pipeline umschalten

1. In Vercel `NEWSLETTER_CRON_DISABLED=true` setzen und neu deployen.
2. Jobs für `/api/cron/generate-newsletters` und `/api/cron/send-newsletters` auf
   cron-job.org deaktivieren.
3. In `worker/.env` `WORKER_NEWSLETTERS_ENABLED=true`, `RESEND_API_KEY` und `APP_URL`
   setzen, dann `docker compose up -d --build`.

Rollback: `WORKER_NEWSLETTERS_ENABLED=false`, `docker compose up -d`, Variable in Vercel
entfernen und die Cron-Jobs wieder aktivieren.

## Nach dem Go-live (Transkription)

- cron-job.org-Job für `/api/cron/transcribe-episodes` deaktivieren.
- Zusätzlich in Vercel `TRANSCRIPTION_CRON_DISABLED=true` setzen. Dann beansprucht die
  Route auch bei einem versehentlichen Aufruf nichts mehr.

## Rollback

`docker compose down`, cron-job.org-Job wieder aktivieren und
`TRANSCRIPTION_CRON_DISABLED` in Vercel entfernen. Die Spalte `transcription_attempts`
kann bleiben, die Vercel-Route ignoriert sie.
