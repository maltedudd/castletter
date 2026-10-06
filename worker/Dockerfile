# Build context is the repository root (see docker-compose.yml), so the worker can
# reuse the shared transcription modules from src/lib without copying them.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app/worker

# YouTube sources (Kanban #29): yt-dlp reads captions/metadata and extracts audio, ffmpeg
# converts it to MP3. The official yt-dlp zipapp (checksum-verified) needs only python3 and
# uses the image's Node as JS runtime for YouTube. YouTube changes often: rebuild with
# `--no-cache` for the latest release, or pin one via `--build-arg YTDLP_VERSION=2026.08.19`.
ARG YTDLP_VERSION=latest
RUN apk add --no-cache ffmpeg python3 \
  && if [ "$YTDLP_VERSION" = latest ]; then \
       url=https://github.com/yt-dlp/yt-dlp/releases/latest/download; \
     else \
       url="https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION"; \
     fi \
  && cd /tmp \
  && wget -q -O yt-dlp "$url/yt-dlp" \
  && wget -q -O SHA2-256SUMS "$url/SHA2-256SUMS" \
  && grep ' yt-dlp$' SHA2-256SUMS | sha256sum -c - \
  && install -m 0755 yt-dlp /usr/local/bin/yt-dlp \
  && rm yt-dlp SHA2-256SUMS \
  && printf -- '--js-runtimes node\n' > /etc/yt-dlp.conf

COPY worker/package.json worker/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/lib/cron /app/src/lib/cron
COPY src/lib/transcription /app/src/lib/transcription
COPY src/lib/newsletter/*.mjs /app/src/lib/newsletter/
COPY src/lib/email/*.mjs /app/src/lib/email/
COPY src/lib/feeds/*.mjs /app/src/lib/feeds/
COPY src/lib/youtube/*.mjs /app/src/lib/youtube/
COPY src/lib/websites/*.mjs /app/src/lib/websites/
COPY src/lib/net/*.mjs /app/src/lib/net/
COPY worker/*.mjs ./

USER node

HEALTHCHECK --interval=60s --timeout=10s --start-period=30s --retries=3 \
  CMD ["node", "healthcheck.mjs"]

CMD ["node", "index.mjs"]
