const {spawn} = require('child_process');
const {createReadStream} = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS || 30000);
// const DOWNLOAD_FORMAT = 'bestvideo[ext=mp4]+bestaudio[ext=mp4]/best[ext=mp4]/best';
const DOWNLOAD_FORMAT = 'bestvideo+bestaudio/best';

const extractVideo = async (url, options = {}) => {
  const normalizedUrl = url.trim();

  if (!isValidHttpUrl(normalizedUrl)) {
    const error = new Error('Please provide a valid http or https video URL.');
    error.statusCode = 400;
    error.code = 'INVALID_URL';
    throw error;
  }

  const info = await runYtDlp(normalizedUrl, options);

  return {
    title: info.title || 'Untitled video',
    platform: info.extractor_key || info.extractor || 'Unknown',
    thumbnail: info.thumbnail || null,
    duration: info.duration || null,
    quality: getQualityLabel(info),
  };
};

const runYtDlp = async (url, options = {}) => {
  const cookieFilePath = await createCookieFile(options.cookies);

  try {
    return await new Promise((resolve, reject) => {
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      url,
    ];

    if (cookieFilePath) {
      args.splice(args.length - 1, 0, '--cookies', cookieFilePath);
    }

    const child = spawn(YT_DLP_PATH, args, {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let isFinished = false;

    const timeout = setTimeout(() => {
      if (isFinished) {
        return;
      }

      isFinished = true;
      child.kill('SIGTERM');

      const error = new Error('Video extraction timed out.');
      error.statusCode = 504;
      error.code = 'EXTRACT_TIMEOUT';
      reject(error);
    }, EXTRACT_TIMEOUT_MS);

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('error', error => {
      if (isFinished) {
        return;
      }

      isFinished = true;
      clearTimeout(timeout);

      const wrappedError = new Error(
        error.code === 'ENOENT'
          ? 'yt-dlp is not installed or YT_DLP_PATH is incorrect.'
          : error.message,
      );
      wrappedError.statusCode = 500;
      wrappedError.code = 'YT_DLP_UNAVAILABLE';
      reject(wrappedError);
    });

    child.on('close', code => {
      if (isFinished) {
        return;
      }

      isFinished = true;
      clearTimeout(timeout);

      if (code !== 0) {
        const error = new Error(
          cleanYtDlpMessage(stderr) || 'yt-dlp could not extract this URL.',
        );
        error.statusCode = 422;
        error.code = 'EXTRACT_FAILED';
        reject(error);
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (_error) {
        const parseError = new Error('yt-dlp returned an invalid response.');
        parseError.statusCode = 500;
        parseError.code = 'INVALID_YT_DLP_RESPONSE';
        reject(parseError);
      }
    });
  });
  } finally {
    if (cookieFilePath) {
      await fs.rm(cookieFilePath, {force: true});
    }
  }
};

const streamVideoDownload = async (job, res) => {
  const normalizedUrl = typeof job?.url === 'string' ? job.url.trim() : '';

  if (!isValidHttpUrl(normalizedUrl)) {
    res.status(400).json({
      error: 'INVALID_URL',
      message: 'A valid video URL is required.',
    });
    return;
  }

  const downloadJob = {
    ...job,
    title: job.title || 'video',
    url: normalizedUrl,
  };
  let tempFilePath;
  let didCleanUp = false;

  const cleanupTempFile = () => {
    if (!tempFilePath || didCleanUp) {
      return;
    }

    didCleanUp = true;
    fs.rm(tempFilePath, {force: true}).catch(error => {
      console.error('[download] temp-cleanup-failed', error.message);
    });
  };

  try {
    console.log('[download] ytdlp-start');
    const abortController = new AbortController();

    res.on('close', () => {
      if (!tempFilePath) {
        abortController.abort();
      }
    });

    tempFilePath = await downloadJobToTempFile(
      downloadJob,
      abortController.signal,
    );
    const fileSize = (await fs.stat(tempFilePath)).size;
    console.log(`[download] ytdlp-complete bytes=${fileSize}`);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(fileSize));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${createSafeFileName(downloadJob.title)}"`,
    );

    const stream = createReadStream(tempFilePath);
    stream.on('error', async error => {
      console.error('[download] file-stream-error', error.message);

      if (!res.headersSent) {
        res.status(500).json({
          error: 'DOWNLOAD_FAILED',
          message: error.message || 'Could not read the downloaded video.',
        });
        return;
      }

      res.destroy(error);
    });

    res.on('finish', () => {
      console.log('[download] response-finished');
      cleanupTempFile();
    });
    res.on('close', () => {
      stream.destroy();
      cleanupTempFile();
    });
    stream.pipe(res);
  } catch (error) {
    const statusCode = error.statusCode || 422;
    console.error(
      `[download] failed code=${error.code || 'DOWNLOAD_FAILED'}`,
      error.message,
    );

    if (!res.headersSent) {
      cleanupTempFile();
      res.status(statusCode).json({
        error: error.code || 'DOWNLOAD_FAILED',
        message: error.message || 'yt-dlp could not download this video.',
      });
      return;
    }

    cleanupTempFile();
    res.destroy(error);
  }
};

