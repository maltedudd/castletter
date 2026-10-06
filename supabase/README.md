# Supabase Setup für Podletter

Dieses Verzeichnis enthält alle Supabase-Migrationen für das Podletter-Projekt.

## Setup

### 1. Supabase Projekt erstellen

1. Gehe zu [https://supabase.com](https://supabase.com) und erstelle ein neues Projekt
2. Notiere dir die **Project URL** und den **Anon Key**

### 2. Environment Variables setzen

Erstelle eine `.env.local` Datei im Root-Verzeichnis:

```env
NEXT_PUBLIC_SUPABASE_URL=https://dein-projekt.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=dein-anon-key
```

### 3. Migrationen ausführen

Du hast zwei Möglichkeiten, die Migrationen auszuführen:

#### Option A: Über Supabase Dashboard (Empfohlen für Anfang)

1. Gehe zu deinem Supabase Projekt Dashboard
2. Klicke auf **SQL Editor** in der Sidebar
3. Öffne die Migrationsdatei `migrations/20250207_create_user_settings.sql`
4. Kopiere den Inhalt und füge ihn im SQL Editor ein
5. Klicke auf **Run**

#### Option B: Mit Supabase CLI

```bash
# Installiere Supabase CLI
npm install -g supabase

# Login
supabase login

# Verknüpfe mit deinem Projekt
supabase link --project-ref dein-projekt-ref

# Führe Migrationen aus
supabase db push
```

## Migrationen

### 20250207_create_user_settings.sql

Erstellt die `user_settings` Tabelle für PROJ-7 (User Settings):

- **Tabelle**: `user_settings`
  - `id` - UUID (Primary Key)
  - `user_id` - UUID (Foreign Key zu auth.users)
  - `newsletter_email` - TEXT (Email für Newsletter-Versand)
  - `newsletter_delivery_hour` - INT (Versandzeit in UTC, 0-23)
  - `created_at` - TIMESTAMPTZ
  - `updated_at` - TIMESTAMPTZ

- **RLS Policies**: User können nur ihre eigenen Settings sehen/ändern
- **Indexes**: Optimiert für Delivery-Hour-Queries (PROJ-6)

### 20261005_add_youtube_channel_sources.sql (Kanban #29)

YouTube-Kanäle als zweite Quellenart im bestehenden Modell:

- **`podcast_subscriptions`**: `source_type` (`podcast` | `youtube`, Standard `podcast`),
  `youtube_channel_id` (stabile `UC…`-ID, Pflicht für YouTube), `enabled` (deaktivierte
  Quellen werden nicht geprüft), `last_checked_at`, `last_check_status`, `last_check_error`.
  Unique-Index je Nutzer und Channel-ID.
- **`episodes`**: `source_type`, `youtube_video_id` (Unique je Quelle), `transcript_source`
  (`captions` | `audio_stt`), `error_code` (Fehlergrund, siehe `worker/README.md`).
- Bestehende Zeilen werden zu `podcast` und verhalten sich unverändert. Die Migration muss
  **vor** dem Deployment von App und Worker laufen.

### 20261006_add_website_rss_sources.sql (Kanban #35)

Websites mit öffentlichem RSS-/Atom-Feed als dritter Quelltyp „Website (RSS)“:

- **`podcast_subscriptions.source_type`** erlaubt `website`; Websites haben keine
  `youtube_channel_id` und sind wie Podcasts über `feed_url` (unique je Nutzer) identifiziert.
- **`episodes`**: `source_type` erlaubt `website`; neue Spalten `article_url` (öffentlicher
  Artikel-Link) und `feed_content` (bereinigter Feed-Text), nur für Website-Zeilen erlaubt;
  `transcript_source` erlaubt zusätzlich `feed_content` | `article`. Neue `error_code`-Werte
  für Websites siehe `worker/README.md`.
- Die CHECK-Constraints auf `source_type`/`transcript_source` werden namensunabhängig ersetzt;
  bestehende Podcast- und YouTube-Zeilen bleiben unverändert. Die Migration ist wiederholbar
  und muss **vor** dem Deployment von App und Worker laufen.

## Verifizierung

Nach dem Ausführen der Migration kannst du im Supabase Dashboard prüfen:

1. Gehe zu **Database** → **Tables**
2. Du solltest die `user_settings` Tabelle sehen
3. Klicke auf **Policies** - es sollten 3 RLS Policies vorhanden sein

## Nächste Schritte

Nach dem Setup:

1. Starte die Entwicklungsumgebung: `npm run dev`
2. Registriere einen Test-Account unter [http://localhost:3000/register](http://localhost:3000/register)
3. Konfiguriere Settings unter [http://localhost:3000/settings](http://localhost:3000/settings)

## Troubleshooting

### "relation does not exist" Fehler

- Stelle sicher, dass die Migration erfolgreich ausgeführt wurde
- Prüfe im SQL Editor: `SELECT * FROM user_settings;`

### "permission denied" Fehler

- RLS Policies sind nicht richtig gesetzt
- Führe die Migration erneut aus oder überprüfe die Policies im Dashboard

### Auth funktioniert nicht

- Überprüfe die Environment Variables in `.env.local`
- Stelle sicher, dass die URL und der Key korrekt sind
- Restarte den Dev-Server nach Änderungen an `.env.local`
