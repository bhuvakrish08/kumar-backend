/**
 * Dedicated Synthetic Demo Dataset Seed & Safe Reset Script (Sprint 3A.1)
 * 
 * Strict safety rules:
 * - Resets ONLY explicitly flagged demo accounts (is_demo_account = TRUE)
 * - NEVER touches or modifies Kumar's real account or any other account
 * - NEVER updates, changes, or resets any user password
 * - Transaction-safe: runs atomic beginTransaction / rollback on failure
 * - Fast, repeatable, and idempotent
 */

require('dotenv').config();
const { getPool } = require('../db');

/**
 * Resets synthetic demo data for a verified demo user account.
 * 
 * @param {number|null} targetUserId - The ID of the authenticated user requesting reset.
 * @param {object} options - Optional parameters like correlationId.
 */
async function resetDemoData(targetUserId = null, options = {}) {
  const pool = getPool();
  const correlationId = options.correlationId || `reset_${Date.now()}`;
  const timestamp = new Date().toISOString();

  console.log(`[Demo Reset] [${correlationId}] 🔄 Initializing Synthetic Demo Dataset Reset at ${timestamp}...`);

  // 1. Identify and verify demo user
  let demoUserId = targetUserId;
  if (!demoUserId) {
    const [demoRows] = await pool.query(
      "SELECT id, username, is_demo_account FROM users WHERE username = 'dossier_demo' AND is_demo_account = 1 LIMIT 1"
    );
    if (demoRows.length > 0) {
      demoUserId = demoRows[0].id;
    } else {
      const err = new Error("No verified demo account found. Please run scripts/setup_demo_account.js first.");
      console.error(`[Demo Reset] [${correlationId}] ❌ Failed: ${err.message}`);
      throw err;
    }
  }

  // 2. Strict Server-Side Verification: User MUST have is_demo_account = 1
  const [userCheck] = await pool.query(
    "SELECT id, username, is_demo_account FROM users WHERE id = ?",
    [demoUserId]
  );

  if (userCheck.length === 0) {
    const err = new Error(`User ID ${demoUserId} does not exist.`);
    console.error(`[Demo Reset] [${correlationId}] ❌ Security Rejection: ${err.message}`);
    throw err;
  }

  const user = userCheck[0];
  if (!user.is_demo_account) {
    const err = new Error(`SECURITY VIOLATION: Account '${user.username}' (ID: ${user.id}) is NOT a demo account. Reset blocked.`);
    console.error(`[Demo Reset] [${correlationId}] 🛑 BLOCKED: Non-demo user '${user.username}' attempted demo reset.`);
    throw err;
  }

  console.log(`[Demo Reset] [${correlationId}] 🔒 Verified demo account '${user.username}' (ID: ${demoUserId}, is_demo_account: 1).`);

  // 3. Acquire connection from pool for Transaction Safety
  const conn = await pool.getConnection();

  try {
    await conn.beginTransaction();

    console.log(`[Demo Reset] [${correlationId}] 🧹 Cleaning previous demo records for owner_user_id = ${demoUserId}...`);

    // Clean demo-scoped data (Strictly WHERE owner_user_id = demoUserId)
    await conn.query('DELETE FROM fact_provenance WHERE owner_user_id = ?', [demoUserId]);
    await conn.query('DELETE FROM contact_history WHERE owner_user_id = ?', [demoUserId]);
    await conn.query('DELETE FROM commitments WHERE owner_user_id = ?', [demoUserId]);
    await conn.query('DELETE FROM candidate_facts WHERE owner_user_id = ?', [demoUserId]);
    await conn.query('DELETE FROM input_events WHERE owner_user_id = ?', [demoUserId]);

    // Clean contact sub-tables scoped strictly to contacts owned by demoUserId
    await conn.query('DELETE FROM interactions WHERE contact_id IN (SELECT id FROM contacts WHERE owner_user_id = ?)', [demoUserId]);
    await conn.query('DELETE FROM relationships WHERE contact_id IN (SELECT id FROM contacts WHERE owner_user_id = ?)', [demoUserId]);
    await conn.query('DELETE FROM contact_phones WHERE contact_id IN (SELECT id FROM contacts WHERE owner_user_id = ?)', [demoUserId]);
    await conn.query('DELETE FROM contact_emails WHERE contact_id IN (SELECT id FROM contacts WHERE owner_user_id = ?)', [demoUserId]);
    await conn.query('DELETE FROM contact_addresses WHERE contact_id IN (SELECT id FROM contacts WHERE owner_user_id = ?)', [demoUserId]);
    await conn.query('DELETE FROM contact_sources WHERE contact_id IN (SELECT id FROM contacts WHERE owner_user_id = ?)', [demoUserId]);

    // Delete contacts owned by demoUserId
    await conn.query('DELETE FROM contacts WHERE owner_user_id = ?', [demoUserId]);

    // 4. Seed Synthetic Contacts for the 6 Investor Demo Scenarios
    console.log(`[Demo Reset] [${correlationId}] 🌱 Reseeding 6 synthetic demo contacts...`);

    // Contact 1: Robert "Bob" Smith (Scenario 2: Duplicate Prevention)
    const [bobRes] = await conn.query(
      `INSERT INTO contacts (
        owner_user_id, created_by, first_name, nickname, last_name,
        job_title, company_name, primary_phone, mobile_phone, primary_email,
        personal_notes, interests, how_we_met_notes
      ) VALUES (?, ?, 'Robert', 'Bob', 'Smith', 'Managing Director', 'TechVentures', '+14155558899', '+14155558899', 'bob@techventures.com',
        'Key venture capital partner and advisor. Prefers WhatsApp or direct call.',
        'Early-stage AI, venture capital, cloud infrastructure',
        'Met at Tech Startup Summit 2023')`,
      [demoUserId, demoUserId]
    );
    const bobId = bobRes.insertId;

    // Contact 2: Michael Scott (Scenario 3: Ambiguous Michael #1)
    const [msRes] = await conn.query(
      `INSERT INTO contacts (
        owner_user_id, created_by, first_name, last_name,
        job_title, company_name, primary_phone, mobile_phone, primary_email,
        personal_notes, how_we_met_notes
      ) VALUES (?, ?, 'Michael', 'Scott', 'Regional Manager', 'Dunder Mifflin', '+15705550100', '+15705550100', 'mscott@dundermifflin.com',
        'Paper supply contact in Pennsylvania. Quirky personality.',
        'Met at Paper Supply Expo in Scranton')`,
      [demoUserId, demoUserId]
    );
    const michaelScottId = msRes.insertId;

    // Contact 3: Michael Chang (Scenario 3: Ambiguous Michael #2)
    const [mcRes] = await conn.query(
      `INSERT INTO contacts (
        owner_user_id, created_by, first_name, last_name,
        job_title, company_name, primary_phone, mobile_phone, primary_email,
        personal_notes, interests, how_we_met_notes
      ) VALUES (?, ?, 'Michael', 'Chang', 'Partner', 'Pacific VC', '+14155550199', '+14155550199', 'mchang@pacificvc.com',
        'Fintech and deep-tech investor based in San Francisco.',
        'Fintech, autonomous agents, cross-border payments',
        'Introduced by David Miller at Sand Hill Road conference')`,
      [demoUserId, demoUserId]
    );
    const michaelChangId = mcRes.insertId;

    // Contact 4: John Doe (Scenario 4: Temporal Employer Change - currently at IBM)
    const [johnRes] = await conn.query(
      `INSERT INTO contacts (
        owner_user_id, created_by, first_name, last_name,
        job_title, company_name, primary_phone, mobile_phone, primary_email,
        personal_notes, how_we_met_notes
      ) VALUES (?, ?, 'John', 'Doe', 'Principal Systems Architect', 'IBM', '+12065550144', '+12065550144', 'john.doe@ibm.com',
        'Enterprise cloud architect. Leads hybrid cloud integrations.',
        'Met at Cloud Migration Summit 2022')`,
      [demoUserId, demoUserId]
    );
    const johnId = johnRes.insertId;

    // Contact 5: Marcus Vance (Scenario 5: Associative Retrieval)
    const [marcusRes] = await conn.query(
      `INSERT INTO contacts (
        owner_user_id, created_by, first_name, last_name,
        job_title, company_name, primary_phone, mobile_phone, primary_email,
        met_context, met_place, how_we_met_notes, personal_notes, interests
      ) VALUES (?, ?, 'Marcus', 'Vance', 'Technology Investor', 'Apex Ventures', '+14155559012', '+14155559012', 'marcus@apexventures.io',
        'Met on flight coming back from California',
        'SFO to JFK Flight',
        'Technology investor seated next to me on the return flight from California. Discussed B2B SaaS and AI infrastructure.',
        'Early-stage technology investor focused on enterprise AI.',
        'Enterprise SaaS, angel investing, California tech ecosystem')`,
      [demoUserId, demoUserId]
    );
    const marcusId = marcusRes.insertId;

    // Contact 6: Elena Rostova (Scenario 6: Multi-channel Contact Act)
    const [elenaRes] = await conn.query(
      `INSERT INTO contacts (
        owner_user_id, created_by, first_name, last_name,
        job_title, company_name, primary_phone, mobile_phone, primary_email,
        personal_notes, how_we_met_notes
      ) VALUES (?, ?, 'Elena', 'Rostova', 'Head of AI Research', 'Apex AI Lab', '+14155550111', '+14155550122', 'elena@apexailab.com',
        'Key AI researcher. Has both office (+1 415-555-0111) and direct mobile (+1 415-555-0122).',
        'Collaborated on foundation model evaluation')`,
      [demoUserId, demoUserId]
    );
    const elenaId = elenaRes.insertId;

    // 5. Seed Open Commitments for Demo Dashboard
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = nextWeek.toISOString().split('T')[0];

    const inThreeDays = new Date();
    inThreeDays.setDate(inThreeDays.getDate() + 3);
    const inThreeDaysStr = inThreeDays.toISOString().split('T')[0];

    await conn.query(
      `INSERT INTO commitments (
        owner_user_id, contact_id, title, details, type, status, due_time
      ) VALUES 
        (?, ?, 'Send quarterly investor update to Bob Smith', 'Share Dossier traction metrics and Sprint 3A Gemini update.', 'follow_up', 'OPEN', ?),
        (?, ?, 'Review Pacific VC term sheet from Michael Chang', 'Evaluate lead investor terms for seed round.', 'deliverable', 'OPEN', ?),
        (?, ?, 'Follow up with Marcus Vance regarding AI infrastructure', 'Send pitch deck discussed on flight back from California.', 'follow_up', 'OPEN', ?)`,
      [
        demoUserId, bobId, inThreeDaysStr,
        demoUserId, michaelChangId, nextWeekStr,
        demoUserId, marcusId, inThreeDaysStr
      ]
    );

    // Commit Transaction
    await conn.commit();

    console.log(`[Demo Reset] [${correlationId}] ✅ Transaction committed successfully.`);
    console.log(`[Demo Reset] [${correlationId}]    - User: '${user.username}' (ID: ${demoUserId})`);
    console.log(`[Demo Reset] [${correlationId}]    - Contacts seeded: 6 (Bob Smith, Michael Scott, Michael Chang, John Doe, Marcus Vance, Elena Rostova)`);
    console.log(`[Demo Reset] [${correlationId}]    - Commitments seeded: 3`);
    console.log(`[Demo Reset] [${correlationId}]    - User password: UNMODIFIED (strictly preserved)`);

    return {
      success: true,
      demoUserId,
      demoUsername: user.username,
      contacts_count: 6,
      commitments_count: 3,
      contacts: {
        bobId,
        michaelScottId,
        michaelChangId,
        johnId,
        marcusId,
        elenaId
      }
    };
  } catch (err) {
    // Rollback on any failure
    await conn.rollback();
    console.error(`[Demo Reset] [${correlationId}] ❌ Transaction rolled back due to error:`, err.message);
    throw err;
  } finally {
    conn.release();
  }
}

if (require.main === module) {
  resetDemoData()
    .then((res) => {
      console.log('🎉 Demo reset complete!');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Demo reset failed:', err.message);
      process.exit(1);
    });
}

module.exports = { resetDemoData };
