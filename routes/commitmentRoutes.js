const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');

/**
 * GET /api/v1/commitments
 * List commitments for authenticated user
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { contact_id, status } = req.query;
    const pool = getPool();

    let sql = `
      SELECT cm.*,
             c.first_name, c.last_name, c.company_name
      FROM commitments cm
      LEFT JOIN contacts c ON c.id = cm.contact_id AND c.owner_user_id = ?
      WHERE cm.owner_user_id = ?
    `;
    const params = [userId, userId];

    if (contact_id) {
      sql += ` AND cm.contact_id = ?`;
      params.push(contact_id);
    }

    if (status) {
      sql += ` AND cm.status = ?`;
      params.push(status);
    }

    sql += ` ORDER BY cm.due_time ASC, cm.created_at DESC`;

    const [rows] = await pool.query(sql, params);
    return res.json(rows);
  } catch (err) {
    console.error('Error fetching commitments:', err);
    return res.status(500).json({ error: 'Failed to fetch commitments' });
  }
});

/**
 * POST /api/v1/commitments
 * Create commitment manually
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { contact_id, type, title, details, due_time } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }

    const pool = getPool();

    if (contact_id) {
      // Validate contact ownership
      const [cRows] = await pool.query('SELECT id FROM contacts WHERE id = ? AND owner_user_id = ?', [contact_id, userId]);
      if (cRows.length === 0) {
        return res.status(404).json({ error: 'Contact not found or unauthorized' });
      }
    }

    const [result] = await pool.query(
      `INSERT INTO commitments (owner_user_id, contact_id, type, title, details, due_time, status)
       VALUES (?, ?, ?, ?, ?, ?, 'OPEN')`,
      [userId, contact_id || null, type || 'follow_up', title.trim(), details || null, due_time || null]
    );

    const [newRows] = await pool.query('SELECT * FROM commitments WHERE id = ? AND owner_user_id = ?', [result.insertId, userId]);
    return res.status(201).json(newRows[0]);
  } catch (err) {
    console.error('Error creating commitment:', err);
    return res.status(500).json({ error: 'Failed to create commitment' });
  }
});

/**
 * PATCH /api/v1/commitments/:id/complete
 * Mark commitment as COMPLETED
 */
router.patch('/:id/complete', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const commitmentId = req.params.id;
    const pool = getPool();

    const [rows] = await pool.query('SELECT * FROM commitments WHERE id = ? AND owner_user_id = ?', [commitmentId, userId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Commitment not found' });
    }

    const currentStatus = rows[0].status;
    const newStatus = currentStatus === 'COMPLETED' ? 'OPEN' : 'COMPLETED';
    const completionTime = newStatus === 'COMPLETED' ? new Date() : null;

    await pool.query(
      `UPDATE commitments SET status = ?, completion_time = ? WHERE id = ? AND owner_user_id = ?`,
      [newStatus, completionTime, commitmentId, userId]
    );

    const [updatedRows] = await pool.query('SELECT * FROM commitments WHERE id = ? AND owner_user_id = ?', [commitmentId, userId]);
    return res.json(updatedRows[0]);
  } catch (err) {
    console.error('Error completing commitment:', err);
    return res.status(500).json({ error: 'Failed to update commitment' });
  }
});

/**
 * DELETE /api/v1/commitments/:id
 * Delete commitment
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const commitmentId = req.params.id;
    const pool = getPool();

    const [rows] = await pool.query('SELECT id FROM commitments WHERE id = ? AND owner_user_id = ?', [commitmentId, userId]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Commitment not found' });
    }

    await pool.query('DELETE FROM commitments WHERE id = ? AND owner_user_id = ?', [commitmentId, userId]);
    return res.json({ success: true, message: 'Commitment deleted' });
  } catch (err) {
    console.error('Error deleting commitment:', err);
    return res.status(500).json({ error: 'Failed to delete commitment' });
  }
});

module.exports = router;
