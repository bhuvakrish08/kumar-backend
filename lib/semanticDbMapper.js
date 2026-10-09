/**
 * Centralized Semantic-to-Database Mapping Layer (Sprint 2 Correction)
 * Maps high-level extracted semantic facts (e.g. professional role, current/future employment, phone, email)
 * to the physical columns of the existing contacts and contact_history database tables.
 */

const { parseAndNormalizePhone } = require('./phoneNormalization');

/**
 * Maps CandidateFactSet person object and temporal facts to database fields.
 * @param {Object} personFact - Extracted person candidate fact object
 * @param {Object} options - Additional options including temporal analysis
 * @returns {Object} { dbContactFields, historyEntries }
 */
function mapSemanticFactToDatabaseFields(personFact = {}, options = {}) {
  const normPhone = personFact.phone ? parseAndNormalizePhone(personFact.phone) : null;
  const cleanPhone = normPhone && normPhone.isValid ? normPhone.e164 : (personFact.phone || null);

  // Parse Name
  const nameStr = (personFact.name || 'Unknown').trim();
  const nameParts = nameStr.split(/\s+/);
  let firstName = nameParts[0] || 'Unknown';
  let lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';
  let middleName = '';
  if (nameParts.length > 2) {
    middleName = nameParts.slice(1, -1).join(' ');
    lastName = nameParts[nameParts.length - 1];
  }

  // Professional Role -> job_title
  const jobTitle = personFact.professional_role || personFact.title || null;

  // Organization -> company_name (only if current)
  const isFutureOrHistorical = options.temporalStatus === 'FUTURE' || options.temporalStatus === 'HISTORICAL';
  const companyName = !isFutureOrHistorical ? (personFact.organization || null) : null;

  const dbContactFields = {
    first_name: firstName,
    middle_name: middleName,
    last_name: lastName,
    job_title: jobTitle,
    company_name: companyName,
    primary_phone: cleanPhone,
    primary_email: personFact.email || null,
    met_date: personFact.met_date || null,
    met_context: personFact.meeting_context || null,
    introduced_by_name: personFact.introducer || null,
    how_we_met_notes: personFact.meeting_context || null,
    personal_notes: personFact.notes || null
  };

  const historyEntries = [];

  // If employment is future or historical, map to contact_history entry
  if (personFact.organization && isFutureOrHistorical) {
    historyEntries.push({
      fact_type: 'employment',
      value_payload: { company_name: personFact.organization, role: jobTitle },
      is_current: false,
      confidence_status: options.temporalStatus || 'FUTURE',
      valid_from: null,
      valid_to: options.temporalStatus === 'HISTORICAL' ? new Date() : null
    });
  } else if (companyName) {
    historyEntries.push({
      fact_type: 'employment',
      value_payload: { company_name: companyName, role: jobTitle },
      is_current: true,
      confidence_status: 'CONFIRMED',
      valid_from: new Date(),
      valid_to: null
    });
  }

  if (cleanPhone) {
    historyEntries.push({
      fact_type: 'phone',
      value_payload: { phone: cleanPhone },
      is_current: true,
      confidence_status: 'CONFIRMED',
      valid_from: new Date()
    });
  }

  if (personFact.email) {
    historyEntries.push({
      fact_type: 'email',
      value_payload: { email: personFact.email },
      is_current: true,
      confidence_status: 'CONFIRMED',
      valid_from: new Date()
    });
  }

  return {
    dbContactFields,
    historyEntries
  };
}

module.exports = {
  mapSemanticFactToDatabaseFields
};
