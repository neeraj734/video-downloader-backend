const cors = require('cors');
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

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'video-downloader-backend',
  });
});

app.use('/api', extractRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `${req.method} ${req.path} is not a valid endpoint.`,
  });
});

app.use((err, _req, res, _next) => {
  const statusCode = err.statusCode || 500;

  res.status(statusCode).json({
    error: err.code || 'SERVER_ERROR',
    message: err.message || 'Something went wrong.',
  });
});

app.listen(port, () => {
  console.log(`Video downloader backend running on port ${port}`);
});
