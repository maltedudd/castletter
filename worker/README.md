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

Der Worker braucht nur ausgehende Verbindungen (Supabase, OpenRouter, Podcast-Feeds und Audio-Hosts, Resend).

## Feed-Check (`WORKER_FEED_CHECK_ENABLED=true`)

Beim Start und danach alle `FEED_CHECK_INTERVAL_MINUTES` (Standard 30) liest der Worker
alle Abo-Feeds und legt neue Episoden als `pending_transcription` an (gleiche Regeln wie
bisher: nur mit Audio, nach Abo-Start bzw. max. 30 Tage zurück, max. 50 je Feed). Jeder
Feed wird in `feed_check_logs` protokolliert. Ein fehlgeschlagener Lauf wird beim nächsten
Durchlauf wiederholt; neue Episoden werden direkt danach transkribiert.

Umschalten: in Vercel `FEED_CHECK_CRON_DISABLED=true` setzen und neu deployen, den Job für
`/api/cron/check-new-episodes` auf cron-job.org deaktivieren, dann in `worker/.env`
`WORKER_FEED_CHECK_ENABLED=true` setzen und `docker compose up -d --build`.

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

1. Migration `supabase/migrations/20261003_add_episode_transcription_attempts.sql` ist auf
   der Datenbank angewendet. Fehlt die Spalte, loggt jede Iteration `iteration_failed`.
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
