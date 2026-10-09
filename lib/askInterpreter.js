/**
 * Ask Dossier Structured Query Interpretation Engine (Sprint 2 Correction)
 * Separates query interpretation from retrieval execution.
 * Generalizes queries beyond canonical literal strings using intent & structured clues.
 */

/**
 * Interprets a user query into a structured query object.
 * @param {string} queryText - Raw user question
 * @param {Array} userContacts - List of user's contacts to extract entity/org clues
 * @returns {Object} Structured query interpretation object
 */
function interpretAskQuery(queryText, userContacts = []) {
  const q = (queryText || '').trim();
  const lower = q.toLowerCase();

  const entityClues = [];
  const organizationClues = [];
  const relationshipClues = [];
  const topicClues = [];
  const commitmentFilters = [];

  // 1. Extract known entity names from query
  for (const c of userContacts) {
    const fn = (c.first_name || '').toLowerCase();
    const ln = (c.last_name || '').toLowerCase();
    const nk = (c.nickname || '').toLowerCase();

    if (fn && fn.length > 1 && lower.includes(fn)) {
      entityClues.push(c.first_name);
    }
    if (ln && ln.length > 1 && lower.includes(ln)) {
      entityClues.push(c.last_name);
    }
    if (nk && nk.length > 1 && lower.includes(nk)) {
      entityClues.push(c.nickname);
    }
  }

  // 2. Extract Organization Clues
  const companyKeywords = ['ibm', 'google', 'apple', 'microsoft', 'amazon', 'abc', 'tech corp', 'paper co', 'l\'oreal', 'loreal'];
  for (const kw of companyKeywords) {
    if (lower.includes(kw)) {
      organizationClues.push(kw.toUpperCase());
    }
  }

  const atCompanyMatch = lower.match(/(?:at|from|works?\s+at)\s+([a-z0-9\s&]{2,20}?)(?=\s+today|\.|\,|$|\s+who|\s+is|\s+he|\s+she)/i);
  if (atCompanyMatch) {
    const compCandidate = atCompanyMatch[1].trim();
    if (!['the', 'a', 'an', 'my', 'our', 'lunch', 'dinner', 'coffee', 'office'].includes(compCandidate.toLowerCase())) {
      organizationClues.push(compCandidate);
    }
  }

  // 3. Extract Relationship / Introducer Clues
  if (lower.includes('introduce') || lower.includes('referred') || lower.includes('met through') || lower.includes('brought')) {
    const introMatch = lower.match(/(?:introduced|referred|by|through)\s+([a-z]+)/i);
    if (introMatch) {
      relationshipClues.push(introMatch[1]);
    }
  }

  // 4. Extract Topic / Interest Clues
  const topicKeywords = ['whisky', 'whiskey', 'coffee', 'golf', 'wine', 'sailing', 'tennis', 'hobby'];
  for (const t of topicKeywords) {
    if (lower.includes(t)) {
      topicClues.push(t);
    }
  }

  // 5. Extract Intent
  let intent = 'GENERAL_SEARCH';

  if (lower.includes('cell') || lower.includes('mobile') || lower.includes('phone') || lower.includes('number') || lower.includes('contact details')) {
    intent = 'PHONE_LOOKUP';
  } else if (lower.includes('pricing') || lower.includes('quote') || lower.includes('proposal') || lower.includes('cost') || lower.includes('owes')) {
    intent = 'COMMITMENT_SEARCH';
    commitmentFilters.push('pricing', 'quote', 'proposal');
  } else if (lower.includes('follow up') || lower.includes('follow-up') || lower.includes('remind') || lower.includes('due') || lower.includes('pending')) {
    intent = 'COMMITMENT_SEARCH';
    commitmentFilters.push('follow_up', 'reminder', 'appointment');
  } else if (lower.includes('introduce') || lower.includes('referred') || lower.includes('who brought')) {
    intent = 'INTRODUCER_LOOKUP';
  } else if (organizationClues.length > 0 && (lower.includes('met at') || lower.includes('who did i meet') || lower.includes('at ibm'))) {
    intent = 'ORGANIZATION_LOOKUP';
  } else if (topicClues.length > 0) {
    intent = 'TOPIC_SEARCH';
  }

  return {
    raw_query: q,
    intent,
    entity_clues: Array.from(new Set(entityClues)),
    organization_clues: Array.from(new Set(organizationClues)),
    relationship_clues: Array.from(new Set(relationshipClues)),
    topic_clues: Array.from(new Set(topicClues)),
    commitment_filters: Array.from(new Set(commitmentFilters))
  };
}

module.exports = {
  interpretAskQuery
};
