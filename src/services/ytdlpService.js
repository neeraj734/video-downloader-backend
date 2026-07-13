const {spawn} = require('child_process');
const crypto = require('crypto');
const {createReadStream} = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS || 30000);
const DOWNLOAD_JOB_TTL_MS = Number(process.env.DOWNLOAD_JOB_TTL_MS || 15 * 60 * 1000);
const downloadJobs = new Map();

const extractVideo = async (url, options = {}) => {
  const normalizedUrl = url.trim();

  if (!isValidHttpUrl(normalizedUrl)) {
    const error = new Error('Please provide a valid http or https video URL.');
    error.statusCode = 400;
    error.code = 'INVALID_URL';
    throw error;
  }

  const info = await runYtDlp(normalizedUrl, options);
  const directDownload = getDirectDownload(info);

  if (!directDownload.url) {
    const error = new Error('Could not extract a direct downloadable video URL.');
    error.statusCode = 422;
    error.code = 'NO_DOWNLOAD_URL';
    throw error;
  }

  const downloadId = createDownloadJob({
    cookies: options.cookies,
    title: info.title || 'video',
    url: normalizedUrl,
  });

  return {
    title: info.title || 'Untitled video',
    platform: info.extractor_key || info.extractor || 'Unknown',
    thumbnail: info.thumbnail || null,
    duration: info.duration || null,
    quality: getQualityLabel(info),
    downloadPath: `/api/download/${downloadId}`,
    httpHeaders: undefined,
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
      '--format',
      'b[ext=mp4]/best[ext=mp4]/best',
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

const streamVideoDownload = async (downloadId, res) => {
  cleanupExpiredDownloadJobs();

  const job = downloadJobs.get(downloadId);

  if (!job) {
    res.status(404).json({
      error: 'DOWNLOAD_NOT_FOUND',
      message: 'This download link expired. Please prepare the download again.',
    });
    return;
  }

  try {
    const abortController = new AbortController();

    res.on('close', () => {
      abortController.abort();
    });

    const tempFilePath = await downloadJobToTempFile(
      job,
      abortController.signal,
    );
    const stats = await fs.stat(tempFilePath);
    downloadJobs.delete(downloadId);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(stats.size));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${createSafeFileName(job.title)}"`,
    );

    const stream = createReadStream(tempFilePath);
    let didCleanUpTempFile = false;
    const cleanupTempFile = async () => {
      if (didCleanUpTempFile) {
        return;
      }

      didCleanUpTempFile = true;
      await fs.rm(tempFilePath, {force: true});
    };

    stream.on('error', async error => {
      await cleanupTempFile();

      if (!res.headersSent) {
        res.status(500).json({
          error: 'DOWNLOAD_FAILED',
          message: error.message || 'Could not read the downloaded video.',
        });
        return;
      }

      res.destroy(error);
    });

    stream.on('close', cleanupTempFile);
    stream.pipe(res);
  } catch (error) {
    const statusCode = error.statusCode || 422;

    if (!res.headersSent) {
      res.status(statusCode).json({
        error: error.code || 'DOWNLOAD_FAILED',
        message: error.message || 'yt-dlp could not download this video.',
      });
      return;
    }

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
        'b[ext=mp4]/best[ext=mp4]/best',
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

const createDownloadJob = job => {
  const downloadId = crypto.randomUUID();
  downloadJobs.set(downloadId, {
    ...job,
    createdAt: Date.now(),
  });
  cleanupExpiredDownloadJobs();
  return downloadId;
};

const cleanupExpiredDownloadJobs = () => {
  const expiresBefore = Date.now() - DOWNLOAD_JOB_TTL_MS;

  for (const [downloadId, job] of downloadJobs.entries()) {
    if (job.createdAt < expiresBefore) {
      downloadJobs.delete(downloadId);
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

const getDirectDownload = info => {
  if (info.url && isValidHttpUrl(info.url)) {
    return {
      url: info.url,
      httpHeaders: sanitizeHttpHeaders(info.http_headers),
    };
  }

  const requestedDownload = info.requested_downloads?.find(item =>
    isValidHttpUrl(item.url),
  );

  if (requestedDownload) {
    return {
      url: requestedDownload.url,
      httpHeaders: sanitizeHttpHeaders(
        requestedDownload.http_headers || info.http_headers,
      ),
    };
  }

  const mp4Format = info.formats
    ?.filter(format => format.ext === 'mp4' && isValidHttpUrl(format.url))
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

  return {
    url: mp4Format?.url || null,
    httpHeaders: sanitizeHttpHeaders(mp4Format?.http_headers || info.http_headers),
  };
};

const sanitizeHttpHeaders = headers => {
  if (!headers || typeof headers !== 'object') {
    return undefined;
  }

  const blockedHeaders = new Set([
    'accept-encoding',
    'content-length',
    'host',
    'range',
  ]);

  return Object.entries(headers).reduce((safeHeaders, [key, value]) => {
    if (!key || value === undefined || value === null) {
      return safeHeaders;
    }

    if (blockedHeaders.has(key.toLowerCase())) {
      return safeHeaders;
    }

    safeHeaders[key] = String(value);
    return safeHeaders;
  }, {});
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
