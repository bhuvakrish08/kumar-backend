const allowedFields = [
  'first_name', 'middle_name', 'last_name', 'nickname', 'company_name', 'job_title',
  'primary_email', 'primary_phone', 'mobile_phone', 'birthday', 'spouse_name',
  'introduced_by_name', 'introduced_by_contact_id', 'met_context', 'met_place', 'met_date',
  'how_we_met_notes', 'work_address1', 'work_address2', 'work_city', 'work_state',
  'work_postal_code', 'work_country', 'interests', 'personal_notes',
  'narrative_override', 'photo_url'
];

function clean(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function contactValues(body) {
  const out = {};
  for (const f of allowedFields) {
    if (f === 'introduced_by_contact_id') {
      const val = clean(body[f]);
      if (!val || val === 'none' || isNaN(Number(val))) {
        out[f] = null;
      } else {
        out[f] = Number(val);
      }
    } else {
      out[f] = clean(body[f]);
    }
  }
  if (!out.first_name) {
    throw new Error('First name is required');
  }
  return out;
}

function sourceNames(body) {
  let list = [];
  if (Array.isArray(body.sources)) {
    list = body.sources;
  } else if (typeof body.sources === 'string') {
    list = body.sources.split(',');
  }

  const seen = new Set();
  const result = [];
  for (const item of list) {
    const trimmed = String(item || '').trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(trimmed);
    }
  }
  return result.slice(0, 100);
}

async function replaceSources(conn, contactId, names, userId) {
  if (!userId) {
    throw new Error('User ID is required to associate sources');
  }

  await conn.query('DELETE FROM contact_sources WHERE contact_id = ?', [contactId]);

  for (const name of names) {
    // 1. Look for existing source belonging to this user (case-insensitive)
    const [existing] = await conn.query(
      'SELECT id FROM sources WHERE created_by = ? AND LOWER(name) = LOWER(?) LIMIT 1',
      [userId, name]
    );

    let sourceId;
    if (existing && existing.length > 0) {
      sourceId = existing[0].id;
    } else {
      const [ins] = await conn.query(
        'INSERT INTO sources (name, created_by) VALUES (?, ?)',
        [name, userId]
      );
      sourceId = ins.insertId;
    }

    if (sourceId) {
      await conn.query(
        'INSERT IGNORE INTO contact_sources (contact_id, source_id) VALUES (?, ?)',
        [contactId, sourceId]
      );
    }
  }
}

module.exports = {
  contactValues,
  sourceNames,
  replaceSources
};
