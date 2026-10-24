/**
 * Demo Management Routes (Sprint 3A.1 Surgical Hardening)
 * Strictly protected endpoints for synthetic investor demonstration resets.
 * 
 * Authorization:
 * - Only accounts explicitly verified in the database with is_demo_account = TRUE can reset.
 * - Non-demo accounts (including Kumar or test users) receive HTTP 403 Forbidden.
 * - Client-supplied owner_user_id or username are strictly ignored.
 * - The authenticated context exclusively determines the target account.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { resetDemoData } = require('../scripts/demo_reset');
const { getPool } = require('../db');

/**
 * POST /api/v1/demo/reset
 * Resets synthetic demo data strictly for the authenticated demo user.
 * Blocks any attempt to supply arbitrary owner_user_id or access from non-demo accounts.
 */
router.post('/reset', requireAuth, async (req, res) => {
  const correlationId = req.headers['x-correlation-id'] || `demo_reset_${Date.now()}`;
  const authUserId = req.user?.id;

  try {
    const pool = getPool();

    // 1. Load account directly from database to verify account classification
    const [userRows] = await pool.query(
      'SELECT id, username, is_demo_account FROM users WHERE id = ?',
      [authUserId]
    );

    if (userRows.length === 0) {
      console.warn(`[Demo Route] [${correlationId}] 401: User not found in database for ID ${authUserId}`);
      return res.status(401).json({ error: 'Unauthorized user context' });
    }

    const dbUser = userRows[0];

    // 2. Strict Security Verification: Account MUST have is_demo_account = TRUE in database
    if (!dbUser.is_demo_account) {
      console.warn(`[Demo Route] [${correlationId}] 403 FORBIDDEN: Non-demo user '${dbUser.username}' (ID: ${dbUser.id}) attempted demo reset.`);
      return res.status(403).json({
        error: 'Demo reset is strictly restricted to verified demo accounts.'
      });
    }

    // 3. Call reset strictly for the verified authenticated demo user ID (never trust request body)
    console.log(`[Demo Route] [${correlationId}] Authorized demo reset initiating for verified demo user '${dbUser.username}' (ID: ${dbUser.id})`);
    
    const result = await resetDemoData(dbUser.id, { correlationId });

    console.log(`[Demo Route] [${correlationId}] Demo reset succeeded for '${dbUser.username}' (ID: ${dbUser.id})`);

    return res.json({
      success: true,
      message: 'Synthetic demo dataset has been reset cleanly.',
      demo_user: dbUser.username,
      contacts_count: result.contacts_count,
      commitments_count: result.commitments_count,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error(`[Demo Route] [${correlationId}] Error during demo reset:`, error.message);
    return res.status(500).json({ error: 'Failed to reset demo dataset' });
  }
});

module.exports = router;
