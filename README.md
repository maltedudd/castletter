# Castletter

A newsletter app that automatically summarizes new podcast episodes, YouTube videos and website articles and delivers them via email.

## How it works

1. Add sources: a podcast via RSS feed, a public YouTube channel (channel ID, URL or @handle) or a website via its public RSS/Atom feed („Website (RSS)“)
2. Castletter detects new episodes, uploads and articles automatically
3. Episodes get transcribed and summarized by AI; website articles are summarized from their complete public text (from the feed or the linked article page) – paywalled or teaser-only articles are marked and skipped, never summarized from a teaser
4. You receive a newsletter with the summary at your preferred time. With several items, the daily newsletter opens with an integrated overview across all sources (built from the summaries, not the transcripts), followed by the complete summaries grouped as podcasts, YouTube and Website (RSS)
5. In the settings you choose the tone of the summaries (factual, concise, analytical, warm) and an optional short addition (max. 500 characters) that refines style and perspective – it cannot override the rules on truthfulness, sources and safety

## Tech Stack

- **Framework:** Next.js (TypeScript)
- **Styling:** Tailwind CSS + shadcn/ui
- **Backend:** Supabase (PostgreSQL + Auth)
- **Deployment:** Vercel

## Getting Started

### 1. Clone & Install

```bash
git clone https://github.com/maltedudd/ai-coding-starter-kit.git castletter
cd castletter
npm install
```

### 2. Set up environment variables

```bash
cp .env.local.example .env.local
```

Fill in your credentials in `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
OPENROUTER_API_KEY=...
OPENROUTER_MODEL=google/gemini-2.5-flash
OPENROUTER_TRANSCRIPTION_MODEL=openai/whisper-large-v3
RESEND_API_KEY=...
CRON_SECRET=...
```

`OPENROUTER_MODEL` and `OPENROUTER_TRANSCRIPTION_MODEL` are optional overrides. Their
defaults are shown above; both newsletter generation and transcription use the shared
`OPENROUTER_API_KEY` and OpenRouter endpoint.

### 3. Set up Supabase

Run the migrations in `supabase/migrations/` in your Supabase project.

YouTube videos are transcribed only by the Docker worker (captions first, otherwise the
full audio via OpenRouter STT using yt-dlp); website articles are also processed only by the
worker (no audio). See `worker/README.md` for details.

### 4. Start the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

```bash
npm run dev      # Development server (localhost:3000)
npm run build    # Production build
npm run lint     # Run ESLint
```

## License

MIT
