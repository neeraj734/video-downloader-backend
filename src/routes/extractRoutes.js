const express = require('express');
const {extractVideo} = require('../services/ytdlpService');

const router = express.Router();

router.post('/extract', async (req, res, next) => {
  try {
    const {url} = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'INVALID_URL',
        message: 'A video URL is required.',
      });
    }

    const result = await extractVideo(url);
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
