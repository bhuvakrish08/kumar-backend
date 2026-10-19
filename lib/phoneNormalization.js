/**
 * Safe International Phone Normalization Service (DRIE v0.2 Hardening)
 * Uses libphonenumber-js for strict international parsing.
 * Supports user-level default_country/phone_region.
 * NO auto-assuming US for unprefixed 10-digit numbers without region context.
 * NO trailing 10-digit matching across different country codes.
 * Distinguishes format validity, mobile classification, and verified personal ownership.
 */

const { parsePhoneNumberFromString } = require('libphonenumber-js/max');

/**
 * Resolves user region from user object or explicit country hint.
 * @param {Object|null} user - Authenticated user context
 * @param {string|null} hint - Explicit country code hint
 * @returns {string|null} Two-letter ISO country code or null
 */
function resolveUserRegion(user = null, hint = null) {
  if (hint && typeof hint === 'string' && hint.trim().length === 2) {
    return hint.trim().toUpperCase();
  }
  if (user && typeof user === 'object' && user !== null) {
    const region = user.phone_region || user.default_country || user.country;
    if (region && typeof region === 'string' && region.trim().length === 2) {
      return region.trim().toUpperCase();
    }
  }
  return null;
}

/**
 * Parses and normalizes phone numbers into E.164 format safely.
 * @param {string} phoneInput - Raw user-entered phone number
 * @param {string|null} defaultCountry - Two-letter ISO country code (e.g. 'US', 'TR', 'GB', 'IN')
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
      isMobileFormat: false,
      isSharedOffice: false,
      isVerifiedPersonal: false,
      ownershipVerified: false
    };
  }

  const digitsOnly = raw.replace(/\D/g, '');

  // Strictly use defaultCountry ONLY if explicitly provided as 2-letter ISO code.
  // NEVER assume US for an unprefixed 10-digit number when user region is unknown.
  let countryContext = (defaultCountry && typeof defaultCountry === 'string' && defaultCountry.trim().length === 2)
    ? defaultCountry.trim().toUpperCase()
    : undefined;

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
    const isMobileFormat = numType === 'MOBILE' || numType === 'FIXED_LINE_OR_MOBILE';

    return {
      raw: raw,
      e164: e164,
      comparisonValue: e164,
      isValid: true,
      country: parsed.country || null,
      numberType: numType,
      isMobileFormat: isMobileFormat,
      isSharedOffice: isSharedOffice,
      // Verified ownership requires identity verification; format validity alone does NOT establish ownership
      isVerifiedPersonal: isMobileFormat && !isSharedOffice,
      ownershipVerified: false
    };
  }

  // Region unknown and number has no explicit country code -> preserve as unverified
  return {
    raw: raw,
    e164: null,
    comparisonValue: digitsOnly,
    isValid: false,
    country: null,
    numberType: 'UNVERIFIED',
    isMobileFormat: false,
    isSharedOffice: false,
    isVerifiedPersonal: false,
    ownershipVerified: false
  };
}

/**
 * Compare two phone numbers safely avoiding trailing digit collapse across country codes.
 * @param {string|Object} phoneA - First phone string or parsed phone object
 * @param {string|Object} phoneB - Second phone string or parsed phone object
 * @param {string|null} userRegion - Authenticated user default country / phone region
 * @returns {Object} { match: boolean, confidence: string, score: number, reason: string }
 */
function comparePhones(phoneA, phoneB, userRegion = null) {
  const normA = (typeof phoneA === 'object' && phoneA !== null && 'e164' in phoneA)
    ? phoneA
    : parseAndNormalizePhone(phoneA, userRegion);
  const normB = (typeof phoneB === 'object' && phoneB !== null && 'e164' in phoneB)
    ? phoneB
    : parseAndNormalizePhone(phoneB, userRegion);

  if (!normA.raw || !normB.raw) {
    return { match: false, confidence: 'NONE', score: 0, reason: 'Empty phone number provided' };
  }

  // 1. Both numbers are valid E.164
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
        reason: `Exact E.164 match (${normA.e164}) on personal mobile (+50)`
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

  // 2. Country mismatch between two numbers with known countries
  if (normA.country && normB.country && normA.country !== normB.country) {
    return {
      match: false,
      confidence: 'COUNTRY_MISMATCH',
      score: -25,
      reason: `Country code conflict (${normA.country} vs ${normB.country})`
    };
  }

  // 3. One is verified E.164 and the other is unverified local format without country code
  // NEVER collapse identical trailing digits under different or unknown country codes!
  if ((normA.isValid && !normB.isValid) || (!normA.isValid && normB.isValid)) {
    return {
      match: false,
      confidence: 'UNVERIFIED_MISMATCH',
      score: 0,
      reason: 'Cannot establish match between verified international number and unverified local number'
    };
  }

  // 4. Both numbers are unverified local numbers
  if (!normA.isValid && !normB.isValid) {
    if (normA.comparisonValue && normB.comparisonValue && normA.comparisonValue === normB.comparisonValue && normA.comparisonValue.length >= 7) {
      return {
        match: true,
        confidence: 'WEAK_UNVERIFIED',
        score: 10,
        reason: `Unverified local digit match (${normA.comparisonValue}) (+10)`
      };
    }
  }

  return { match: false, confidence: 'NO_MATCH', score: 0, reason: 'Phone numbers do not match' };
}

module.exports = {
  resolveUserRegion,
  parseAndNormalizePhone,
  comparePhones
};
