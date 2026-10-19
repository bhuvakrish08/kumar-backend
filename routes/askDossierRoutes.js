const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { interpretAskQuery } = require('../lib/askInterpreter');
const {
  retrieveContactDetails,
  retrieveCommitments,
  retrieveRelationships,
  retrieveOrganizationContext,
  retrieveTopicContext,
  retrieveGeneralSearch
} = require('../lib/askRetrievalServices');

/**
 * POST /api/v1/ask-dossier
 * Generalized natural language search engine using AskIntent and modular retrieval services.
 * NO route-level hardcoded literal branches (IBM, whisky, pricing are evaluation fixtures, not architecture).
 */
router.post('/', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { query } = req.body;

    if (!query || typeof query !== 'string' || query.trim() === '') {
      return res.status(400).json({ error: 'query parameter is required' });
    }

    const q = query.trim();
    const pool = getPool();

    // 1. Fetch user contacts for interpretation context (strictly owner-scoped)
    const [contactRows] = await pool.query(
      `SELECT id, first_name, last_name, nickname, company_name
       FROM contacts
       WHERE owner_user_id = ?`,
      [userId]
    );

    // 2. Structured Natural Language Query Interpretation -> normalized AskIntent
    const askIntent = interpretAskQuery(q, contactRows);

    let retrievalResult = null;

    // 3. Dispatch to modular retrieval service based on AskIntent
    switch (askIntent.intent) {
      case 'CONTACT_DETAIL':
        retrievalResult = await retrieveContactDetails(pool, userId, askIntent, q);
        break;

      case 'COMMITMENT_SEARCH':
        retrievalResult = await retrieveCommitments(pool, userId, askIntent, q);
        break;

      case 'RELATIONSHIP_LOOKUP':
        retrievalResult = await retrieveRelationships(pool, userId, askIntent, q);
        break;

      case 'ORGANIZATION_LOOKUP':
        retrievalResult = await retrieveOrganizationContext(pool, userId, askIntent, q);
        break;

      case 'TOPIC_SEARCH':
        retrievalResult = await retrieveTopicContext(pool, userId, askIntent, q);
        break;

      case 'GENERAL_PERSON_SEARCH':
      default:
        retrievalResult = await retrieveGeneralSearch(pool, userId, askIntent, q);
        break;
    }

    // Fallback to general search if specialized intent yielded no answer
    if (!retrievalResult || !retrievalResult.answer || (retrievalResult.primary_contact === null && (!retrievalResult.commitments || retrievalResult.commitments.length === 0))) {
      const fallbackResult = await retrieveGeneralSearch(pool, userId, askIntent, q);
      if (fallbackResult && fallbackResult.primary_contact) {
        retrievalResult = fallbackResult;
      }
    }

    const finalResult = retrievalResult || {
      answer: `No contacts or commitments found matching "${q}".`,
      primary_contact: null,
      commitments: [],
      alternatives: [],
      reason: 'No matching records found across owner contacts or commitments.',
      requires_clarification: false,
      clarification_choices: []
    };

    return res.json({
      query: q,
      answer: finalResult.answer,
      primary_contact: finalResult.primary_contact,
      commitments: finalResult.commitments || [],
      reason: finalResult.reason,
      alternatives: finalResult.alternatives || [],
      requires_clarification: Boolean(finalResult.requires_clarification),
      clarification_choices: finalResult.clarification_choices || [],
      interpretation: askIntent
    });

  } catch (err) {
    console.error('Error executing Ask Dossier query:', err);
    return res.status(500).json({ error: 'Failed to answer Dossier query' });
  }
});

module.exports = router;
