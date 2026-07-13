const express = require('express');
const {extractVideo, streamVideoDownload} = require('../services/ytdlpService');

const router = express.Router();

router.post('/extract', async (req, res, next) => {
  try {
    const {url, cookies} = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'INVALID_URL',
        message: 'A video URL is required.',
      });
    }

    const result = await extractVideo(url, {cookies});
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

router.get('/download/:downloadId', async (req, res, next) => {
  try {
    await streamVideoDownload(req.params.downloadId, res);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
