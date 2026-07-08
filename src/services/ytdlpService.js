const {spawn} = require('child_process');

const YT_DLP_PATH = process.env.YT_DLP_PATH || 'yt-dlp';
const EXTRACT_TIMEOUT_MS = Number(process.env.EXTRACT_TIMEOUT_MS || 30000);

const extractVideo = async url => {
  const normalizedUrl = url.trim();

  if (!isValidHttpUrl(normalizedUrl)) {
    const error = new Error('Please provide a valid http or https video URL.');
    error.statusCode = 400;
    error.code = 'INVALID_URL';
    throw error;
  }

  const info = await runYtDlp(normalizedUrl);
  const directUrl = getDirectDownloadUrl(info);

  if (!directUrl) {
    const error = new Error('Could not extract a direct downloadable video URL.');
    error.statusCode = 422;
    error.code = 'NO_DOWNLOAD_URL';
    throw error;
  }

  return {
    title: info.title || 'Untitled video',
    platform: info.extractor_key || info.extractor || 'Unknown',
    thumbnail: info.thumbnail || null,
    duration: info.duration || null,
    quality: getQualityLabel(info),
    downloadUrl: directUrl,
  };
};

const runYtDlp = url =>
  new Promise((resolve, reject) => {
    const args = [
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '--format',
      'bv*+ba/b[ext=mp4]/b',
      url,
    ];

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

const getDirectDownloadUrl = info => {
  if (info.url && isValidHttpUrl(info.url)) {
    return info.url;
  }

  const requestedDownload = info.requested_downloads?.find(item =>
    isValidHttpUrl(item.url),
  );

  if (requestedDownload) {
    return requestedDownload.url;
  }

  const mp4Format = info.formats
    ?.filter(format => format.ext === 'mp4' && isValidHttpUrl(format.url))
    .sort((a, b) => (b.height || 0) - (a.height || 0))[0];

  return mp4Format?.url || null;
};

const getQualityLabel = info => {
  if (info.height) {
    return `${info.height}p`;
  }

  const height = info.requested_downloads?.find(item => item.height)?.height;
  return height ? `${height}p` : 'best';
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
};
