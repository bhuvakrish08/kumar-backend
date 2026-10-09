/**
 * Safe International Phone Normalization Service (Sprint 2 Correction)
 * Uses libphonenumber-js for strict international parsing.
 * NO trailing 10-digit matching without country code verification.
 */

const { parsePhoneNumberFromString } = require('libphonenumber-js/max');

/**
 * Parses and normalizes phone numbers into E.164 format safely.
 * @param {string} phoneInput - Raw user-entered phone number
 * @param {string|null} defaultCountry - Two-letter ISO country code
 * @returns {Object} Normalized phone details
 */
function parseAndNormalizePhone(phoneInput, defaultCountry = null) {
  const raw = typeof phoneInput === 'string' ? phoneInput.trim() : '';

  if (!raw) {
    return {
      raw: '',
      e164: null,
      comparisonValue: '',
      isValid: false,
      country: null,
      numberType: 'UNKNOWN',
      isSharedOffice: false,
      isVerifiedPersonal: false
    };
  }

  // Auto-detect NANP / US default when 10/11 digit US format is provided without leading +
  const digitsOnly = raw.replace(/\D/g, '');
  let countryContext = (defaultCountry && typeof defaultCountry === 'string' && defaultCountry.length === 2)
    ? defaultCountry.toUpperCase()
    : undefined;

  if (!countryContext && !raw.startsWith('+')) {
    if (digitsOnly.length === 10 || (digitsOnly.length === 11 && digitsOnly.startsWith('1'))) {
      countryContext = 'US';
    }
  }

  let parsed = null;
  try {
    parsed = parsePhoneNumberFromString(raw, countryContext);
  } catch (err) {
    parsed = null;
  }

  if (parsed && parsed.isValid()) {
    const e164 = parsed.format('E.164');
    const numType = parsed.getType() || 'UNKNOWN';
    const isSharedOffice = numType === 'FIXED_LINE' || numType === 'TOLL_FREE' || numType === 'PREMIUM_RATE';
    const isVerifiedPersonal = numType === 'MOBILE' || numType === 'FIXED_LINE_OR_MOBILE';

    return {
      raw: raw,
      e164: e164,
      comparisonValue: e164,
      isValid: true,
      country: parsed.country || null,
      numberType: numType,
      isSharedOffice: isSharedOffice,
      isVerifiedPersonal: isVerifiedPersonal
    };
  }

  return {
    raw: raw,
    e164: null,
    comparisonValue: digitsOnly,
    isValid: false,
    country: null,
    numberType: 'UNVERIFIED',
    isSharedOffice: false,
    isVerifiedPersonal: false
  };
}

/**
 * Compare two phone numbers safely avoiding trailing digit collapse across country codes.
 */
function comparePhones(phoneA, phoneB) {
  const normA = typeof phoneA === 'object' && phoneA !== null ? phoneA : parseAndNormalizePhone(phoneA);
  const normB = typeof phoneB === 'object' && phoneB !== null ? phoneB : parseAndNormalizePhone(phoneB);

  if (!normA.raw || !normB.raw) {
    return { match: false, confidence: 'NONE', score: 0, reason: 'Empty phone number provided' };
  }

  // Both resolvable E.164
  if (normA.isValid && normB.isValid) {
    if (normA.e164 === normB.e164) {
      if (normA.isSharedOffice || normB.isSharedOffice) {
        return {
          match: true,
          confidence: 'SHARED_OFFICE',
          score: 15,
          reason: `Exact E.164 match (${normA.e164}) on shared office/landline (+15)`
        };
      }
      return {
        match: true,
        confidence: 'STRONG_PERSONAL',
        score: 50,
        reason: `Exact E.164 match (${normA.e164}) on verified personal mobile (+50)`
      };
    } else {
      return {
        match: false,
        confidence: 'NO_MATCH',
        score: -25,
        reason: `Different E.164 numbers (${normA.e164} vs ${normB.e164})`
      };
    }
  }

  // Country mismatch
  if (normA.country && normB.country && normA.country !== normB.country) {
    return {
      match: false,
      confidence: 'COUNTRY_MISMATCH',
      score: -25,
      reason: `Country code conflict (${normA.country} vs ${normB.country})`
    };
  }

  if (normA.comparisonValue && normB.comparisonValue && normA.comparisonValue === normB.comparisonValue) {
    return {
      match: true,
      confidence: 'WEAK_UNVERIFIED',
      score: 10,
      reason: `Unverified digit match (${normA.comparisonValue}) (+10)`
    };
  }

  return { match: false, confidence: 'NO_MATCH', score: 0, reason: 'Phone numbers do not match' };
}

module.exports = {
  parseAndNormalizePhone,
  comparePhones
};
