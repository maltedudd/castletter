# Castletter Transkriptions-Worker

Eigenständiger Docker-Worker, der Podcast-Episoden ohne das Zeitlimit von Vercel
transkribiert. Er ersetzt den Cron-Aufruf von `/api/cron/transcribe-episodes`.

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

Der Worker braucht nur ausgehende Verbindungen (Supabase, OpenRouter, Audio-Hosts).

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

## Nach dem Go-live

- cron-job.org-Job für `/api/cron/transcribe-episodes` deaktivieren.
- Zusätzlich in Vercel `TRANSCRIPTION_CRON_DISABLED=true` setzen. Dann beansprucht die
  Route auch bei einem versehentlichen Aufruf nichts mehr.

## Rollback

`docker compose down`, cron-job.org-Job wieder aktivieren und
`TRANSCRIPTION_CRON_DISABLED` in Vercel entfernen. Die Spalte `transcription_attempts`
kann bleiben, die Vercel-Route ignoriert sie.
