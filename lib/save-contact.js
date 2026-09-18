const allowedFields = [
  'first_name', 'middle_name', 'last_name', 'nickname', 'company_name', 'job_title',
  'primary_email', 'primary_phone', 'mobile_phone', 'birthday', 'spouse_name',
  'introduced_by_name', 'met_context', 'met_place', 'met_date', 'work_address1',
  'work_address2', 'work_city', 'work_state', 'work_postal_code', 'work_country',
  'interests', 'personal_notes', 'narrative_override', 'photo_url'
];

function clean(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

function contactValues(body) {
  const out = {};
  for (const f of allowedFields) {
    out[f] = clean(body[f]);
  }
  if (!out.first_name) {
    throw new Error('First name is required');
  }
  return out;
}

function sourceNames(body) {
  if (Array.isArray(body.sources)) {
    return body.sources.map(s => String(s).trim()).filter(Boolean);
  }
  return String(body.sources || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter((s, i, a) => a.findIndex(x => x.toLowerCase() === s.toLowerCase()) === i)
    .slice(0, 100);
}

async function replaceSources(conn, contactId, names, userId = null) {
  await conn.query('DELETE FROM contact_sources WHERE contact_id=?', [contactId]);
  for (const name of names) {
    await conn.query(
      'INSERT INTO sources (name, created_by) VALUES (?, ?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)',
      [name, userId]
    );
    const [rows] = await conn.query('SELECT id FROM sources WHERE name=? LIMIT 1', [name]);
    if (rows.length > 0) {
      await conn.query('INSERT IGNORE INTO contact_sources (contact_id, source_id) VALUES (?, ?)', [contactId, rows[0].id]);
    }
  }
}

module.exports = {
  contactValues,
  sourceNames,
  replaceSources
};
