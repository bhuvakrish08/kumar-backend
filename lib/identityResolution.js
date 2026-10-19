/**
 * Identity Resolution Engine v0.2.1 (DRIE v0.2 Hardening)
 *
 * Implements:
 * - User-region aware phone comparisons
 * - Structured evidence with category, signal, score contribution, and human explanation
 * - Configurable weights from identityRules.json
 * - Protection against multiple weak signals creating an unjustified MATCH
 * - Negative evidence handling: spouse conflict, geography conflict, chronology conflict
 * - Temporal context for company mismatches
 * - Deterministic decisions: MATCH, PROBABLE_MATCH, AMBIGUOUS, CONFLICT, NEW_PERSON
 */

const path = require('path');
const fs = require('fs');
const { parseAndNormalizePhone, comparePhones, resolveUserRegion } = require('./phoneNormalization');

// Common Nicknames Mapping Dictionary
const NICKNAMES = {
  bob: ['robert'], robert: ['bob', 'bobby'],
  bill: ['william'], william: ['bill', 'billy'],
  jim: ['james'], james: ['jim', 'jimmy'],
  mike: ['michael'], michael: ['mike'],
  alex: ['alexander', 'alexandra'], alexander: ['alex'], alexandra: ['alex'],
  dave: ['david'], david: ['dave'],
  dan: ['daniel'], daniel: ['dan', 'danny'],
  dick: ['richard'], richard: ['dick', 'rick']
};

// Load versioned configuration
let identityConfig = {
  version: 'v0.2.1',
  thresholds: { match: 45, probable_match: 25, ambiguous_margin: 15, minimum_confidence: 20, require_anchor_for_match: true },
  weights: {
    strong_identifier: { personal_mobile_exact: 50, email_exact: 50, shared_office_phone_exact: 15, unverified_phone_exact: 10 },
    identity: { full_name_exact: 30, first_name_exact: 15, nickname_exact: 20 },
    organization: { company_exact: 15, company_mismatch_penalty: -10, company_mismatch_temporal_ignore: true },
    relationship: { introducer_exact: 10 },
    contextual: { met_context_exact: 5 },
    negative: {
      email_mismatch_penalty: -25,
      phone_mismatch_penalty: -25,
      spouse_mismatch_penalty: -30,
      geography_mismatch_penalty: -20,
      chronology_conflict_penalty: -25
    }
  }
};

try {
  const cfgPath = path.join(__dirname, '..', 'config', 'identityRules.json');
  if (fs.existsSync(cfgPath)) {
    identityConfig = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  }
} catch (e) {
  // Use default fallback config
}

function normalizePhone(phone, defaultCountry = null) {
  const norm = parseAndNormalizePhone(phone, defaultCountry);
  return norm.e164 || norm.comparisonValue || '';
}

function normalizeEmail(email) {
  if (!email) return '';
  return email.trim().toLowerCase();
}

function normalizeName(name) {
  if (!name) return '';
  let cleaned = name.trim().toLowerCase();
  cleaned = cleaned.replace(/\b(mr|mrs|ms|dr|prof|sir)\b\.?/g, '').trim();
  return cleaned.replace(/\s+/g, ' ');
}

function normalizeCompany(company) {
  if (!company) return '';
  let cleaned = company.trim().toLowerCase();
  cleaned = cleaned.replace(/\b(inc|llc|corp|corporation|ltd|limited|pvt|co)\b\.?/g, '').trim();
  return cleaned.replace(/\s+/g, ' ');
}

function isNicknameMatch(nameA, nameB) {
  if (!nameA || !nameB) return false;
  const a = nameA.toLowerCase();
  const b = nameB.toLowerCase();
  if (a === b) return true;
  if (NICKNAMES[a] && NICKNAMES[a].includes(b)) return true;
  if (NICKNAMES[b] && NICKNAMES[b].includes(a)) return true;
  return false;
}

