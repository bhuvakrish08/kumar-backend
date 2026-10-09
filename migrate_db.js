const { getPool } = require('./db');

async function migrate() {
  const pool = getPool();
  console.log('Starting migration...');

  // 0. Retrieve verified Kumar production user ID for legacy records
  let kumarUserId = null;
  try {
    const [rows] = await pool.query("SELECT id FROM users WHERE username = 'kumar' LIMIT 1");
    if (rows.length > 0) {
      kumarUserId = rows[0].id;
      console.log(`Verified Kumar production user ID: ${kumarUserId}`);
    } else {
      console.warn('Warning: Production user "kumar" not found in users table.');
    }
  } catch (err) {
    console.error('Error querying Kumar user ID:', err.message);
  }

  // 1. Assign existing legacy contacts to verified Kumar production user if created_by is null
  try {
    const [unassigned] = await pool.query('SELECT id FROM contacts WHERE created_by IS NULL');
    if (unassigned.length > 0) {
      if (kumarUserId) {
        const [res] = await pool.query('UPDATE contacts SET created_by = ? WHERE created_by IS NULL', [kumarUserId]);
        console.log(`Updated ${res.affectedRows} legacy contacts to verified Kumar user (ID: ${kumarUserId}).`);
      } else {
        const ids = unassigned.map(r => r.id).join(', ');
        console.error(`Migration stopped: ${unassigned.length} contacts have unverified ownership (IDs: ${ids}).`);
        throw new Error(`Cannot verify ownership for contacts: ${ids}`);
      }
    }
  } catch (e) {
    console.error('Error updating contacts created_by:', e.message);
    throw e;
  }

  // 2. Assign existing legacy sources to verified Kumar production user if created_by is null
  try {
    const [unassigned] = await pool.query('SELECT id FROM sources WHERE created_by IS NULL');
    if (unassigned.length > 0) {
      if (kumarUserId) {
        const [res] = await pool.query('UPDATE sources SET created_by = ? WHERE created_by IS NULL', [kumarUserId]);
        console.log(`Updated ${res.affectedRows} legacy sources to verified Kumar user (ID: ${kumarUserId}).`);
      } else {
        const ids = unassigned.map(r => r.id).join(', ');
        console.error(`Migration stopped: ${unassigned.length} sources have unverified ownership (IDs: ${ids}).`);
        throw new Error(`Cannot verify ownership for sources: ${ids}`);
      }
    }
  } catch (e) {
    console.error('Error updating sources created_by:', e.message);
    throw e;
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
      // Backfill owner_user_id from created_by first
      await pool.query('UPDATE contacts SET owner_user_id = created_by WHERE owner_user_id IS NULL AND created_by IS NOT NULL');
      // Backfill legacy records without created_by using verified Kumar user ID if available
      if (kumarUserId) {
        await pool.query('UPDATE contacts SET owner_user_id = ? WHERE owner_user_id IS NULL', [kumarUserId]);
      }
      // Verify no contacts remain with unverified ownership
      const [unverified] = await pool.query('SELECT id FROM contacts WHERE owner_user_id IS NULL');
      if (unverified.length > 0) {
        const ids = unverified.map(r => r.id).join(', ');
        console.error(`Migration stopped: ${unverified.length} contacts have unverified ownership (IDs: ${ids}).`);
        throw new Error(`Unverified owner_user_id for contacts: ${ids}`);
      }

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
    throw e;
  }

  // 9. Add owner_user_id to sources if not exists, backfill safely, update uq_user_source index
  try {
    const [colsSrcOwner] = await pool.query("SHOW COLUMNS FROM sources LIKE 'owner_user_id'");
    if (colsSrcOwner.length === 0) {
      await pool.query('ALTER TABLE sources ADD COLUMN owner_user_id bigint(20) UNSIGNED DEFAULT NULL AFTER created_by');
      // Backfill owner_user_id from created_by first
      await pool.query('UPDATE sources SET owner_user_id = created_by WHERE owner_user_id IS NULL AND created_by IS NOT NULL');
      // Backfill legacy records without created_by using verified Kumar user ID if available
      if (kumarUserId) {
        await pool.query('UPDATE sources SET owner_user_id = ? WHERE owner_user_id IS NULL', [kumarUserId]);
      }
      // Verify no sources remain with unverified ownership
      const [unverified] = await pool.query('SELECT id FROM sources WHERE owner_user_id IS NULL');
      if (unverified.length > 0) {
        const ids = unverified.map(r => r.id).join(', ');
        console.error(`Migration stopped: ${unverified.length} sources have unverified ownership (IDs: ${ids}).`);
        throw new Error(`Unverified owner_user_id for sources: ${ids}`);
      }

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
    throw e;
  }

  // 10. Sprint 2: Create input_events table
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS input_events (
        id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
        owner_user_id bigint(20) UNSIGNED NOT NULL,
        input_type varchar(50) NOT NULL DEFAULT 'text',
        raw_content text NOT NULL,
        capture_time datetime DEFAULT CURRENT_TIMESTAMP,
        event_time_hint datetime DEFAULT NULL,
        processing_status varchar(50) NOT NULL DEFAULT 'PENDING',
        parser_version varchar(50) NOT NULL DEFAULT '1.0.0',
        created_at datetime DEFAULT CURRENT_TIMESTAMP,
        updated_at datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_input_events_owner (owner_user_id),
        CONSTRAINT fk_input_events_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('Verified input_events table exists.');
  } catch (e) {
    console.error('Error creating input_events table:', e.message);
  }

  // 11. Sprint 2: Create candidate_facts table
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS candidate_facts (
        id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
        owner_user_id bigint(20) UNSIGNED NOT NULL,
        input_event_id bigint(20) UNSIGNED NOT NULL,
        candidate_type varchar(100) NOT NULL,
        structured_payload json NOT NULL,
        confidence decimal(5,2) DEFAULT '0.00',
        status varchar(50) NOT NULL DEFAULT 'PENDING',
        conflict_state varchar(50) NOT NULL DEFAULT 'NONE',
        created_at datetime DEFAULT CURRENT_TIMESTAMP,
        updated_at datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_candidate_facts_owner (owner_user_id),
        KEY idx_candidate_facts_event (input_event_id),
        CONSTRAINT fk_candidate_facts_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_candidate_facts_event FOREIGN KEY (input_event_id) REFERENCES input_events (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('Verified candidate_facts table exists.');
  } catch (e) {
    console.error('Error creating candidate_facts table:', e.message);
  }

  // 12. Sprint 2: Create fact_provenance table
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS fact_provenance (
        id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
        owner_user_id bigint(20) UNSIGNED NOT NULL,
        input_event_id bigint(20) UNSIGNED NOT NULL,
        target_reference varchar(255) NOT NULL,
        fact_type varchar(100) NOT NULL,
        source_excerpt text DEFAULT NULL,
        confirmation_time datetime DEFAULT CURRENT_TIMESTAMP,
        created_at datetime DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_provenance_owner (owner_user_id),
        KEY idx_provenance_event (input_event_id),
        CONSTRAINT fk_provenance_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_provenance_event FOREIGN KEY (input_event_id) REFERENCES input_events (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('Verified fact_provenance table exists.');
  } catch (e) {
    console.error('Error creating fact_provenance table:', e.message);
  }

  // 13. Sprint 2: Create commitments table
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS commitments (
        id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
        owner_user_id bigint(20) UNSIGNED NOT NULL,
        contact_id bigint(20) UNSIGNED DEFAULT NULL,
        interaction_id bigint(20) UNSIGNED DEFAULT NULL,
        type varchar(50) NOT NULL DEFAULT 'follow_up',
        title varchar(255) NOT NULL,
        details text DEFAULT NULL,
        due_time datetime DEFAULT NULL,
        status varchar(50) NOT NULL DEFAULT 'OPEN',
        source_input_event_id bigint(20) UNSIGNED DEFAULT NULL,
        completion_time datetime DEFAULT NULL,
        created_at datetime DEFAULT CURRENT_TIMESTAMP,
        updated_at datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_commitments_owner (owner_user_id),
        KEY idx_commitments_contact (contact_id),
        KEY idx_commitments_event (source_input_event_id),
        CONSTRAINT fk_commitments_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_commitments_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE SET NULL,
        CONSTRAINT fk_commitments_event FOREIGN KEY (source_input_event_id) REFERENCES input_events (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('Verified commitments table exists.');
  } catch (e) {
    console.error('Error creating commitments table:', e.message);
  }

  // 14. Migration 003: Create contact_history table & alter fact_provenance
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contact_history (
        id bigint(20) UNSIGNED NOT NULL AUTO_INCREMENT,
        owner_user_id bigint(20) UNSIGNED NOT NULL,
        contact_id bigint(20) UNSIGNED NOT NULL,
        fact_type varchar(50) NOT NULL,
        value_payload json NOT NULL,
        valid_from datetime DEFAULT CURRENT_TIMESTAMP,
        valid_to datetime DEFAULT NULL,
        is_current tinyint(1) NOT NULL DEFAULT '1',
        confidence_status varchar(50) NOT NULL DEFAULT 'CONFIRMED',
        source_input_event_id bigint(20) UNSIGNED DEFAULT NULL,
        created_at datetime DEFAULT CURRENT_TIMESTAMP,
        updated_at datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_history_owner (owner_user_id),
        KEY idx_history_contact (contact_id),
        KEY idx_history_event (source_input_event_id),
        CONSTRAINT fk_history_owner FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT fk_history_contact FOREIGN KEY (contact_id) REFERENCES contacts (id) ON DELETE CASCADE,
        CONSTRAINT fk_history_event FOREIGN KEY (source_input_event_id) REFERENCES input_events (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    console.log('Verified contact_history table exists.');

    const [colsCandidate] = await pool.query("SHOW COLUMNS FROM fact_provenance LIKE 'candidate_fact_id'");
    if (colsCandidate.length === 0) {
      await pool.query(`
        ALTER TABLE fact_provenance
          ADD COLUMN candidate_fact_id bigint(20) UNSIGNED DEFAULT NULL AFTER input_event_id,
          ADD COLUMN target_type varchar(50) DEFAULT NULL AFTER candidate_fact_id,
          ADD COLUMN target_id bigint(20) UNSIGNED DEFAULT NULL AFTER target_type,
          ADD KEY idx_provenance_candidate (candidate_fact_id),
          ADD CONSTRAINT fk_provenance_candidate FOREIGN KEY (candidate_fact_id) REFERENCES candidate_facts (id) ON DELETE SET NULL
      `);
      console.log('Altered fact_provenance to include candidate_fact_id, target_type, and target_id.');

      // Safely backfill parseable legacy target_reference (e.g. contacts:123 -> target_type='contact', target_id=123)
      const [provRows] = await pool.query('SELECT id, target_reference FROM fact_provenance WHERE target_type IS NULL');
      for (const p of provRows) {
        if (p.target_reference && p.target_reference.includes(':')) {
          const parts = p.target_reference.split(':');
          const type = parts[0] === 'contacts' ? 'contact' : parts[0] === 'interactions' ? 'interaction' : parts[0];
          const idNum = parseInt(parts[1], 10);
          if (type && !isNaN(idNum)) {
            await pool.query('UPDATE fact_provenance SET target_type = ?, target_id = ? WHERE id = ?', [type, idNum, p.id]);
          }
        }
      }
      console.log('Backfilled parseable legacy fact_provenance target_reference values.');
    } else {
      console.log('fact_provenance candidate_fact_id already exists.');
    }

    // Safely backfill current contact facts into contact_history for existing contacts if missing
    const [existingContacts] = await pool.query('SELECT id, owner_user_id, company_name, primary_phone, mobile_phone, primary_email FROM contacts');
    for (const c of existingContacts) {
      if (c.company_name) {
        const [h] = await pool.query('SELECT id FROM contact_history WHERE contact_id = ? AND fact_type = "employment" LIMIT 1', [c.id]);
        if (h.length === 0) {
          await pool.query(
            'INSERT INTO contact_history (owner_user_id, contact_id, fact_type, value_payload, is_current, confidence_status) VALUES (?, ?, "employment", ?, 1, "CONFIRMED")',
            [c.owner_user_id, c.id, JSON.stringify({ company_name: c.company_name })]
          );
        }
      }
      const phoneVal = c.primary_phone || c.mobile_phone;
      if (phoneVal) {
        const [h] = await pool.query('SELECT id FROM contact_history WHERE contact_id = ? AND fact_type = "phone" LIMIT 1', [c.id]);
        if (h.length === 0) {
          await pool.query(
            'INSERT INTO contact_history (owner_user_id, contact_id, fact_type, value_payload, is_current, confidence_status) VALUES (?, ?, "phone", ?, 1, "CONFIRMED")',
            [c.owner_user_id, c.id, JSON.stringify({ phone: phoneVal })]
          );
        }
      }
      if (c.primary_email) {
        const [h] = await pool.query('SELECT id FROM contact_history WHERE contact_id = ? AND fact_type = "email" LIMIT 1', [c.id]);
        if (h.length === 0) {
          await pool.query(
            'INSERT INTO contact_history (owner_user_id, contact_id, fact_type, value_payload, is_current, confidence_status) VALUES (?, ?, "email", ?, 1, "CONFIRMED")',
            [c.owner_user_id, c.id, JSON.stringify({ email: c.primary_email })]
          );
        }
      }
    }
    console.log('Verified contact_history backfill complete.');

  } catch (e) {
    console.error('Error executing Migration 003:', e.message);
  }

  console.log('Migration finished successfully!');
  process.exit(0);
}

migrate().catch(err => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
