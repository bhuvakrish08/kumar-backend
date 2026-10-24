const express = require('express');
const router = express.Router();
const { getPool } = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { extractCandidateFactsWithAdapter } = require('../lib/aiAdapter');
const { resolveIdentity } = require('../lib/identityResolution');
const { analyzeTemporalTransitions, saveContactHistoryTransitions } = require('../lib/temporalReconciliation');
const { PARSER_VERSION } = require('../lib/intelligence');
const { buildNarrative } = require('../lib/narrative');

/**
 * POST /api/v1/tell-dossier/analyze
 * Step 1 of Tell Dossier: Parse messy text, run strict AI validation, identity resolution v0.2, and temporal analysis.
 */
router.post('/analyze', requireAuth, async (req, res) => {
  const isStream = req.body?.stream === true || (req.headers['accept'] && req.headers['accept'].includes('text/event-stream'));

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  }

  const sendProgress = (stage, percent, message, data = null) => {
    if (isStream) {
      res.write(`data: ${JSON.stringify({ stage, percent, message, data })}\n\n`);
    }
  };

  try {
    const userId = req.user.id;
    const { raw_content, event_time_hint } = req.body;

    if (!raw_content || typeof raw_content !== 'string' || raw_content.trim() === '') {
      if (isStream) {
        sendProgress('ERROR', 0, 'raw_content is required');
        return res.end();
      }
      return res.status(400).json({ error: 'raw_content is required' });
    }

    sendProgress('INITIALIZING', 12, 'Input captured & analysis initialized');

    const pool = getPool();

    // 1. Create Input Event
    const [eventRes] = await pool.query(
      `INSERT INTO input_events (owner_user_id, input_type, raw_content, capture_time, event_time_hint, processing_status, parser_version)
       VALUES (?, 'text', ?, NOW(), ?, 'PROCESSING', ?)`,
      [userId, raw_content.trim(), event_time_hint || null, PARSER_VERSION]
    );
    const inputEventId = eventRes.insertId;

    sendProgress('AI_EXTRACTING', 28, 'Polishing memory & analyzing facts...');

    // 2. Extract & Validate Candidate Facts (via AI Adapter & Strict CandidateFactSet Schema Validator)
    const extraction = await extractCandidateFactsWithAdapter(raw_content, {
      userId,
      correlationId: req.correlationId,
      userRegion: req.user ? req.user.phone_region : null,
      onProgress: (p, msg) => sendProgress('AI_EXTRACTING', p, msg)
    });

    sendProgress('SCHEMA_VALIDATED', 64, 'Candidate facts extracted & schema validated');

    // 3. Fetch User's existing contacts for identity resolution
    sendProgress('FETCHING_CONTACTS', 72, 'Scanning existing contacts...');
    const [existingContacts] = await pool.query(
      `SELECT id, first_name, middle_name, last_name, nickname, company_name, job_title, primary_email, primary_phone, mobile_phone, introduced_by_name, how_we_met_notes
       FROM contacts WHERE owner_user_id = ?`,
      [userId]
    );

    // 4. Analyze Temporal Transitions (e.g. "John left IBM and joined Amazon")
    sendProgress('TEMPORAL_ANALYSIS', 80, 'Analyzing temporal career transitions...');
    const temporalAnalysis = analyzeTemporalTransitions(raw_content, extraction.person, null);

    // 5. Run Identity Resolution Engine v0.2
    sendProgress('IDENTITY_RESOLUTION', 88, 'Resolving identity & duplicate check...');
    const identityRes = resolveIdentity(extraction.person, existingContacts, {
      isTemporalEmployerChange: temporalAnalysis.isTemporalEmployerChange
    });

    // 6. Store Candidate Facts in DB
    sendProgress('STORING_FACTS', 95, 'Storing candidate facts & preparing review...');
    const confidenceScore = identityRes.decision === 'MATCH' ? 0.95 : identityRes.decision === 'PROBABLE_MATCH' ? 0.75 : 0.50;
    const conflictState = identityRes.decision === 'CONFLICT' ? 'CONFLICT' : identityRes.decision === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'NONE';

    const [factRes] = await pool.query(
      `INSERT INTO candidate_facts (owner_user_id, input_event_id, candidate_type, structured_payload, confidence, status, conflict_state)
       VALUES (?, ?, 'tell_dossier_extraction', ?, ?, 'PENDING', ?)`,
      [userId, inputEventId, JSON.stringify(extraction), confidenceScore, conflictState]
    );
    const candidateFactId = factRes.insertId;

    // Update Input Event processing status and polished_content
    await pool.query(
      `UPDATE input_events SET processing_status = 'ANALYZED', polished_content = ? WHERE id = ? AND owner_user_id = ?`,
      [extraction.polishedMemory || null, inputEventId, userId]
    );

    // 7. Build structured review items
    let matchedContact = null;
    if (identityRes.matchedContactId) {
      const [matchedRows] = await pool.query(
        `SELECT id, first_name, middle_name, last_name, nickname, company_name, job_title, primary_email, primary_phone, mobile_phone
         FROM contacts WHERE id = ? AND owner_user_id = ?`,
        [identityRes.matchedContactId, userId]
      );
      if (matchedRows.length > 0) matchedContact = matchedRows[0];
    }

    const personRole = extraction.person.title || extraction.person.professional_role || '';

    const reviewItems = {
      contact_info: {
        name: { value: extraction.person.name || '', status: matchedContact ? 'RECONFIRM' : 'ADD' },
        phone: { value: extraction.person.phone || '', status: matchedContact ? (matchedContact.primary_phone || matchedContact.mobile_phone ? 'UPDATE' : 'ADD') : 'ADD' },
        email: { value: extraction.person.email || '', status: matchedContact ? (matchedContact.primary_email ? 'UPDATE' : 'ADD') : 'ADD' },
        title: { value: personRole, status: matchedContact ? 'UPDATE' : 'ADD' }
      },
      organization: {
        company_name: { value: extraction.person.organization || '', status: matchedContact ? (matchedContact.company_name ? 'UPDATE' : 'ADD') : 'ADD' },
        job_title: { value: personRole, status: matchedContact ? 'UPDATE' : 'ADD' }
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
        date: {
          value: extraction.interaction.date || null,
          raw_expression: extraction.interaction.raw_date_expression || null,
          status: extraction.interaction.date ? 'ADD' : 'UNKNOWN'
        }
      } : null,
      notes: { value: extraction.person.notes || raw_content, status: 'ADD' },
      sources: extraction.sources.map(s => ({ value: s, status: 'ADD' })),
      commitments: extraction.commitments.map(c => ({
        type: c.type,
        title: c.title,
        details: c.details,
        due_time: c.due_time,
        status: 'ADD'
      })),
      temporal_transitions: temporalAnalysis.historyTransitions
    };

    const finalResult = {
      input_event_id: inputEventId,
      candidate_fact_id: candidateFactId,
      raw_content: raw_content,
      polished_memory: extraction.polishedMemory || null,
      extraction,
      identity_resolution: {
        decision: identityRes.decision,
        matched_contact: matchedContact,
        candidate_contacts: (identityRes.candidateContacts || []).map(c => ({
          ...c,
          id: c.id || c.contactId,
          contactId: c.contactId || c.id,
          first_name: c.first_name || (c.contactName ? c.contactName.split(' ')[0] : ''),
          last_name: c.last_name || (c.contactName ? c.contactName.split(' ').slice(1).join(' ') : ''),
          company_name: c.company_name || c.company || ''
        })),
        evidence: identityRes.evidence,
        model_version: identityRes.model_version
      },
      temporal_analysis: temporalAnalysis,
      review_items: reviewItems
    };

    if (isStream) {
      sendProgress('COMPLETE', 100, 'Ready!', finalResult);
      return res.end();
    }

    return res.json(finalResult);

  } catch (err) {
    console.error('Error analyzing Tell Dossier input:', err);
    if (isStream) {
      sendProgress('ERROR', 0, err.message || 'Failed to analyze Dossier input');
      return res.end();
    }
    return res.status(500).json({ error: 'Failed to analyze Dossier input' });
  }
});

