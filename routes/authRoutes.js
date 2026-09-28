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

// Helper function to ensure columns exist in users table
async function ensureUserColumnsExist(pool) {
  const columnsToAdd = [
    { col: 'username', spec: 'VARCHAR(255) DEFAULT NULL' },
    { col: 'email', spec: 'VARCHAR(255) DEFAULT NULL' },
    { col: 'mobile_no', spec: 'VARCHAR(50) DEFAULT NULL' },
    { col: 'full_name', spec: 'VARCHAR(255) DEFAULT NULL' },
    { col: 'name', spec: 'VARCHAR(255) DEFAULT NULL' },
    { col: 'password', spec: 'VARCHAR(255) DEFAULT NULL' },
    { col: 'password_hash', spec: 'VARCHAR(255) DEFAULT NULL' },
  ];

  for (const { col, spec } of columnsToAdd) {
    try {
      const [rows] = await pool.query(`SHOW COLUMNS FROM users LIKE '${col}'`);
      if (!rows || rows.length === 0) {
        await pool.query(`ALTER TABLE users ADD COLUMN ${col} ${spec}`);
      }
    } catch (e) {
      // Ignore if column check fails
    }
  }
}

// ======================================================
// POST /api/v1/auth/register
// ======================================================
router.post('/register', async (req, res) => {
  try {
    const { username, name, email, mobile, mobile_no, password } = req.body;
    const rawMobile = mobile_no || mobile || '';

    const trimmedUsername = (username || '').trim();
    const trimmedEmail = (email || '').trim().toLowerCase();
    const trimmedMobile = rawMobile.trim();
    const trimmedName = (name || trimmedUsername || trimmedEmail).trim();

    if (!trimmedUsername) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (!trimmedEmail) {
      return res.status(400).json({ error: 'Email address is required' });
    }
    if (!trimmedMobile) {
      return res.status(400).json({ error: 'Mobile number is required' });
    }
    if (!password || password.trim().length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters long' });
    }

    const pool = getPool();
    await ensureUserColumnsExist(pool);

    // Check if user with this username or email already exists
    const [existing] = await pool.query(
      'SELECT id, username, email FROM users WHERE username = ? OR email = ? LIMIT 1',
      [trimmedUsername, trimmedEmail]
    );

    if (existing && existing.length > 0) {
      if (existing[0].username === trimmedUsername) {
        return res.status(400).json({ error: 'A user with this username already exists' });
      }
      return res.status(400).json({ error: 'A user with this email address already exists' });
    }

    // Hash password with bcrypt
    const passwordHash = await bcrypt.hash(password.trim(), 10);

    // Insert new user into MySQL users table
    const [insertRes] = await pool.query(
      `INSERT INTO users (username, name, full_name, email, mobile_no, password, password_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [trimmedUsername, trimmedName, trimmedName, trimmedEmail, trimmedMobile, passwordHash, passwordHash]
    );

    const userId = insertRes.insertId;

    // Generate JWT Session Token
    const tokenPayload = {
      id: userId,
      username: trimmedUsername,
      full_name: trimmedName,
      email: trimmedEmail,
    };

    const token = jwt.sign(tokenPayload, getSecret(), { expiresIn: '14d' });

    // Store token in HTTP-Only Cookie
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? 'none' : 'lax',
      path: '/',
      maxAge: 14 * 24 * 60 * 60 * 1000,
    });

    return res.status(201).json({
      message: 'Registered and logged in successfully',
      user: tokenPayload,
    });

  } catch (err) {
    console.error('Registration error:', err);
    return res.status(500).json({ error: err.message || 'Server error during registration' });
  }
});

// ======================================================
// POST /api/v1/auth/login
// ======================================================
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username/Email and password are required' });
    }

    const trimmedUsername = username.trim();
    const pool = getPool();
    await ensureUserColumnsExist(pool);

    // Query user from MySQL users table by username OR email
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE username = ? OR email = ? LIMIT 1',
      [trimmedUsername, trimmedUsername.toLowerCase()]
    );

    if (!rows || rows.length === 0) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    const user = rows[0];
    const storedPassword = user.password || user.password_hash;

    if (!storedPassword) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    // Compare entered password with password in database (supports bcrypt hash, automatically upgrades plain text)
    let passwordMatched = false;
    let needsUpgradeToBcrypt = false;

    if (
      typeof storedPassword === 'string' &&
      (storedPassword.startsWith('$2a$') ||
       storedPassword.startsWith('$2b$') ||
       storedPassword.startsWith('$2y$'))
    ) {
      passwordMatched = await bcrypt.compare(password, storedPassword);
    } else {
      // Legacy plain text check
      passwordMatched = (password === storedPassword);
      if (passwordMatched) {
        needsUpgradeToBcrypt = true;
      }
    }

    if (!passwordMatched) {
      return res.status(401).json({ error: 'Incorrect username or password' });
    }

    // Automatically upgrade legacy plain text password to bcrypt
    if (needsUpgradeToBcrypt) {
      try {
        const upgradedHash = await bcrypt.hash(password, 10);
        await pool.query('UPDATE users SET password = ? WHERE id = ?', [upgradedHash, user.id]);
      } catch (err) {
        console.warn('Could not upgrade password hash:', err.message);
      }
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
      path: '/',
      maxAge: 14 * 24 * 60 * 60 * 1000,
    });

    // Secure response: do NOT return JWT token in JSON response
    return res.status(200).json({
      message: 'Logged in successfully',
      user: tokenPayload,
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
      path: '/',
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
      path: '/',
      maxAge: 14 * 24 * 60 * 60 * 1000,
    });

    return res.status(200).json({
      message: 'Password updated successfully!',
      user: tokenPayload,
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