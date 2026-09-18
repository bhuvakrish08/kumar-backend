const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');

// GET /api/v1/interactions - List interactions
router.get('/', requireAuth, async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT i.*, CONCAT_WS(' ', c.first_name, c.last_name) AS contact_name
       FROM interactions i
       JOIN contacts c ON c.id = i.contact_id
       ORDER BY i.occurred_at DESC LIMIT 500`
    );
    return res.json(rows);
  } catch (err) {
    console.error('List interactions error:', err);
    return res.status(500).json({ error: 'Failed to fetch interactions' });
  }
});

// DELETE /api/v1/interactions/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const pool = getPool();
    await pool.query('DELETE FROM interactions WHERE id = ?', [id]);
    return res.json({ message: 'Interaction removed successfully' });
  } catch (err) {
    console.error('Delete interaction error:', err);
    return res.status(500).json({ error: 'Failed to delete interaction' });
  }
});

module.exports = router;
