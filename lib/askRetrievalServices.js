/**
 * Ask Dossier Modular Retrieval Services (v0.2)
 *
 * Implements safe, parameterized retrieval services scoped strictly to owner_user_id = ?
 * - Contact details retrieval (phone, email, role)
 * - Commitments & promises retrieval (pricing, quotes, follow-ups)
 * - Relationships & introducers retrieval
 * - Organizations & context retrieval
 * - Topics & interests retrieval
 * - General person search
 * - Ambiguity handling returning clarification choices rather than matched[0]
 */

/**
 * Service 1: Contact Details & Reachability Retrieval
 */
async function retrieveContactDetails(pool, userId, askIntent, rawQuery) {
  const entityClues = askIntent.entity_clues;

  if (entityClues.length === 0) {
    // If no explicit entity was extracted, do general search
    return null;
  }

  // Parameterized query searching contacts by name
  let nameConditions = entityClues.map(() => `(first_name LIKE ? OR last_name LIKE ? OR nickname LIKE ?)`).join(' OR ');
  let nameParams = [];
  for (const name of entityClues) {
    const likeVal = `%${name}%`;
    nameParams.push(likeVal, likeVal, likeVal);
  }

  const [matched] = await pool.query(
    `SELECT id, first_name, middle_name, last_name, nickname, company_name, job_title,
            primary_phone, mobile_phone, primary_email, introduced_by_name, met_context, personal_notes
     FROM contacts
     WHERE owner_user_id = ? AND (${nameConditions})`,
    [userId, ...nameParams]
  );

  if (matched.length === 0) {
    return {
      answer: `No contact found matching "${entityClues.join(', ')}".`,
      primary_contact: null,
      alternatives: [],
      reason: `Searched owner contacts for name clue(s): ${entityClues.join(', ')}.`,
      requires_clarification: false,
      clarification_choices: []
    };
  }

  // Ambiguity Check: multiple candidates matching entity clue (e.g., two people named David)
  if (matched.length > 1) {
    const choices = matched.map(m => ({
      id: m.id,
      name: `${m.first_name || ''} ${m.last_name || ''}`.trim(),
      company: m.company_name || 'No company listed',
      phone: m.mobile_phone || m.primary_phone || 'No phone recorded'
    }));

    return {
      answer: `Found ${matched.length} contacts matching "${entityClues[0]}": ${choices.map(c => `${c.name} (${c.company})`).join(' and ')}. Please clarify which person you are looking for.`,
      primary_contact: matched[0],
      alternatives: matched.slice(1),
      reason: `Multiple contacts (${matched.length}) matched name criteria. Returning clarification options.`,
      requires_clarification: true,
      clarification_choices: choices
    };
  }

  const contact = matched[0];
  const fullName = `${contact.first_name || ''} ${contact.last_name || ''}`.trim();
  const phone = contact.mobile_phone || contact.primary_phone || 'No phone recorded';
  const email = contact.primary_email || 'No email recorded';

  let answer = '';
  if (askIntent.requested_fact === 'email') {
    answer = `${fullName}'s email address is: ${email}.`;
  } else {
    answer = `${fullName}'s phone number is: ${phone}.`;
  }

  return {
    answer,
    primary_contact: contact,
    alternatives: [],
    reason: `Retrieved contact details for ${fullName} from owner database.`,
    requires_clarification: false,
    clarification_choices: []
  };
}

/**
 * Service 2: Commitments & Promises Retrieval
 */
