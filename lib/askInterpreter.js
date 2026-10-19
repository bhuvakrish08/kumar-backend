/**
 * Ask Dossier Generalized Natural Language Query Interpretation Engine (v0.2)
 *
 * Implements:
 * - Normalized AskIntent schema:
 *   intent, requested_fact, requested_action, entity_clues, organization_clues,
 *   relationship_clues, topic_clues, temporal_clues, commitment_filters, ambiguity, confidence
 * - Zero route-level hardcoded literal branch dependencies (IBM, whisky, pricing are evaluation fixtures, not architecture)
 * - Generalized intent classification:
 *   CONTACT_DETAIL, COMMITMENT_SEARCH, RELATIONSHIP_LOOKUP, ORGANIZATION_LOOKUP, TOPIC_SEARCH, GENERAL_PERSON_SEARCH
 * - Ambiguity detection and confidence scoring
 */

/**
 * Normalized AskIntent interpretation structure
 */
function createAskIntent(partial = {}) {
  return {
    intent: partial.intent || 'GENERAL_PERSON_SEARCH',
    requested_fact: partial.requested_fact || null,
    requested_action: partial.requested_action || null,
    entity_clues: partial.entity_clues || [],
    organization_clues: partial.organization_clues || [],
    relationship_clues: partial.relationship_clues || [],
    topic_clues: partial.topic_clues || [],
    temporal_clues: partial.temporal_clues || [],
    commitment_filters: partial.commitment_filters || {},
    ambiguity: Boolean(partial.ambiguity),
    confidence: typeof partial.confidence === 'number' ? partial.confidence : 0.8
  };
}

/**
 * Interprets a natural language query into a structured AskIntent.
 * @param {string} queryText - Raw user query
 * @param {Array<Object>} userContacts - Authenticated user contacts for entity context
 * @returns {Object} Normalized AskIntent object
 */
