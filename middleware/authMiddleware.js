const jwt = require('jsonwebtoken');

const COOKIE_NAME = 'kumarda_session';

function getSecret() {
  return process.env.SESSION_SECRET || 'fallback-secret-key';
}

function requireAuth(req, res, next) {
  let token = req.cookies[COOKIE_NAME];

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
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired session' });
  }
}

function optionalAuth(req, res, next) {
  let token = req.cookies[COOKIE_NAME];
  if (!token && req.headers.authorization) {
    const parts = req.headers.authorization.split(' ');
    if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
      token = parts[1];
    }
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, getSecret());
      req.user = decoded;
    } catch (e) {
      // ignore
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
