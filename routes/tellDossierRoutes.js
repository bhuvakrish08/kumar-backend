const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { extractCandidateFacts, PARSER_VERSION } = require('../lib/intelligence');
const { resolveIdentity } = require('../lib/identityResolution');
const { buildNarrative } = require('../lib/narrative');

/**
 * POST /api/v1/tell-dossier/analyze
 * Step 1 of Tell Dossier: Parse messy text, run identity resolution, return review package
 */
router.post('/analyze', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { raw_content, event_time_hint } = req.body;

    if (!raw_content || typeof raw_content !== 'string' || raw_content.trim() === '') {
      return res.status(400).json({ error: 'raw_content is required' });
    }

    const pool = getPool();

    // 1. Create Input Event
    const [eventRes] = await pool.query(
      `INSERT INTO input_events (owner_user_id, input_type, raw_content, capture_time, event_time_hint, processing_status, parser_version)
       VALUES (?, 'text', ?, NOW(), ?, 'PROCESSING', ?)`,
      [userId, raw_content.trim(), event_time_hint || null, PARSER_VERSION]
    );
    const inputEventId = eventRes.insertId;

    // 2. Extract Candidate Facts (Server-side Provider-Neutral Intelligence Layer)
    const extraction = await extractCandidateFacts(raw_content, { userId });

    // 3. Fetch User's existing contacts for backend identity resolution
    const [existingContacts] = await pool.query(
      `SELECT id, first_name, middle_name, last_name, nickname, company_name, job_title, primary_email, primary_phone, mobile_phone, introduced_by_name, how_we_met_notes
       FROM contacts WHERE owner_user_id = ?`,
      [userId]
    );

    // 4. Run Identity Resolution v0.1
    const identityRes = resolveIdentity(extraction.person, existingContacts);

    // 5. Store Candidate Facts in DB
    const confidenceScore = identityRes.decision === 'MATCH' ? 0.95 : identityRes.decision === 'PROBABLE_MATCH' ? 0.75 : 0.50;
    const conflictState = identityRes.decision === 'CONFLICT' ? 'CONFLICT' : identityRes.decision === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'NONE';

    await pool.query(
      `INSERT INTO candidate_facts (owner_user_id, input_event_id, candidate_type, structured_payload, confidence, status, conflict_state)
       VALUES (?, ?, 'tell_dossier_extraction', ?, ?, 'PENDING', ?)`,
      [userId, inputEventId, JSON.stringify(extraction), confidenceScore, conflictState]
    );

    // Update Input Event processing status
    await pool.query(
      `UPDATE input_events SET processing_status = 'ANALYZED' WHERE id = ? AND owner_user_id = ?`,
      [inputEventId, userId]
    );

    // 6. Build structured review items
    let matchedContact = null;
    if (identityRes.matchedContactId) {
      const [matchedRows] = await pool.query(
        `SELECT id, first_name, middle_name, last_name, nickname, company_name, job_title, primary_email, primary_phone, mobile_phone
         FROM contacts WHERE id = ? AND owner_user_id = ?`,
        [identityRes.matchedContactId, userId]
      );
      if (matchedRows.length > 0) matchedContact = matchedRows[0];
    }

    const reviewItems = {
      contact_info: {
        name: { value: extraction.person.name || '', status: matchedContact ? 'RECONFIRM' : 'ADD' },
        phone: { value: extraction.person.phone || '', status: matchedContact ? (matchedContact.primary_phone || matchedContact.mobile_phone ? 'UPDATE' : 'ADD') : 'ADD' },
        email: { value: extraction.person.email || '', status: matchedContact ? (matchedContact.primary_email ? 'UPDATE' : 'ADD') : 'ADD' },
        title: { value: extraction.person.title || '', status: matchedContact ? 'UPDATE' : 'ADD' }
      },
      organization: {
        company_name: { value: extraction.person.organization || '', status: matchedContact ? (matchedContact.company_name ? 'UPDATE' : 'ADD') : 'ADD' },
        job_title: { value: extraction.person.title || '', status: matchedContact ? 'UPDATE' : 'ADD' }
      },
      how_we_met: {
        met_date: { value: extraction.person.met_date || '', status: 'ADD' },
        met_context: { value: extraction.person.meeting_context || '', status: 'ADD' },
        introduced_by_name: { value: extraction.person.introducer || '', status: 'ADD' },
        how_we_met_notes: { value: extraction.person.meeting_context || '', status: 'ADD' }
      },
      interaction: extraction.interaction ? {
        type: { value: extraction.interaction.type || 'Meeting', status: 'ADD' },
        details: { value: extraction.interaction.details || raw_content, status: 'ADD' },
        date: { value: extraction.interaction.date || new Date().toISOString().split('T')[0], status: 'ADD' }
      } : null,
      notes: { value: extraction.person.notes || raw_content, status: 'ADD' },
      sources: extraction.sources.map(s => ({ value: s, status: 'ADD' })),
      commitments: extraction.commitments.map(c => ({
        type: c.type,
        title: c.title,
        details: c.details,
        due_time: c.due_time,
        status: 'ADD'
      }))
    };

    return res.json({
      input_event_id: inputEventId,
      raw_content: raw_content,
      extraction,
      identity_resolution: {
        decision: identityRes.decision,
        matched_contact: matchedContact,
        candidate_contacts: identityRes.candidateContacts,
        evidence: identityRes.evidence
      },
      review_items: reviewItems
    });

  } catch (err) {
    console.error('Error analyzing Tell Dossier input:', err);
    return res.status(500).json({ error: 'Failed to analyze Dossier input' });
  }
});