/**
 * POST /api/v1/tell-dossier/commit
 * Step 2 of Tell Dossier: Save user-accepted candidate facts to authoritative DB with provenance and temporal history.
 */
// Strict schema validation for accepted_items to reject arbitrary injected fields
const ALLOWED_TOP_LEVEL_KEYS = new Set([
  'contact_info',
  'organization',
  'how_we_met',
  'interaction',
  'notes',
  'sources',
  'commitments',
  'temporal_transitions'
]);

const ALLOWED_CONTACT_KEYS = new Set(['name', 'phone', 'email', 'title']);
const ALLOWED_ORG_KEYS = new Set(['company_name', 'job_title']);
const ALLOWED_HOW_WE_MET_KEYS = new Set(['met_date', 'met_context', 'introduced_by_name', 'how_we_met_notes']);
const ALLOWED_INTERACTION_KEYS = new Set(['type', 'details', 'date']);
const ALLOWED_COMMITMENT_KEYS = new Set(['id', 'type', 'title', 'details', 'due_time', 'status']);
const ALLOWED_TRANSITION_KEYS = new Set([
  'fact_type', 'current_value', 'proposed_value', 'value_payload',
  'effective_time', 'observation_time', 'temporal_precision', 'raw_time_expression',
  'status', 'approved', 'is_current', 'confidence_status', 'valid_from', 'valid_to', 'candidate_fact_id'
]);

