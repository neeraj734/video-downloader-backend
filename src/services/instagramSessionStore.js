let instagramSession = null;

const saveInstagramSession = ({sessionId, csrfToken}) => {
  instagramSession = {
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

  return `sessionid=${instagramSession.sessionId}; csrftoken=${instagramSession.csrfToken}`;
};

module.exports = {
  getInstagramCookieString,
  saveInstagramSession,
};
