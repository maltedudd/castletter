# Castletter

A newsletter app that automatically summarizes new podcast episodes and delivers them via email.

## How it works

1. Subscribe to any podcast via RSS feed
2. Castletter detects new episodes automatically
3. Episodes get transcribed and summarized by AI
4. You receive a newsletter with the summary at your preferred time

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
OPENAI_API_KEY=...
RESEND_API_KEY=...
CRON_SECRET=...
```

### 3. Set up Supabase

Run the migrations in `supabase/migrations/` in your Supabase project.

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
