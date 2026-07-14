let instagramSession = null;

const saveInstagramSession = ({sessionId, csrfToken, cookieHeader}) => {
  instagramSession = {
    cookieHeader: sanitizeCookieHeader(cookieHeader),
    csrfToken,
    sessionId,
    updatedAt: Date.now(),
  };

  return instagramSession;
};

const getInstagramCookieString = () => {
  if (!instagramSession?.sessionId || !instagramSession?.csrfToken) {
    return undefined;
  }

  return (
    instagramSession.cookieHeader ||
    `sessionid=${instagramSession.sessionId}; csrftoken=${instagramSession.csrfToken}`
  );
};

const sanitizeCookieHeader = cookieHeader => {
  if (!cookieHeader || typeof cookieHeader !== 'string') {
    return undefined;
  }

  return cookieHeader
    .split(';')
    .map(cookie => cookie.trim())
    .filter(cookie => cookie.includes('='))
    .join('; ');
};

module.exports = {
  getInstagramCookieString,
  saveInstagramSession,
};
