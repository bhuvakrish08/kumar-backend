/**
 * Demo Management Routes
 * Strictly protected endpoints for synthetic investor demonstration resets.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { resetDemoData } = require('../scripts/demo_reset');

/**
 * POST /api/v1/demo/reset
 * Resets synthetic demo data strictly for the authenticated demo user.
 * Blocks any attempt to supply arbitrary owner_user_id or access from unauthorized users.
 */
router.post('/reset', requireAuth, async (req, res) => {
  try {
    const authUser = req.user;

    // Strict security check: Only authorized demo user 'kumar' (or test owner) can reset demo state
    if (authUser.username !== 'kumar' && authUser.id !== 2) {
      return res.status(403).json({
        error: 'Demo reset is restricted to the synthetic demo account.'
      });
    }

    // Call reset strictly for the authenticated user ID (never trust request body)
    const result = await resetDemoData(authUser.id);

    return res.json({
      success: true,
      message: 'Synthetic demo dataset has been reset cleanly.',
      demo_user: authUser.username,
      contacts_count: 6,
      commitments_count: 3
    });
  } catch (error) {
    console.error('Error during demo reset:', error);
    return res.status(500).json({ error: 'Failed to reset demo dataset' });
  }
});

module.exports = router;
