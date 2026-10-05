# Castletter Worker

Eigenständiger Docker-Worker, der Podcast-Episoden ohne das Zeitlimit von Vercel
transkribiert und – wenn zugeschaltet – neue Episoden aus den Feeds holt sowie die
Newsletter erzeugt und verschickt. Er ersetzt die Cron-Aufrufe von
`/api/cron/check-new-episodes`, `/api/cron/transcribe-episodes`,
`/api/cron/generate-newsletters` und `/api/cron/send-newsletters`.

## Ablauf

Jede Minute (`TRANSCRIPTION_POLL_INTERVAL_SECONDS`) läuft eine Iteration:

1. `transcribing`-Episoden mit abgelaufener Lease (15 min ohne Fortschritt) gehen zurück auf
   `pending_transcription`.
2. Die **älteste** `pending_transcription`-Episode, die höchstens
   `TRANSCRIPTION_MAX_EPISODE_AGE_DAYS` alt ist, wird statusgeschützt beansprucht.
3. Die Episode wird vollständig transkribiert (Range-Chunks in Reihenfolge). Nach jedem
   Chunk wird die Lease erneuert. `transcribed` wird nur mit dem vollständig
   zusammengesetzten Transkript gespeichert.
4. Gibt es weitere Arbeit, startet die nächste Iteration sofort.

Fehler:

- Permanente Fehler (Audio nicht erreichbar, keine Sprache, kein Range-Support) → `failed`.
- Temporäre Fehler → zurück auf `pending_transcription` mit
  „Temporärer Fehler (Versuch n/max)“.
- Nach `TRANSCRIPTION_MAX_ATTEMPTS` Versuchen → `failed` mit dem letzten Fehlertext.

Der Worker braucht nur ausgehende Verbindungen (Supabase, OpenRouter, Podcast-Feeds und Audio-Hosts, YouTube, Resend).

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
2. **Transkription** (nur im Worker; die Vercel-Route überspringt YouTube-Episoden):
   - Zuerst vollständige YouTube-Untertitel: manuelle Untertitel (Originalsprache, dann
     `YOUTUBE_CAPTION_LANGUAGES`), sonst automatische Untertitel nur in der gesprochenen
     Originalsprache – nie maschinelle Übersetzungen. Untertitel gelten nur als brauchbar,
     wenn sie bis zum Videoende reichen (max. 60 s bzw. 5 % Lücke) und genug Text enthalten.
   - Sonst wird das **komplette** Audio per yt-dlp als Mono-MP3 geladen und über den
     bestehenden OpenRouter-STT-Weg (in Reihenfolge, chunkweise, alles oder nichts)
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
