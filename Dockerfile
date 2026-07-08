FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
  && pip3 install --break-system-packages --no-cache-dir yt-dlp \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src

ENV PORT=8080
ENV YT_DLP_PATH=yt-dlp
ENV EXTRACT_TIMEOUT_MS=30000

EXPOSE 8080

CMD ["npm", "start"]
