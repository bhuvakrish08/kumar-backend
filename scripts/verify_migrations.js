/**
 * Migration Smoke Test & Schema Integrity Verification Script
 * Verifies that all tables, columns, indexes, and constraints for
 * Migrations 001, 002, 003, and 004 are present and correctly configured.
 */

const { getPool } = require('../db');

async function verifyMigrations() {
  console.log('🔍 Starting Database Migration & Schema Integrity Smoke Test...\n');
  const pool = getPool();
  let errors = 0;

  async function checkColumn(table, column, description) {
    try {
      const [cols] = await pool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
      if (cols.length > 0) {
        console.log(`   ✅ [${table}.${column}] exists (${description})`);
      } else {
        console.error(`   ❌ MISSING: [${table}.${column}] (${description})`);
        errors++;
      }
    } catch (e) {
      console.error(`   ❌ Error checking [${table}.${column}]:`, e.message);
      errors++;
    }
  }

  async function checkIndex(table, indexName, description) {
    try {
      const [idx] = await pool.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [indexName]);
      if (idx.length > 0) {
        console.log(`   ✅ [Index: ${table}.${indexName}] exists (${description})`);
      } else {
        console.error(`   ❌ MISSING: [Index: ${table}.${indexName}] (${description})`);
        errors++;
      }
    } catch (e) {
      console.error(`   ❌ Error checking index [${table}.${indexName}]:`, e.message);
      errors++;
    }
  }

  console.log('1️⃣ Checking Migration 001 (Owner User ID & Tenant Isolation)...');
  await checkColumn('contacts', 'owner_user_id', 'Owner user isolation for contacts');
  await checkColumn('sources', 'owner_user_id', 'Owner user isolation for sources');

  console.log('\n2️⃣ Checking Migration 002 (Tell Dossier Tables & Commitments)...');
  await checkColumn('input_events', 'owner_user_id', 'Input events owner field');
  await checkColumn('candidate_facts', 'structured_payload', 'Candidate facts payload');
  await checkColumn('commitments', 'due_time', 'Commitment due date/time');
  await checkColumn('commitments', 'status', 'Commitment status (OPEN/COMPLETED)');

  console.log('\n3️⃣ Checking Migration 003 (Provenance & Contact History)...');
  await checkColumn('contact_history', 'value_payload', 'Historical fact value payload');
  await checkColumn('fact_provenance', 'candidate_fact_id', 'Provenance candidate link');
  await checkColumn('fact_provenance', 'target_type', 'Provenance target type');
  await checkColumn('fact_provenance', 'target_id', 'Provenance target ID');

  console.log('\n4️⃣ Checking Migration 004 (History Hardening, Provenance Indexing & Phone Region)...');
  await checkColumn('users', 'phone_region', 'User default phone region ISO code');
  await checkColumn('contact_history', 'candidate_fact_id', 'Candidate fact reference in history');
  await checkColumn('contact_history', 'temporal_precision', 'Temporal precision (exact/day/month/etc.)');
  await checkColumn('contact_history', 'raw_time_expression', 'Preserved raw temporal expression');
  await checkIndex('contact_history', 'idx_history_owner_contact_type_current', 'Composite index for current history queries');
  await checkIndex('fact_provenance', 'idx_provenance_owner_target', 'Composite index for owner/target provenance queries');

  console.log('\n5️⃣ Checking Migration 005 (Polished Natural-Language Memory Capture)...');
  await checkColumn('input_events', 'polished_content', 'Preserved polished natural-language memory');

  console.log('\n6️⃣ Checking Migration 006 (Demo Account Isolation & Unknown Date Handling)...');
  await checkColumn('users', 'is_demo_account', 'Account classification flag for demo reset isolation');
  await checkIndex('users', 'idx_users_is_demo', 'Index on users.is_demo_account');
  await checkColumn('interactions', 'raw_time_expression', 'Preserved raw temporal expression for interactions');

  console.log('\n📊 Migration Smoke Test Summary:');
  if (errors === 0) {
    console.log('🎉 ALL MIGRATION CHECKS PASSED (001 -> 002 -> 003 -> 004 -> 005 -> 006 Verified)!');
    return true;
  } else {
    console.error(`❌ Migration verification encountered ${errors} error(s)!`);
    return false;
  }
}

if (require.main === module) {
  verifyMigrations().then(success => {
    process.exit(success ? 0 : 1);
  }).catch(err => {
    console.error('Fatal error running migration verification:', err);
    process.exit(1);
  });
}

module.exports = { verifyMigrations };
