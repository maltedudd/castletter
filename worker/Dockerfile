# Build context is the repository root (see docker-compose.yml), so the worker can
# reuse the shared transcription modules from src/lib without copying them.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app/worker

COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/lib/cron /app/src/lib/cron
COPY src/lib/transcription /app/src/lib/transcription
COPY src/lib/newsletter/*.mjs /app/src/lib/newsletter/
COPY src/lib/email/*.mjs /app/src/lib/email/
COPY src/lib/feeds/*.mjs /app/src/lib/feeds/
COPY worker/*.mjs ./

USER node

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

CMD ["node", "index.mjs"]
