function fullName(c) {
  return [c.first_name, c.middle_name, c.last_name].filter(Boolean).join(' ');
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

function buildNarrative(c) {
  const name = fullName(c);
  const sentences = [];

  if (c.job_title && c.company_name) {
    const location = place(c.work_city, c.work_state, c.work_country);
    sentences.push(`${name} works at ${c.company_name} as ${c.job_title}${location ? ` in ${location}` : ''}.`);
  } else if (c.company_name) {
    sentences.push(`${name} works at ${c.company_name}.`);
  } else if (c.job_title) {
    sentences.push(`${name} works as ${c.job_title}.`);
  }

  if (c.spouse_name) {
    sentences.push(`${c.first_name}'s spouse is ${c.spouse_name}.`);
  }

  if (c.introduced_by_name || c.met_context || c.met_place || c.met_date) {
    const pieces = [];
    if (c.introduced_by_name) pieces.push(`through ${c.introduced_by_name}`);
    if (c.met_context) pieces.push(`at ${c.met_context}`);
    if (c.met_place) pieces.push(`at ${c.met_place}`);
    const met = humanDate(c.met_date);
    if (met) pieces.push(`on ${met}`);
    if (pieces.length) sentences.push(`We met ${c.first_name} ${pieces.join(' ')}.`);
  }

  const birthday = humanDate(c.birthday);
  if (birthday) sentences.push(`${c.first_name}'s birthday is ${birthday}.`);
  if (c.interests) sentences.push(`${c.first_name} enjoys ${c.interests.replace(/[.]+$/, '')}.`);
  if (c.personal_notes) sentences.push(c.personal_notes.trim().replace(/([.!?])?$/, '.'));

  if (!sentences.length) {
    return `${name} is in your contacts. Add a few details and Kumarda’s Dossier will turn them into a short, readable biography.`;
  }
  return sentences.join(' ').replace(/\s+/g, ' ').trim();
}

module.exports = { buildNarrative };
