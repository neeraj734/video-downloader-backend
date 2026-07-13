const express = require('express');
const {
  getInstagramCookieString,
  saveInstagramSession,
} = require('../services/instagramSessionStore');
const {extractVideo, streamVideoDownload} = require('../services/ytdlpService');

const router = express.Router();

router.post('/session/instagram', (req, res) => {
  const {sessionId, csrfToken} = req.body || {};

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({
      error: 'INVALID_INSTAGRAM_SESSION',
      message: 'An Instagram sessionId is required.',
    });
  }

  if (!csrfToken || typeof csrfToken !== 'string') {
    return res.status(400).json({
      error: 'INVALID_INSTAGRAM_SESSION',
      message: 'An Instagram csrfToken is required.',
    });
  }

  const session = saveInstagramSession({
    csrfToken: csrfToken.trim(),
    sessionId: sessionId.trim(),
  });

  return res.json({
    ok: true,
    updatedAt: session.updatedAt,
  });
});

router.post('/extract', async (req, res, next) => {
  try {
    const {url} = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'INVALID_URL',
        message: 'A video URL is required.',
      });
    }

    const cookies = isInstagramUrl(url) ? getInstagramCookieString() : undefined;

    if (isInstagramUrl(url) && !cookies) {
      return res.status(401).json({
        error: 'INSTAGRAM_LOGIN_REQUIRED',
        message: 'Please login to Instagram before downloading this link.',
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

const isInstagramUrl = url => url.toLowerCase().includes('instagram.com');

module.exports = router;
