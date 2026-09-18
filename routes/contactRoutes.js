const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { buildNarrative } = require('../lib/narrative');
const { contactValues, sourceNames, replaceSources } = require('../lib/save-contact');

// Helper to get sources for a contact
async function getSources(pool, contactId) {
  const [rows] = await pool.query(
    `SELECT s.id, s.name FROM sources s
     JOIN contact_sources cs ON cs.source_id = s.id
     WHERE cs.contact_id = ? ORDER BY s.name`,
    [contactId]
  );
  return rows;
}

// GET /api/v1/contacts - List & Search
router.get('/', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const sourceFilter = (req.query.source || '').trim();
    const pool = getPool();

    let query = `
      SELECT c.*,
        GROUP_CONCAT(DISTINCT s.name ORDER BY s.name SEPARATOR ', ') AS source_names,
        (SELECT MAX(i.occurred_at) FROM interactions i WHERE i.contact_id = c.id) AS last_contact
      FROM contacts c
      LEFT JOIN contact_sources cs ON cs.contact_id = c.id
      LEFT JOIN sources s ON s.id = cs.source_id
    `;
    const params = [];
    const whereClauses = [];

    if (q) {
      const like = `%${q}%`;
      whereClauses.push(`(
        CONCAT_WS(' ', c.first_name, c.middle_name, c.last_name, c.nickname, c.company_name, c.job_title,
          c.primary_email, c.primary_phone, c.mobile_phone, c.spouse_name, c.introduced_by_name,
          c.met_context, c.met_place, c.work_city, c.work_state, c.work_country, c.interests, c.personal_notes) LIKE ?
        OR s.name LIKE ?
      )`);
      params.push(like, like);
    }

    if (sourceFilter) {
      whereClauses.push(`s.name = ?`);
      params.push(sourceFilter);
    }

    if (whereClauses.length) {
      query += ` WHERE ` + whereClauses.join(' AND ');
    }

    query += ` GROUP BY c.id ORDER BY c.last_name, c.first_name LIMIT 500`;

    const [rows] = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('List contacts error:', err);
    return res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// GET /api/v1/contacts/:id - Contact Details with Server-Side Narrative
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Invalid contact ID' });
    }

    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM contacts WHERE id = ? LIMIT 1', [id]);
    const contact = rows[0];

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const [sources, interactions, relationships] = await Promise.all([
      getSources(pool, id),
      pool.query('SELECT * FROM interactions WHERE contact_id = ? ORDER BY occurred_at DESC, id DESC', [id]).then(([r]) => r),
      pool.query(
        `SELECT r.*, CONCAT_WS(' ', c.first_name, c.last_name) AS linked_name
         FROM relationships r LEFT JOIN contacts c ON c.id = r.related_contact_id
         WHERE r.contact_id = ? ORDER BY r.relationship_type, r.id`,
        [id]
      ).then(([r]) => r)
    ]);

    // Narrative Engine strictly on backend
    const narrative = contact.narrative_override?.trim() || buildNarrative(contact);

    return res.json({
      contact,
      sources,
      interactions,
      relationships,
      narrative
    });
  } catch (err) {
    console.error('Get contact error:', err);
    return res.status(500).json({ error: 'Failed to fetch contact details' });
  }
});

// POST /api/v1/contacts - Create Contact
router.post('/', requireAuth, async (req, res) => {
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const data = contactValues(req.body);
    data.created_by = req.user?.id || null;
    data.updated_by = req.user?.id || null;

    const [result] = await conn.query('INSERT INTO contacts SET ?', [data]);
    const contactId = result.insertId;

    const names = sourceNames(req.body);
    if (names.length) {
      await replaceSources(conn, contactId, names, req.user?.id);
    }

    await conn.commit();
    return res.status(201).json({ id: contactId, message: 'Contact created successfully' });
  } catch (err) {
    await conn.rollback();
    console.error('Create contact error:', err);
    return res.status(400).json({ error: err.message || 'Failed to create contact' });
  } finally {
    conn.release();
  }
});

// PUT /api/v1/contacts/:id - Update Contact
router.put('/:id', requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid contact ID' });
  }

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const data = contactValues(req.body);
    data.updated_by = req.user?.id || null;

    await conn.query('UPDATE contacts SET ? WHERE id = ?', [data, id]);

    const names = sourceNames(req.body);
    await replaceSources(conn, id, names, req.user?.id);

    await conn.commit();
    return res.json({ id, message: 'Contact updated successfully' });
  } catch (err) {
    await conn.rollback();
    console.error('Update contact error:', err);
    return res.status(400).json({ error: err.message || 'Failed to update contact' });
  } finally {
    conn.release();
  }
});

// DELETE /api/v1/contacts/:id - Delete Contact
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid contact ID' });

    const pool = getPool();
    await pool.query('DELETE FROM contacts WHERE id = ?', [id]);
    return res.json({ message: 'Contact deleted successfully' });
  } catch (err) {
    console.error('Delete contact error:', err);
    return res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// POST /api/v1/contacts/:id/interactions - Add Interaction
router.post('/:id/interactions', requireAuth, async (req, res) => {
  try {
    const contactId = Number(req.params.id);
    const { interaction_type, occurred_at, subject, details } = req.body;

    if (!contactId || isNaN(contactId)) {
      return res.status(400).json({ error: 'Invalid contact ID' });
    }

    const pool = getPool();
    const dateVal = occurred_at ? new Date(occurred_at) : new Date();

    const [result] = await pool.query(
      `INSERT INTO interactions (contact_id, interaction_type, occurred_at, subject, details, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        interaction_type || 'Note',
        dateVal,
        subject || null,
        details || null,
        req.user?.id || null,
        req.user?.id || null
      ]
    );

    return res.status(201).json({ id: result.insertId, message: 'Interaction added successfully' });
  } catch (err) {
    console.error('Add interaction error:', err);
    return res.status(500).json({ error: 'Failed to add interaction' });
  }
});

// POST /api/v1/contacts/:id/relationships - Add Relationship
router.post('/:id/relationships', requireAuth, async (req, res) => {
  try {
    const contactId = Number(req.params.id);
    const { relationship_type, related_name, related_contact_id, notes } = req.body;

    if (!contactId || isNaN(contactId)) {
      return res.status(400).json({ error: 'Invalid contact ID' });
    }
    if (!relationship_type || !related_name) {
      return res.status(400).json({ error: 'Relationship type and related name are required' });
    }

    const pool = getPool();
    const [result] = await pool.query(
      `INSERT INTO relationships (contact_id, related_contact_id, related_name, relationship_type, notes, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        related_contact_id || null,
        related_name,
        relationship_type,
        notes || null,
        req.user?.id || null,
        req.user?.id || null
      ]
    );

    return res.status(201).json({ id: result.insertId, message: 'Relationship added successfully' });
  } catch (err) {
    console.error('Add relationship error:', err);
    return res.status(500).json({ error: 'Failed to add relationship' });
  }
});

module.exports = router;
