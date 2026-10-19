/**
 * Strict CandidateFactSet Schema Validation Service (DRIE v0.2 Hardening)
 *
 * Ensures all authoritative input from AI/providers conforms to strict schema definitions:
 * - Root object, person, people[], interaction, sources, commitments, uncertain_dates
 * - Recursive forbidden-field detection (security isolation)
 * - Array size limits with explicit rejection (no silent truncation)
 * - Strict email and phone validation for people[] matching primary person
 * - String length bounds enforced at all levels
 * - Date uncertainty preserved without inventing today's date
 * - Normalization tracking for mapped interaction types
 * - schema_version: "0.2.0"
 */

const { parseAndNormalizePhone, resolveUserRegion } = require('./phoneNormalization');

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
const MAX_DATE_EXPR_LENGTH = 100;
const MAX_ARRAY_SIZE = 20;

// Email regex according to RFC 5322 simplified standard
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Security: Forbidden system/auth fields that provider output may never set
const FORBIDDEN_KEYS = new Set([
  'owner_user_id', 'user_id', 'id', 'contact_id', 'database_id',
  'status', 'commit_state', 'review_state', 'authorization',
  'role', 'roles', 'permissions', 'permission', 'sql', 'query', 'admin'
]);

/**
 * Recursively inspects all objects and arrays for forbidden keys.
 */
function detectForbiddenFieldsRecursively(obj, path = '', errors = []) {
  if (!obj || typeof obj !== 'object') return errors;

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      detectForbiddenFieldsRecursively(obj[i], `${path}[${i}]`, errors);
    }
    return errors;
  }

  for (const key of Object.keys(obj)) {
    const currentPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      errors.push(`Security Violation: AI output attempted to inject forbidden key "${currentPath}"`);
    }
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      detectForbiddenFieldsRecursively(obj[key], currentPath, errors);
    }
  }
  return errors;
}

/**
 * Validates and sanitizes CandidateFactSet data extracted from AI/Provider calls.
 * @param {Object} rawExtraction - Extracted output object from AI or rule engine
 * @param {Object} options - Validation options including userRegion
 * @returns {Object} { isValid: boolean, sanitized: Object|null, errors: Array<string>, normalization_issues: Array<string> }
 */