function validateAcceptedItems(acceptedItems) {
  if (!acceptedItems || typeof acceptedItems !== 'object') {
    return { valid: true };
  }
  for (const key of Object.keys(acceptedItems)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
      return { valid: false, error: `Forbidden or injected field in accepted_items: ${key}` };
    }
  }

  if (acceptedItems.contact_info && typeof acceptedItems.contact_info === 'object') {
    for (const key of Object.keys(acceptedItems.contact_info)) {
      if (!ALLOWED_CONTACT_KEYS.has(key)) {
        return { valid: false, error: `Forbidden field in contact_info: ${key}` };
      }
    }
  }

  if (acceptedItems.organization && typeof acceptedItems.organization === 'object') {
    for (const key of Object.keys(acceptedItems.organization)) {
      if (!ALLOWED_ORG_KEYS.has(key)) {
        return { valid: false, error: `Forbidden field in organization: ${key}` };
      }
    }
  }

  if (acceptedItems.how_we_met && typeof acceptedItems.how_we_met === 'object') {
    for (const key of Object.keys(acceptedItems.how_we_met)) {
      if (!ALLOWED_HOW_WE_MET_KEYS.has(key)) {
        return { valid: false, error: `Forbidden field in how_we_met: ${key}` };
      }
    }
  }

  if (acceptedItems.interaction && typeof acceptedItems.interaction === 'object') {
    for (const key of Object.keys(acceptedItems.interaction)) {
      if (!ALLOWED_INTERACTION_KEYS.has(key)) {
        return { valid: false, error: `Forbidden field in interaction: ${key}` };
      }
    }
  }

  if (acceptedItems.commitments) {
    if (!Array.isArray(acceptedItems.commitments)) {
      return { valid: false, error: 'commitments must be an array' };
    }
    for (const com of acceptedItems.commitments) {
      if (typeof com !== 'object' || com === null) {
        return { valid: false, error: 'Invalid commitment entry' };
      }
      for (const k of Object.keys(com)) {
        if (!ALLOWED_COMMITMENT_KEYS.has(k)) {
          return { valid: false, error: `Forbidden field in commitment: ${k}` };
        }
      }
    }
  }

  if (acceptedItems.temporal_transitions) {
    if (!Array.isArray(acceptedItems.temporal_transitions)) {
      return { valid: false, error: 'temporal_transitions must be an array' };
    }
    for (const tr of acceptedItems.temporal_transitions) {
      if (typeof tr !== 'object' || tr === null) {
        return { valid: false, error: 'Invalid temporal transition entry' };
      }
      for (const k of Object.keys(tr)) {
        if (!ALLOWED_TRANSITION_KEYS.has(k)) {
          return { valid: false, error: `Forbidden field in temporal_transition: ${k}` };
        }
      }
    }
  }

  return { valid: true };
}

