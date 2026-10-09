/**
 * Temporal Reconciliation & History Engine (Sprint 2 Blocker #4)
 * Recognizes temporal language, creates contact_history records, and prevents blind overwrites.
 */

/**
 * Analyzes input text for temporal language and constructs structured history facts.
 * @param {string} rawContent - Input text from user memory
 * @param {Object} extractedPerson - Candidate person facts (name, company, phone, email)
 * @param {Object|null} existingContact - Matched contact record from DB if present
 * @returns {Object} Temporal analysis containing historyTransitions, isTemporalEmployerChange, uncertainDates
 */
function analyzeTemporalTransitions(rawContent, extractedPerson = {}, existingContact = null) {
  const text = (rawContent || '').trim();
  const lower = text.toLowerCase();

  const historyTransitions = [];
  let isTemporalEmployerChange = false;
  const uncertainDates = [];

  // Temporal Keywords & Patterns
  const formerOrgPatterns = [
    /(?:left|departed\s+from|used\s+to\s+work\s+at|former\s+(?:employee\s+at|at)|previously\s+at)\s+([A-Z0-9][a-zA-C0-9&.\s]{1,30}?)(?=\s+and|\s+joined|\s+now|\.|\,|$)/i
  ];
  const currentOrgPatterns = [
    /(?:joined|now\s+at|currently\s+at|moved\s+to|new\s+role\s+at|is\s+now\s+at)\s+([A-Z0-9][a-zA-C0-9&.\s]{1,30}?)(?=\s+as|\s+today|\.|\,|$)/i
  ];
  const futureOrgPatterns = [
    /(?:joining|may\s+join|planning\s+to\s+join|moving\s+to)\s+([A-Z0-9][a-zA-C0-9&.\s]{1,30}?)(?=\s+next\s+month|\s+soon|\s+next\s+year|\.|\,|$)/i
  ];

  // 1. Employment History Reconciliation
  let formerCompany = null;
  let currentCompany = null;
  let futureCompany = null;

  for (const pat of formerOrgPatterns) {
    const m = text.match(pat);
    if (m) {
      formerCompany = m[1].trim();
      break;
    }
  }
  for (const pat of currentOrgPatterns) {
    const m = text.match(pat);
    if (m) {
      currentCompany = m[1].trim();
      break;
    }
  }
  for (const pat of futureOrgPatterns) {
    const m = text.match(pat);
    if (m) {
      futureCompany = m[1].trim();
      break;
    }
  }

  // Case 1: "John left IBM and joined Amazon."
  if (formerCompany || currentCompany) {
    isTemporalEmployerChange = true;
    if (formerCompany) {
      historyTransitions.push({
        fact_type: 'employment',
        value_payload: { company_name: formerCompany },
        is_current: false,
        confidence_status: 'HISTORICAL',
        valid_to: new Date()
      });
    }
    if (currentCompany) {
      historyTransitions.push({
        fact_type: 'employment',
        value_payload: { company_name: currentCompany },
        is_current: true,
        confidence_status: 'CONFIRMED',
        valid_from: new Date()
      });
    }
  }

  // Case 3: "He used to work at L'Oreal."
  if (lower.includes('used to work at') || lower.includes('former employee')) {
    if (!currentCompany && extractedPerson.organization) {
      historyTransitions.push({
        fact_type: 'employment',
        value_payload: { company_name: extractedPerson.organization },
        is_current: false,
        confidence_status: 'HISTORICAL',
        valid_to: new Date()
      });
      isTemporalEmployerChange = true;
    }
  }

  // Case 4: "He may be joining Amazon next month." -> Future/Uncertain Fact
  if (futureCompany || lower.includes('next month') || lower.includes('may be joining')) {
    const targetFutureComp = futureCompany || extractedPerson.organization || 'Unspecified Company';
    historyTransitions.push({
      fact_type: 'employment',
      value_payload: { company_name: targetFutureComp, note: 'Future/Uncertain transition specified in text' },
      is_current: false,
      confidence_status: 'FUTURE',
      valid_from: null
    });
    uncertainDates.push(`Future transition to ${targetFutureComp} specified without exact date`);
  }

  // 2. Phone History Reconciliation
  // Case 2: "His new mobile is X."
  if (lower.includes('new mobile') || lower.includes('new phone') || lower.includes('changed phone')) {
    if (existingContact && (existingContact.primary_phone || existingContact.mobile_phone) && extractedPerson.phone) {
      const oldPhone = existingContact.primary_phone || existingContact.mobile_phone;
      if (oldPhone !== extractedPerson.phone) {
        historyTransitions.push({
          fact_type: 'phone',
          value_payload: { phone: oldPhone },
          is_current: false,
          confidence_status: 'HISTORICAL',
          valid_to: new Date()
        });
        historyTransitions.push({
          fact_type: 'phone',
          value_payload: { phone: extractedPerson.phone },
          is_current: true,
          confidence_status: 'CONFIRMED',
          valid_from: new Date()
        });
      }
    }
  }

  // 3. Email History Reconciliation
  if (lower.includes('new email') || lower.includes('changed email')) {
    if (existingContact && existingContact.primary_email && extractedPerson.email) {
      if (existingContact.primary_email !== extractedPerson.email) {
        historyTransitions.push({
          fact_type: 'email',
          value_payload: { email: existingContact.primary_email },
          is_current: false,
          confidence_status: 'HISTORICAL',
          valid_to: new Date()
        });
        historyTransitions.push({
          fact_type: 'email',
          value_payload: { email: extractedPerson.email },
          is_current: true,
          confidence_status: 'CONFIRMED',
          valid_from: new Date()
        });
      }
    }
  }

  // If existing contact has an old company and extracted person has a new company without explicit former phrase, record transition
  if (existingContact && existingContact.company_name && extractedPerson.organization && existingContact.company_name !== extractedPerson.organization) {
    if (!historyTransitions.some(h => h.fact_type === 'employment' && h.value_payload.company_name === existingContact.company_name)) {
      historyTransitions.push({
        fact_type: 'employment',
        value_payload: { company_name: existingContact.company_name },
        is_current: false,
        confidence_status: 'HISTORICAL',
        valid_to: new Date()
      });
      isTemporalEmployerChange = true;
    }
    if (!historyTransitions.some(h => h.fact_type === 'employment' && h.is_current)) {
      historyTransitions.push({
        fact_type: 'employment',
        value_payload: { company_name: extractedPerson.organization },
        is_current: true,
        confidence_status: 'CONFIRMED',
        valid_from: new Date()
      });
    }
  }

  return {
    historyTransitions,
    isTemporalEmployerChange,
    uncertainDates
  };
}

