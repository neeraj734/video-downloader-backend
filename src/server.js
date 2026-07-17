const cors = require('cors');
const {execSync} = require('child_process');
const dotenv = require('dotenv');
const express = require('express');
const helmet = require('helmet');
const extractRoutes = require('./routes/extractRoutes');

dotenv.config();

const app = express();
const port = process.env.PORT || 8080;

app.use(helmet());
app.use(cors());
app.use(express.json({limit: '1mb'}));
app.use((req, res, next) => {
  const startedAt = Date.now();

  res.on('finish', () => {
    console.log(
      `[request] ${req.method} ${req.originalUrl} ${res.statusCode} ${
        Date.now() - startedAt
      }ms`,
    );
  });

  next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'video-downloader-backend',
  });
});

app.use('/api', extractRoutes);
app.get('/debug/formats', (req, res) => {
  const {execFileSync} = require('child_process');
  const url = req.query.url;

  if (!url) {
    return res.status(400).json({error: 'Missing url parameter'});
  }

  let hostname;

  try {
    hostname = new URL(url).hostname;
  } catch (_error) {
    return res.status(400).json({error: 'Invalid URL'});
  }

  const allowed = ['instagram.com', 'www.instagram.com'];

  if (!allowed.includes(hostname)) {
    return res.status(403).json({error: 'Domain not allowed'});
  }

  try {
    const output = execFileSync('yt-dlp', ['-F', url], {
      timeout: 30000,
    }).toString();
    return res.type('text/plain').send(output);
  } catch (err) {
    return res.status(500).type('text/plain').send('Error: ' + err.message);
  }
});


app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `${req.method} ${req.path} is not a valid endpoint.`,
  });
});

app.use((err, _req, res, _next) => {
  const statusCode = err.statusCode || 500;

  console.error('[error]', err.code || 'SERVER_ERROR', err.message);

  res.status(statusCode).json({
    error: err.code || 'SERVER_ERROR',
    message: err.message || 'Something went wrong.',
  });
});

app.listen(port, () => {
  console.log(`Video downloader backend running on port ${port}`);
  console.log('yt-dlp version:', execSync('yt-dlp --version').toString().trim());
});
