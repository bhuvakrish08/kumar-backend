const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { buildNarrative } = require('../lib/narrative');
const { contactValues, sourceNames, replaceSources } = require('../lib/save-contact');

// Helper to get sources for a contact strictly belonging to this user
async function getContactSources(pool, contactId, userId) {
  const [rows] = await pool.query(
    `SELECT s.id, s.name FROM sources s
     JOIN contact_sources cs ON cs.source_id = s.id
     WHERE cs.contact_id = ? AND s.owner_user_id = ?
     ORDER BY s.name`,
    [contactId, userId]
  );
  return rows;
}

// GET /api/v1/contacts - List & Search (Strictly scoped to authenticated user)
router.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const q = (req.query.q || '').trim();
    const sourceFilter = (req.query.source || '').trim();
    const pool = getPool();

    let query = `
      SELECT c.*,
        GROUP_CONCAT(DISTINCT s.name ORDER BY s.name SEPARATOR ', ') AS source_names,
        (SELECT MAX(i.occurred_at) FROM interactions i JOIN contacts c_int ON c_int.id = i.contact_id WHERE i.contact_id = c.id AND c_int.owner_user_id = ?) AS last_contact
      FROM contacts c
      LEFT JOIN contact_sources cs ON cs.contact_id = c.id
      LEFT JOIN sources s ON s.id = cs.source_id AND s.owner_user_id = ?
    `;

    const params = [userId, userId];
    const whereClauses = ['c.owner_user_id = ?'];
    params.push(userId);

    if (q) {
      const like = `%${q}%`;
      whereClauses.push(`(
        CONCAT_WS(' ', c.first_name, c.middle_name, c.last_name, c.nickname, c.company_name, c.job_title,
          c.primary_email, c.primary_phone, c.mobile_phone, c.spouse_name, c.introduced_by_name,
          c.met_context, c.met_place, c.how_we_met_notes, c.work_city, c.work_state, c.work_country,
          c.interests, c.personal_notes) LIKE ?
        OR s.name LIKE ?
      )`);
      params.push(like, like);
    }

    if (sourceFilter) {
      whereClauses.push(`s.name = ?`);
      params.push(sourceFilter);
    }

    query += ` WHERE ` + whereClauses.join(' AND ');
    query += ` GROUP BY c.id ORDER BY c.last_name, c.first_name LIMIT 500`;

    const [rows] = await pool.query(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('List contacts error:', err);
    return res.status(500).json({ error: 'Failed to fetch contacts' });
  }
});

// GET /api/v1/contacts/:id - Contact Details with Deterministic Narrative (IDOR Protected)
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = Number(req.params.id);
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Invalid contact ID' });
    }

    const pool = getPool();
    // Strictly filter by ID AND owner_user_id to prevent IDOR
    const [rows] = await pool.query(
      'SELECT * FROM contacts WHERE id = ? AND owner_user_id = ? LIMIT 1',
      [id, userId]
    );
    const contact = rows[0];

    if (!contact) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const [sources, interactions, relationships, introducerRows] = await Promise.all([
      getContactSources(pool, id, userId),
      pool.query(
        `SELECT i.* FROM interactions i
         JOIN contacts c ON c.id = i.contact_id
         WHERE i.contact_id = ? AND c.owner_user_id = ?
         ORDER BY i.occurred_at DESC, i.id DESC`,
        [id, userId]
      ).then(([r]) => r),
      pool.query(
        `SELECT r.*, CONCAT_WS(' ', c.first_name, c.last_name) AS linked_name
         FROM relationships r
         JOIN contacts c1 ON c1.id = r.contact_id AND c1.owner_user_id = ?
         LEFT JOIN contacts c ON c.id = r.related_contact_id AND c.owner_user_id = ?
         WHERE r.contact_id = ?
         ORDER BY r.relationship_type, r.id`,
        [userId, userId, id]
      ).then(([r]) => r),
      contact.introduced_by_contact_id
        ? pool.query(
            'SELECT id, first_name, last_name, company_name FROM contacts WHERE id = ? AND owner_user_id = ? LIMIT 1',
            [contact.introduced_by_contact_id, userId]
          ).then(([r]) => r)
        : Promise.resolve([])
    ]);

    const introduced_by_contact = introducerRows.length > 0 ? introducerRows[0] : null;

    // Narrative Summary Engine: uses contact details, how they know each other, SOURCE tags, relationships, interactions
    const narrative = contact.narrative_override?.trim() || buildNarrative(contact, sources, relationships, interactions);

    return res.json({
      contact,
      sources,
      interactions,
      relationships,
      introduced_by_contact,
      narrative
    });
  } catch (err) {
    console.error('Get contact error:', err);
    return res.status(500).json({ error: 'Failed to fetch contact details' });
  }
});

