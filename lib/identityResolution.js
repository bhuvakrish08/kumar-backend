/**
 * Identity Resolution Engine v0.2
 * Versioned, configurable, and explainable identity matching.
 */

const path = require('path');
const fs = require('fs');
const { parseAndNormalizePhone, comparePhones } = require('./phoneNormalization');

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
  version: 'v0.2.0',
  thresholds: { match: 45, probable_match: 25, ambiguous_margin: 15, minimum_confidence: 20 },
  weights: {
    strong_identifier: { personal_mobile_exact: 50, email_exact: 50, shared_office_phone_exact: 15, unverified_phone_exact: 10 },
    identity: { full_name_exact: 30, first_name_exact: 15, nickname_exact: 20 },
    organization: { company_exact: 15, company_mismatch_penalty: -10 },
    relationship: { introducer_exact: 10 },
    contextual: { met_context_exact: 5 },
    negative: { email_mismatch_penalty: -25, phone_mismatch_penalty: -25 }
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
 * Resolve candidate identity against user's existing contacts (v0.2)
 */
function resolveIdentity(candidatePerson, existingContacts = [], options = {}) {
  const modelVersion = identityConfig.version || 'v0.2.0';
  const cfg = identityConfig;

  if (!candidatePerson || !existingContacts || existingContacts.length === 0) {
    return {
      decision: 'NEW_PERSON',
      matchedContactId: null,
      candidateContacts: [],
      evidence: ['No existing contacts found for user. Categorized as NEW_PERSON.'],
      model_version: modelVersion
    };
  }

  const candName = normalizeName(candidatePerson.name);
  const candPhoneNorm = parseAndNormalizePhone(candidatePerson.phone, candidatePerson.country_hint);
  const candEmail = normalizeEmail(candidatePerson.email);
  const candCompany = normalizeCompany(candidatePerson.organization);
  const candIntro = normalizeName(candidatePerson.introducer);

  if (!candName && !candPhoneNorm.raw && !candEmail) {
    return {
      decision: 'NEW_PERSON',
      matchedContactId: null,
      candidateContacts: [],
      evidence: ['Insufficient extracted identifiers for contact matching.'],
      model_version: modelVersion
    };
  }

  const scoredCandidates = [];
  let matchingPhoneContacts = [];
  let matchingEmailContacts = [];

  for (const contact of existingContacts) {
    let score = 0;
    const evidence = [];

    const fullName = normalizeName(`${contact.first_name || ''} ${contact.last_name || ''}`);
    const firstName = normalizeName(contact.first_name);
    const lastName = normalizeName(contact.last_name);
    const nickname = normalizeName(contact.nickname);
    const contactEmail = normalizeEmail(contact.primary_email);
    const contactCompany = normalizeCompany(contact.company_name);
    const contactIntro = normalizeName(contact.introduced_by_name);

    // 1. Phone Comparison via Safe International Normalization Layer
    const contactPhoneRaw = contact.primary_phone || contact.mobile_phone;
    if (candPhoneNorm.raw && contactPhoneRaw) {
      const phoneComp = comparePhones(candPhoneNorm, contactPhoneRaw);
      if (phoneComp.match) {
        const nameCompatible = !candName || fullName.includes(candName) || candName.includes(firstName) || (nickname && candName.includes(nickname)) || isNicknameMatch(candName.split(' ')[0], firstName);
        
        if (phoneComp.confidence === 'SHARED_OFFICE' && !nameCompatible) {
          // Shared office number + incompatible names -> DO NOT MATCH
          evidence.push(`[shared_office] Shared office phone (${contactPhoneRaw}) ignored due to incompatible names`);
        } else {
          matchingPhoneContacts.push(contact);
          let pScore = phoneComp.score;
          if (nameCompatible || !candName) {
            score += pScore;
            evidence.push(`[strong_identifier] ${phoneComp.reason} (+${pScore})`);
          } else {
            score += Math.min(pScore, 10);
            evidence.push(`[strong_identifier] Shared phone (${contactPhoneRaw}) (+${Math.min(pScore, 10)})`);
          }
        }
      } else if (phoneComp.score < 0) {
        score += phoneComp.score;
        evidence.push(`[negative_conflict] ${phoneComp.reason} (${phoneComp.score})`);
      }
    }

    // 2. Email Matching
    if (candEmail && contactEmail) {
      if (candEmail === contactEmail) {
        matchingEmailContacts.push(contact);
        const eScore = cfg.weights.strong_identifier.email_exact;
        score += eScore;
        evidence.push(`[strong_identifier] Exact email match (${candEmail}) (+${eScore})`);
      } else if (candName && fullName && (candName === fullName || (firstName && candName.includes(firstName)))) {
        score += cfg.weights.negative.email_mismatch_penalty;
        evidence.push(`[negative_conflict] Email mismatch (${candEmail} vs ${contactEmail}) (${cfg.weights.negative.email_mismatch_penalty})`);
      }
    }

    // 3. Name Matching
    if (candName && (fullName || firstName)) {
      const candFirst = candName.split(' ')[0];
      const candLast = candName.split(' ').slice(-1)[0];

      if (candName === fullName) {
        const nScore = cfg.weights.identity.full_name_exact;
        score += nScore;
        evidence.push(`[identity] Exact full name match ("${contact.first_name} ${contact.last_name}") (+${nScore})`);
      } else if (firstName && lastName && candFirst && candLast && (candFirst === firstName || isNicknameMatch(candFirst, firstName)) && (candLast === lastName || candName.includes(lastName))) {
        // First & Last name match with middle initial variation (e.g. Arthur Conan Doyle vs Arthur Doyle)
        const nScore = cfg.weights.identity.full_name_exact;
        score += nScore;
        evidence.push(`[identity] First & Last name match with middle name variation ("${candName}") (+${nScore})`);
      } else if (candName.includes(firstName) || firstName.includes(candName) || isNicknameMatch(candFirst, firstName) || (nickname && (candName === nickname || candFirst === nickname))) {
        const fnScore = cfg.weights.identity.first_name_exact;
        score += fnScore;
        evidence.push(`[identity] First name or nickname match ("${candName}") (+${fnScore})`);
      }
    } else if (candName && nickname && (candName === nickname || isNicknameMatch(candName, nickname))) {
      const nkScore = cfg.weights.identity.nickname_exact;
      score += nkScore;
      evidence.push(`[identity] Nickname match ("${contact.nickname}") (+${nkScore})`);
    }

    // 4. Organization / Company Matching
    if (candCompany && contactCompany) {
      if (candCompany === contactCompany) {
        const cScore = cfg.weights.organization.company_exact;
        score += cScore;
        evidence.push(`[organization] Company match ("${contact.company_name}") (+${cScore})`);
      } else if (score > 15) {
        if (options.isTemporalEmployerChange) {
          evidence.push(`[contextual] Company mismatch ("${candidatePerson.organization}" vs "${contact.company_name}") recognized as temporal employer transition`);
        } else {
          const pen = cfg.weights.organization.company_mismatch_penalty;
          score += pen;
          evidence.push(`[negative_conflict] Company mismatch ("${candidatePerson.organization}" vs "${contact.company_name}") (${pen})`);
        }
      }
    }

    // 5. Relationship (Introducer) Matching
    if (candIntro && contactIntro && candIntro === contactIntro) {
      const iScore = cfg.weights.relationship.introducer_exact;
      score += iScore;
      evidence.push(`[relationship] Introducer match ("${contact.introduced_by_name}") (+${iScore})`);
    }

    if (score > 0) {
      scoredCandidates.push({
        contactId: contact.id,
        contactName: `${contact.first_name || ''} ${contact.last_name || ''}`.trim(),
        company: contact.company_name,
        score,
        evidence
      });
    }
  }

  // Sort candidates by score descending
  scoredCandidates.sort((a, b) => b.score - a.score);

  // Check CONFLICT: phone matches Contact A, email matches Contact B
  if (matchingPhoneContacts.length > 0 && matchingEmailContacts.length > 0) {
    if (matchingPhoneContacts[0].id !== matchingEmailContacts[0].id) {
      return {
        decision: 'CONFLICT',
        matchedContactId: null,
        candidateContacts: scoredCandidates,
        evidence: [
          `Conflicting identifiers: Phone matches ${matchingPhoneContacts[0].first_name} ${matchingPhoneContacts[0].last_name} (ID: ${matchingPhoneContacts[0].id}), but Email matches ${matchingEmailContacts[0].first_name} ${matchingEmailContacts[0].last_name} (ID: ${matchingEmailContacts[0].id}). Review required.`
        ],
        model_version: modelVersion
      };
    }
  }

  // Check AMBIGUOUS: multiple candidates with close scores
  if (scoredCandidates.length > 1) {
    const top = scoredCandidates[0];
    const runnerUp = scoredCandidates[1];
    if (top.score >= cfg.thresholds.probable_match && (top.score - runnerUp.score < cfg.thresholds.ambiguous_margin)) {
      return {
        decision: 'AMBIGUOUS',
        matchedContactId: null,
        candidateContacts: scoredCandidates,
        evidence: [
          `Multiple contacts matched similar identity criteria (${top.contactName} [Score ${top.score}] vs ${runnerUp.contactName} [Score ${runnerUp.score}]). User selection required.`
        ],
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
      model_version: modelVersion
    };
  }

  const topMatch = scoredCandidates[0];
  if (topMatch.score >= cfg.thresholds.match) {
    return {
      decision: 'MATCH',
      matchedContactId: topMatch.contactId,
      candidateContacts: scoredCandidates,
      evidence: topMatch.evidence,
      model_version: modelVersion
    };
  } else {
    return {
      decision: 'PROBABLE_MATCH',
      matchedContactId: topMatch.contactId,
      candidateContacts: scoredCandidates,
      evidence: topMatch.evidence,
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
