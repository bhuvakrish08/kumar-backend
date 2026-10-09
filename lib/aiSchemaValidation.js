/**
 * Strict CandidateFactSet Schema Validation Service (Sprint 2 Blocker #2)
 * Ensures AI and provider outputs pass explicit schema checks before storage.
 * Strictly prevents security field injection (owner_user_id, id, roles, permissions).
 */

const { parseAndNormalizePhone } = require('./phoneNormalization');

// Allow-lists
const ALLOWED_CANDIDATE_TYPES = ['tell_dossier_extraction', 'manual_entry', 'system_import'];
const ALLOWED_COMMITMENT_TYPES = ['follow_up', 'expected_item', 'appointment', 'reminder'];
const ALLOWED_INTERACTION_TYPES = ['Meeting', 'Call', 'Email', 'Text', 'WhatsApp', 'Note'];

// Field Length Limits
const MAX_NAME_LENGTH = 150;
const MAX_TITLE_LENGTH = 150;
const MAX_ORG_LENGTH = 200;
const MAX_EMAIL_LENGTH = 255;
const MAX_NOTES_LENGTH = 5000;
const MAX_ARRAY_SIZE = 20;

// Email regex
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

/**
 * Validates and sanitizes CandidateFactSet data extracted from AI/Provider calls.
 * @param {Object} rawExtraction - Extracted output object from AI or rule engine
 * @returns {Object} { isValid: boolean, sanitized: Object|null, errors: Array<string> }
 */
