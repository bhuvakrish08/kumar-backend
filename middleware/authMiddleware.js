const jwt = require('jsonwebtoken');
const { getPool } = require('../db');

const COOKIE_NAME = 'kumarda_session';

function getSecret() {
  if (!process.env.SESSION_SECRET) {
    throw new Error('FATAL SECURITY ERROR: SESSION_SECRET environment variable is missing');
  }
  return process.env.SESSION_SECRET;
}

async function requireAuth(req, res, next) {
  let token;
  try {
    token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized: Invalid cookies' });
  }

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Authentication required' });
  }

  try {
    const secret = getSecret();
    const decoded = jwt.verify(token, secret);
    if (!decoded || !decoded.id) {
      return res.status(401).json({ error: 'Unauthorized: Invalid session token' });
    }

    // Verify user exists in database to prevent FK failures on deleted/invalid users
    const pool = getPool();
    const [userRows] = await pool.query('SELECT id FROM users WHERE id = ? LIMIT 1', [decoded.id]);
    if (!userRows || userRows.length === 0) {
      res.clearCookie(COOKIE_NAME);
      return res.status(401).json({ error: 'Unauthorized: Session user no longer exists. Please log in again.' });
    }

    req.user = decoded;
    next();
  } catch (err) {
    if (err.message && err.message.includes('SESSION_SECRET environment variable is missing')) {
      return res.status(500).json({ error: err.message });
    }
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired session' });
  }
}

function optionalAuth(req, res, next) {
  const token = req.cookies ? req.cookies[COOKIE_NAME] : null;
  if (token) {
    try {
      const secret = getSecret();
      const decoded = jwt.verify(token, secret);
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
