const express = require('express');
const {
  getInstagramCookieString,
  saveInstagramSession,
} = require('../services/instagramSessionStore');
const {extractVideo, streamVideoDownload} = require('../services/ytdlpService');

const router = express.Router();

router.post('/session/instagram', (req, res) => {
  const {sessionId, csrfToken, cookieHeader} = req.body || {};

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
    cookieHeader,
    csrfToken: csrfToken.trim(),
    sessionId: sessionId.trim(),
  });

  console.log('[instagram-session] saved');

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
      console.log('[extract] instagram login required');
      return res.status(401).json({
        error: 'INSTAGRAM_LOGIN_REQUIRED',
        message: 'Please login to Instagram before downloading this link.',
      });
    }

    console.log(`[extract] start platform=${isInstagramUrl(url) ? 'instagram' : 'other'}`);
    const result = await extractVideo(url, {
      cookies,
      requireAudio: isInstagramUrl(url),
    });
    console.log('[extract] success');
    return res.json(result);
  } catch (error) {
    return next(error);
  }
});

router.get('/download', async (req, res, next) => {
  try {
    const {url, cookies} = req.query || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        error: 'INVALID_URL',
        message: 'A video URL is required.',
      });
    }

    const cookieHeader =
      typeof cookies === 'string' && cookies.trim()
        ? cookies.trim()
        : isInstagramUrl(url)
          ? getInstagramCookieString()
          : undefined;

    if (isInstagramUrl(url) && !cookieHeader) {
      console.log('[download] instagram login required');
      return res.status(401).json({
        error: 'INSTAGRAM_LOGIN_REQUIRED',
        message: 'Please login to Instagram before downloading this link.',
      });
    }

    console.log(`[download] request platform=${isInstagramUrl(url) ? 'instagram' : 'other'}`);
    await streamVideoDownload(
      {
        cookies: cookieHeader,
        requireAudio: isInstagramUrl(url),
        url,
      },
      res,
    );
  } catch (error) {
    return next(error);
  }
});

const isInstagramUrl = url => url.toLowerCase().includes('instagram.com');

module.exports = router;