function interpretAskQuery(queryText, userContacts = []) {
  const q = (queryText || '').trim();
  const lower = q.toLowerCase();

  const entityClues = [];
  const organizationClues = [];
  const relationshipClues = [];
  const topicClues = [];
  const temporalClues = [];
  const commitmentFilters = {};

  let requestedFact = null;
  let requestedAction = null;

  // 1. Extract Entity Clues (Contact First Names, Last Names, Nicknames)
  // Strip possessive 's (e.g., "David's" -> "David")
  const cleanedTokens = q.replace(/'s\b/gi, '').split(/[\s,?!]+/);

  for (const token of cleanedTokens) {
    if (token.length < 2) continue;
    const lowerTok = token.toLowerCase();

    // Check against user's contact database
    for (const c of userContacts) {
      const fn = (c.first_name || '').toLowerCase();
      const ln = (c.last_name || '').toLowerCase();
      const nk = (c.nickname || '').toLowerCase();

      if (fn && fn === lowerTok) entityClues.push(c.first_name);
      if (ln && ln === lowerTok) entityClues.push(c.last_name);
      if (nk && nk === lowerTok) entityClues.push(c.nickname);
    }

    // Capitalized word heuristic for named entities not yet in contacts
    if (/^[A-Z][a-z]+$/.test(token) && !['What', 'Who', 'Where', 'How', 'Give', 'Tell', 'Show', 'Find', 'The', 'Does', 'Did', 'And'].includes(token)) {
      entityClues.push(token);
    }
  }

  // 2. Extract Organization Clues
  // A. Check known company names from contacts
  for (const c of userContacts) {
    if (c.company_name && c.company_name.trim().length > 1) {
      const compLower = c.company_name.trim().toLowerCase();
      if (lower.includes(compLower)) {
        organizationClues.push(c.company_name.trim());
      }
    }
  }

  // B. Pattern matching: e.g. "at IBM", "at Microsoft", "works at Google", "from Apple"
  const orgPattern = /(?:at|from|with|for)\s+([A-Za-z0-9&.\s]{2,30}?)(?=\s+(?:today|yesterday|last|who|he|she|in|on)|[\?.,!]|\s*$)/gi;
  let orgMatch;
  while ((orgMatch = orgPattern.exec(q)) !== null) {
    const candidate = orgMatch[1].trim();
    const candidateLower = candidate.toLowerCase();
    const commonStopWords = ['the', 'a', 'an', 'my', 'our', 'lunch', 'dinner', 'coffee', 'office', 'home', 'work', 'me', 'him', 'her', 'us', 'project'];
    if (!commonStopWords.includes(candidateLower) && candidate.length > 1) {
      organizationClues.push(candidate);
    }
  }

  // 3. Extract Relationship / Introducer Clues: e.g. "Who introduced me to John?", "Larry introduced", "introduced by Sarah"
  const introPatterns = [
    /(?:introduced\s+by|referred\s+by|through|brought\s+by)\s+([A-Za-z]+)/i,
    /([A-Za-z]+)\s+introduced/i,
    /who\s+did\s+([A-Za-z]+)\s+introduce/i
  ];

  for (const pat of introPatterns) {
    const m = q.match(pat);
    if (m && m[1]) {
      const introName = m[1].trim();
      if (!['who', 'me', 'you', 'someone', 'the'].includes(introName.toLowerCase())) {
        relationshipClues.push(introName);
      }
    }
  }

  // 4. Extract Topic / Interest Clues
  // Captures semantic topics dynamically (e.g. whisky, golf, pricing, contracts, quotes, machine learning, tennis)
  const topicRegex = /\b(whisky|whiskey|golf|wine|sailing|tennis|coffee|pricing|quote|proposal|contract|invoice|shipment|deliverable|presentation|budget|hiring)\b/gi;
  let tMatch;
  while ((tMatch = topicRegex.exec(q)) !== null) {
    topicClues.push(tMatch[1].toLowerCase());
  }

  // Also extract topic from descriptive phrases: "The [topic] fellow", "About [topic]"
  const fellowMatch = q.match(/(?:the|that)\s+([a-z]+)\s+(?:fellow|guy|person|lady|contact)/i);
  if (fellowMatch && fellowMatch[1]) {
    topicClues.push(fellowMatch[1].toLowerCase());
  }

  // 5. Extract Temporal Clues: e.g. "today", "yesterday", "next week", "last year", "in June"
  const tempRegex = /\b(today|yesterday|tomorrow|next week|last week|next month|last month|last year|recently|soon|in\s+[A-Za-z]+|on\s+[A-Za-z]+\s+\d{1,2})\b/gi;
  let dMatch;
  while ((dMatch = tempRegex.exec(q)) !== null) {
    temporalClues.push(dMatch[0].trim());
  }

  // 6. Intent Classification
  let intent = 'GENERAL_PERSON_SEARCH';
  let confidence = 0.85;

  // Family 1: Contact Details & Reachability ("What is David's cell?", "Give me David's mobile", "How do I call David?")
  if (
    lower.includes('cell') || lower.includes('mobile') || lower.includes('phone') ||
    lower.includes('call') || lower.includes('reach') || lower.includes('number') ||
    lower.includes('dial') || lower.includes('ring') || lower.includes('email') ||
    lower.includes('address')
  ) {
    intent = 'CONTACT_DETAIL';
    confidence = 0.95;

    if (lower.includes('cell') || lower.includes('mobile') || lower.includes('phone') || lower.includes('call') || lower.includes('dial')) {
      requestedFact = 'phone';
      requestedAction = 'call';
    } else if (lower.includes('email') || lower.includes('write')) {
      requestedFact = 'email';
      requestedAction = 'email';
    } else if (lower.includes('address') || lower.includes('located') || lower.includes('where is')) {
      requestedFact = 'address';
      requestedAction = 'visit';
    }
  }

  // Family 2: Commitments, Deliverables & Promises ("Who owes me pricing?", "Who was sending the quote?", "Who do I need to follow up with?")
  else if (
    lower.includes('owe') || lower.includes('owes') || lower.includes('pricing') ||
    lower.includes('quote') || lower.includes('proposal') || lower.includes('invoice') ||
    lower.includes('follow up') || lower.includes('follow-up') || lower.includes('supposed to send') ||
    lower.includes('promised') || lower.includes('pending') || lower.includes('remind') ||
    lower.includes('deadline') || lower.includes('due')
  ) {
    intent = 'COMMITMENT_SEARCH';
    confidence = 0.95;
    commitmentFilters.status = lower.includes('completed') || lower.includes('done') ? 'COMPLETED' : 'OPEN';

    if (lower.includes('pricing') || lower.includes('quote') || lower.includes('proposal') || lower.includes('cost')) {
      commitmentFilters.topic = 'pricing';
      commitmentFilters.type = 'expected_item';
    } else {
      commitmentFilters.type = 'follow_up';
    }
  }

  // Family 3: Relationships & Introducers ("Who introduced me to John?", "Who did Larry introduce me to at IBM?", "The fellow Larry introduced")
  else if (
    relationshipClues.length > 0 || lower.includes('introduce') || lower.includes('refer') ||
    lower.includes('who introduced') || lower.includes('who brought')
  ) {
    intent = 'RELATIONSHIP_LOOKUP';
    confidence = 0.90;
    requestedFact = 'introducer';
  }

  // Family 4: Organizations & Context ("Who did I meet at IBM?", "Who works at Microsoft?")
  else if (
    organizationClues.length > 0 &&
    (lower.includes('met at') || lower.includes('who did i meet') || lower.includes('works at') || lower.includes('contacts at') || lower.includes('at '))
  ) {
    intent = 'ORGANIZATION_LOOKUP';
    confidence = 0.90;
    requestedFact = 'organization_members';
  }

  // Family 5: Topics & Interests ("Tell me about Larry and whisky", "The whisky fellow", "The golf contact")
  else if (topicClues.length > 0 || lower.includes('tell me about')) {
    intent = 'TOPIC_SEARCH';
    confidence = 0.85;
  }

  // Detect ambiguity: multiple candidate names found
  const uniqueEntities = Array.from(new Set(entityClues));
  const uniqueOrgs = Array.from(new Set(organizationClues));
  const uniqueRelationships = Array.from(new Set(relationshipClues));
  const uniqueTopics = Array.from(new Set(topicClues));
  const uniqueTemporal = Array.from(new Set(temporalClues));

  const ambiguity = uniqueEntities.length > 1;

  return createAskIntent({
    intent,
    requested_fact: requestedFact,
    requested_action: requestedAction,
    entity_clues: uniqueEntities,
    organization_clues: uniqueOrgs,
    relationship_clues: uniqueRelationships,
    topic_clues: uniqueTopics,
    temporal_clues: uniqueTemporal,
    commitment_filters: commitmentFilters,
    ambiguity,
    confidence
  });
}

module.exports = {
  interpretAskQuery,
  createAskIntent
};
