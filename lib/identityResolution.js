/**
 * Identity Resolution Engine v0.1
 * Deterministic and explainable identity matching in backend code.
 */

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  // Return last 10 digits if available
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

function normalizeEmail(email) {
  if (!email) return '';
  return email.trim().toLowerCase();
}

function normalizeName(name) {
  if (!name) return '';
  let cleaned = name.trim().toLowerCase();
  // Strip honorifics
  cleaned = cleaned.replace(/\b(mr|mrs|ms|dr|prof|sir)\b\.?/g, '').trim();
  // Replace multiple spaces
  return cleaned.replace(/\s+/g, ' ');
}

function normalizeCompany(company) {
  if (!company) return '';
  let cleaned = company.trim().toLowerCase();
  cleaned = cleaned.replace(/\b(inc|llc|corp|corporation|ltd|limited|pvt|co)\b\.?/g, '').trim();
  return cleaned.replace(/\s+/g, ' ');
}

/**
 * Score candidate facts against owner's existing contacts
 * @param {Object} candidatePerson - extracted candidate facts person object { name, phone, email, title, organization, introducer }
 * @param {Array} existingContacts - list of contact records owned by the user
 */
function resolveIdentity(candidatePerson, existingContacts = []) {
  if (!candidatePerson || !existingContacts || existingContacts.length === 0) {
    return {
      decision: 'NEW_PERSON',
      matchedContactId: null,
      candidateContacts: [],
      evidence: ['No existing contacts found for user. Categorized as NEW_PERSON.']
    };
  }

  const candName = normalizeName(candidatePerson.name);
  const candPhone = normalizePhone(candidatePerson.phone);
  const candEmail = normalizeEmail(candidatePerson.email);
  const candCompany = normalizeCompany(candidatePerson.organization);
  const candIntro = normalizeName(candidatePerson.introducer);

  if (!candName && !candPhone && !candEmail) {
    return {
      decision: 'NEW_PERSON',
      matchedContactId: null,
      candidateContacts: [],
      evidence: ['Insufficient extracted identifiers for contact matching.']
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
    const nickname = normalizeName(contact.nickname);
    const contactPhone = normalizePhone(contact.primary_phone || contact.mobile_phone);
    const contactEmail = normalizeEmail(contact.primary_email);
    const contactCompany = normalizeCompany(contact.company_name);
    const contactIntro = normalizeName(contact.introduced_by_name);

    // 1. Phone matching
    if (candPhone && contactPhone && candPhone === contactPhone) {
      matchingPhoneContacts.push(contact);
      const nameCompatible = candName && (fullName.includes(candName) || candName.includes(firstName) || (nickname && candName.includes(nickname)));
      if (nameCompatible || !candName) {
        score += 50;
        evidence.push(`Exact mobile/phone match (${candPhone}) with compatible name (+50)`);
      } else {
        score += 15;
        evidence.push(`Shared business phone match (${candPhone}) but names differ (+15)`);
      }
    }

    // 2. Email matching
    if (candEmail && contactEmail && candEmail === contactEmail) {
      matchingEmailContacts.push(contact);
      score += 50;
      evidence.push(`Exact email match (${candEmail}) (+50)`);
    }

    // 3. Name & Company matching
    if (candName && fullName) {
      if (candName === fullName) {
        score += 30;
        evidence.push(`Exact full name match ("${contact.first_name} ${contact.last_name}") (+30)`);
        if (candCompany && contactCompany && candCompany === contactCompany) {
          score += 15;
          evidence.push(`Exact company match ("${contact.company_name}") (+15)`);
        }
      } else if (candName.includes(firstName) || firstName.includes(candName) || (nickname && candName === nickname)) {
        score += 15;
        evidence.push(`First name or nickname match ("${candName}") (+15)`);
        if (candCompany && contactCompany && candCompany === contactCompany) {
          score += 15;
          evidence.push(`Company match ("${contact.company_name}") (+15)`);
        }
        if (candIntro && contactIntro && candIntro === contactIntro) {
          score += 10;
          evidence.push(`Introducer match ("${contact.introduced_by_name}") (+10)`);
        }
      }
    } else if (candName && nickname && candName === nickname) {
      score += 20;
      evidence.push(`Nickname match ("${contact.nickname}") (+20)`);
    }

    // Negative evidence / conflicts
    if (candCompany && contactCompany && candCompany !== contactCompany && score > 20) {
      evidence.push(`Company mismatch ("${candidatePerson.organization}" vs "${contact.company_name}") - Possible employer change`);
    }

    if (score > 0) {
      scoredCandidates.push({
        contactId: contact.id,
        contactName: `${contact.first_name} ${contact.last_name}`.trim(),
        company: contact.company_name,
        score,
        evidence
      });
    }
  }

  // Sort candidates by score descending
  scoredCandidates.sort((a, b) => b.score - a.score);

  // Check for CONFLICT: phone matches Contact A, email matches Contact B
  if (matchingPhoneContacts.length > 0 && matchingEmailContacts.length > 0) {
    if (matchingPhoneContacts[0].id !== matchingEmailContacts[0].id) {
      return {
        decision: 'CONFLICT',
        matchedContactId: null,
        candidateContacts: scoredCandidates,
        evidence: [
          `Conflicting identifiers: Phone matches ${matchingPhoneContacts[0].first_name} ${matchingPhoneContacts[0].last_name} (ID: ${matchingPhoneContacts[0].id}), but Email matches ${matchingEmailContacts[0].first_name} ${matchingEmailContacts[0].last_name} (ID: ${matchingEmailContacts[0].id}). Review required.`
        ]
      };
    }
  }

  // Check for AMBIGUOUS: multiple candidates with high close scores (e.g. multiple Michaels or shared phone)
  if (scoredCandidates.length > 1) {
    const top = scoredCandidates[0];
    const runnerUp = scoredCandidates[1];
    if (top.score >= 30 && (top.score - runnerUp.score < 15)) {
      return {
        decision: 'AMBIGUOUS',
        matchedContactId: null,
        candidateContacts: scoredCandidates,
        evidence: [
          `Multiple contacts matched similar identity criteria (${top.contactName} [Score ${top.score}] vs ${runnerUp.contactName} [Score ${runnerUp.score}]). User selection required.`
        ]
      };
    }
  }

  if (scoredCandidates.length === 0 || scoredCandidates[0].score < 20) {
    return {
      decision: 'NEW_PERSON',
      matchedContactId: null,
      candidateContacts: scoredCandidates,
      evidence: ['No existing contact matched confidence threshold. Proposed as NEW_PERSON.']
    };
  }

  const topMatch = scoredCandidates[0];
  if (topMatch.score >= 45) {
    return {
      decision: 'MATCH',
      matchedContactId: topMatch.contactId,
      candidateContacts: scoredCandidates,
      evidence: topMatch.evidence
    };
  } else {
    return {
      decision: 'PROBABLE_MATCH',
      matchedContactId: topMatch.contactId,
      candidateContacts: scoredCandidates,
      evidence: topMatch.evidence
    };
  }
}

module.exports = {
  normalizePhone,
  normalizeEmail,
  normalizeName,
  normalizeCompany,
  resolveIdentity
};