/**
 * POST /api/v1/tell-dossier/commit
 * Step 2 of Tell Dossier: Save user-accepted candidate facts to authoritative DB with provenance and temporal history.
 * Hardened with:
 * - Server-side identity conflict verification (browser spoofing blocked)
 * - Strict candidate_fact_id / input_event_id / owner_user_id validation
 * - Injected field rejection in accepted_items
 * - Target contact ownership verification (IDOR blocked)
 * - Single atomic MySQL transaction with complete rollback on error
 */
router.post('/commit', requireAuth, async (req, res) => {
  const connection = await getPool().getConnection();
  try {
    const userId = req.user.id;
    const { input_event_id, candidate_fact_id, identity_decision, target_person_option, target_contact_id, accepted_items, polished_memory } = req.body;

    if (!input_event_id) {
      connection.release();
      return res.status(400).json({ error: 'input_event_id is required' });
    }

    // 1. Security Check: Verify Input Event belongs to authenticated user
    const [eventRows] = await connection.query(
      `SELECT * FROM input_events WHERE id = ? AND owner_user_id = ?`,
      [input_event_id, userId]
    );

    if (eventRows.length === 0) {
      connection.release();
      return res.status(404).json({ error: 'Input event not found or unauthorized' });
    }
    const inputEvent = eventRows[0];

    // Idempotency: Protect against duplicate button clicks / repeat submissions
    if (inputEvent.processing_status === 'COMMITTED') {
      const [existingProv] = await connection.query(
        'SELECT target_id FROM fact_provenance WHERE input_event_id = ? AND target_type = "contact" AND owner_user_id = ? LIMIT 1',
        [input_event_id, userId]
      );
      connection.release();
      const existingContactId = existingProv.length > 0 ? existingProv[0].target_id : (target_contact_id || null);
      return res.json({
        success: true,
        is_idempotent: true,
        message: 'Input event has already been safely committed',
        contact_id: existingContactId
      });
    }

    // 2. Validate accepted_items against strict allowed schema
    const validationRes = validateAcceptedItems(accepted_items);
    if (!validationRes.valid) {
      connection.release();
      return res.status(400).json({ error: validationRes.error });
    }

    // 3. Security Check: Verify Candidate Fact belongs to this input event and user
    let candidateFact = null;
    if (candidate_fact_id) {
      const [candRows] = await connection.query(
        `SELECT * FROM candidate_facts WHERE id = ? AND input_event_id = ? AND owner_user_id = ?`,
        [candidate_fact_id, input_event_id, userId]
      );
      if (candRows.length === 0) {
        connection.release();
        return res.status(403).json({ error: 'Candidate fact does not match input event or belongs to another user' });
      }
      candidateFact = candRows[0];
    } else {
      const [candRows] = await connection.query(
        `SELECT * FROM candidate_facts WHERE input_event_id = ? AND owner_user_id = ? ORDER BY id DESC LIMIT 1`,
        [input_event_id, userId]
      );
      if (candRows.length > 0) {
        candidateFact = candRows[0];
      }
    }

    // 4. Server-Side Identity Conflict Enforcement:
    // Browser cannot spoof CONFLICT / AMBIGUOUS to MATCH. Server checks candidateFact.conflict_state directly from DB.
    const trustedConflictState = candidateFact ? candidateFact.conflict_state : 'NONE';
    const effectiveDecision = identity_decision || trustedConflictState;
    if (trustedConflictState === 'AMBIGUOUS' || trustedConflictState === 'CONFLICT' || effectiveDecision === 'AMBIGUOUS' || effectiveDecision === 'CONFLICT') {
      const hasValidResolution =
        (target_person_option === 'new' || target_person_option === 'new_person') ||
        (target_person_option === 'existing' && Boolean(target_contact_id));

      if (!hasValidResolution) {
        connection.release();
        return res.status(400).json({
          error: 'Ambiguous or conflicting identity requires explicit user selection of an authorized existing contact or New Person'
        });
      }
    }

    // 5. Target Contact Ownership Verification (IDOR Protection)
    let existingContactObj = null;
    if (target_person_option === 'existing') {
      if (!target_contact_id) {
        connection.release();
        return res.status(400).json({ error: 'target_contact_id is required when target_person_option is existing' });
      }

      const [contactRows] = await connection.query(
        `SELECT * FROM contacts WHERE id = ? AND owner_user_id = ?`,
        [target_contact_id, userId]
      );

      if (contactRows.length === 0) {
        connection.release();
        return res.status(403).json({ error: 'Target contact not found or unauthorized' });
      }
      existingContactObj = contactRows[0];
    }

    // Start single atomic transaction
    await connection.beginTransaction();

    let finalContactId = null;

    // Helper to safely extract string value
    const getVal = (v) => {
      if (!v) return null;
      if (typeof v === 'string') return v.trim();
      if (typeof v === 'object' && v.value !== undefined) return typeof v.value === 'string' ? v.value.trim() : v.value;
      return String(v).trim();
    };

    // Parse person name into first, middle, last
    const nameStr = getVal(accepted_items?.contact_info?.name) || null;
    let firstName = null;
    let middleName = null;
    let lastName = null;

    if (nameStr) {
      const nameParts = nameStr.split(/\s+/);
      firstName = nameParts[0] || null;
      lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : null;
      if (nameParts.length > 2) {
        middleName = nameParts.slice(1, -1).join(' ');
        lastName = nameParts[nameParts.length - 1];
      }
    } else if (target_person_option !== 'existing') {
      firstName = 'Unknown';
      lastName = '';
    }

    const phone = getVal(accepted_items?.contact_info?.phone);
    const email = getVal(accepted_items?.contact_info?.email);
    const title = getVal(accepted_items?.contact_info?.title) || getVal(accepted_items?.organization?.job_title);
    const company = getVal(accepted_items?.organization?.company_name);
    const metDate = getVal(accepted_items?.how_we_met?.met_date);
    const metContext = getVal(accepted_items?.how_we_met?.met_context);
    const introducer = getVal(accepted_items?.how_we_met?.introduced_by_name);
    const howWeMetNotes = getVal(accepted_items?.how_we_met?.how_we_met_notes);
    const resolvedMemory = (typeof polished_memory === 'string' && polished_memory.trim())
      ? polished_memory.trim()
      : (inputEvent.polished_content || inputEvent.raw_content);
    const personalNotes = getVal(accepted_items?.notes) || resolvedMemory;

    if (target_person_option === 'existing' && existingContactObj) {
      finalContactId = existingContactObj.id;

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
    } else {
      // Create NEW person contact
      const [cRes] = await connection.query(
        `INSERT INTO contacts (owner_user_id, created_by, first_name, middle_name, last_name, job_title, company_name, primary_phone, primary_email, met_date, met_context, introduced_by_name, how_we_met_notes, personal_notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, userId, firstName, middleName, lastName, title, company, phone, email, metDate, metContext, introducer, howWeMetNotes, personalNotes]
      );
      finalContactId = cRes.insertId;
    }

    const candFactId = candidateFact ? candidateFact.id : (candidate_fact_id || null);

    // Temporal Reconciliation: Save temporal history transitions
    const temporalAnalysis = analyzeTemporalTransitions(inputEvent.raw_content, { name: nameStr, phone, email, organization: company }, existingContactObj);
    if (accepted_items?.temporal_transitions && Array.isArray(accepted_items.temporal_transitions)) {
      await saveContactHistoryTransitions(connection, userId, finalContactId, input_event_id, accepted_items.temporal_transitions, candFactId);
    } else if (temporalAnalysis.historyTransitions.length > 0) {
      await saveContactHistoryTransitions(connection, userId, finalContactId, input_event_id, temporalAnalysis.historyTransitions, candFactId);
    }

    // Save Sources
    if (accepted_items?.sources && Array.isArray(accepted_items.sources)) {
      for (const item of accepted_items.sources) {
        const cleanSrc = getVal(item);
        if (!cleanSrc) continue;
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
    const interDetails = getVal(accepted_items?.interaction?.details) || resolvedMemory || inputEvent.raw_content;
    if (interDetails) {
      const interType = getVal(accepted_items?.interaction?.type) || 'Meeting';
      const rawDateVal = getVal(accepted_items?.interaction?.date);
      const interDate = (rawDateVal && typeof rawDateVal === 'string' && rawDateVal.trim() !== '' && !['null', 'unknown', 'undefined'].includes(rawDateVal.toLowerCase())) ? rawDateVal.trim() : null;
      const rawTimeExpr = getVal(accepted_items?.interaction?.raw_date_expression) || getVal(accepted_items?.how_we_met?.how_we_met_notes) || null;

      const [iRes] = await connection.query(
        `INSERT INTO interactions (contact_id, occurred_at, raw_time_expression, interaction_type, details, follow_up_status)
         VALUES (?, ?, ?, ?, ?, 'none')`,
        [finalContactId, interDate, rawTimeExpr, interType, interDetails]
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

    // Save Normalized Fact Provenance records with candidate_fact_id, target_type, target_id
    const provenanceEntries = [
      {
        candidate_fact_id: candFactId,
        target_type: 'contact',
        target_id: finalContactId,
        target_reference: `contacts:${finalContactId}`,
        fact_type: 'person_contact',
        source_excerpt: `Extracted person: ${firstName} ${lastName}`
      },
      {
        candidate_fact_id: candFactId,
        target_type: createdInteractionId ? 'interaction' : 'contact',
        target_id: createdInteractionId || finalContactId,
        target_reference: createdInteractionId ? `interactions:${createdInteractionId}` : `contacts:${finalContactId}`,
        fact_type: 'interaction',
        source_excerpt: inputEvent.raw_content
      }
    ];

    for (const p of provenanceEntries) {
      await connection.query(
        `INSERT INTO fact_provenance (owner_user_id, input_event_id, candidate_fact_id, target_type, target_id, target_reference, fact_type, source_excerpt, confirmation_time)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [userId, input_event_id, p.candidate_fact_id, p.target_type, p.target_id, p.target_reference, p.fact_type, p.source_excerpt]
      );
    }

    // Update Input Event and Candidate Fact statuses
    await connection.query(
      `UPDATE input_events SET processing_status = 'COMMITTED', polished_content = COALESCE(?, polished_content) WHERE id = ? AND owner_user_id = ?`,
      [(typeof polished_memory === 'string' && polished_memory.trim()) ? polished_memory.trim() : null, input_event_id, userId]
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

/**
 * GET /api/v1/tell-dossier/contact-history/:contactId
 * Fetches temporal history & provenance for a contact strictly scoped to authenticated owner.
 */
router.get('/contact-history/:contactId', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const contactId = Number(req.params.contactId);
    if (!contactId || isNaN(contactId)) {
      return res.status(400).json({ error: 'Invalid contact ID' });
    }

    const pool = getPool();
    // Strictly verify contact belongs to authenticated user
    const [cRows] = await pool.query(
      'SELECT id, first_name, last_name, company_name FROM contacts WHERE id = ? AND owner_user_id = ? LIMIT 1',
      [contactId, userId]
    );
    if (cRows.length === 0) {
      return res.status(404).json({ error: 'Contact not found or unauthorized' });
    }

    const [historyRows] = await pool.query(
      `SELECT ch.*, ie.raw_content AS source_raw_content, ie.capture_time, cf.candidate_type
       FROM contact_history ch
       LEFT JOIN input_events ie ON ie.id = ch.source_input_event_id AND ie.owner_user_id = ?
       LEFT JOIN candidate_facts cf ON cf.id = ch.candidate_fact_id AND cf.owner_user_id = ?
       WHERE ch.contact_id = ? AND ch.owner_user_id = ?
       ORDER BY ch.is_current DESC, ch.valid_from DESC, ch.id DESC`,
      [userId, userId, contactId, userId]
    );

    return res.json({
      contact: cRows[0],
      history: historyRows
    });
  } catch (err) {
    console.error('Error fetching contact history:', err);
    return res.status(500).json({ error: 'Failed to fetch contact history' });
  }
});

module.exports = router;