// POST /api/v1/contacts - Create Contact (Strictly user-scoped)
router.post('/', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const data = contactValues(req.body);
    data.owner_user_id = userId; // Derived strictly from authenticated session
    data.created_by = userId;
    data.updated_by = userId;

    // If introduced_by_contact_id is set, verify that it belongs to this user
    if (data.introduced_by_contact_id) {
      const [introRows] = await conn.query(
        'SELECT id, first_name, last_name FROM contacts WHERE id = ? AND owner_user_id = ? LIMIT 1',
        [data.introduced_by_contact_id, userId]
      );
      if (introRows.length === 0) {
        data.introduced_by_contact_id = null;
      } else if (!data.introduced_by_name) {
        data.introduced_by_name = [introRows[0].first_name, introRows[0].last_name].filter(Boolean).join(' ');
      }
    }

    const [result] = await conn.query('INSERT INTO contacts SET ?', [data]);
    const contactId = result.insertId;

    const names = sourceNames(req.body);
    if (names.length) {
      await replaceSources(conn, contactId, names, userId);
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

// PUT /api/v1/contacts/:id - Update Contact (IDOR Protected)
router.put('/:id', requireAuth, async (req, res) => {
  const userId = req.user.id;
  const id = Number(req.params.id);
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: 'Invalid contact ID' });
  }

  const pool = getPool();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Verify contact belongs to authenticated user
    const [existing] = await conn.query(
      'SELECT id FROM contacts WHERE id = ? AND owner_user_id = ? LIMIT 1',
      [id, userId]
    );
    if (!existing || existing.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: 'Contact not found' });
    }

    const data = contactValues(req.body);
    data.owner_user_id = userId; // Always derived from authenticated session
    data.updated_by = userId;

    // Verify introduced_by_contact_id if provided
    if (data.introduced_by_contact_id) {
      if (data.introduced_by_contact_id === id) {
        data.introduced_by_contact_id = null; // Cannot introduce oneself
      } else {
        const [introRows] = await conn.query(
          'SELECT id, first_name, last_name FROM contacts WHERE id = ? AND owner_user_id = ? LIMIT 1',
          [data.introduced_by_contact_id, userId]
        );
        if (introRows.length === 0) {
          data.introduced_by_contact_id = null;
        } else if (!data.introduced_by_name) {
          data.introduced_by_name = [introRows[0].first_name, introRows[0].last_name].filter(Boolean).join(' ');
        }
      }
    }

    await conn.query('UPDATE contacts SET ? WHERE id = ? AND owner_user_id = ?', [data, id, userId]);

    const names = sourceNames(req.body);
    await replaceSources(conn, id, names, userId);

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

// DELETE /api/v1/contacts/:id - Delete Contact (IDOR Protected)
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const id = Number(req.params.id);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid contact ID' });

    const pool = getPool();
    const [result] = await pool.query('DELETE FROM contacts WHERE id = ? AND owner_user_id = ?', [id, userId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    return res.json({ message: 'Contact deleted successfully' });
  } catch (err) {
    console.error('Delete contact error:', err);
    return res.status(500).json({ error: 'Failed to delete contact' });
  }
});

