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
       WHERE (s.created_by = ? OR s.created_by IS NULL)
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
       JOIN sources target_s ON target_s.id = cs.source_id AND (target_s.created_by = ? OR target_s.created_by IS NULL)
       LEFT JOIN contact_sources cs_all ON cs_all.contact_id = c.id
       LEFT JOIN sources s ON s.id = cs_all.source_id AND (s.created_by = ? OR s.created_by IS NULL)
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

// POST /api/v1/sources - Create a new SOURCE tag
router.post('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { name } = req.body;
    const trimmedName = (name || '').trim();

    if (!trimmedName) {
      return res.status(400).json({ error: 'Source tag name is required' });
    }

    const pool = getPool();

    // Check if source already exists for this user (case-insensitive)
    const [existing] = await pool.query(
      'SELECT id, name FROM sources WHERE (created_by = ? OR created_by IS NULL) AND LOWER(name) = LOWER(?) LIMIT 1',
      [userId, trimmedName]
    );

    if (existing && existing.length > 0) {
      return res.status(400).json({ error: `Source tag "${existing[0].name}" already exists` });
    }

    const [result] = await pool.query(
      'INSERT INTO sources (name, created_by) VALUES (?, ?)',
      [trimmedName, userId]
    );

    return res.status(201).json({
      id: result.insertId,
      name: trimmedName,
      contact_count: 0
    });
  } catch (err) {
    console.error('Create source error:', err);
    return res.status(500).json({ error: 'Failed to create source tag' });
  }
});

// PUT /api/v1/sources/:id - Rename an existing SOURCE tag
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const sourceId = Number(req.params.id);
    const { name } = req.body;
    const trimmedName = (name || '').trim();

    if (!sourceId || isNaN(sourceId)) {
      return res.status(400).json({ error: 'Invalid source ID' });
    }

    if (!trimmedName) {
      return res.status(400).json({ error: 'Source tag name is required' });
    }

    const pool = getPool();

    // Verify source exists
    const [sourceRows] = await pool.query(
      'SELECT id, name FROM sources WHERE id = ? AND (created_by = ? OR created_by IS NULL) LIMIT 1',
      [sourceId, userId]
    );

    if (!sourceRows || sourceRows.length === 0) {
      return res.status(404).json({ error: 'Source tag not found' });
    }

    // Check for name collision with another source of the same user
    const [duplicate] = await pool.query(
      'SELECT id FROM sources WHERE (created_by = ? OR created_by IS NULL) AND LOWER(name) = LOWER(?) AND id != ? LIMIT 1',
      [userId, trimmedName, sourceId]
    );

    if (duplicate && duplicate.length > 0) {
      return res.status(400).json({ error: `Another source tag named "${trimmedName}" already exists` });
    }

    await pool.query(
      'UPDATE sources SET name = ?, created_by = ? WHERE id = ? AND (created_by = ? OR created_by IS NULL)',
      [trimmedName, userId, sourceId, userId]
    );

    return res.json({
      id: sourceId,
      name: trimmedName,
      message: 'Source tag updated successfully'
    });
  } catch (err) {
    console.error('Update source error:', err);
    return res.status(500).json({ error: 'Failed to update source tag' });
  }
});

// DELETE /api/v1/sources/:id - Delete a SOURCE tag and detach from contacts
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const sourceId = Number(req.params.id);

    if (!sourceId || isNaN(sourceId)) {
      return res.status(400).json({ error: 'Invalid source ID' });
    }

    const pool = getPool();

    // Verify ownership or accessibility
    const [sourceRows] = await pool.query(
      'SELECT id, name FROM sources WHERE id = ? AND (created_by = ? OR created_by IS NULL) LIMIT 1',
      [sourceId, userId]
    );

    if (!sourceRows || sourceRows.length === 0) {
      return res.status(404).json({ error: 'Source tag not found' });
    }

    // Delete mapping in contact_sources
    await pool.query('DELETE FROM contact_sources WHERE source_id = ?', [sourceId]);

    // Delete from sources table
    await pool.query('DELETE FROM sources WHERE id = ? AND (created_by = ? OR created_by IS NULL)', [sourceId, userId]);

    return res.json({ message: 'Source tag deleted successfully', id: sourceId });
  } catch (err) {
    console.error('Delete source error:', err);
    return res.status(500).json({ error: 'Failed to delete source tag' });
  }
});

module.exports = router;

