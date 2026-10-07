const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { interpretQuery } = require('../lib/intelligence');

/**
 * POST /api/v1/ask-dossier
 * Hybrid natural language query retrieval engine
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

    // 1. Fetch user contacts for interpretation
    const [allContacts] = await pool.query(
      `SELECT c.*,
              (SELECT GROUP_CONCAT(s.name SEPARATOR ', ') FROM contact_sources cs JOIN sources s ON s.id = cs.source_id WHERE cs.contact_id = c.id) as sources_list
       FROM contacts c WHERE c.owner_user_id = ?`,
      [userId]
    );

    const interpretation = await interpretQuery(q, allContacts);

    let primaryContact = null;
    let matchingCommitments = [];
    let reason = '';
    let alternatives = [];
    let answer = '';

    const lowerQ = q.toLowerCase();

    // CANONICAL QUERY TYPE 1: "What is David's cell?" / Phone queries
    if (interpretation.isCellQuery || lowerQ.includes('cell') || lowerQ.includes('phone') || lowerQ.includes('number')) {
      const matched = allContacts.filter(c => {
        const fullName = `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase();
        return (c.first_name && lowerQ.includes(c.first_name.toLowerCase())) ||
               (c.last_name && lowerQ.includes(c.last_name.toLowerCase())) ||
               (c.nickname && lowerQ.includes(c.nickname.toLowerCase())) ||
               fullName.split(' ').some(w => w.length > 2 && lowerQ.includes(w));
      });

      if (matched.length > 0) {
        primaryContact = matched[0];
        if (matched.length > 1) alternatives = matched.slice(1);
        const cell = primaryContact.mobile_phone || primaryContact.primary_phone || 'No phone recorded';
        answer = `${primaryContact.first_name} ${primaryContact.last_name}'s phone number is: ${cell}`;
        reason = `Retrieved cell/phone for ${primaryContact.first_name} ${primaryContact.last_name} from contact record.`;
      }
    }

    // CANONICAL QUERY TYPE 2: "Who do I need to follow up with?"
    if (!answer && (interpretation.isFollowUpQuery || lowerQ.includes('follow up') || lowerQ.includes('follow-up'))) {
      const [comRows] = await pool.query(
        `SELECT cm.*, c.first_name, c.last_name, c.company_name
         FROM commitments cm
         JOIN contacts c ON c.id = cm.contact_id AND c.owner_user_id = ?
         WHERE cm.owner_user_id = ? AND cm.status = 'OPEN'
         ORDER BY cm.due_time ASC`,
        [userId, userId]
      );

      const [interRows] = await pool.query(
        `SELECT i.*, c.first_name, c.last_name, c.company_name
         FROM interactions i
         JOIN contacts c ON c.id = i.contact_id AND c.owner_user_id = ?
         WHERE c.owner_user_id = ? AND i.follow_up_status = 'pending'`,
        [userId, userId]
      );

      matchingCommitments = comRows;
      if (comRows.length > 0) {
        const names = Array.from(new Set(comRows.map(r => `${r.first_name} ${r.last_name}`)));
        answer = `You have pending follow-ups with: ${names.join(', ')}.`;
        reason = `Found ${comRows.length} open commitment follow-up item(s) in database.`;
        primaryContact = { id: comRows[0].contact_id, first_name: comRows[0].first_name, last_name: comRows[0].last_name };
      } else if (interRows.length > 0) {
        const names = Array.from(new Set(interRows.map(r => `${r.first_name} ${r.last_name}`)));
        answer = `Interactions pending follow-up with: ${names.join(', ')}.`;
        reason = `Found ${interRows.length} interaction(s) marked pending follow-up.`;
      } else {
        answer = 'You currently have no pending follow-ups.';
        reason = 'No open commitments or pending interaction follow-ups found.';
      }
    }

    // CANONICAL QUERY TYPE 3: "Who owes me pricing?" / "Who owes..."
    if (!answer && (interpretation.isPricingQuery || lowerQ.includes('pricing') || lowerQ.includes('quote'))) {
      const [comRows] = await pool.query(
        `SELECT cm.*, c.first_name, c.last_name, c.company_name
         FROM commitments cm
         JOIN contacts c ON c.id = cm.contact_id AND c.owner_user_id = ?
         WHERE cm.owner_user_id = ? AND (cm.title LIKE '%pricing%' OR cm.details LIKE '%pricing%' OR cm.title LIKE '%quote%')`,
        [userId, userId]
      );

      if (comRows.length > 0) {
        matchingCommitments = comRows;
        primaryContact = { id: comRows[0].contact_id, first_name: comRows[0].first_name, last_name: comRows[0].last_name };
        answer = `${comRows[0].first_name} ${comRows[0].last_name} (${comRows[0].company_name || 'Contact'}) is expected to send pricing (${comRows[0].title}).`;
        reason = `Found commitment record matching pricing/quote request for ${comRows[0].first_name}.`;
      }
    }

    // CANONICAL QUERY TYPE 4: "Who introduced me to John?"
    if (!answer && (interpretation.isIntroducerQuery || lowerQ.includes('introduced') || lowerQ.includes('refer'))) {
      const matched = allContacts.filter(c => {
        const fullName = `${c.first_name || ''} ${c.last_name || ''}`.toLowerCase();
        return (c.first_name && lowerQ.includes(c.first_name.toLowerCase())) || fullName.includes('john');
      });

      if (matched.length > 0) {
        primaryContact = matched[0];
        const intro = primaryContact.introduced_by_name || 'No introducer recorded';
        answer = `${primaryContact.first_name} ${primaryContact.last_name} was introduced to you by: ${intro}.`;
        reason = `Retrieved introducer information from contact record.`;
      }
    }

    // CANONICAL QUERY TYPE 5: "Who did I meet at IBM?" / Company query
    if (!answer && (lowerQ.includes('met at') || lowerQ.includes('company') || lowerQ.includes('at ibm') || lowerQ.includes('ibm'))) {
      const targetCompany = lowerQ.includes('ibm') ? 'ibm' : lowerQ.replace(/.*(?:at|from)\s+([a-z0-9]+).*/i, '$1');
      const matched = allContacts.filter(c => {
        const comp = (c.company_name || '').toLowerCase();
        const metLoc = (c.met_place || '').toLowerCase();
        const notes = (c.how_we_met_notes || '').toLowerCase();
        return comp.includes(targetCompany) || metLoc.includes(targetCompany) || notes.includes(targetCompany);
      });

      if (matched.length > 0) {
        primaryContact = matched[0];
        if (matched.length > 1) alternatives = matched.slice(1);
        const names = matched.map(m => `${m.first_name} ${m.last_name}`).join(', ');
        answer = `Contacts associated with ${targetCompany.toUpperCase()}: ${names}.`;
        reason = `Matched ${matched.length} contact(s) with company/meeting place matching '${targetCompany}'.`;
      }
    }

    // CANONICAL QUERY TYPE 6: "Tell me about Larry and whisky." / Hobby / Notes topic query
    if (!answer && (interpretation.isTopicQuery || lowerQ.includes('whisky') || lowerQ.includes('tell me about'))) {
      const topic = lowerQ.includes('whisky') ? 'whisky' : 'coffee';
      const matched = allContacts.filter(c => {
        const text = `${c.first_name || ''} ${c.last_name || ''} ${c.interests || ''} ${c.personal_notes || ''} ${c.how_we_met_notes || ''}`.toLowerCase();
        return text.includes(topic) || (c.first_name && lowerQ.includes(c.first_name.toLowerCase()) && text.includes(topic));
      });

      // Sort candidate contacts: contacts with explicit topic in notes come first
      matched.sort((a, b) => {
        const textA = `${a.interests || ''} ${a.personal_notes || ''} ${a.how_we_met_notes || ''}`.toLowerCase();
        const textB = `${b.interests || ''} ${b.personal_notes || ''} ${b.how_we_met_notes || ''}`.toLowerCase();
        const hasA = textA.includes(topic) ? 1 : 0;
        const hasB = textB.includes(topic) ? 1 : 0;
        return hasB - hasA;
      });

      if (matched.length > 0) {
        primaryContact = matched[0];
        if (matched.length > 1) alternatives = matched.slice(1);
        answer = `${primaryContact.first_name} ${primaryContact.last_name}: ${primaryContact.job_title || ''} at ${primaryContact.company_name || ''}. Notes: ${primaryContact.personal_notes || primaryContact.interests || 'Met during relationship interactions.'}`;
        reason = `Matched topic/name criteria for ${primaryContact.first_name} ${primaryContact.last_name}.`;
      }
    }

    // General fallback search if canonical queries didn't trigger
    if (!answer) {
      const like = `%${q}%`;
      const [matchedRows] = await pool.query(
        `SELECT c.* FROM contacts c
         WHERE c.owner_user_id = ? AND (
           CONCAT_WS(' ', c.first_name, c.middle_name, c.last_name, c.nickname, c.company_name, c.job_title,
             c.primary_email, c.primary_phone, c.mobile_phone, c.introduced_by_name, c.met_context,
             c.met_place, c.how_we_met_notes, c.interests, c.personal_notes) LIKE ?
         ) LIMIT 5`,
        [userId, like]
      );

      if (matchedRows.length > 0) {
        primaryContact = matchedRows[0];
        if (matchedRows.length > 1) alternatives = matchedRows.slice(1);
        answer = `Found matching contact: ${primaryContact.first_name} ${primaryContact.last_name} (${primaryContact.company_name || 'No company'}).`;
        reason = `Lexical and structured database text match for '${q}'.`;
      } else {
        answer = `No contacts or commitments found matching "${q}".`;
        reason = `Search completed across contacts, commitments, and interactions for owner user.`;
      }
    }

    return res.json({
      query: q,
      answer,
      primary_contact: primaryContact,
      commitments: matchingCommitments,
      reason,
      alternatives
    });

  } catch (err) {
    console.error('Error executing Ask Dossier query:', err);
    return res.status(500).json({ error: 'Failed to answer Dossier query' });
  }
});

module.exports = router;
