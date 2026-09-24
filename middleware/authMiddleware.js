const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'kumarda_session';

function getSecret() {
  return process.env.SESSION_SECRET || 'fallback-secret-key-kumarda-contacts';
}

function requireAuth(req, res, next) {
  let token = req.cookies ? req.cookies[COOKIE_NAME] : null;

  // Optional fallback to Authorization header for programmatic testing
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      token = parts[1];
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, getSecret());
    if (!decoded || !decoded.id) {
      return res.status(401).json({ error: 'Unauthorized: Invalid session token' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired session' });
  }
}

function optionalAuth(req, res, next) {
  let token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      token = parts[1];
    }
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, getSecret());
      if (decoded && decoded.id) {
        req.user = decoded;
      }
    } catch (e) {
      // ignore invalid optional token
    }
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  getSecret,
  requireAuth,
  optionalAuth
};
