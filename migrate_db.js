const { getPool } = require('./db');

async function migrate() {
  const pool = getPool();
  console.log('Starting migration...');

  // 1. Assign existing contacts to user 2 if created_by is null
  try {
    const [res] = await pool.query('UPDATE contacts SET created_by = 2 WHERE created_by IS NULL');
    console.log(`Updated ${res.affectedRows} contacts to user 2.`);
  } catch (e) {
    console.error('Error updating contacts created_by:', e.message);
  }

  // 2. Assign existing sources to user 2 if created_by is null
  try {
    const [res] = await pool.query('UPDATE sources SET created_by = 2 WHERE created_by IS NULL');
    console.log(`Updated ${res.affectedRows} sources to user 2.`);
  } catch (e) {
    console.error('Error updating sources created_by:', e.message);
  }

  // 3. Add introduced_by_contact_id to contacts if not exists
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM contacts LIKE 'introduced_by_contact_id'");
    if (cols.length === 0) {
      await pool.query('ALTER TABLE contacts ADD COLUMN introduced_by_contact_id bigint(20) UNSIGNED DEFAULT NULL AFTER introduced_by_name');
      console.log('Added introduced_by_contact_id column to contacts.');
      try {
        await pool.query('ALTER TABLE contacts ADD CONSTRAINT fk_contacts_introduced_by FOREIGN KEY (introduced_by_contact_id) REFERENCES contacts (id) ON DELETE SET NULL');
        console.log('Added fk_contacts_introduced_by constraint.');
      } catch (err) {
        console.log('Note on fk_contacts_introduced_by:', err.message);
      }
    } else {
      console.log('introduced_by_contact_id already exists.');
    }
  } catch (e) {
    console.error('Error adding introduced_by_contact_id:', e.message);
  }

  // 4. Add how_we_met_notes to contacts if not exists
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM contacts LIKE 'how_we_met_notes'");
    if (cols.length === 0) {
      await pool.query('ALTER TABLE contacts ADD COLUMN how_we_met_notes text DEFAULT NULL AFTER met_date');
      console.log('Added how_we_met_notes column to contacts.');
    } else {
      console.log('how_we_met_notes already exists.');
    }
  } catch (e) {
    console.error('Error adding how_we_met_notes:', e.message);
  }

  // 5. Add follow_up_date and follow_up_status to interactions if not exists
  try {
    const [colsDate] = await pool.query("SHOW COLUMNS FROM interactions LIKE 'follow_up_date'");
    if (colsDate.length === 0) {
      await pool.query('ALTER TABLE interactions ADD COLUMN follow_up_date date DEFAULT NULL AFTER details');
      console.log('Added follow_up_date column to interactions.');
    } else {
      console.log('follow_up_date already exists.');
    }

    const [colsStatus] = await pool.query("SHOW COLUMNS FROM interactions LIKE 'follow_up_status'");
    if (colsStatus.length === 0) {
      await pool.query("ALTER TABLE interactions ADD COLUMN follow_up_status varchar(50) NOT NULL DEFAULT 'none' AFTER follow_up_date");
      console.log('Added follow_up_status column to interactions.');
    } else {
      console.log('follow_up_status already exists.');
    }
  } catch (e) {
    console.error('Error updating interactions columns:', e.message);
  }

  // 6. Update sources unique constraint: replace global uq_source_name with uq_user_source (created_by, name)
  try {
    const [indexes] = await pool.query('SHOW INDEX FROM sources');
    const hasGlobalUq = indexes.some(i => i.Key_name === 'uq_source_name');
    const hasUserUq = indexes.some(i => i.Key_name === 'uq_user_source');

    if (hasGlobalUq) {
      await pool.query('ALTER TABLE sources DROP INDEX uq_source_name');
      console.log('Dropped global uq_source_name from sources.');
    }
    if (!hasUserUq) {
      await pool.query('ALTER TABLE sources ADD UNIQUE KEY uq_user_source (created_by, name)');
      console.log('Added unique index uq_user_source on (created_by, name).');
    }
  } catch (e) {
    console.error('Error updating sources indexes:', e.message);
  }

  console.log('Migration finished successfully!');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
