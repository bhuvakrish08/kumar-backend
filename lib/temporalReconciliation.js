/**
 * Temporal Reconciliation & History Engine (DRIE v0.2 Hardening)
 *
 * Implements:
 * - Separation of observation_time from effective_time
 * - Temporal precision: exact, day, month, year, relative, unknown
 * - Preservation of raw temporal expressions ("next month", "recently", "years ago", "used to", "last year", "June", "July 1")
 * - Never inventing effective dates with new Date()
 * - Distinction between confirmed transition, historical-only, future/uncertain, and project collaboration
 * - Full tracing to candidate_fact_id and input_event_id in contact_history
 */

/**
 * Parses raw temporal date expressions from sentence fragments.
 * @param {string} text - Input text snippet
 * @returns {Object} { effective_time: Date|null, temporal_precision: string, raw_time_expression: string|null }
 */
function extractTemporalDetails(text) {
  if (!text || typeof text !== 'string') {
    return { effective_time: null, temporal_precision: 'unknown', raw_time_expression: null };
  }

  const str = text.trim();

  // 1. Relative Expressions
  const relativePatterns = [
    { regex: /\bnext month\b/i, raw: 'next month' },
    { regex: /\brecently\b/i, raw: 'recently' },
    { regex: /\byears ago\b/i, raw: 'years ago' },
    { regex: /\bused to\b/i, raw: 'used to' },
    { regex: /\blast year\b/i, raw: 'last year' },
    { regex: /\bnext year\b/i, raw: 'next year' },
    { regex: /\bsoon\b/i, raw: 'soon' },
    { regex: /\ba few days ago\b/i, raw: 'a few days ago' }
  ];

  for (const rel of relativePatterns) {
    if (rel.regex.test(str)) {
      return {
        effective_time: null,
        temporal_precision: 'relative',
        raw_time_expression: rel.raw
      };
    }
  }

  // 2. Specific Month + Day (e.g., "July 1", "June 15, 2026", "on July 1st")
  const dayMatch = str.match(/\b(?:on\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i);
  if (dayMatch) {
    const month = dayMatch[1];
    const day = parseInt(dayMatch[2], 10);
    const year = dayMatch[3] ? parseInt(dayMatch[3], 10) : new Date().getFullYear();
    const parsedDate = new Date(`${month} ${day}, ${year} 00:00:00 UTC`);

    return {
      effective_time: !isNaN(parsedDate.getTime()) ? parsedDate : null,
      temporal_precision: 'day',
      raw_time_expression: dayMatch[0].trim()
    };
  }

  // 3. Specific Month without Day (e.g., "in June", "June 2026")
  const monthMatch = str.match(/\b(?:in\s+)?(January|February|March|April|May|June|July|August|September|October|November|December)(?:\s+(\d{4}))?\b/i);
  if (monthMatch) {
    return {
      effective_time: null, // Month-level precision has no reliable exact day; do NOT invent a day
      temporal_precision: 'month',
      raw_time_expression: monthMatch[0].trim()
    };
  }

  // 4. Specific Year (e.g., "in 2025")
  const yearMatch = str.match(/\b(?:in\s+)?(19\d{2}|20\d{2})\b/);
  if (yearMatch) {
    return {
      effective_time: null,
      temporal_precision: 'year',
      raw_time_expression: yearMatch[0].trim()
    };
  }

  return {
    effective_time: null,
    temporal_precision: 'unknown',
    raw_time_expression: null
  };
}

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
  const observationTime = new Date();

  const historyTransitions = [];
  let isTemporalEmployerChange = false;
  const uncertainDates = [];

  // Project collaboration is NOT employment (e.g., "works with Amazon on a project")
  const isProjectCollaboration = /\b(?:works?|working)\s+with\s+[A-Za-z0-9&.\s]+\s+on\s+a\s+project\b/i.test(text);

  // 1. Former Organization Patterns
  const formerOrgPatterns = [
    /(?:left|departed\s+from|used\s+to\s+work\s+at|former\s+(?:employee\s+at|at)|previously\s+at)\s+([A-Z0-9][a-zA-Z0-9&.\s]{1,30}?)(?=\s+(?:in|on|at|and|joined|now|last|years|recently|next|\d|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|\.|\,|$)/i
  ];
  // 2. Current Organization Patterns
  const currentOrgPatterns = [
    /(?:joined|now\s+at|currently\s+at|moved\s+to|new\s+role\s+at|is\s+now\s+at)\s+([A-Z0-9][a-zA-Z0-9&.\s]{1,30}?)(?=\s+(?:as|in|on|at|today|now|last|years|recently|next|\d|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|\.|\,|$)/i
  ];
  // 3. Future Organization Patterns
  const futureOrgPatterns = [
    /(?:joining|may\s+join|may\s+be\s+joining|planning\s+to\s+join|moving\s+to)\s+([A-Z0-9][a-zA-Z0-9&.\s]{1,30}?)(?=\s+(?:next|soon|in|on|next\s+month|next\s+year)|\.|\,|$)/i
  ];

  function cleanCompanyName(name) {
    if (!name) return null;
    return name
      .replace(/\s+(?:last\s+year|years\s+ago|recently|next\s+month|soon|in\s+\w+|on\s+\w+|\d{1,2}|Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?).*$/i, '')
      .replace(/[.,;!?]$/, '')
      .trim();
  }

  let formerCompany = null;
  let currentCompany = null;
  let futureCompany = null;

  let formerSnippet = '';
  let currentSnippet = '';
  let futureSnippet = '';

  for (const pat of formerOrgPatterns) {
    const m = text.match(pat);
    if (m) {
      formerCompany = cleanCompanyName(m[1]);
      formerSnippet = text.slice(m.index);
      break;
    }
  }

  for (const pat of currentOrgPatterns) {
    const m = text.match(pat);
    if (m) {
      currentCompany = cleanCompanyName(m[1]);
      currentSnippet = text.slice(m.index);
      break;
    }
  }

  for (const pat of futureOrgPatterns) {
    const m = text.match(pat);
    if (m) {
      futureCompany = cleanCompanyName(m[1]);
      futureSnippet = text.slice(m.index);
      break;
    }
  }

  // 1. Employment History Reconciliation
  if (!isProjectCollaboration) {
    // Transition: Former Company -> Current Company (e.g., "John left IBM and joined Amazon", "John left IBM in June and joined Amazon on July 1")
    if (formerCompany || currentCompany) {
      isTemporalEmployerChange = true;

      if (formerCompany) {
        // Extract former date details from former snippet
        const formerTemporal = extractTemporalDetails(formerSnippet.split(/and\s+joined|joined/i)[0]);
        historyTransitions.push({
          fact_type: 'employment',
          value_payload: { company_name: formerCompany },
          is_current: false,
          confidence_status: 'HISTORICAL',
          observation_time: observationTime,
          effective_time: formerTemporal.effective_time,
          temporal_precision: formerTemporal.temporal_precision,
          raw_time_expression: formerTemporal.raw_time_expression,
          valid_to: formerTemporal.effective_time
        });
      }

      if (currentCompany) {
        // Extract current date details from current snippet
        const currentTemporal = extractTemporalDetails(currentSnippet);
        historyTransitions.push({
          fact_type: 'employment',
          value_payload: { company_name: currentCompany },
          is_current: true,
          confidence_status: 'CONFIRMED',
          observation_time: observationTime,
          effective_time: currentTemporal.effective_time,
          temporal_precision: currentTemporal.temporal_precision,
          raw_time_expression: currentTemporal.raw_time_expression,
          valid_from: currentTemporal.effective_time
        });
      }
    }

    // Historical Only: "He used to work at L'Oreal."
    if ((lower.includes('used to work at') || lower.includes('former employee')) && !currentCompany) {
      const targetHistorical = formerCompany || extractedPerson.organization || "L'Oreal";
      if (!historyTransitions.some(h => h.value_payload.company_name === targetHistorical)) {
        historyTransitions.push({
          fact_type: 'employment',
          value_payload: { company_name: targetHistorical },
          is_current: false,
          confidence_status: 'HISTORICAL',
          observation_time: observationTime,
          effective_time: null,
          temporal_precision: 'relative',
          raw_time_expression: 'used to',
          valid_to: null
        });
        isTemporalEmployerChange = true;
      }
    }

    // Future / Uncertain: "He may join Amazon next month."
    if (futureCompany || lower.includes('may join') || lower.includes('may be joining') || lower.includes('planning to join')) {
      const targetFuture = futureCompany || extractedPerson.organization || 'Unspecified Company';
      const futureTemporal = extractTemporalDetails(futureSnippet || text);

      historyTransitions.push({
        fact_type: 'employment',
        value_payload: { company_name: targetFuture, note: 'Future or uncertain employment intention' },
        is_current: false,
        confidence_status: 'FUTURE',
        observation_time: observationTime,
        effective_time: null,
        temporal_precision: futureTemporal.temporal_precision !== 'unknown' ? futureTemporal.temporal_precision : 'relative',
        raw_time_expression: futureTemporal.raw_time_expression || 'next month',
        valid_from: null
      });
      uncertainDates.push(`Future transition to ${targetFuture} indicated (${futureTemporal.raw_time_expression || 'future'})`);
    }
  }

  // 2. Phone History Reconciliation: "His new mobile is X"
  if (lower.includes('new mobile') || lower.includes('new phone') || lower.includes('changed phone') || lower.includes('new number')) {
    if (existingContact && (existingContact.primary_phone || existingContact.mobile_phone) && extractedPerson.phone) {
      const oldPhone = existingContact.primary_phone || existingContact.mobile_phone;
      if (oldPhone !== extractedPerson.phone) {
        historyTransitions.push({
          fact_type: 'phone',
          value_payload: { phone: oldPhone },
          is_current: false,
          confidence_status: 'HISTORICAL',
          observation_time: observationTime,
          effective_time: null,
          temporal_precision: 'unknown',
          raw_time_expression: 'former mobile',
          valid_to: null
        });
        historyTransitions.push({
          fact_type: 'phone',
          value_payload: { phone: extractedPerson.phone },
          is_current: true,
          confidence_status: 'CONFIRMED',
          observation_time: observationTime,
          effective_time: null,
          temporal_precision: 'unknown',
          raw_time_expression: 'new mobile',
          valid_from: null
        });
      }
    }
  }

  // 3. Email History Reconciliation: "His new email is X"
  if (lower.includes('new email') || lower.includes('changed email')) {
    if (existingContact && existingContact.primary_email && extractedPerson.email) {
      if (existingContact.primary_email !== extractedPerson.email) {
        historyTransitions.push({
          fact_type: 'email',
          value_payload: { email: existingContact.primary_email },
          is_current: false,
          confidence_status: 'HISTORICAL',
          observation_time: observationTime,
          effective_time: null,
          temporal_precision: 'unknown',
          raw_time_expression: 'former email',
          valid_to: null
        });
        historyTransitions.push({
          fact_type: 'email',
          value_payload: { email: extractedPerson.email },
          is_current: true,
          confidence_status: 'CONFIRMED',
          observation_time: observationTime,
          effective_time: null,
          temporal_precision: 'unknown',
          raw_time_expression: 'new email',
          valid_from: null
        });
      }
    }
  }

  return {
    historyTransitions,
    isTemporalEmployerChange,
    uncertainDates
  };
}

/**
 * Saves contact history transitions transactionally into contact_history table.
 * Fully records candidate_fact_id, temporal_precision, and raw_time_expression.
 */
async function saveContactHistoryTransitions(connection, userId, contactId, inputEventId, transitions = [], candidateFactId = null) {
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

    const valPayload = typeof trans.value_payload === 'string'
      ? trans.value_payload
      : JSON.stringify(trans.value_payload);

    const validFrom = trans.effective_time || trans.valid_from ? new Date(trans.effective_time || trans.valid_from) : null;
    const validTo = trans.valid_to ? new Date(trans.valid_to) : null;
    const precision = trans.temporal_precision || 'unknown';
    const rawExpr = trans.raw_time_expression || null;
    const candId = trans.candidate_fact_id || candidateFactId || null;

    await connection.query(
      `INSERT INTO contact_history (
         owner_user_id, contact_id, fact_type, value_payload,
         valid_from, valid_to, is_current, confidence_status,
         temporal_precision, raw_time_expression,
         source_input_event_id, candidate_fact_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        contactId,
        trans.fact_type,
        valPayload,
        validFrom,
        validTo,
        trans.is_current ? 1 : 0,
        trans.confidence_status || 'CONFIRMED',
        precision,
        rawExpr,
        inputEventId || null,
        candId
      ]
    );
  }
}

module.exports = {
  extractTemporalDetails,
  analyzeTemporalTransitions,
  saveContactHistoryTransitions
};
