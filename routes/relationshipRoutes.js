const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');

// GET /api/v1/relationships - List relationships strictly for authenticated user
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT r.*,
        CONCAT_WS(' ', c1.first_name, c1.last_name) AS contact_name,
        CONCAT_WS(' ', c2.first_name, c2.last_name) AS linked_contact_name
       FROM relationships r
       JOIN contacts c1 ON c1.id = r.contact_id AND c1.owner_user_id = ?
       LEFT JOIN contacts c2 ON c2.id = r.related_contact_id AND c2.owner_user_id = ?
       ORDER BY r.created_at DESC LIMIT 500`,
      [userId, userId]
    );
    return res.json(rows);
  } catch (err) {
    console.error('List relationships error:', err);
    return res.status(500).json({ error: 'Failed to fetch relationships' });
  }
});

// DELETE /api/v1/relationships/:id - Delete relationship (IDOR Protected)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Invalid relationship ID' });
    }

    const pool = getPool();
    // Verify relationship belongs to authenticated user's contact
    const [existing] = await pool.query(
      `SELECT r.id FROM relationships r
       JOIN contacts c ON c.id = r.contact_id
       WHERE r.id = ? AND c.owner_user_id = ?
       LIMIT 1`,
      [id, userId]
    );

    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: 'Relationship not found' });
    }

    await pool.query('DELETE FROM relationships WHERE id = ?', [id]);
    return res.json({ message: 'Relationship removed successfully' });
  } catch (err) {
    console.error('Delete relationship error:', err);
    return res.status(500).json({ error: 'Failed to delete relationship' });
  }
});

module.exports = router;