/**
 * POST /api/v1/tell-dossier/commit
 * Step 2 of Tell Dossier: Save user-accepted candidate facts to authoritative DB
 */
router.post('/commit', requireAuth, async (req, res) => {
  const connection = await getPool().getConnection();
  try {
    const userId = req.user.id;
    const { input_event_id, target_person_option, target_contact_id, accepted_items, identity_decision } = req.body;

    if (!input_event_id) {
      connection.release();
      return res.status(400).json({ error: 'input_event_id is required' });
    }

    // Security Check: Verify Input Event belongs to this user
    const [eventRows] = await connection.query(
      `SELECT * FROM input_events WHERE id = ? AND owner_user_id = ?`,
      [input_event_id, userId]
    );

    if (eventRows.length === 0) {
      connection.release();
      return res.status(404).json({ error: 'Input event not found' });
    }

    const inputEvent = eventRows[0];

    // Enforce Rule: AMBIGUOUS or CONFLICT identity decision requires explicit resolution from user
    if ((identity_decision === 'AMBIGUOUS' || identity_decision === 'CONFLICT') && !target_person_option) {
      connection.release();
      return res.status(400).json({
        error: 'Ambiguous or conflicting identity requires explicit user selection of existing contact or New Person'
      });
    }

    await connection.beginTransaction();

    let finalContactId = null;

    // Helper to safely extract string value whether item is string or object {value: ...}
    const getVal = (v) => {
      if (!v) return null;
      if (typeof v === 'string') return v.trim();
      if (typeof v === 'object' && v.value !== undefined) return typeof v.value === 'string' ? v.value.trim() : v.value;
      return String(v).trim();
    };

    // Parse person name into first, middle, last
    const nameStr = getVal(accepted_items?.contact_info?.name) || 'Unknown';
    const nameParts = nameStr.split(/\s+/);
    let firstName = nameParts[0] || 'Unknown';
    let lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
    let middleName = '';
    if (nameParts.length > 2) {
      middleName = nameParts.slice(1, -1).join(' ');
      lastName = nameParts[nameParts.length - 1];
    }

    const phone = getVal(accepted_items?.contact_info?.phone);
    const email = getVal(accepted_items?.contact_info?.email);
    const title = getVal(accepted_items?.contact_info?.title) || getVal(accepted_items?.organization?.job_title);
    const company = getVal(accepted_items?.organization?.company_name);
    const metDate = getVal(accepted_items?.how_we_met?.met_date);
    const metContext = getVal(accepted_items?.how_we_met?.met_context);
    const introducer = getVal(accepted_items?.how_we_met?.introduced_by_name);
    const howWeMetNotes = getVal(accepted_items?.how_we_met?.how_we_met_notes);
    const personalNotes = getVal(accepted_items?.notes) || inputEvent.raw_content;

    if (target_person_option === 'existing' && target_contact_id) {
      // Security Check: Verify target contact belongs to user
      const [contactRows] = await connection.query(
        `SELECT * FROM contacts WHERE id = ? AND owner_user_id = ?`,
        [target_contact_id, userId]
      );

      if (contactRows.length === 0) {
        await connection.rollback();
        connection.release();
        return res.status(404).json({ error: 'Target contact not found or unauthorized' });
      }

      finalContactId = target_contact_id;
      const existing = contactRows[0];

      // Update contact fields if provided
      await connection.query(
        `UPDATE contacts SET
           first_name = COALESCE(?, first_name),
           last_name = COALESCE(?, last_name),
           job_title = COALESCE(?, job_title),
           company_name = COALESCE(?, company_name),
           primary_phone = COALESCE(?, primary_phone),
           primary_email = COALESCE(?, primary_email),
           met_date = COALESCE(?, met_date),
           met_context = COALESCE(?, met_context),
           introduced_by_name = COALESCE(?, introduced_by_name),
           how_we_met_notes = COALESCE(?, how_we_met_notes),
           personal_notes = CASE WHEN personal_notes IS NULL OR personal_notes = '' THEN ? ELSE CONCAT(personal_notes, '\n', ?) END
         WHERE id = ? AND owner_user_id = ?`,
        [
          firstName, lastName, title, company, phone, email,
          metDate, metContext, introducer, howWeMetNotes,
          personalNotes, personalNotes, finalContactId, userId
        ]
      );

      // Preserve narrative override if set
      if (!existing.narrative_override) {
        const updatedNarrative = buildNarrative({
          ...existing,
          first_name: firstName || existing.first_name,
          last_name: lastName || existing.last_name,
          job_title: title || existing.job_title,
          company_name: company || existing.company_name,
          primary_phone: phone || existing.primary_phone,
          primary_email: email || existing.primary_email,
          met_date: metDate || existing.met_date,
          met_context: metContext || existing.met_context,
          introduced_by_name: introducer || existing.introduced_by_name,
          how_we_met_notes: howWeMetNotes || existing.how_we_met_notes,
          personal_notes: existing.personal_notes ? existing.personal_notes + '\n' + personalNotes : personalNotes
        }, []);

        // Narrative is generated dynamically by narrative.js, but if user overrides, set narrative_override
      }

    } else {
      // Create NEW person contact
      const [cRes] = await connection.query(
        `INSERT INTO contacts (owner_user_id, created_by, first_name, middle_name, last_name, job_title, company_name, primary_phone, primary_email, met_date, met_context, introduced_by_name, how_we_met_notes, personal_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, userId, firstName, middleName, lastName, title, company, phone, email, metDate, metContext, introducer, howWeMetNotes, personalNotes]
      );
      finalContactId = cRes.insertId;
    }

    // Save Sources
    if (accepted_items?.sources && Array.isArray(accepted_items.sources)) {
      for (const item of accepted_items.sources) {
        const cleanSrc = getVal(item);
        if (!cleanSrc) continue;
        // Insert source if not exists for owner
        await connection.query(
          `INSERT INTO sources (owner_user_id, created_by, name) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,
          [userId, userId, cleanSrc]
        );
        const [srcRow] = await connection.query(
          `SELECT id FROM sources WHERE owner_user_id = ? AND name = ? LIMIT 1`,
          [userId, cleanSrc]
        );
        if (srcRow.length > 0) {
          const sourceId = srcRow[0].id;
          await connection.query(
            `INSERT IGNORE INTO contact_sources (contact_id, source_id) VALUES (?, ?)`,
            [finalContactId, sourceId]
          );
        }
      }
    }

    // Save Interaction if accepted
    let createdInteractionId = null;
    const interDetails = getVal(accepted_items?.interaction?.details);
    if (interDetails) {
      const interType = getVal(accepted_items?.interaction?.type) || 'Meeting';
      const interDate = getVal(accepted_items?.interaction?.date) || new Date().toISOString().split('T')[0];

      const [iRes] = await connection.query(
        `INSERT INTO interactions (contact_id, occurred_at, interaction_type, details, follow_up_status)
         VALUES (?, ?, ?, ?, 'none')`,
        [finalContactId, interDate, interType, interDetails]
      );
      createdInteractionId = iRes.insertId;
    }

    // Save Commitments
    const createdCommitments = [];
    if (accepted_items?.commitments && Array.isArray(accepted_items.commitments)) {
      for (const com of accepted_items.commitments) {
        if (!com.title) continue;
        const [comRes] = await connection.query(
          `INSERT INTO commitments (owner_user_id, contact_id, interaction_id, type, title, details, due_time, status, source_input_event_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?)`,
          [
            userId,
            finalContactId,
            createdInteractionId,
            com.type || 'follow_up',
            com.title,
            com.details || null,
            com.due_time || null,
            input_event_id
          ]
        );
        createdCommitments.push({
          id: comRes.insertId,
          type: com.type || 'follow_up',
          title: com.title,
          due_time: com.due_time
        });
      }
    }

    // Save Fact Provenance records for audit trail
    const provenanceEntries = [
      { fact_type: 'person_contact', target: `contacts:${finalContactId}`, excerpt: `Extracted person: ${firstName} ${lastName}` },
      { fact_type: 'interaction', target: createdInteractionId ? `interactions:${createdInteractionId}` : `contacts:${finalContactId}`, excerpt: inputEvent.raw_content }
    ];

    for (const p of provenanceEntries) {
      await connection.query(
        `INSERT INTO fact_provenance (owner_user_id, input_event_id, target_reference, fact_type, source_excerpt, confirmation_time)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [userId, input_event_id, p.target, p.fact_type, p.excerpt]
      );
    }

    // Update Input Event and Candidate Fact statuses
    await connection.query(
      `UPDATE input_events SET processing_status = 'COMMITTED' WHERE id = ? AND owner_user_id = ?`,
      [input_event_id, userId]
    );

    await connection.query(
      `UPDATE candidate_facts SET status = 'ACCEPTED' WHERE input_event_id = ? AND owner_user_id = ?`,
      [input_event_id, userId]
    );

    await connection.commit();
    connection.release();

    return res.json({
      success: true,
      contact_id: finalContactId,
      input_event_id,
      commitments: createdCommitments
    });

  } catch (err) {
    await connection.rollback();
    connection.release();
    console.error('Error committing Tell Dossier data:', err);
    return res.status(500).json({ error: 'Failed to commit Dossier data' });
  }
});

module.exports = router;
