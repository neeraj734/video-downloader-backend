const express = require('express');
const {
  getInstagramCookieString,
  saveInstagramSession,
} = require('../services/instagramSessionStore');
const {extractVideo, streamVideoDownload} = require('../services/ytdlpService');

const router = express.Router();
const INSTAGRAM_RETRY_DELAYS_MS = [3000, 5000];

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

    const isInstagram = isInstagramUrl(url);
    const cookies = isInstagram ? getInstagramCookieString() : undefined;

    if (isInstagram && !cookies) {
      console.log('[extract] instagram login required');
      return res.status(401).json({
        error: 'INSTAGRAM_LOGIN_REQUIRED',
        message: 'Please login to Instagram before downloading this link.',
      });
    }

    console.log(`[extract] start platform=${isInstagram ? 'instagram' : 'other'}`);
    const extract = () =>
      extractVideo(url, {
        cookies,
        requireAudio: isInstagram,
      });
    const result = isInstagram
      ? await retryInstagramRequest('extract', extract)
      : await extract();
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

    const isInstagram = isInstagramUrl(url);
    const cookieHeader =
      typeof cookies === 'string' && cookies.trim()
        ? cookies.trim()
        : isInstagram
          ? getInstagramCookieString()
          : undefined;

    if (isInstagram && !cookieHeader) {
      console.log('[download] instagram login required');
      return res.status(401).json({
        error: 'INSTAGRAM_LOGIN_REQUIRED',
        message: 'Please login to Instagram before downloading this link.',
      });
    }

    console.log(`[download] request platform=${isInstagram ? 'instagram' : 'other'}`);
    const download = () =>
      streamVideoDownload(
        {
          cookies: cookieHeader,
          requireAudio: isInstagram,
          throwOnError: isInstagram,
          url,
        },
        res,
      );

    if (isInstagram) {
      await retryInstagramRequest('download', download);
    } else {
      await download();
    }
  } catch (error) {
    return next(error);
  }
});

const isInstagramUrl = url => url.toLowerCase().includes('instagram.com');

const retryInstagramRequest = async (routeName, request) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      const retryDelay = INSTAGRAM_RETRY_DELAYS_MS[attempt];

      if (retryDelay === undefined || !isRetryableInstagramError(error)) {
        throw error;
      }

      console.log(
        `[${routeName}] instagram retry attempt=${attempt + 1} delayMs=${retryDelay} code=${
          error.code || 'UNKNOWN'
        } status=${error.statusCode || 'UNKNOWN'}`,
      );
      await delay(retryDelay);
    }
  }
};

const isRetryableInstagramError = error =>
  error?.code === 'NO_AUDIO_STREAM' ||
  error?.statusCode === 404 ||
  error?.statusCode === 422;

const delay = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

module.exports = router;
