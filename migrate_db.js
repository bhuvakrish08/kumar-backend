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

  // 7. Ensure users table columns exist for registration (email, mobile_no, name, full_name)
  try {
    const [colsEmail] = await pool.query("SHOW COLUMNS FROM users LIKE 'email'");
    if (colsEmail.length === 0) {
      await pool.query('ALTER TABLE users ADD COLUMN email varchar(255) DEFAULT NULL');
      console.log('Added email column to users.');
    }

    const [colsMobile] = await pool.query("SHOW COLUMNS FROM users LIKE 'mobile_no'");
    if (colsMobile.length === 0) {
      await pool.query('ALTER TABLE users ADD COLUMN mobile_no varchar(50) DEFAULT NULL');
      console.log('Added mobile_no column to users.');
    }

    const [colsName] = await pool.query("SHOW COLUMNS FROM users LIKE 'name'");
    if (colsName.length === 0) {
      await pool.query('ALTER TABLE users ADD COLUMN name varchar(255) DEFAULT NULL');
      console.log('Added name column to users.');
    }

    const [colsFullName] = await pool.query("SHOW COLUMNS FROM users LIKE 'full_name'");
    if (colsFullName.length === 0) {
      await pool.query('ALTER TABLE users ADD COLUMN full_name varchar(255) DEFAULT NULL');
      console.log('Added full_name column to users.');
    }
  } catch (e) {
    console.error('Error updating users columns:', e.message);
  }

  // 8. Add owner_user_id to contacts if not exists, backfill safely, add FK & index
  try {
    const [colsOwner] = await pool.query("SHOW COLUMNS FROM contacts LIKE 'owner_user_id'");
    if (colsOwner.length === 0) {
      await pool.query('ALTER TABLE contacts ADD COLUMN owner_user_id bigint(20) UNSIGNED DEFAULT NULL AFTER photo_url');
      await pool.query('UPDATE contacts SET owner_user_id = COALESCE(created_by, 2) WHERE owner_user_id IS NULL');
      await pool.query('ALTER TABLE contacts MODIFY COLUMN owner_user_id bigint(20) UNSIGNED NOT NULL');
      try {
        await pool.query('ALTER TABLE contacts ADD KEY idx_contacts_owner (owner_user_id)');
        await pool.query('ALTER TABLE contacts ADD CONSTRAINT fk_contacts_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE');
        console.log('Added owner_user_id column, index, and FK constraint to contacts.');
      } catch (err) {
        console.log('Note on contacts owner_user_id constraint:', err.message);
      }
    } else {
      console.log('contacts.owner_user_id already exists.');
    }
  } catch (e) {
    console.error('Error adding contacts.owner_user_id:', e.message);
  }

  // 9. Add owner_user_id to sources if not exists, backfill safely, update uq_user_source index
  try {
    const [colsSrcOwner] = await pool.query("SHOW COLUMNS FROM sources LIKE 'owner_user_id'");
    if (colsSrcOwner.length === 0) {
      await pool.query('ALTER TABLE sources ADD COLUMN owner_user_id bigint(20) UNSIGNED DEFAULT NULL AFTER created_by');
      await pool.query('UPDATE sources SET owner_user_id = COALESCE(created_by, 2) WHERE owner_user_id IS NULL');
      await pool.query('ALTER TABLE sources MODIFY COLUMN owner_user_id bigint(20) UNSIGNED NOT NULL');
      try {
        const [indexes] = await pool.query('SHOW INDEX FROM sources');
        if (indexes.some(i => i.Key_name === 'uq_user_source')) {
          await pool.query('ALTER TABLE sources DROP INDEX uq_user_source');
        }
        await pool.query('ALTER TABLE sources ADD KEY idx_sources_owner (owner_user_id)');
        await pool.query('ALTER TABLE sources ADD UNIQUE KEY uq_user_source (owner_user_id, name)');
        await pool.query('ALTER TABLE sources ADD CONSTRAINT fk_sources_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE');
        console.log('Added owner_user_id column, updated uq_user_source, and added FK constraint to sources.');
      } catch (err) {
        console.log('Note on sources owner_user_id constraint:', err.message);
      }
    } else {
      console.log('sources.owner_user_id already exists.');
    }
  } catch (e) {
    console.error('Error adding sources.owner_user_id:', e.message);
  }

  console.log('Migration finished successfully!');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
