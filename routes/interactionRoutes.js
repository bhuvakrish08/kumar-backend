const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');

// GET /api/v1/interactions - List interactions strictly for authenticated user (newest first)
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT i.*, CONCAT_WS(' ', c.first_name, c.last_name) AS contact_name
       FROM interactions i
       JOIN contacts c ON c.id = i.contact_id
       WHERE c.owner_user_id = ?
       ORDER BY i.occurred_at DESC, i.id DESC LIMIT 500`,
      [userId]
    );
    return res.json(rows);
  } catch (err) {
    console.error('List interactions error:', err);
    return res.status(500).json({ error: 'Failed to fetch interactions' });
  }
});

// PUT /api/v1/interactions/:id - Edit an existing interaction (IDOR Protected)
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Invalid interaction ID' });
    }

    const { interaction_type, occurred_at, subject, details, follow_up_date, follow_up_status } = req.body;
    const pool = getPool();

    // Verify interaction belongs to the authenticated user's contact
    const [existing] = await pool.query(
      `SELECT i.id FROM interactions i
       JOIN contacts c ON c.id = i.contact_id
       WHERE i.id = ? AND c.owner_user_id = ?
       LIMIT 1`,
      [id, userId]
    );

    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: 'Interaction not found' });
    }

    let validFollowUpDate = null;
    if (follow_up_date) {
      const d = new Date(follow_up_date);
      if (!isNaN(d.getTime())) validFollowUpDate = d;
    }

    let validOccurredAt = new Date();
    if (occurred_at) {
      const d = new Date(occurred_at);
      if (!isNaN(d.getTime())) validOccurredAt = d;
    }

    const validFollowUpStatus = ['pending', 'completed', 'cancelled', 'none'].includes(follow_up_status)
      ? follow_up_status
      : (validFollowUpDate ? 'pending' : 'none');

    const updateFields = {
      interaction_type: interaction_type || 'Note',
      occurred_at: validOccurredAt,
      subject: subject !== undefined ? (subject?.trim() || null) : undefined,
      details: details !== undefined ? (details?.trim() || null) : undefined,
      follow_up_date: validFollowUpDate,
      follow_up_status: validFollowUpStatus,
      updated_by: userId
    };

    // Remove undefined
    Object.keys(updateFields).forEach(k => updateFields[k] === undefined && delete updateFields[k]);

    await pool.query('UPDATE interactions SET ? WHERE id = ?', [updateFields, id]);

    return res.json({ id, message: 'Interaction updated successfully' });
  } catch (err) {
    console.error('Update interaction error:', err);
    return res.status(500).json({ error: 'Failed to update interaction' });
  }
});

// DELETE /api/v1/interactions/:id - Delete Interaction (IDOR Protected)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Invalid interaction ID' });
    }

    const pool = getPool();
    // Verify interaction belongs to authenticated user's contact
    const [existing] = await pool.query(
      `SELECT i.id FROM interactions i
       JOIN contacts c ON c.id = i.contact_id
       WHERE i.id = ? AND c.owner_user_id = ?
       LIMIT 1`,
      [id, userId]
    );

    if (!existing || existing.length === 0) {
      return res.status(404).json({ error: 'Interaction not found' });
    }

    await pool.query('DELETE FROM interactions WHERE id = ?', [id]);
    return res.json({ message: 'Interaction removed successfully' });
  } catch (err) {
    console.error('Delete interaction error:', err);
    return res.status(500).json({ error: 'Failed to delete interaction' });
  }
});

module.exports = router;