/**
 * Resolve candidate identity against user's existing contacts (v0.2.1)
 * @param {Object} candidatePerson - Extracted candidate person attributes
 * @param {Array<Object>} existingContacts - User's existing contact records
 * @param {Object} options - Matching options including userRegion, isTemporalEmployerChange
 * @returns {Object} Resolution decision, matched contact ID, candidate rankings, evidence
 */
function resolveIdentity(candidatePerson, existingContacts = [], options = {}) {
  const modelVersion = identityConfig.version || 'v0.2.1';
  const cfg = identityConfig;
  const userRegion = resolveUserRegion(options.user, options.userRegion || options.defaultCountry || candidatePerson?.country_hint);

  if (!candidatePerson || !existingContacts || existingContacts.length === 0) {
    return {
      decision: 'NEW_PERSON',
      matchedContactId: null,
      candidateContacts: [],
      evidence: ['No existing contacts found for user. Categorized as NEW_PERSON.'],
      structured_evidence: [{
        category: 'baseline',
        signal: 'empty_contact_database',
        score_contribution: 0,
        explanation: 'No existing contacts found for user. Categorized as NEW_PERSON.'
      }],
      model_version: modelVersion
    };
  }

  const candNameRaw = normalizeName(candidatePerson.name);
  const candName = (candNameRaw === 'unknown person' || candNameRaw === 'unknown') ? '' : candNameRaw;
  const candPhoneNorm = parseAndNormalizePhone(candidatePerson.phone, userRegion);
  const candEmail = normalizeEmail(candidatePerson.email);
  const candCompany = normalizeCompany(candidatePerson.organization);
  const candIntro = normalizeName(candidatePerson.introducer);
  const candSpouse = normalizeName(candidatePerson.spouse_name || candidatePerson.spouse);
  const candLocation = normalizeName(candidatePerson.work_city || candidatePerson.location || candidatePerson.city || candidatePerson.country);
  const candNotes = (candidatePerson.notes || '').toLowerCase();

  if (!candName && !candPhoneNorm.raw && !candEmail && !candCompany && !candIntro && !candidatePerson.interests && !candidatePerson.title && !candidatePerson.professional_role) {
    return {
      decision: 'NEW_PERSON',
      matchedContactId: null,
      candidateContacts: [],
      evidence: ['Insufficient extracted identifiers for contact matching.'],
      structured_evidence: [{
        category: 'baseline',
        signal: 'insufficient_identifiers',
        score_contribution: 0,
        explanation: 'Insufficient extracted identifiers for contact matching.'
      }],
      model_version: modelVersion
    };
  }

  const scoredCandidates = [];
  let matchingPhoneContacts = [];
  let matchingEmailContacts = [];

  for (const contact of existingContacts) {
    let score = 0;
    const evidence = [];
    const structuredEvidence = [];
    let hasAnchorSignal = false; // Tracks if at least one primary anchor (strong ID or full name) exists

    const fullName = normalizeName(`${contact.first_name || ''} ${contact.last_name || ''}`);
    const firstName = normalizeName(contact.first_name);
    const lastName = normalizeName(contact.last_name);
    const nickname = normalizeName(contact.nickname);
    const contactEmail = normalizeEmail(contact.primary_email);
    const contactCompany = normalizeCompany(contact.company_name);
    const contactIntro = normalizeName(contact.introduced_by_name);
    const contactSpouse = normalizeName(contact.spouse_name);
    const contactLocation = normalizeName(`${contact.work_city || ''} ${contact.work_country || ''}`);

    function addEvidence(category, signal, contrib, expl) {
      score += contrib;
      evidence.push(`[${category}] ${expl} (${contrib >= 0 ? '+' : ''}${contrib})`);
      structuredEvidence.push({
        category,
        signal,
        score_contribution: contrib,
        explanation: expl
      });
    }

    // 1. Phone Comparison via Safe International Normalization Layer
    const contactPhoneRaw = contact.primary_phone || contact.mobile_phone;
    if (candPhoneNorm.raw && contactPhoneRaw) {
      const phoneComp = comparePhones(candPhoneNorm, contactPhoneRaw, userRegion);
      if (phoneComp.match) {
        const nameCompatible = !candName || fullName.includes(candName) || candName.includes(firstName) || (nickname && candName.includes(nickname)) || isNicknameMatch(candName.split(' ')[0], firstName);

        if (phoneComp.confidence === 'SHARED_OFFICE' && !nameCompatible) {
          // Shared office number + incompatible names -> DO NOT MATCH
          evidence.push(`[shared_office] Shared office phone (${contactPhoneRaw}) ignored due to incompatible names`);
          structuredEvidence.push({
            category: 'shared_office',
            signal: 'shared_office_phone_ignored',
            score_contribution: 0,
            explanation: `Shared office phone (${contactPhoneRaw}) ignored due to incompatible names`
          });
        } else {
          matchingPhoneContacts.push(contact);
          let pScore = phoneComp.score;
          if (nameCompatible || !candName) {
            addEvidence('strong_identifier', phoneComp.confidence === 'SHARED_OFFICE' ? 'shared_office_phone_exact' : 'personal_mobile_exact', pScore, phoneComp.reason);
            if (phoneComp.confidence !== 'SHARED_OFFICE') {
              hasAnchorSignal = true;
            }
          } else {
            const cappedScore = Math.min(pScore, 10);
            addEvidence('strong_identifier', 'shared_phone_capped', cappedScore, `Shared phone (${contactPhoneRaw})`);
          }
        }
      } else if (phoneComp.score < 0) {
        addEvidence('negative_conflict', 'phone_mismatch', phoneComp.score, phoneComp.reason);
      }
    }

    // 2. Email Matching
    if (candEmail && contactEmail) {
      if (candEmail === contactEmail) {
        matchingEmailContacts.push(contact);
        const eScore = cfg.weights.strong_identifier.email_exact;
        addEvidence('strong_identifier', 'email_exact', eScore, `Exact email match (${candEmail})`);
        hasAnchorSignal = true;
      } else if (candName && fullName && (candName === fullName || (firstName && candName.includes(firstName)))) {
        const pen = cfg.weights.negative.email_mismatch_penalty;
        addEvidence('negative_conflict', 'email_mismatch', pen, `Email mismatch (${candEmail} vs ${contactEmail})`);
      }
    }

    // 3. Name Matching
    if (candName && (fullName || firstName)) {
      const candFirst = candName.split(' ')[0];
      const candLast = candName.split(' ').slice(-1)[0];

      if (candName === fullName) {
        const nScore = cfg.weights.identity.full_name_exact;
        addEvidence('identity', 'full_name_exact', nScore, `Exact full name match ("${contact.first_name} ${contact.last_name}")`);
        hasAnchorSignal = true;
      } else if (firstName && lastName && candFirst && candLast && (candFirst === firstName || isNicknameMatch(candFirst, firstName)) && (candLast === lastName || candName.includes(lastName))) {
        const nScore = cfg.weights.identity.full_name_exact;
        addEvidence('identity', 'full_name_exact', nScore, `First & Last name match with middle name variation ("${candName}")`);
        hasAnchorSignal = true;
      } else if (candName.includes(firstName) || firstName.includes(candName) || isNicknameMatch(candFirst, firstName) || (nickname && (candName === nickname || candFirst === nickname))) {
        const fnScore = cfg.weights.identity.first_name_exact;
        addEvidence('identity', 'first_name_exact', fnScore, `First name or nickname match ("${candName}")`);
      }
    } else if (candName && nickname && (candName === nickname || isNicknameMatch(candName, nickname))) {
      const nkScore = cfg.weights.identity.nickname_exact;
      addEvidence('identity', 'nickname_exact', nkScore, `Nickname match ("${contact.nickname}")`);
    }

    // 4. Organization / Company Matching
    if (candCompany && contactCompany) {
      if (candCompany === contactCompany) {
        const cScore = cfg.weights.organization.company_exact;
        addEvidence('organization', 'company_exact', cScore, `Company match ("${contact.company_name}")`);
      } else if (score > 15) {
        if (options.isTemporalEmployerChange) {
          evidence.push(`[contextual] Company mismatch ("${candidatePerson.organization}" vs "${contact.company_name}") recognized as temporal employer transition (+0)`);
          structuredEvidence.push({
            category: 'contextual',
            signal: 'temporal_employer_transition',
            score_contribution: 0,
            explanation: `Company mismatch ("${candidatePerson.organization}" vs "${contact.company_name}") recognized as temporal employer transition`
          });
        } else {
          const pen = cfg.weights.organization.company_mismatch_penalty;
          addEvidence('negative_conflict', 'company_mismatch', pen, `Company mismatch ("${candidatePerson.organization}" vs "${contact.company_name}")`);
        }
      }
    }

    // 5. Contextual: Job Title Matching
    const candTitle = (candidatePerson.title || candidatePerson.professional_role || '').trim().toLowerCase();
    const contactTitle = (contact.job_title || '').trim().toLowerCase();
    if (candTitle && contactTitle && (candTitle.includes(contactTitle) || contactTitle.includes(candTitle))) {
      addEvidence('contextual', 'job_title_match', 10, `Job title match ("${contact.job_title}")`);
    }

    // 6. Contextual: Interests / Topic Matching
    const candInterests = (candidatePerson.interests || '').trim().toLowerCase();
    const contactInterests = (contact.interests || '').trim().toLowerCase();
    const contactNotes = (contact.personal_notes || '').trim().toLowerCase();
    if (candInterests && (contactInterests.includes(candInterests) || contactNotes.includes(candInterests))) {
      addEvidence('contextual', 'interest_match', 15, `Interests/topic match ("${candidatePerson.interests}")`);
    }

    // 7. Contextual: Meeting Venue / Place Matching
    const candVenue = (candidatePerson.meeting_context || candidatePerson.work_city || '').trim().toLowerCase();
    const contactVenue = (contact.met_place || contact.met_context || '').trim().toLowerCase();
    if (candVenue && contactVenue && (contactVenue.includes(candVenue) || candVenue.includes(contactVenue))) {
      addEvidence('contextual', 'met_venue_match', 5, `Meeting venue/context match`);
    }

    // 8. Relationship (Introducer) Matching
    if (candIntro && contactIntro && candIntro === contactIntro) {
      const iScore = cfg.weights.relationship.introducer_exact;
      addEvidence('relationship', 'introducer_exact', iScore, `Introducer match ("${contact.introduced_by_name}")`);
    }

    // 9. Negative Conflict: Spouse Mismatch
    if (candSpouse && contactSpouse && candSpouse !== contactSpouse) {
      const pen = cfg.weights.negative.spouse_mismatch_penalty || -30;
      addEvidence('negative_conflict', 'spouse_mismatch', pen, `Spouse conflict ("${candidatePerson.spouse_name || candidatePerson.spouse}" vs "${contact.spouse_name}")`);
    }

    // 10. Negative Conflict: Geography Conflict
    if (candLocation && contactLocation && !contactLocation.includes(candLocation) && !candLocation.includes(contactLocation)) {
      const pen = cfg.weights.negative.geography_mismatch_penalty || -20;
      addEvidence('negative_conflict', 'geography_conflict', pen, `Geography conflict ("${candLocation}" vs "${contactLocation}")`);
    }

    // 11. Negative Conflict: Incompatible Chronology
    if (options.chronologyConflict || candidatePerson.chronology_conflict) {
      const pen = cfg.weights.negative.chronology_conflict_penalty || -25;
      addEvidence('negative_conflict', 'chronology_conflict', pen, 'Incompatible chronological facts detected');
    }
    // 12. Contextual: Project / Notes keyword match
    if (candNotes && contactNotes) {
      const keywords = ['amazon', 'cloud', 'migration', 'pricing', 'oracle', 'sales', 'ibm', 'ai', 'mobile', 'deck'];
      const sharedKeyword = keywords.find(k => candNotes.includes(k) && contactNotes.includes(k));
      if (sharedKeyword) {
        addEvidence('contextual', 'project_context_match', 10, `Shared project/topic context ("${sharedKeyword}")`);
      }
    }

    if (score > 0 || structuredEvidence.some(e => e.category === 'negative_conflict')) {
      scoredCandidates.push({
        contactId: contact.id,
        contactName: `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
        company: contact.company_name,
        score,
        hasAnchorSignal,
        evidence,
        structuredEvidence
      });
    }
  }

  // Sort candidates by score descending
  scoredCandidates.sort((a, b) => b.score - a.score);

  // Check CONFLICT: phone matches Contact A, email matches Contact B
  if (matchingPhoneContacts.length > 0 && matchingEmailContacts.length > 0) {
    if (matchingPhoneContacts[0].id !== matchingEmailContacts[0].id) {
      const msg = `Conflicting identifiers: Phone matches ${matchingPhoneContacts[0].first_name} ${matchingPhoneContacts[0].last_name} (ID: ${matchingPhoneContacts[0].id}), but Email matches ${matchingEmailContacts[0].first_name} ${matchingEmailContacts[0].last_name} (ID: ${matchingEmailContacts[0].id}). Review required.`;
      return {
        decision: 'CONFLICT',
        matchedContactId: null,
        candidateContacts: scoredCandidates,
        evidence: [msg],
        structured_evidence: [{
          category: 'negative_conflict',
          signal: 'cross_contact_identifier_split',
          score_contribution: 0,
          explanation: msg
        }],
        model_version: modelVersion
      };
    }
  }

  // Check AMBIGUOUS: multiple candidates with close scores
  if (scoredCandidates.length > 1) {
    const top = scoredCandidates[0];
    const runnerUp = scoredCandidates[1];
    if (top.score >= 15 && (top.score - runnerUp.score < cfg.thresholds.ambiguous_margin)) {
      const msg = `Multiple contacts matched similar identity criteria (${top.contactName} [Score ${top.score}] vs ${runnerUp.contactName} [Score ${runnerUp.score}]). User selection required.`;
      return {
        decision: 'AMBIGUOUS',
        matchedContactId: null,
        candidateContacts: scoredCandidates,
        evidence: [msg],
        structured_evidence: [{
          category: 'ambiguous_identity',
          signal: 'competing_top_candidates',
          score_contribution: 0,
          explanation: msg
        }],
        model_version: modelVersion
      };
    }
  }

  if (scoredCandidates.length === 0 || scoredCandidates[0].score < cfg.thresholds.minimum_confidence) {
    return {
      decision: 'NEW_PERSON',
      matchedContactId: null,
      candidateContacts: scoredCandidates,
      evidence: ['No existing contact matched confidence threshold. Proposed as NEW_PERSON.'],
      structured_evidence: [{
        category: 'baseline',
        signal: 'below_confidence_threshold',
        score_contribution: 0,
        explanation: 'No existing contact matched confidence threshold. Proposed as NEW_PERSON.'
      }],
      model_version: modelVersion
    };
  }

  const topMatch = scoredCandidates[0];

  // Protection against multiple weak signals creating an unjustified MATCH:
  // If topMatch score >= match threshold but lacks an anchor signal (exact email, personal mobile, or full name),
  // downgrade to PROBABLE_MATCH to prevent false merges!
  const meetsMatchThreshold = topMatch.score >= cfg.thresholds.match;
  const canDecideMatch = meetsMatchThreshold && (!cfg.thresholds.require_anchor_for_match || topMatch.hasAnchorSignal);

  if (canDecideMatch) {
    return {
      decision: 'MATCH',
      matchedContactId: topMatch.contactId,
      candidateContacts: scoredCandidates,
      evidence: topMatch.evidence,
      structured_evidence: topMatch.structuredEvidence,
      model_version: modelVersion
    };
  } else {
    return {
      decision: 'PROBABLE_MATCH',
      matchedContactId: topMatch.contactId,
      candidateContacts: scoredCandidates,
      evidence: topMatch.evidence,
      structured_evidence: topMatch.structuredEvidence,
      model_version: modelVersion
    };
  }
}

module.exports = {
  identityConfig,
  normalizePhone,
  normalizeEmail,
  normalizeName,
  normalizeCompany,
  resolveIdentity
};
