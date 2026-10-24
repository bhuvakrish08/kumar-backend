/**
 * Dedicated Synthetic Demo Account Provisioning Script
 * 
 * Strict safety rules:
 * - Provisions isolated demo account 'dossier_demo' with is_demo_account = TRUE
 * - Reads password strictly from DEMO_USER_PASSWORD environment variable
 * - Fails safely if environment variable is missing
 * - Never modifies or touches Kumar's real account or any other account
 * - Hashes password using bcrypt with cost factor 10
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getPool } = require('../db');

async function setupDemoAccount() {
  const pool = getPool();
  const demoUsername = 'dossier_demo';
  const demoEmail = 'demo@dossier.local';

  console.log('🔒 Provisioning isolated synthetic demo account...');

  const demoPassword = process.env.DEMO_USER_PASSWORD;
  if (!demoPassword) {
    // Check if demo user already exists
    const [existing] = await pool.query(
      "SELECT id, username, is_demo_account FROM users WHERE username = ?",
      [demoUsername]
    );

    if (existing.length > 0) {
      console.log(`ℹ️ Demo account '${demoUsername}' already exists (ID: ${existing[0].id}, is_demo_account: ${existing[0].is_demo_account}).`);
      // Ensure flag is set to true
      if (!existing[0].is_demo_account) {
        await pool.query("UPDATE users SET is_demo_account = 1 WHERE id = ?", [existing[0].id]);
        console.log(`✅ Updated '${demoUsername}' to is_demo_account = 1.`);
      }
      return existing[0].id;
    }

    console.error('❌ FATAL CONFIGURATION ERROR: DEMO_USER_PASSWORD environment variable is missing!');
    console.error('   Please define DEMO_USER_PASSWORD (minimum 10 characters) to provision the demo account.');
    throw new Error('DEMO_USER_PASSWORD environment variable required');
  }

  if (demoPassword.length < 10) {
    console.error('❌ FATAL: DEMO_USER_PASSWORD must be at least 10 characters long.');
    throw new Error('DEMO_USER_PASSWORD too short (<10 chars)');
  }

  const passwordHash = await bcrypt.hash(demoPassword, 10);

  const [existing] = await pool.query(
    "SELECT id FROM users WHERE username = ?",
    [demoUsername]
  );

  let demoUserId = null;
  if (existing.length > 0) {
    demoUserId = existing[0].id;
    await pool.query(
      "UPDATE users SET password = ?, is_demo_account = 1, email = ? WHERE id = ?",
      [passwordHash, demoEmail, demoUserId]
    );
    console.log(`✅ Demo account '${demoUsername}' updated successfully (ID: ${demoUserId}, is_demo_account = 1).`);
  } else {
    const [createRes] = await pool.query(
      "INSERT INTO users (username, password, email, is_demo_account) VALUES (?, ?, ?, 1)",
      [demoUsername, passwordHash, demoEmail]
    );
    demoUserId = createRes.insertId;
    console.log(`✅ Dedicated demo account '${demoUsername}' created successfully (ID: ${demoUserId}, is_demo_account = 1).`);
  }

  return demoUserId;
}

if (require.main === module) {
  setupDemoAccount()
    .then((id) => {
      console.log(`🎉 Demo account provisioning complete (User ID: ${id})`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Demo account provisioning failed:', err.message);
      process.exit(1);
    });
}

module.exports = { setupDemoAccount };
