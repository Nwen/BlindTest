# ── Stage 1 : build du client React ──────────────────────────────────────────
FROM node:20-slim AS client-builder

WORKDIR /build/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ── Stage 2 : image finale ────────────────────────────────────────────────────
FROM node:20-slim

# yt-dlp + ffmpeg (nécessaire pour re-encoder/normaliser l'audio)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 ffmpeg curl ca-certificates \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
         -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dépendances serveur (prod uniquement)
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

COPY server/ ./server/

# Client buildé
COPY --from=client-builder /build/client/dist ./client/dist

# Dossier cache YouTube
RUN mkdir -p /tmp/blindtest

EXPOSE 3000

CMD ["node", "server/index.js"]
