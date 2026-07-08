# Video Downloader Backend

Node.js API that uses the `yt-dlp` CLI to extract video metadata and a direct downloadable URL.

## Local setup

```bash
npm install
npm start
```

Health check:

```bash
curl http://localhost:8080/health
```

Extract endpoint:

```bash
curl -X POST http://localhost:8080/api/extract \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"https://example.com/video\"}"
```

## Environment

Copy `.env.example` to `.env` if you need custom settings.

```txt
PORT=8080
YT_DLP_PATH=yt-dlp
EXTRACT_TIMEOUT_MS=30000
```

`yt-dlp` must be installed on the server or available at `YT_DLP_PATH`.
