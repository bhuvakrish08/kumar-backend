const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { getPool } = require('../db');
const {
  COOKIE_NAME,
  getSecret,
  requireAuth,
} = require('../middleware/authMiddleware');

// ======================================================
// POST /api/v1/auth/login
// ======================================================
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const trimmedUsername = username.trim();
    const pool = getPool();

    // Query user strictly from MySQL users table
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE username = ? LIMIT 1',
      [trimmedUsername]
    );

    if (!rows || rows.length === 0) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    const user = rows[0];
    const storedPassword = user.password || user.password_hash;

    if (!storedPassword) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    // Compare entered password with password in database (supports bcrypt hash or plain text)
    let passwordMatched = false;
    if (
      typeof storedPassword === 'string' &&
      (storedPassword.startsWith('$2a$') ||
       storedPassword.startsWith('$2b$') ||
       storedPassword.startsWith('$2y$'))
    ) {
      passwordMatched = await bcrypt.compare(password, storedPassword);
    } else {
      passwordMatched = (password === storedPassword);
    }

    if (!passwordMatched) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    // Generate JWT Token
    const tokenPayload = {
      id: user.id,
      username: user.username,
      full_name: user.full_name || null,
    };

    const token = jwt.sign(tokenPayload, getSecret(), { expiresIn: '14d' });

    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: 14 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      message: 'Logged in successfully',
      user: tokenPayload,
      token,
    });

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Server error during authentication' });
  }
});

// ======================================================
// POST /api/v1/auth/logout
// ======================================================
router.post('/logout', (req, res) => {
  try {
    const isProd = process.env.NODE_ENV === 'production';
    res.clearCookie(COOKIE_NAME, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
    });
    return res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to logout' });
  }
});

// ======================================================
// GET /api/v1/auth/me
// ======================================================
router.get('/me', requireAuth, (req, res) => {
  return res.status(200).json({ user: req.user });
});

// ======================================================
// Change Password Handler
// ======================================================
async function handleChangePassword(req, res) {
  try {
    const { newPassword } = req.body;

    if (!newPassword || newPassword.trim() === '') {
      return res.status(400).json({ error: 'Please enter a new password' });
    }

    const trimmedPassword = newPassword.trim();
    if (trimmedPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const userId = req.user.id;
    const username = req.user.username;

    if (!userId && !username) {
      return res.status(401).json({ error: 'Invalid authenticated user' });
    }

    const pool = getPool();

    // Generate bcrypt hash for the new password
    const passwordHash = await bcrypt.hash(trimmedPassword, 10);

    // Update password in database users table (handles both 'password' and 'password_hash' columns)
    let updated = false;
    try {
      const [res1] = await pool.query(
        'UPDATE users SET password = ? WHERE id = ? OR username = ?',
        [passwordHash, userId, username]
      );
      if (res1 && res1.affectedRows > 0) updated = true;
    } catch (e) {
      // Ignore if column doesn't exist
    }

    if (!updated) {
      try {
        const [res2] = await pool.query(
          'UPDATE users SET password_hash = ? WHERE id = ? OR username = ?',
          [passwordHash, userId, username]
        );
        if (res2 && res2.affectedRows > 0) updated = true;
      } catch (e) {
        // Ignore
      }
    }

    const tokenPayload = {
      id: userId,
      username: username,
      full_name: req.user.full_name || null,
    };

    const token = jwt.sign(tokenPayload, getSecret(), { expiresIn: '14d' });

    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      maxAge: 14 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      message: 'Password updated successfully!',
      user: tokenPayload,
      token,
    });

  } catch (err) {
    console.error('Change password error:', err);
    return res.status(500).json({ error: 'Failed to update password' });
  }
}

router.put('/change-credentials', requireAuth, handleChangePassword);
router.post('/change-credentials', requireAuth, handleChangePassword);
router.put('/change-password', requireAuth, handleChangePassword);
router.post('/change-password', requireAuth, handleChangePassword);

module.exports = router;