async function retrieveCommitments(pool, userId, askIntent, rawQuery) {
  const topicFilter = askIntent.commitment_filters?.topic;
  const statusFilter = askIntent.commitment_filters?.status || 'OPEN';

  let query = `
    SELECT cm.*, c.first_name, c.last_name, c.company_name, c.primary_phone, c.primary_email
    FROM commitments cm
    JOIN contacts c ON c.id = cm.contact_id AND c.owner_user_id = ?
    WHERE cm.owner_user_id = ?
  `;
  const params = [userId, userId];

  if (statusFilter !== 'ALL') {
    query += ` AND cm.status = ?`;
    params.push(statusFilter);
  }

  if (topicFilter === 'pricing') {
    query += ` AND (cm.title LIKE '%pricing%' OR cm.details LIKE '%pricing%' OR cm.title LIKE '%quote%' OR cm.details LIKE '%quote%' OR cm.title LIKE '%proposal%' OR cm.details LIKE '%proposal%')`;
  } else if (askIntent.topic_clues.length > 0) {
    const topicLikes = askIntent.topic_clues.map(() => `(cm.title LIKE ? OR cm.details LIKE ?)`).join(' OR ');
    query += ` AND (${topicLikes})`;
    for (const t of askIntent.topic_clues) {
      params.push(`%${t}%`, `%${t}%`);
    }
  }

  query += ` ORDER BY cm.due_time ASC, cm.id DESC LIMIT 10`;

  const [rows] = await pool.query(query, params);

  if (rows.length === 0) {
    // If no filtered commitments found, query open commitments generally
    const [generalRows] = await pool.query(
      `SELECT cm.*, c.first_name, c.last_name, c.company_name
       FROM commitments cm
       JOIN contacts c ON c.id = cm.contact_id AND c.owner_user_id = ?
       WHERE cm.owner_user_id = ? AND cm.status = 'OPEN'
       ORDER BY cm.due_time ASC LIMIT 5`,
      [userId, userId]
    );

    if (generalRows.length > 0) {
      const names = Array.from(new Set(generalRows.map(r => `${r.first_name} ${r.last_name}`)));
      return {
        answer: `You currently have open follow-ups with: ${names.join(', ')}.`,
        primary_contact: { id: generalRows[0].contact_id, first_name: generalRows[0].first_name, last_name: generalRows[0].last_name },
        commitments: generalRows,
        alternatives: [],
        reason: `Found ${generalRows.length} open commitment(s) in database.`,
        requires_clarification: false,
        clarification_choices: []
      };
    }

    return {
      answer: 'You have no pending commitments or follow-ups matching this query.',
      primary_contact: null,
      commitments: [],
      alternatives: [],
      reason: 'No matching commitments found for authenticated owner.',
      requires_clarification: false,
      clarification_choices: []
    };
  }

  const primary = rows[0];
  const primaryName = `${primary.first_name || ''} ${primary.last_name || ''}`.trim();
  const answer = `${primaryName} (${primary.company_name || 'Contact'}) has an open item: "${primary.title}"${primary.due_time ? ` due on ${new Date(primary.due_time).toLocaleDateString()}` : ''}.`;

  return {
    answer,
    primary_contact: { id: primary.contact_id, first_name: primary.first_name, last_name: primary.last_name },
    commitments: rows,
    alternatives: rows.slice(1).map(r => ({ id: r.contact_id, name: `${r.first_name} ${r.last_name}`, title: r.title })),
    reason: `Matched commitment record for ${primaryName} (${primary.type || 'follow_up'}).`,
    requires_clarification: false,
    clarification_choices: []
  };
}

/**
 * Service 3: Relationships & Introducers Retrieval
 */
async function retrieveRelationships(pool, userId, askIntent, rawQuery) {
  const relClues = askIntent.relationship_clues;
  const orgClues = askIntent.organization_clues;
  const entityClues = askIntent.entity_clues;

  let query = `
    SELECT c.*
    FROM contacts c
    WHERE c.owner_user_id = ?
  `;
  const params = [userId];

  // If asking "Who introduced me to [Entity]?"
  if (entityClues.length > 0 && !relClues.some(r => entityClues.includes(r))) {
    const nameLike = `%${entityClues[0]}%`;
    query += ` AND (c.first_name LIKE ? OR c.last_name LIKE ?)`;
    params.push(nameLike, nameLike);
  }

  // If introducer is specified: e.g. "Who did Larry introduce me to at IBM?"
  if (relClues.length > 0) {
    const introLike = `%${relClues[0]}%`;
    query += ` AND c.introduced_by_name LIKE ?`;
    params.push(introLike);
  }

  // If organization is specified: e.g. "at IBM" / "at Microsoft"
  if (orgClues.length > 0) {
    const orgLike = `%${orgClues[0]}%`;
    query += ` AND (c.company_name LIKE ? OR c.how_we_met_notes LIKE ? OR c.met_place LIKE ?)`;
    params.push(orgLike, orgLike, orgLike);
  }

  // If topic is specified: e.g. "The whisky fellow Larry introduced" / "The golf fellow Larry introduced"
  const topicClues = askIntent.topic_clues || [];
  if (topicClues.length > 0) {
    const topicLike = `%${topicClues[0]}%`;
    query += ` AND (c.interests LIKE ? OR c.personal_notes LIKE ? OR c.how_we_met_notes LIKE ?)`;
    params.push(topicLike, topicLike, topicLike);
  }

  query += ` ORDER BY c.id DESC`;
  const [matched] = await pool.query(query, params);

  if (matched.length === 0) {
    return {
      answer: `No contacts found matching relationship query for ${[...relClues, ...orgClues, ...entityClues].join(', ')}.`,
      primary_contact: null,
      alternatives: [],
      reason: 'No contact records found with specified introducer/organization criteria.',
      requires_clarification: false,
      clarification_choices: []
    };
  }

  const primary = matched[0];
  const primaryName = `${primary.first_name || ''} ${primary.last_name || ''}`.trim();
  const intro = primary.introduced_by_name || 'No introducer recorded';

  let answer = '';
  const interestNote = (topicClues.length > 0 && primary.interests) ? ` [Interests: ${primary.interests}]` : '';
  const titleOrg = `${primary.job_title ? primary.job_title + ' ' : ''}at ${primary.company_name || 'their organization'}`.trim();

  if (relClues.length > 0) {
    answer = `${relClues[0]} introduced you to ${primaryName} (${titleOrg}${interestNote}).`;
  } else {
    answer = `${primaryName} was introduced to you by: ${intro}${interestNote}.`;
  }

  return {
    answer,
    primary_contact: primary,
    alternatives: matched.slice(1),
    reason: `Retrieved introducer information from contact record (${primaryName}).`,
    requires_clarification: false,
    clarification_choices: []
  };
}