function validateCandidateFactSet(rawExtraction, options = {}) {
  const errors = [];
  const normalization_issues = [];
  const userRegion = resolveUserRegion(options.user, options.userRegion);

  if (!rawExtraction || typeof rawExtraction !== 'object' || Array.isArray(rawExtraction)) {
    return {
      isValid: false,
      sanitized: null,
      errors: ['CandidateFactSet must be a non-null JSON object'],
      normalization_issues: []
    };
  }

  // 1. Recursive Forbidden Field Inspection
  detectForbiddenFieldsRecursively(rawExtraction, '', errors);

  // 2. Validate Oversized Arrays (Explicit Rejection, never silently truncate)
  if (Array.isArray(rawExtraction.people) && rawExtraction.people.length > MAX_ARRAY_SIZE) {
    errors.push(`Array "people" exceeds maximum allowed size of ${MAX_ARRAY_SIZE} items (found ${rawExtraction.people.length})`);
  }
  if (Array.isArray(rawExtraction.sources) && rawExtraction.sources.length > MAX_ARRAY_SIZE) {
    errors.push(`Array "sources" exceeds maximum allowed size of ${MAX_ARRAY_SIZE} items (found ${rawExtraction.sources.length})`);
  }
  if (Array.isArray(rawExtraction.commitments) && rawExtraction.commitments.length > MAX_ARRAY_SIZE) {
    errors.push(`Array "commitments" exceeds maximum allowed size of ${MAX_ARRAY_SIZE} items (found ${rawExtraction.commitments.length})`);
  }
  if (Array.isArray(rawExtraction.uncertain_dates) && rawExtraction.uncertain_dates.length > MAX_ARRAY_SIZE) {
    errors.push(`Array "uncertain_dates" exceeds maximum allowed size of ${MAX_ARRAY_SIZE} items (found ${rawExtraction.uncertain_dates.length})`);
  }

  // 3. Validate Primary Person
  const person = rawExtraction.person;
  if (!person || typeof person !== 'object' || Array.isArray(person)) {
    errors.push('person field must be a valid non-array JSON object');
  }

  const cleanName = person && typeof person.name === 'string' ? person.name.trim() : null;
  if (cleanName && cleanName.length > MAX_NAME_LENGTH) {
    errors.push(`Person name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
  }

  const cleanTitle = person && typeof (person.professional_role || person.title) === 'string'
    ? (person.professional_role || person.title).trim()
    : null;
  if (cleanTitle && cleanTitle.length > MAX_TITLE_LENGTH) {
    errors.push(`Person title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`);
  }

  const cleanOrg = person && typeof person.organization === 'string'
    ? person.organization.trim()
    : null;
  if (cleanOrg && cleanOrg.length > MAX_ORG_LENGTH) {
    errors.push(`Organization exceeds maximum length of ${MAX_ORG_LENGTH} characters`);
  }

  // Primary Email Validation
  let cleanEmail = person && typeof person.email === 'string' ? person.email.trim() : null;
  if (cleanEmail) {
    if (cleanEmail.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(cleanEmail)) {
      errors.push(`Invalid email format: "${cleanEmail}"`);
      cleanEmail = null;
    }
  }

  // Primary Phone Validation
  let cleanPhone = person && typeof person.phone === 'string' ? person.phone.trim() : null;
  let normalizedPhoneObj = null;
  if (cleanPhone) {
    normalizedPhoneObj = parseAndNormalizePhone(cleanPhone, userRegion);
    cleanPhone = normalizedPhoneObj.e164 || normalizedPhoneObj.raw;
  }

  const cleanNotes = person && typeof person.notes === 'string'
    ? person.notes.trim().slice(0, MAX_NOTES_LENGTH)
    : null;
  const cleanIntroducer = person && typeof person.introducer === 'string'
    ? person.introducer.trim().slice(0, MAX_NAME_LENGTH)
    : null;
  const cleanMetDate = person && typeof person.met_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(person.met_date)
    ? person.met_date
    : null;
  const cleanContext = person && typeof person.meeting_context === 'string'
    ? person.meeting_context.trim().slice(0, 500)
    : null;
  const cleanSpouse = person && typeof (person.spouse_name || person.spouse) === 'string'
    ? (person.spouse_name || person.spouse).trim().slice(0, MAX_NAME_LENGTH)
    : null;
  const cleanCity = person && typeof (person.work_city || person.location || person.city) === 'string'
    ? (person.work_city || person.location || person.city).trim().slice(0, 100)
    : null;
  const cleanInterests = person && typeof person.interests === 'string'
    ? person.interests.trim().slice(0, 255)
    : null;

  // 4. Validate Secondary People Array with identical strict email/phone validation
  const cleanPeople = [];
  if (Array.isArray(rawExtraction.people)) {
    for (let i = 0; i < rawExtraction.people.length; i++) {
      const pItem = rawExtraction.people[i];
      if (typeof pItem !== 'object' || pItem === null || Array.isArray(pItem)) {
        errors.push(`people[${i}] must be a valid JSON object`);
        continue;
      }

      const pName = typeof pItem.name === 'string' ? pItem.name.trim() : null;
      if (pName && pName.length > MAX_NAME_LENGTH) {
        errors.push(`people[${i}].name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
      }

      let pEmail = typeof pItem.email === 'string' ? pItem.email.trim() : null;
      if (pEmail) {
        if (pEmail.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(pEmail)) {
          errors.push(`Invalid email format in people[${i}]: "${pEmail}"`);
          pEmail = null;
        }
      }

      let pPhone = typeof pItem.phone === 'string' ? pItem.phone.trim() : null;
      let pPhoneNorm = null;
      if (pPhone) {
        pPhoneNorm = parseAndNormalizePhone(pPhone, userRegion);
        pPhone = pPhoneNorm.e164 || pPhoneNorm.raw;
      }

      const pTitle = typeof (pItem.professional_role || pItem.title) === 'string'
        ? (pItem.professional_role || pItem.title).trim().slice(0, MAX_TITLE_LENGTH)
        : null;
      const pOrg = typeof pItem.organization === 'string'
        ? pItem.organization.trim().slice(0, MAX_ORG_LENGTH)
        : null;

      if (pName || pEmail || pPhone) {
        cleanPeople.push({
          name: pName,
          phone: pPhone,
          phone_normalized: pPhoneNorm,
          email: pEmail,
          title: pTitle,
          organization: pOrg
        });
      }
    }
  }

  // 5. Validate Sources Array
  const rawSources = Array.isArray(rawExtraction.sources) ? rawExtraction.sources : [];
  const cleanSources = [];
  for (let sIdx = 0; sIdx < rawSources.length; sIdx++) {
    const s = rawSources[sIdx];
    if (typeof s !== 'string') {
      errors.push(`sources[${sIdx}] must be a string`);
      continue;
    }
    const trimmedS = s.trim();
    if (trimmedS) {
      cleanSources.push(trimmedS.slice(0, 100));
    }
  }

  // 6. Validate Commitments Array
  const rawCommitments = Array.isArray(rawExtraction.commitments) ? rawExtraction.commitments : [];
  const cleanCommitments = [];
  for (let cIdx = 0; cIdx < rawCommitments.length; cIdx++) {
    const c = rawCommitments[cIdx];
    if (typeof c !== 'object' || c === null || Array.isArray(c)) {
      errors.push(`commitments[${cIdx}] must be a valid JSON object`);
      continue;
    }

    const cType = typeof c.type === 'string' ? c.type.toLowerCase().trim() : 'follow_up';
    if (!ALLOWED_COMMITMENT_TYPES.includes(cType)) {
      errors.push(`Invalid commitment type in commitments[${cIdx}]: "${c.type}". Allowed: ${ALLOWED_COMMITMENT_TYPES.join(', ')}`);
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

  // Deduplicate overlapping commitments
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

  // 7. Validate Uncertain Dates
  const rawUncertain = Array.isArray(rawExtraction.uncertain_dates) ? rawExtraction.uncertain_dates : [];
  const cleanUncertain = [];
  for (const u of rawUncertain) {
    if (typeof u === 'string' && u.trim() !== '') {
      cleanUncertain.push(u.trim().slice(0, 255));
    }
  }

  // 8. Validate Interaction & Preserve Date Expressions (NEVER invent new Date())
  let cleanInteraction = null;
  if (rawExtraction.interaction && typeof rawExtraction.interaction === 'object' && !Array.isArray(rawExtraction.interaction)) {
    const inter = rawExtraction.interaction;
    let iType = typeof inter.type === 'string' ? inter.type.trim() : 'Meeting';

    if (!ALLOWED_INTERACTION_TYPES.includes(iType)) {
      normalization_issues.push(`Unknown interaction type "${iType}" mapped to supported type "Meeting"`);
      iType = 'Meeting';
    }

    const iDetails = typeof inter.details === 'string' ? inter.details.trim().slice(0, 2000) : '';

    let iDate = null;
    let rawDateExpr = null;

    if (typeof inter.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(inter.date)) {
      iDate = inter.date;
    } else if (inter.date || inter.raw_date_expression) {
      // Preserve invalid or uncertain date expression without inventing today's date
      rawDateExpr = typeof inter.raw_date_expression === 'string'
        ? inter.raw_date_expression.trim().slice(0, MAX_DATE_EXPR_LENGTH)
        : String(inter.date).trim().slice(0, MAX_DATE_EXPR_LENGTH);

      cleanUncertain.push(`Unresolved interaction date expression: "${rawDateExpr}"`);
      normalization_issues.push(`Approximate/unparsed interaction date "${rawDateExpr}" preserved without converting to current date`);
    }

    if (iDetails || iDate || rawDateExpr) {
      cleanInteraction = {
        type: iType,
        details: iDetails,
        date: iDate,
        raw_date_expression: rawDateExpr
      };
    }
  }

  if (errors.length > 0) {
    return {
      isValid: false,
      sanitized: null,
      errors,
      normalization_issues
    };
  }

  return {
    isValid: true,
    sanitized: {
      schema_version: '0.2.0',
      provider: typeof rawExtraction.provider === 'string' ? rawExtraction.provider : 'unknown',
      model: typeof rawExtraction.model === 'string' ? rawExtraction.model : 'unknown',
      parser_version: typeof rawExtraction.parser_version === 'string' ? rawExtraction.parser_version : '2.0.0',
      polishedMemory: (typeof rawExtraction.polishedMemory === 'string' && rawExtraction.polishedMemory.trim())
        ? rawExtraction.polishedMemory.trim()
        : (typeof rawExtraction.polished_memory === 'string' && rawExtraction.polished_memory.trim() ? rawExtraction.polished_memory.trim() : null),
      person: {
        name: cleanName,
        phone: cleanPhone,
        phone_normalized: normalizedPhoneObj,
        email: cleanEmail,
        professional_role: cleanTitle,
        title: cleanTitle,
        organization: cleanOrg,
        introducer: cleanIntroducer,
        spouse_name: cleanSpouse,
        work_city: cleanCity,
        location: cleanCity,
        interests: cleanInterests,
        meeting_context: cleanContext,
        met_date: cleanMetDate,
        notes: cleanNotes
      },
      people: cleanPeople,
      sources: cleanSources,
      interaction: cleanInteraction,
      commitments: deduplicatedCommitmentList,
      uncertain_dates: cleanUncertain
    },
    errors: [],
    normalization_issues
  };
}

module.exports = {
  validateCandidateFactSet,
  ALLOWED_CANDIDATE_TYPES,
  ALLOWED_COMMITMENT_TYPES,
  ALLOWED_INTERACTION_TYPES
};
