/**
 * Dedicated Synthetic Demo Dataset Seed & Safe Reset Script
 * 
 * Strict safety rules:
 * - Resets ONLY the synthetic demo account (user: 'kumar', id: 2)
 * - NEVER touches or modifies any other user's records
 * - Never imports private production user data
 * - Fast, repeatable, and idempotent
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getPool } = require('../db');

async function resetDemoData(targetUserId = null) {
  const pool = getPool();

  console.log('🔄 Initializing Synthetic Demo Dataset Reset...');

  // 1. Identify or ensure demo user 'kumar'
  let demoUserId = targetUserId;
  if (!demoUserId) {
    const [userRows] = await pool.query("SELECT id FROM users WHERE username = 'kumar'");
    if (userRows.length > 0) {
      demoUserId = userRows[0].id;
    } else {
      const hash = await bcrypt.hash('Password123!', 10);
      const [createRes] = await pool.query(
        "INSERT INTO users (username, password, email) VALUES ('kumar', ?, 'kumar@example.com')",
        [hash]
      );
      demoUserId = createRes.insertId;
    }
  }

  // Ensure password is confirmed to Password123!
  const passwordHash = await bcrypt.hash('Password123!', 10);
  await pool.query('UPDATE users SET password = ? WHERE id = ?', [passwordHash, demoUserId]);

  console.log(`🔒 Resetting data strictly for demo owner_user_id = ${demoUserId}...`);

  // 2. Safely clean existing demo-scoped data (Strictly WHERE owner_user_id = demoUserId)
  await pool.query('DELETE FROM fact_provenance WHERE owner_user_id = ?', [demoUserId]);
  await pool.query('DELETE FROM contact_history WHERE owner_user_id = ?', [demoUserId]);
  await pool.query('DELETE FROM commitments WHERE owner_user_id = ?', [demoUserId]);
  await pool.query('DELETE FROM candidate_facts WHERE owner_user_id = ?', [demoUserId]);
  await pool.query('DELETE FROM input_events WHERE owner_user_id = ?', [demoUserId]);
  
  // Clean contact sub-tables scoped to owner contacts
  await pool.query('DELETE FROM interactions WHERE contact_id IN (SELECT id FROM contacts WHERE owner_user_id = ?)', [demoUserId]);
  await pool.query('DELETE FROM relationships WHERE contact_id IN (SELECT id FROM contacts WHERE owner_user_id = ?)', [demoUserId]);
  await pool.query('DELETE FROM contact_phones WHERE contact_id IN (SELECT id FROM contacts WHERE owner_user_id = ?)', [demoUserId]);
  await pool.query('DELETE FROM contact_emails WHERE contact_id IN (SELECT id FROM contacts WHERE owner_user_id = ?)', [demoUserId]);
  await pool.query('DELETE FROM contact_addresses WHERE contact_id IN (SELECT id FROM contacts WHERE owner_user_id = ?)', [demoUserId]);
  await pool.query('DELETE FROM contact_sources WHERE contact_id IN (SELECT id FROM contacts WHERE owner_user_id = ?)', [demoUserId]);
  
  await pool.query('DELETE FROM contacts WHERE owner_user_id = ?', [demoUserId]);

  console.log('   🧹 Cleaned previous demo records.');

  // 3. Seed Synthetic Contacts for the 6 Demo Scenarios
  // Contact 1: Robert "Bob" Smith (Scenario 2: Duplicate Prevention)
  const [bobRes] = await pool.query(
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
  const [msRes] = await pool.query(
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
  const [mcRes] = await pool.query(
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
  const [johnRes] = await pool.query(
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
  const [marcusRes] = await pool.query(
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
  const [elenaRes] = await pool.query(
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

  // 4. Seed Open Commitments for Demo Dashboard
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  const nextWeekStr = nextWeek.toISOString().split('T')[0];

  const inThreeDays = new Date();
  inThreeDays.setDate(inThreeDays.getDate() + 3);
  const inThreeDaysStr = inThreeDays.toISOString().split('T')[0];

  await pool.query(
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

  console.log('✅ Synthetic Demo Dataset Seeded Successfully!');
  console.log(`   - 6 Synthetic Contacts created (Bob Smith, Michael Scott, Michael Chang, John Doe, Marcus Vance, Elena Rostova)`);
  console.log(`   - 3 Open Commitments created for Dashboard`);
  console.log(`   - All data owner-scoped to demo user id ${demoUserId}`);

  return {
    success: true,
    demoUserId,
    contacts: {
      bobId,
      michaelScottId,
      michaelChangId,
      johnId,
      marcusId,
      elenaId
    }
  };
}

if (require.main === module) {
  resetDemoData()
    .then(() => {
      console.log('🎉 Demo reset complete!');
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Demo reset failed:', err);
      process.exit(1);
    });
}

module.exports = { resetDemoData };