/**
 * Saves contact history transitions transactionally into contact_history table
 */
async function saveContactHistoryTransitions(connection, userId, contactId, inputEventId, transitions = []) {
  if (!transitions || transitions.length === 0) return;

  for (const trans of transitions) {
    // If setting a new current fact, update previous entries for this contact and fact_type to is_current = 0
    if (trans.is_current) {
      await connection.query(
        `UPDATE contact_history
         SET is_current = 0, valid_to = NOW(), confidence_status = 'HISTORICAL'
         WHERE owner_user_id = ? AND contact_id = ? AND fact_type = ? AND is_current = 1`,
        [userId, contactId, trans.fact_type]
      );
    }

    await connection.query(
      `INSERT INTO contact_history (owner_user_id, contact_id, fact_type, value_payload, valid_from, valid_to, is_current, confidence_status, source_input_event_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        contactId,
        trans.fact_type,
        JSON.stringify(trans.value_payload),
        trans.valid_from ? new Date(trans.valid_from) : (trans.is_current ? new Date() : null),
        trans.valid_to ? new Date(trans.valid_to) : null,
        trans.is_current ? 1 : 0,
        trans.confidence_status || 'CONFIRMED',
        inputEventId || null
      ]
    );
  }
}

module.exports = {
  analyzeTemporalTransitions,
  saveContactHistoryTransitions
};