/**
 * Service 4: Organizations & Context Retrieval
 */
async function retrieveOrganizationContext(pool, userId, askIntent, rawQuery) {
  const orgClues = askIntent.organization_clues;
  if (orgClues.length === 0) return null;

  const targetOrg = orgClues[0];
  const orgLike = `%${targetOrg}%`;

  const [matched] = await pool.query(
    `SELECT c.* FROM contacts c
     WHERE c.owner_user_id = ? AND (
       c.company_name LIKE ? OR c.met_place LIKE ? OR c.how_we_met_notes LIKE ? OR c.met_context LIKE ?
     ) ORDER BY c.id DESC`,
    [userId, orgLike, orgLike, orgLike, orgLike]
  );

  if (matched.length === 0) {
    return {
      answer: `No contacts found associated with "${targetOrg}".`,
      primary_contact: null,
      alternatives: [],
      reason: `Searched company and meeting context for "${targetOrg}".`,
      requires_clarification: false,
      clarification_choices: []
    };
  }

  const names = matched.map(m => `${m.first_name} ${m.last_name}`).join(', ');
  const primary = matched[0];

  return {
    answer: `Contacts associated with ${targetOrg.toUpperCase()}: ${names}.`,
    primary_contact: primary,
    alternatives: matched.slice(1),
    reason: `Matched ${matched.length} contact(s) with organization/meeting context matching '${targetOrg}'.`,
    requires_clarification: false,
    clarification_choices: []
  };
}

/**
 * Service 5: Topics & Interests Retrieval
 */
async function retrieveTopicContext(pool, userId, askIntent, rawQuery) {
  const topics = askIntent.topic_clues;
  const relClues = askIntent.relationship_clues;
  const entityClues = askIntent.entity_clues;

  if (topics.length === 0 && entityClues.length === 0) return null;

  const topic = topics[0] || '';
  const topicLike = `%${topic}%`;

  let query = `
    SELECT c.*,
           (CASE WHEN c.interests LIKE ? OR c.personal_notes LIKE ? THEN 2 ELSE 1 END) as topic_relevance
    FROM contacts c
    WHERE c.owner_user_id = ?
  `;
  const params = [topicLike, topicLike, userId];

  if (topic) {
    query += ` AND (
      c.interests LIKE ? OR c.personal_notes LIKE ? OR c.how_we_met_notes LIKE ? OR c.met_context LIKE ?
    )`;
    params.push(topicLike, topicLike, topicLike, topicLike);
  }

  if (relClues.length > 0) {
    query += ` AND c.introduced_by_name LIKE ?`;
    params.push(`%${relClues[0]}%`);
  }

  if (entityClues.length > 0 && !relClues.includes(entityClues[0])) {
    query += ` AND (c.first_name LIKE ? OR c.last_name LIKE ?)`;
    params.push(`%${entityClues[0]}%`, `%${entityClues[0]}%`);
  }

  query += ` ORDER BY topic_relevance DESC, c.id DESC LIMIT 10`;

  const [matched] = await pool.query(query, params);

  if (matched.length === 0) {
    return {
      answer: `No contacts found associated with topic "${topic}".`,
      primary_contact: null,
      alternatives: [],
      reason: `Searched personal notes, interests, and background for '${topic}'.`,
      requires_clarification: false,
      clarification_choices: []
    };
  }

  const primary = matched[0];
  const primaryName = `${primary.first_name || ''} ${primary.last_name || ''}`.trim();
  const notes = primary.personal_notes || primary.interests || primary.how_we_met_notes || 'Topic match in notes';

  return {
    answer: `${primaryName}: ${primary.job_title || ''} at ${primary.company_name || 'their company'}. Notes: ${notes}`,
    primary_contact: primary,
    alternatives: matched.slice(1),
    reason: `Matched topic "${topic}" for ${primaryName}.`,
    requires_clarification: false,
    clarification_choices: []
  };
}

/**
 * Service 6: General Parameterized Person Search & Associative Retrieval
 */
