const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');

// GET /api/v1/sources - List all distinct SOURCE entities strictly for the authenticated user
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT s.id, s.name, COUNT(DISTINCT c.id) AS contact_count
       FROM sources s
       LEFT JOIN contact_sources cs ON cs.source_id = s.id
       LEFT JOIN contacts c ON c.id = cs.contact_id AND c.created_by = ?
       WHERE s.created_by = ?
       GROUP BY s.id, s.name
       ORDER BY s.name ASC`,
      [userId, userId]
    );
    return res.json(rows);
  } catch (err) {
    console.error('List sources error:', err);
    return res.status(500).json({ error: 'Failed to fetch sources' });
  }
});

// GET /api/v1/sources/:name - Get user's contacts associated with a specific SOURCE tag
router.get('/:name', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const sourceName = req.params.name.trim();
    const pool = getPool();

    const [contacts] = await pool.query(
      `SELECT c.*,
        GROUP_CONCAT(DISTINCT s.name ORDER BY s.name SEPARATOR ', ') AS source_names,
        (SELECT MAX(i.occurred_at) FROM interactions i WHERE i.contact_id = c.id AND i.created_by = ?) AS last_contact
       FROM contacts c
       JOIN contact_sources cs ON cs.contact_id = c.id
       JOIN sources target_s ON target_s.id = cs.source_id AND target_s.created_by = ?
       LEFT JOIN contact_sources cs_all ON cs_all.contact_id = c.id
       LEFT JOIN sources s ON s.id = cs_all.source_id AND s.created_by = ?
       WHERE target_s.name = ? AND c.created_by = ?
       GROUP BY c.id
       ORDER BY c.last_name, c.first_name`,
      [userId, userId, userId, sourceName, userId]
    );

    return res.json({
      source: sourceName,
      count: contacts.length,
      contacts
    });
  } catch (err) {
    console.error('Get source contacts error:', err);
    return res.status(500).json({ error: 'Failed to fetch contacts for source' });
  }
});

module.exports = router;
