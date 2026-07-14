const {spawn} = require('child_process');
const crypto = require('crypto');
const {createReadStream} = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';
const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS || 30000);
const DOWNLOAD_JOB_TTL_MS = Number(process.env.DOWNLOAD_JOB_TTL_MS || 15 * 60 * 1000);
const PHONE_COMPATIBLE_FORMAT =
  [
    'bv*[vcodec^=avc1][ext=mp4]+ba[ext=m4a]',
    'bv*[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a]',
    'b[vcodec^=avc1][acodec!=none][ext=mp4]',
    'b[acodec!=none][ext=mp4]',
    'bv*[vcodec^=avc1]+ba[ext=m4a]',
    'bestvideo+bestaudio',
    'best[acodec!=none]',
  ].join('/');
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
    requireAudio: Boolean(options.requireAudio),
    title: info.title || 'video',
    url: normalizedUrl,
  });

  console.log(`[extract] job-created id=${downloadId}`);

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
      PHONE_COMPATIBLE_FORMAT,
      '--format-sort',
      'vcodec:h264,acodec:aac,ext:mp4:m4a',
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
    console.log(`[download] missing-job id=${downloadId}`);
    res.status(404).json({
      error: 'DOWNLOAD_NOT_FOUND',
      message: 'This download link expired. Please prepare the download again.',
    });
    return;
  }

  try {
    console.log(`[download] ytdlp-start id=${downloadId}`);
    if (!job.tempFilePath) {
      const abortController = new AbortController();

      res.on('close', () => {
        abortController.abort();
      });

      job.tempFilePath = await downloadJobToTempFile(
        job,
        abortController.signal,
      );
      job.completedAt = Date.now();
      job.fileSize = (await fs.stat(job.tempFilePath)).size;
      console.log(
        `[download] ytdlp-complete id=${downloadId} bytes=${job.fileSize}`,
      );
    } else {
      console.log(`[download] cached-file id=${downloadId} bytes=${job.fileSize}`);
    }

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', String(job.fileSize));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${createSafeFileName(job.title)}"`,
    );

    const stream = createReadStream(job.tempFilePath);
    stream.on('error', async error => {
      console.error(`[download] file-stream-error id=${downloadId}`, error.message);

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
      console.log(`[download] response-finished id=${downloadId}`);
    });
    stream.pipe(res);
  } catch (error) {
    const statusCode = error.statusCode || 422;
    console.error(
      `[download] failed id=${downloadId} code=${error.code || 'DOWNLOAD_FAILED'}`,
      error.message,
    );

    if (!job.tempFilePath) {
      downloadJobs.delete(downloadId);
    }

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
        PHONE_COMPATIBLE_FORMAT,
        '--format-sort',
        'vcodec:h264,acodec:aac,ext:mp4:m4a',
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

    const mediaStreams = await probeMediaStreams(tempFilePath);

    if (job.requireAudio && !mediaStreams.hasAudio) {
      const error = new Error(
        'This reel could not be downloaded with audio. Please try another link or refresh your Instagram login.',
      );
      error.statusCode = 422;
      error.code = 'MISSING_AUDIO_TRACK';
      throw error;
    }

    if (mediaStreams.hasAudio) {
      if (mediaStreams.needsAudioTranscode) {
        await transcodeAudioToAac(tempFilePath);
      }
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
      if (job.tempFilePath) {
        fs.rm(job.tempFilePath, {force: true}).catch(error => {
          console.error(
            `[download] temp-cleanup-failed id=${downloadId}`,
            error.message,
          );
        });
      }

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

const probeMediaStreams = async filePath =>
  new Promise(resolve => {
    const child = spawn(
      FFPROBE_PATH,
      [
        '-v',
        'error',
        '-show_entries',
        'stream=codec_name,codec_type',
        '-of',
        'json',
        filePath,
      ],
      {
        windowsHide: true,
      },
    );

    let stdout = '';

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.on('error', error => {
      console.error('[download] ffprobe-unavailable', error.message);
      resolve({hasAudio: true, needsAudioTranscode: false});
    });

    child.on('close', code => {
      if (code !== 0) {
        resolve({hasAudio: true, needsAudioTranscode: false});
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        const audioStreams =
          parsed.streams?.filter(stream => stream.codec_type === 'audio') || [];
        resolve({
          hasAudio: audioStreams.length > 0,
          needsAudioTranscode: audioStreams.some(
            stream => !isAndroidFriendlyAudioCodec(stream.codec_name),
          ),
        });
      } catch (_error) {
        resolve({hasAudio: true, needsAudioTranscode: false});
      }
    });
  });

const isAndroidFriendlyAudioCodec = codecName =>
  ['aac', 'mp3'].includes(String(codecName || '').toLowerCase());

const transcodeAudioToAac = async filePath => {
  const outputPath = `${filePath}.audio-fixed.mp4`;

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        FFMPEG_PATH,
        [
          '-y',
          '-i',
          filePath,
          '-c:v',
          'copy',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
          '-movflags',
          '+faststart',
          outputPath,
        ],
        {
          windowsHide: true,
        },
      );

      let stderr = '';

      child.stderr.on('data', data => {
        stderr += data.toString();
      });

      child.on('error', error => {
        const wrappedError = new Error(
          error.code === 'ENOENT'
            ? 'ffmpeg is not installed or FFMPEG_PATH is incorrect.'
            : error.message,
        );
        wrappedError.statusCode = 500;
        wrappedError.code = 'FFMPEG_UNAVAILABLE';
        reject(wrappedError);
      });

      child.on('close', code => {
        if (code === 0) {
          resolve();
          return;
        }

        const error = new Error(
          cleanYtDlpMessage(stderr) || 'ffmpeg could not normalize the audio.',
        );
        error.statusCode = 422;
        error.code = 'AUDIO_NORMALIZE_FAILED';
        reject(error);
      });
    });

    await fs.rename(outputPath, filePath);
  } catch (error) {
    await fs.rm(outputPath, {force: true});
    throw error;
  }
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