function validateCandidateFactSet(rawExtraction) {
  const errors = [];

  if (!rawExtraction || typeof rawExtraction !== 'object' || Array.isArray(rawExtraction)) {
    return {
      isValid: false,
      sanitized: null,
      errors: ['CandidateFactSet must be a non-null JSON object']
    };
  }

  // SECURITY GUARD: Reject any attempt to inject forbidden system/auth fields
  const forbiddenKeys = [
    'owner_user_id', 'user_id', 'id', 'contact_id', 'database_id',
    'status', 'commit_state', 'review_state', 'authorization',
    'role', 'permissions', 'sql', 'query'
  ];

  const rootKeys = Object.keys(rawExtraction);
  for (const key of rootKeys) {
    if (forbiddenKeys.includes(key.toLowerCase())) {
      errors.push(`Security Violation: AI output attempted to inject forbidden key "${key}"`);
    }
  }

  // 1. Validate Person Object
  const person = rawExtraction.person || {};
  if (typeof person !== 'object' || Array.isArray(person)) {
    errors.push('person field must be a valid JSON object');
  }

  // Check nested person for forbidden keys
  if (typeof person === 'object' && person !== null) {
    for (const pKey of Object.keys(person)) {
      if (forbiddenKeys.includes(pKey.toLowerCase())) {
        errors.push(`Security Violation: Person object attempted to inject forbidden key "${pKey}"`);
      }
    }
  }

  const cleanName = typeof person.name === 'string' ? person.name.trim() : null;
  if (cleanName && cleanName.length > MAX_NAME_LENGTH) {
    errors.push(`Person name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
  }

  const cleanTitle = typeof (person.professional_role || person.title) === 'string' ? (person.professional_role || person.title).trim() : null;
  if (cleanTitle && cleanTitle.length > MAX_TITLE_LENGTH) {
    errors.push(`Person title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`);
  }

  const cleanOrg = typeof person.organization === 'string' ? person.organization.trim() : null;
  if (cleanOrg && cleanOrg.length > MAX_ORG_LENGTH) {
    errors.push(`Organization exceeds maximum length of ${MAX_ORG_LENGTH} characters`);
  }

  // Email validation
  let cleanEmail = typeof person.email === 'string' ? person.email.trim() : null;
  if (cleanEmail) {
    if (cleanEmail.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(cleanEmail)) {
      errors.push(`Invalid email format: "${cleanEmail}"`);
      cleanEmail = null;
    }
  }

  // Phone validation through Phone Normalization Layer
  let cleanPhone = typeof person.phone === 'string' ? person.phone.trim() : null;
  let normalizedPhoneObj = null;
  if (cleanPhone) {
    normalizedPhoneObj = parseAndNormalizePhone(cleanPhone);
    cleanPhone = normalizedPhoneObj.e164 || normalizedPhoneObj.raw;
  }

  const cleanNotes = typeof person.notes === 'string' ? person.notes.trim().slice(0, MAX_NOTES_LENGTH) : null;
  const cleanIntroducer = typeof person.introducer === 'string' ? person.introducer.trim().slice(0, MAX_NAME_LENGTH) : null;
  const cleanMetDate = typeof person.met_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(person.met_date) ? person.met_date : null;

  // Validate People array if present
  const cleanPeople = [];
  if (Array.isArray(rawExtraction.people)) {
    for (const pItem of rawExtraction.people.slice(0, MAX_ARRAY_SIZE)) {
      if (typeof pItem !== 'object' || pItem === null) continue;
      const pName = typeof pItem.name === 'string' ? pItem.name.trim().slice(0, MAX_NAME_LENGTH) : null;
      if (pName) {
        cleanPeople.push({
          name: pName,
          phone: typeof pItem.phone === 'string' ? pItem.phone.trim() : null,
          email: typeof pItem.email === 'string' ? pItem.email.trim() : null,
          title: typeof (pItem.professional_role || pItem.title) === 'string' ? (pItem.professional_role || pItem.title).trim().slice(0, MAX_TITLE_LENGTH) : null,
          organization: typeof pItem.organization === 'string' ? pItem.organization.trim().slice(0, MAX_ORG_LENGTH) : null
        });
      }
    }
  }

  // 2. Validate Sources Array
  const rawSources = Array.isArray(rawExtraction.sources) ? rawExtraction.sources : [];
  if (rawSources.length > MAX_ARRAY_SIZE) {
    errors.push(`Sources array exceeds maximum size of ${MAX_ARRAY_SIZE}`);
  }
  const cleanSources = rawSources
    .filter(s => typeof s === 'string' && s.trim() !== '')
    .map(s => s.trim().slice(0, 100))
    .slice(0, MAX_ARRAY_SIZE);

  // 3. Validate Commitments Array
  const rawCommitments = Array.isArray(rawExtraction.commitments) ? rawExtraction.commitments : [];
  if (rawCommitments.length > MAX_ARRAY_SIZE) {
    errors.push(`Commitments array exceeds maximum size of ${MAX_ARRAY_SIZE}`);
  }

  const cleanCommitments = [];
  for (const c of rawCommitments) {
    if (typeof c !== 'object' || c === null) continue;

    for (const cKey of Object.keys(c)) {
      if (forbiddenKeys.includes(cKey.toLowerCase())) {
        errors.push(`Security Violation: Commitment object attempted to inject forbidden key "${cKey}"`);
      }
    }

    const cType = typeof c.type === 'string' ? c.type.toLowerCase().trim() : 'follow_up';
    if (!ALLOWED_COMMITMENT_TYPES.includes(cType)) {
      errors.push(`Invalid commitment type: "${c.type}". Allowed: ${ALLOWED_COMMITMENT_TYPES.join(', ')}`);
      continue;
    }

    let cTitle = typeof c.title === 'string' ? c.title.trim().slice(0, 255) : '';
    cTitle = cTitle
      .replace(/\s+(?:and\s+)?(?:his\s+|her\s+|my\s+)?(?:email|phone|mobile|number|contact|\w+\s+email|\w+\s+phone)\s+is.*$/i, '')
      .replace(/[.,;!?]$/, '')
      .trim();

    if (!cTitle || cTitle.length < 3) continue;

    let cDetails = typeof c.details === 'string' ? c.details.trim().slice(0, 2000) : null;
    if (cDetails) {
      cDetails = cDetails
        .replace(/\s+(?:and\s+)?(?:his\s+|her\s+|my\s+)?(?:email|phone|mobile|number|contact|\w+\s+email|\w+\s+phone)\s+is.*$/i, '')
        .replace(/[.,;!?]$/, '')
        .trim();
    }
    const cDue = typeof c.due_time === 'string' && c.due_time.length <= 50 ? c.due_time : null;

    cleanCommitments.push({
      type: cType,
      title: cTitle,
      details: cDetails,
      due_time: cDue
    });
  }

  // Deduplicate overlapping / sub-phrase commitments
  const deduplicatedCommitmentList = [];
  for (let i = 0; i < cleanCommitments.length; i++) {
    const current = cleanCommitments[i];
    const isSub = cleanCommitments.some((other, j) => {
      if (i === j) return false;
      const curLower = current.title.toLowerCase();
      const othLower = other.title.toLowerCase();
      return othLower.includes(curLower) && othLower.length > curLower.length;
    });

    if (!isSub && !deduplicatedCommitmentList.some(f => f.title.toLowerCase() === current.title.toLowerCase())) {
      deduplicatedCommitmentList.push(current);
    }
  }

  // 4. Validate Interaction
  let cleanInteraction = null;
  if (rawExtraction.interaction && typeof rawExtraction.interaction === 'object') {
    const inter = rawExtraction.interaction;
    for (const iKey of Object.keys(inter)) {
      if (forbiddenKeys.includes(iKey.toLowerCase())) {
        errors.push(`Security Violation: Interaction object attempted to inject forbidden key "${iKey}"`);
      }
    }

    const iType = typeof inter.type === 'string' && ALLOWED_INTERACTION_TYPES.includes(inter.type) ? inter.type : 'Meeting';
    const iDetails = typeof inter.details === 'string' ? inter.details.trim().slice(0, 2000) : '';
    const iDate = typeof inter.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(inter.date) ? inter.date : new Date().toISOString().split('T')[0];

    if (iDetails) {
      cleanInteraction = { type: iType, details: iDetails, date: iDate };
    }
  }

  // 5. Validate Uncertain Dates
  const rawUncertain = Array.isArray(rawExtraction.uncertain_dates) ? rawExtraction.uncertain_dates : [];
  const cleanUncertain = rawUncertain
    .filter(u => typeof u === 'string' && u.trim() !== '')
    .map(u => u.trim().slice(0, 255))
    .slice(0, MAX_ARRAY_SIZE);

  if (errors.length > 0) {
    return {
      isValid: false,
      sanitized: null,
      errors
    };
  }

  return {
    isValid: true,
    sanitized: {
      provider: typeof rawExtraction.provider === 'string' ? rawExtraction.provider : 'unknown',
      model: typeof rawExtraction.model === 'string' ? rawExtraction.model : 'unknown',
      parser_version: typeof rawExtraction.parser_version === 'string' ? rawExtraction.parser_version : '2.0.0',
      person: {
        name: cleanName,
        phone: cleanPhone,
        phone_normalized: normalizedPhoneObj,
        email: cleanEmail,
        professional_role: cleanTitle,
        title: cleanTitle,
        organization: cleanOrg,
        introducer: cleanIntroducer,
        meeting_context: typeof person.meeting_context === 'string' ? person.meeting_context.trim().slice(0, 500) : null,
        met_date: cleanMetDate,
        notes: cleanNotes
      },
      people: cleanPeople,
      sources: cleanSources,
      interaction: cleanInteraction,
      commitments: deduplicatedCommitmentList,
      uncertain_dates: cleanUncertain
    },
    errors: []
  };
}

module.exports = {
  validateCandidateFactSet,
  ALLOWED_CANDIDATE_TYPES,
  ALLOWED_COMMITMENT_TYPES
};