// POST /api/v1/contacts/:id/interactions - Add Interaction (IDOR Protected)
router.post('/:id/interactions', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const contactId = Number(req.params.id);
    const { interaction_type, occurred_at, subject, details, follow_up_date, follow_up_status } = req.body;

    if (!contactId || isNaN(contactId)) {
      return res.status(400).json({ error: 'Invalid contact ID' });
    }

    const pool = getPool();
    // Verify contact belongs to user
    const [contacts] = await pool.query(
      'SELECT id FROM contacts WHERE id = ? AND owner_user_id = ? LIMIT 1',
      [contactId, userId]
    );
    if (!contacts || contacts.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const dateVal = occurred_at ? new Date(occurred_at) : new Date();
    const validFollowUpDate = follow_up_date ? new Date(follow_up_date) : null;
    const validFollowUpStatus = ['pending', 'completed', 'cancelled', 'none'].includes(follow_up_status)
      ? follow_up_status
      : (follow_up_date ? 'pending' : 'none');

    const [result] = await pool.query(
      `INSERT INTO interactions (
        contact_id, interaction_type, occurred_at, subject, details,
        follow_up_date, follow_up_status, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        interaction_type || 'Note',
        dateVal,
        subject?.trim() || null,
        details?.trim() || null,
        validFollowUpDate,
        validFollowUpStatus,
        userId,
        userId
      ]
    );

    return res.status(201).json({ id: result.insertId, message: 'Interaction added successfully' });
  } catch (err) {
    console.error('Add interaction error:', err);
    return res.status(500).json({ error: 'Failed to add interaction' });
  }
});

// POST /api/v1/contacts/:id/relationships - Add Relationship (Strictly Same-User Verified)
router.post('/:id/relationships', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const contactId = Number(req.params.id);
    const { relationship_type, related_name, related_contact_id, notes } = req.body;

    if (!contactId || isNaN(contactId)) {
      return res.status(400).json({ error: 'Invalid contact ID' });
    }
    if (!relationship_type || (!related_name && !related_contact_id)) {
      return res.status(400).json({ error: 'Relationship type and person name are required' });
    }

    const pool = getPool();
    // 1. Verify target contact belongs to authenticated user
    const [contacts] = await pool.query(
      'SELECT id FROM contacts WHERE id = ? AND owner_user_id = ? LIMIT 1',
      [contactId, userId]
    );
    if (!contacts || contacts.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    let linkedContactId = null;
    let finalRelatedName = related_name?.trim() || '';

    // 2. If connecting to an existing contact, VERIFY that it belongs to the SAME USER
    if (related_contact_id && Number(related_contact_id)) {
      const relId = Number(related_contact_id);
      if (relId === contactId) {
        return res.status(400).json({ error: 'Cannot connect a contact to itself' });
      }

      const [relRows] = await pool.query(
        'SELECT id, first_name, last_name FROM contacts WHERE id = ? AND owner_user_id = ? LIMIT 1',
        [relId, userId]
      );

      if (!relRows || relRows.length === 0) {
        return res.status(400).json({ error: 'Related contact must belong to your own account' });
      }

      linkedContactId = relId;
      if (!finalRelatedName) {
        finalRelatedName = [relRows[0].first_name, relRows[0].last_name].filter(Boolean).join(' ');
      }
    }

    const [result] = await pool.query(
      `INSERT INTO relationships (
        contact_id, related_contact_id, related_name, relationship_type,
        notes, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        linkedContactId,
        finalRelatedName,
        relationship_type.trim(),
        notes?.trim() || null,
        userId,
        userId
      ]
    );

    return res.status(201).json({ id: result.insertId, message: 'Relationship added successfully' });
  } catch (err) {
    console.error('Add relationship error:', err);
    return res.status(500).json({ error: 'Failed to add relationship' });
  }
});

module.exports = router;