async function retrieveGeneralSearch(pool, userId, askIntent, rawQuery) {
  const q = rawQuery.trim();
  const like = `%${q}%`;

  // 1. Try exact full-phrase match first
  let [matchedRows] = await pool.query(
    `SELECT c.* FROM contacts c
     WHERE c.owner_user_id = ? AND (
       CONCAT_WS(' ', c.first_name, c.middle_name, c.last_name, c.nickname, c.company_name, c.job_title,
         c.primary_email, c.primary_phone, c.mobile_phone, c.introduced_by_name, c.met_context,
         c.met_place, c.how_we_met_notes, c.interests, c.personal_notes) LIKE ?
     ) LIMIT 5`,
    [userId, like]
  );

  let isAssociativeMatch = false;
  let matchedTokens = [];

  // 2. If no exact phrase match, perform associative structured retrieval by significant keywords
  if (matchedRows.length === 0) {
    const stopWords = new Set([
      'who', 'what', 'where', 'when', 'why', 'how', 'is', 'was', 'are', 'were', 'the', 'a', 'an',
      'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she', 'they', 'it', 'to', 'from',
      'at', 'in', 'on', 'with', 'by', 'about', 'coming', 'came', 'back', 'met', 'meet', 'did',
      'do', 'does', 'tell', 'show', 'find', 'give', 'any', 'some', 'that', 'this', 'there',
      'contact', 'person', 'fellow', 'guy'
    ]);

    const rawTokens = q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    const significantTokens = Array.from(new Set(rawTokens.filter(t => t.length >= 3 && !stopWords.has(t))));

    if (significantTokens.length > 0) {
      const tokenLikes = significantTokens.map(t => `%${t}%`);
      const scoreCases = significantTokens.map(() => `(CASE WHEN CONCAT_WS(' ', c.first_name, c.middle_name, c.last_name, c.nickname, c.company_name, c.job_title, c.primary_email, c.primary_phone, c.mobile_phone, c.introduced_by_name, c.met_context, c.met_place, c.how_we_met_notes, c.interests, c.personal_notes) LIKE ? THEN 1 ELSE 0 END)`).join(' + ');

      const querySql = `
        SELECT c.*, (${scoreCases}) AS match_score
        FROM contacts c
        WHERE c.owner_user_id = ? AND (${scoreCases}) > 0
        ORDER BY match_score DESC, c.id DESC
        LIMIT 5
      `;

      const params = [...tokenLikes, userId, ...tokenLikes];
      const [scoredRows] = await pool.query(querySql, params);

      if (scoredRows.length > 0) {
        matchedRows = scoredRows;
        isAssociativeMatch = true;
        matchedTokens = significantTokens;
      }
    }
  }

  if (matchedRows.length === 0) {
    return {
      answer: `No contacts or commitments found matching "${q}".`,
      primary_contact: null,
      commitments: [],
      alternatives: [],
      reason: `Search completed across contacts, commitments, and interactions for owner user.`,
      requires_clarification: false,
      clarification_choices: []
    };
  }

  const primary = matchedRows[0];
  const primaryName = `${primary.first_name || ''} ${primary.last_name || ''}`.trim();
  const roleCompany = [primary.job_title, primary.company_name].filter(Boolean).join(' at ');
  const contextSnippet = primary.met_context || primary.how_we_met_notes || primary.personal_notes || '';

  let answer = '';
  let reason = '';

  if (isAssociativeMatch) {
    const hits = matchedTokens.filter(t => {
      const haystack = `${primary.first_name} ${primary.last_name} ${primary.company_name} ${primary.job_title} ${primary.met_context} ${primary.met_place} ${primary.how_we_met_notes} ${primary.personal_notes} ${primary.interests}`.toLowerCase();
      return haystack.includes(t);
    });
    answer = `${primaryName}${roleCompany ? ` (${roleCompany})` : ''} is the contact matching your search.${contextSnippet ? ` Context: ${contextSnippet}` : ''}`;
    reason = `Associative retrieval matched clues [${hits.join(', ')}] across structured role, meeting context, and relationship notes.`;
  } else {
    answer = `Found matching contact: ${primaryName}${roleCompany ? ` (${roleCompany})` : ''}.${contextSnippet ? ` Context: ${contextSnippet}` : ''}`;
    reason = `Lexical and structured database text match for "${q}".`;
  }

  return {
    answer,
    primary_contact: primary,
    commitments: [],
    alternatives: matchedRows.slice(1),
    reason,
    requires_clarification: false,
    clarification_choices: []
  };
}

module.exports = {
  retrieveContactDetails,
  retrieveCommitments,
  retrieveRelationships,
  retrieveOrganizationContext,
  retrieveTopicContext,
  retrieveGeneralSearch
};