const downloadJobToTempFile = async (job, abortSignal) => {
  const cookieFilePath = await createCookieFile(job.cookies);
  const tempFilePath = path.join(
    os.tmpdir(),
    `video-download-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`,
  );

  try {
    await new Promise((resolve, reject) => {
      const args = [
        '--no-warnings',
        '--no-playlist',
        '--no-part',
        '--force-overwrites',
        '--retries',
        '10',
        '--fragment-retries',
        '10',
        '--format',
        DOWNLOAD_FORMAT,
        '--merge-output-format',
        'mp4',
        '--remux-video',
        'mp4',
        '--output',
        tempFilePath,
        job.url,
      ];

      if (cookieFilePath) {
        args.splice(args.length - 1, 0, '--cookies', cookieFilePath);
      }

      const child = spawn(YT_DLP_PATH, args, {
        windowsHide: true,
      });

      let stderr = '';
      let isSettled = false;

      const abortDownload = () => {
        if (!isSettled && !child.killed) {
          child.kill('SIGTERM');
        }
      };

      if (abortSignal?.aborted) {
        abortDownload();
      } else {
        abortSignal?.addEventListener('abort', abortDownload, {once: true});
      }

      child.stderr.on('data', data => {
        stderr += data.toString();
      });

      child.on('error', error => {
        if (isSettled) {
          return;
        }

        isSettled = true;
        abortSignal?.removeEventListener('abort', abortDownload);

        const wrappedError = new Error(
          error.code === 'ENOENT'
            ? 'yt-dlp is not installed or YT_DLP_PATH is incorrect.'
            : error.message,
        );
        wrappedError.statusCode = 500;
        wrappedError.code = 'YT_DLP_UNAVAILABLE';
        reject(wrappedError);
      });

      child.on('close', code => {
        if (isSettled) {
          return;
        }

        isSettled = true;
        abortSignal?.removeEventListener('abort', abortDownload);

        if (abortSignal?.aborted) {
          const error = new Error('The video download was canceled.');
          error.statusCode = 499;
          error.code = 'DOWNLOAD_CANCELED';
          reject(error);
          return;
        }

        if (code !== 0) {
          const error = new Error(
            cleanYtDlpMessage(stderr) || 'yt-dlp could not download this video.',
          );
          console.error('[download] ytdlp-stderr', cleanYtDlpMessage(stderr));
          error.statusCode = 422;
          error.code = 'DOWNLOAD_FAILED';
          reject(error);
          return;
        }

        resolve();
      });
    });

    const stats = await fs.stat(tempFilePath);

    if (!stats.size) {
      const error = new Error('No video data was downloaded.');
      error.statusCode = 422;
      error.code = 'EMPTY_DOWNLOAD';
      throw error;
    }

    return tempFilePath;
  } catch (error) {
    await fs.rm(tempFilePath, {force: true});
    throw error;
  } finally {
    if (cookieFilePath) {
      await fs.rm(cookieFilePath, {force: true});
    }
  }
};

const createCookieFile = async cookies => {
  if (!cookies || typeof cookies !== 'string') {
    return null;
  }

  const cookieLines = cookies
    .split(';')
    .map(cookie => cookie.trim())
    .filter(Boolean)
    .map(cookie => {
      const separatorIndex = cookie.indexOf('=');

      if (separatorIndex === -1) {
        return null;
      }

      const name = cookie.slice(0, separatorIndex).trim();
      const value = cookie.slice(separatorIndex + 1).trim();

      if (!name) {
        return null;
      }

      return [
        '.instagram.com',
        'TRUE',
        '/',
        'TRUE',
        '0',
        name,
        value,
      ].join('\t');
    })
    .filter(Boolean);

  if (!cookieLines.length) {
    return null;
  }

  const cookieFileContent = [
    '# Netscape HTTP Cookie File',
    ...cookieLines,
    '',
  ].join('\n');
  const cookieFilePath = path.join(
    os.tmpdir(),
    `instagram-cookies-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}.txt`,
  );

  await fs.writeFile(cookieFilePath, cookieFileContent, 'utf8');
  return cookieFilePath;
};

const getQualityLabel = info => {
  if (info.height) {
    return `${info.height}p`;
  }

  const height = info.requested_downloads?.find(item => item.height)?.height;
  return height ? `${height}p` : 'best';
};

const createSafeFileName = title => {
  const safeTitle = String(title || 'video')
    .replace(/\.[^/.]+$/, '')
    .replace(/[^a-z0-9-_]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 70);

  return `${safeTitle || 'video'}.mp4`;
};

const cleanYtDlpMessage = message =>
  message
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-2)
    .join(' ');

const isValidHttpUrl = value => {
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:';
  } catch (_error) {
    return false;
  }
};

module.exports = {
  extractVideo,
  streamVideoDownload,
};
