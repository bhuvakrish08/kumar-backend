function fullName(c) {
  return [c.first_name, c.middle_name, c.last_name].filter(Boolean).join(' ').trim();
}

function humanDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date);
}

function place(city, state, country) {
  return [city, state, country].filter(Boolean).join(', ');
}

function cleanSentence(text) {
  if (!text) return '';
  const trimmed = String(text).trim();
  if (!trimmed) return '';
  return trimmed.replace(/([.!?])?$/, '.');
}

/**
 * Builds a deterministic, comprehensive narrative dossier summary using:
 * - Contact information (name, role, company, location, personal notes, interests, birthday, spouse)
 * - "How I Know This Person" (introducer, met context, met place, met date, how we met notes)
 * - SOURCE tags
 * - Relationships (connected contacts and their roles)
 * - Interactions (recent activity, latest touchpoint, upcoming follow-ups)
 *
 * Guaranteed: No AI, never makes up or hallucinates information.
 */
function buildNarrative(c, sources = [], relationships = [], interactions = []) {
  const name = fullName(c) || c.first_name || 'This contact';
  const sentences = [];

  // 1. Identity, Nickname, and Professional Role
  const nicknamePart = c.nickname ? ` (known as "${c.nickname}")` : '';
  const location = place(c.work_city, c.work_state, c.work_country);

  if (c.job_title && c.company_name) {
    sentences.push(`${name}${nicknamePart} works as ${c.job_title} at ${c.company_name}${location ? ` in ${location}` : ''}.`);
  } else if (c.company_name) {
    sentences.push(`${name}${nicknamePart} is associated with ${c.company_name}${location ? ` in ${location}` : ''}.`);
  } else if (c.job_title) {
    sentences.push(`${name}${nicknamePart} works as ${c.job_title}${location ? ` in ${location}` : ''}.`);
  } else if (location) {
    sentences.push(`${name}${nicknamePart} is based in ${location}.`);
  }

  // 2. How I Know This Person (Meeting context, introducer, place, date, meeting notes)
  const hasMetInfo = c.introduced_by_name || c.met_context || c.met_place || c.met_date;
  if (hasMetInfo) {
    const metPieces = [];
    if (c.introduced_by_name) {
      metPieces.push(`through ${c.introduced_by_name}`);
    }
    if (c.met_context) {
      metPieces.push(`at ${c.met_context}`);
    }
    if (c.met_place) {
      metPieces.push(`in ${c.met_place}`);
    }
    const metDateStr = humanDate(c.met_date);
    if (metDateStr) {
      metPieces.push(`on ${metDateStr}`);
    }
    if (metPieces.length) {
      sentences.push(`First connected ${metPieces.join(' ')}.`);
    }
  }

  if (c.how_we_met_notes) {
    sentences.push(cleanSentence(c.how_we_met_notes));
  }

  // 3. SOURCE Tags
  const sourceNames = (sources || [])
    .map(s => (typeof s === 'string' ? s : s?.name))
    .filter(Boolean);

  if (sourceNames.length > 0) {
    const tagList = sourceNames.join(', ');
    sentences.push(`Categorized under the SOURCE tag${sourceNames.length > 1 ? 's' : ''}: ${tagList}.`);
  }

  // 4. Relationships (Connections to other people)
  if (relationships && relationships.length > 0) {
    const relDescriptions = relationships.slice(0, 4).map(r => {
      const relPerson = r.related_name || r.linked_name || 'Contact';
      const relType = r.relationship_type || 'Connected';
      return `${relPerson} (${relType})`;
    });
    sentences.push(`Connected in your network to: ${relDescriptions.join(', ')}.`);
  }

  // 5. Interactions & Follow-up Status
  if (interactions && interactions.length > 0) {
    // interactions are sorted newest first
    const latest = interactions[0];
    const latestDate = humanDate(latest.occurred_at);
    const typeStr = (latest.interaction_type || 'interaction').toLowerCase();
    const subjectStr = latest.subject ? ` regarding "${latest.subject}"` : '';

    if (latestDate) {
      sentences.push(`The most recent interaction was a ${typeStr}${subjectStr} on ${latestDate}.`);
    } else {
      sentences.push(`The most recent interaction recorded was a ${typeStr}${subjectStr}.`);
    }

    // Check for pending follow-up across interactions
    const pendingFollowUp = interactions.find(
      i => i.follow_up_status === 'pending' && i.follow_up_date
    );
    if (pendingFollowUp) {
      const fDate = humanDate(pendingFollowUp.follow_up_date);
      if (fDate) {
        sentences.push(`A follow-up is scheduled for ${fDate}.`);
      }
    }
  }

  // 6. Personal Details (Family, Birthday, Interests, Notes)
  if (c.spouse_name) {
    sentences.push(`${c.first_name}'s spouse is ${c.spouse_name}.`);
  }

  const birthday = humanDate(c.birthday);
  if (birthday) {
    sentences.push(`${c.first_name}'s birthday is ${birthday}.`);
  }

  if (c.interests) {
    sentences.push(`${c.first_name} enjoys ${c.interests.replace(/[.]+$/, '')}.`);
  }

  if (c.personal_notes) {
    sentences.push(cleanSentence(c.personal_notes));
  }

  // Fallback if record is completely bare
  if (!sentences.length) {
    return `${name} is in your contacts. Add relationship details, SOURCE tags, interactions, or how you met to build an executive briefing summary.`;
  }

  return sentences.join(' ').replace(/\s+/g, ' ').trim();
}

module.exports = { buildNarrative, fullName, humanDate, place };
