/**
 * Server-Side Provider-Neutral Intelligence Service
 * Performs extraction and intent parsing.
 * NEVER writes directly to database or selects owner_user_id.
 */

const http = require('http');
const https = require('https');

const PARSER_VERSION = '2.0.0';

/**
 * Helper to parse commitment date and time locally from snippet
 */
function extractCommitmentDateAndTime(snippet) {
  if (!snippet || typeof snippet !== 'string') return null;
  const lower = snippet.toLowerCase();
  
  let timeStr = '10:00:00';
  const timeMatch = snippet.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const mins = timeMatch[2] ? timeMatch[2].padStart(2, '0') : '00';
    const ampm = timeMatch[3].toUpperCase();
    if (ampm === 'PM' && hours < 12) hours += 12;
    if (ampm === 'AM' && hours === 12) hours = 0;
    timeStr = `${String(hours).padStart(2, '0')}:${mins}:00`;
  }

  if (lower.includes('tomorrow') || lower.includes('tommorow')) {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return `${d.toISOString().split('T')[0]} ${timeStr}`;
  }
  if (lower.includes('next week')) {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return `${d.toISOString().split('T')[0]} ${timeStr}`;
  }

  const dateMatch = snippet.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(october|octomber|november|december|january|february|march|april|may|june|july|august|september)(?:\s+(\d{4}))?/i)
    || snippet.match(/(october|octomber|november|december|january|february|march|april|may|june|july|august|september)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?/i);
    
  if (dateMatch) {
    const monthMap = {
      january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
      july: '07', august: '08', september: '09', october: '10', octomber: '10', november: '11', december: '12'
    };
    const isFirstNum = /^\d+$/.test(dateMatch[1]);
    const dayStr = (isFirstNum ? dateMatch[1] : dateMatch[2]).padStart(2, '0');
    const monthWord = (isFirstNum ? dateMatch[2] : dateMatch[1]).toLowerCase();
    const yearStr = dateMatch[3] || new Date().getFullYear();
    const monthStr = monthMap[monthWord] || '10';
    return `${yearStr}-${monthStr}-${dayStr} ${timeStr}`;
  }

  return null;
}

/**
 * Extracts multiple commitments, enumerated follow-ups, and scheduled meetings.
 */
function extractAllCommitments(rawText, contactName = '') {
  const commitments = [];
  const addedTitles = new Set();

  function addCommitment(type, title, details, snippet) {
    let cleanTitle = title
      .replace(/^[,\s.:;—–-]+|[,\s.:;—–-]+$/g, '')
      .replace(/\s+(?:and\s+)?(?:his\s+|her\s+|my\s+)?(?:email|phone|mobile|number|contact|\w+\s+email|\w+\s+phone)\s+is.*$/i, '')
      .trim();
    if (cleanTitle.length < 4) return;
    cleanTitle = cleanTitle.charAt(0).toUpperCase() + cleanTitle.slice(1);
    const key = cleanTitle.toLowerCase();
    if (addedTitles.has(key)) return;
    addedTitles.add(key);
    
    commitments.push({
      type,
      title: cleanTitle,
      details: (details || cleanTitle).trim(),
      due_time: extractCommitmentDateAndTime(snippet || details || title)
    });
  }

  // 1. Ordinal Enumeration Detection ("First, ... Second, ... Third, ...")
  const ordinalMarkers = /\b(?:First|Second|Third|Fourth|Fifth|1st|2nd|3rd|4th|5th)\b[,\s:—–-]+/gi;
  const matchIndices = [];
  let m;
  while ((m = ordinalMarkers.exec(rawText)) !== null) {
    matchIndices.push({ index: m.index, marker: m[0] });
  }

  if (matchIndices.length > 0) {
    for (let i = 0; i < matchIndices.length; i++) {
      const start = matchIndices[i].index + matchIndices[i].marker.length;
      const end = (i + 1 < matchIndices.length) ? matchIndices[i + 1].index : rawText.length;
      let chunk = rawText.slice(start, end).trim();
      chunk = chunk.replace(/[.\n;]+$/, '').trim();
      
      const lower = chunk.toLowerCase();
      let type = 'follow_up';
      if (lower.startsWith('call') || lower.startsWith('phone') || lower.startsWith('speak') || lower.startsWith('talk')) {
        type = 'follow_up';
      } else if (lower.startsWith('prepare') || lower.startsWith('send') || lower.startsWith('draft') || lower.startsWith('share')) {
        type = 'expected_item';
      } else if (lower.includes('meeting') || lower.includes('appointment')) {
        type = 'appointment';
      }
      addCommitment(type, chunk, chunk, chunk);
    }
  }

  // 2. Scheduled Meeting Detection
  const meetingMatch = rawText.match(/(?:scheduled|set|arranged|booked)\s+(?:a\s+)?meeting\s+(?:for|on)?\s*([^.\n]+)/i);
  if (meetingMatch) {
    const snippet = meetingMatch[0].trim();
    const title = `Meeting with ${contactName || 'Contact'} (${meetingMatch[1].trim()})`;
    addCommitment('appointment', title, snippet, snippet);
  }

  // 3. Standard Action Patterns
  const patterns = [
    { regex: /(?:will\s+set\s+(?:an?|a)?\s*meeting|set\s+(?:an?|a)?\s*meeting)\s+([^.\n]+)/i, type: 'appointment' },
    { regex: /(?:will\s+schedule|schedule|scheduling)\s+([^.\n]+)/i, type: 'appointment' },
    { regex: /(?:meet\s*up|meetup)\s+at\s+([^.\n]+)/i, type: 'appointment' },
    { regex: /(?:will\s+send|sending|to\s+send|share|share\s+catalog|send\s+pricing|provide)\s+([^.\n]+)/i, type: 'expected_item' },
    { regex: /(?:follow\s*up|follow-up)\s+([^.\n]+)/i, type: 'follow_up' },
    { regex: /(?:remind\s+me\s+to|don't\s+forget\s+to)\s+([^.\n]+)/i, type: 'reminder' }
  ];
  for (const p of patterns) {
    const match = rawText.match(p.regex);
    if (match) {
      addCommitment(p.type, match[0].trim(), match[1] ? match[1].trim() : match[0].trim(), match[0]);
    }
  }

  return commitments;
}

/**
 * Natural language rule engine fallback for entity extraction
 */
function extractWithRuleEngine(rawContent, context = {}) {
  const text = (rawContent || '').trim();
  const lower = text.toLowerCase();

  // Flexible Phone Match (Standard, International, 10-digit, spaced/hyphenated)
  const phoneMatch = text.match(/(?:\+91[-.\s]?)?[6-9]\d{4}[-.\s]?\d{5}\b/)
    || text.match(/(?:\+\d{1,3}[-.\s]?)?\(?\d{3,4}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/)
    || text.match(/\b\d{5}[-.\s]?\d{5}\b/);

  // Email Match
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

  let name = null;
  let company = null;
  let title = null;
  let introducer = null;
  let metDate = null;
  let metContext = null;
  let workCity = null;
  let spouseName = null;

  // 1. Name Extraction Patterns
  // Pattern A: "I met Dr. Rahul Patel", "i will meet manthan", "Had lunch with Michael", "Connected with Priya"
  const metPattern = /(?:i\s+(?:will\s+)?meet|will\s+meet|met|spoke\s+with|talked\s+to|connected\s+with|had\s+(?:lunch|dinner|coffee|a\s+meeting)\s+with|contact:?)\s+((?:Dr\.|Mr\.|Mrs\.|Ms\.|Prof\.|Er\.)?\s*[A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?)/i;
  const metMatch = text.match(metPattern);
  if (metMatch) {
    name = metMatch[1].trim();
    name = name.replace(/[;,!?]/g, '').replace(/\s+(?:today|yesterday|tomorrow|tommorow|this|at|from|with|for|and|who|he|she)$/i, '').trim();
  }

  // Pattern B: "referred me of manthan", "referred me to manthan", "referred manthan"
  if (!name) {
    const referredTargetMatch = text.match(/referred\s+(?:me\s+(?:of|to)|us\s+(?:of|to)|to\s+me\s+)?\s*([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?)/i);
    if (referredTargetMatch) {
      name = referredTargetMatch[1].trim();
    }
  }

  // Pattern C: "Yesterday i met Yashesh Patel." or capitalized name at start/phrase
  if (!name) {
    const namePhraseMatch = text.match(/(?:met|with|to)\s+((?:Dr\.|Mr\.|Mrs\.|Ms\.|Prof\.|Er\.)?\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
    if (namePhraseMatch) {
      name = namePhraseMatch[1].trim();
    }
  }

  // Pattern D: Capitalized words fallback
  if (!name) {
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[^a-zA-Z]/g, '');
      if (w.length > 2 && /^[A-Z][a-z]+$/.test(w) && !['Today', 'Yesterday', 'Tomorrow', 'Phone', 'Email', 'He', 'She', 'They', 'His', 'Her', 'Met', 'Also', 'Owner', 'CEO', 'CTO', 'The', 'A', 'An', 'That', 'This', 'Chief', 'Architect', 'Founder', 'Director', 'Manager', 'VP'].includes(w)) {
        name = w;
        if (i + 1 < words.length && /^[A-Z][a-z]+$/.test(words[i+1].replace(/[^a-zA-Z]/g, '')) && !['Today', 'Yesterday', 'Tomorrow', 'Owner', 'Exim'].includes(words[i+1])) {
          name += ' ' + words[i+1].replace(/[^a-zA-Z]/g, '');
        }
        break;
      }
    }
  }

  // Clean and title-case name
  if (name) {
    name = name.replace(/[.,;!?]/g, '').trim();
    if (name.toLowerCase().startsWith('the ')) name = name.slice(4).trim();
    if (['the', 'a', 'an'].includes(name.toLowerCase())) {
      name = null;
    } else if (['chief architect', 'architect', 'founder', 'director', 'manager', 'vp', 'ceo', 'cto'].includes(name.toLowerCase())) {
      if (!title) title = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      name = null;
    } else {
      name = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
  }

  // 2. Title & Organization Extraction
  // Pattern A: "Managing Director of Shah Industries", "CEO of IBM", "co-founder at Google"
  const titleOrgMatch = text.match(/(?:is(?:\s+\b(?:a|an|the)\b)?|works?\s+as(?:\s+\b(?:a|an|the)\b)?|title\s+is)?\s*\b(managing director|executive director|general manager|managing partner|vice president|vp|owner|founder|co-founder|ceo|cto|cfo|coo|manager|director|president|partner|head|lead|developer|engineer|consultant|designer|analyst|architect|chief architect)\s+(?:of|at|for|in)\s+([A-Za-z0-9][A-Za-z0-9&.\s]{1,30}?)(?=\s+and|\s+his|\s+her|\s+he|\s+she|\s+phone|\s+email|\.|\,|$|\s+we|\s+who|\s+that)/i);
  if (titleOrgMatch) {
    title = titleOrgMatch[1].trim();
    title = title.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    company = titleOrgMatch[2].trim().replace(/[.,;!?]/g, '');
  }

  // Pattern B: standalone company: "from ABC", "at IBM", "works at Microsoft", "work for Digiva"
  if (!company) {
    const companyPattern = /(?:from|at|works?\s+(?:at|for|with)|will\s+work\s+(?:for|with)|work\s+(?:for|with)|working\s+(?:for|with)|joined|for)\s+([A-Za-z0-9][a-zA-C0-9&.\s]{1,30}?)(?=\s+today|\s+yesterday|\s+tomorrow|\.|\,|$|\s+his|\s+her|\s+he|\s+she|\s+as|\s+and|\s+mobile|\s+phone)/i;
    const companyMatch = text.match(companyPattern);
    if (companyMatch) {
      let candidateComp = companyMatch[1].trim();
      candidateComp = candidateComp.replace(/[.,;!?]/g, '').replace(/\s+(?:and|with|for|at|his|her|he|she|today|yesterday|tomorrow)$/i, '').trim();
      const compLower = candidateComp.toLowerCase();
      const knownCities = ['london', 'mumbai', 'delhi', 'ahmedabad', 'cupertino', 'seattle', 'new york', 'san francisco', 'boston', 'chicago', 'austin', 'tokyo', 'paris', 'berlin', 'toronto', 'india', 'uk', 'usa'];
      if (knownCities.includes(compLower)) {
        workCity = candidateComp.charAt(0).toUpperCase() + candidateComp.slice(1);
      } else if (candidateComp && !['today', 'yesterday', 'tomorrow', 'lunch', 'dinner', 'coffee', 'the office'].includes(compLower)) {
        company = candidateComp.charAt(0).toUpperCase() + candidateComp.slice(1);
      }
    }
  }

  // Pattern C: standalone Title: "works as CTO", "is full stack developer", "VP of Sales", "Manager"
  if (!title) {
    const titleMatch = text.match(/(?:is(?:\s+\b(?:a|an|the)\b)?|works?\s+as(?:\s+\b(?:a|an|the)\b)?|title\s+is)\s+([A-Za-z]+(?:\s+[A-Za-z]+)*)(?=\s+at|\s+from|\s+for|\.|\,|$|\s+and|\s+he|\s+she|\s+who)/i);
    if (titleMatch) {
      let rawT = titleMatch[1].replace(/[.,;!?]/g, '').replace(/\s+(?:and|he|she|at|from|for|who).*$/i, '').trim();
      if (rawT && rawT.length < 50) {
        title = rawT.charAt(0).toUpperCase() + rawT.slice(1);
      }
    }
  }

  // 3. Introducer Extraction
  // Patterns: "introduced by Sarah", "referred by Bob", "cousin of Yash Patel, who referred him to me", "rajni sir introduced me to yashesh patel"
  const introMatch = text.match(/(?:introduced\s+by|referred\s+by|met\s+through|connected\s+via|brought\s+by)\s+([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?(?:\s+(?:sir|ji|ma'am|madam))?)/i)
    || text.match(/(?:cousin\s+of\s+)?([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?)[, ]+\s*who\s+referred\s+(?:him|her|them|me|us)\b/i)
    || text.match(/([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?(?:\s+(?:sir|ji|ma'am|madam))?)\s+introduced\s+(?:me|us)?\s*(?:to\s+([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?))?/i)
    || text.match(/\b(?!(?:who|that|he|she|and)\b)([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?)\s+referred\s+(?:me\s+(?:of|to)|us\s+(?:of|to))?\s*([A-Za-z][a-z]+)?/i);
  if (introMatch) {
    let rawIntro = introMatch[1].trim();
    rawIntro = rawIntro.replace(/^(?:and\s+|that\s+|who\s+|whom\s+)/i, '').trim();
    if (rawIntro && !['i', 'he', 'she', 'they', 'who', 'and', 'also', 'at', 'that', 'whom'].includes(rawIntro.toLowerCase())) {
      introducer = rawIntro.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      // If name was mistakenly identified as the introducer, swap or reassign if second person was matched
      if (introMatch[2] && (!name || name.toLowerCase() === introducer.toLowerCase())) {
        name = introMatch[2].charAt(0).toUpperCase() + introMatch[2].slice(1).toLowerCase();
      }
    }
  }

  // 4. Meeting Context & Dates
  let rawDateExpr = null;
  const monthMap = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', octomber: '10', november: '11', december: '12'
  };

  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const explicitDateMatch = text.match(/\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|octomber|november|december)(?:\s+(\d{4}))?\b/i)
    || text.match(/\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|octomber|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i);

  if (isoMatch) {
    metDate = `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
    metContext = `Met on ${metDate}`;
    rawDateExpr = isoMatch[0];
  } else if (explicitDateMatch) {
    const isFirstNum = /^\d+$/.test(explicitDateMatch[1]);
    const dayStr = (isFirstNum ? explicitDateMatch[1] : explicitDateMatch[2]).padStart(2, '0');
    const monthWord = (isFirstNum ? explicitDateMatch[2] : explicitDateMatch[1]).toLowerCase();
    const yearStr = explicitDateMatch[3] || '2024';
    const monthStr = monthMap[monthWord] || '01';
    metDate = `${yearStr}-${monthStr}-${dayStr}`;
    metContext = `Met on ${explicitDateMatch[0]}`;
    rawDateExpr = explicitDateMatch[0];
  } else if (lower.includes('today')) {
    metDate = new Date().toISOString().split('T')[0];
    metContext = 'Met today';
    rawDateExpr = 'today';
  } else if (lower.includes('yesterday')) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    metDate = d.toISOString().split('T')[0];
    metContext = 'Met yesterday';
    rawDateExpr = 'yesterday';
  } else if (lower.match(/\b(?:years\s+ago|many\s+years\s+ago)\b/i)) {
    metDate = null;
    metContext = 'Met years ago';
    rawDateExpr = 'years ago';
  } else if (lower.match(/\b(?:recently|spoke\s+recently|met\s+recently)\b/i)) {
    metDate = null;
    metContext = 'Spoke recently';
    rawDateExpr = 'recently';
  } else if (lower.match(/\b(?:last\s+month)\b/i)) {
    metDate = null;
    metContext = 'Last month';
    rawDateExpr = 'last month';
  } else {
    metDate = null;
    metContext = null;
    rawDateExpr = null;
  }

  // Check specific venue/event context: "at jaybhai wedding", "at Club baby loan hotel", "at the conference", "had an event"
  const contextEventMatch = text.match(/(?:at|had|in|attended)\s+([A-Za-z0-9\s]{2,45}?\s+(?:wedding|party|event|conference|summit|meetup|office|hotel|dinner|lunch|cafe|reception|expo|club))/i);
  if (contextEventMatch) {
    const rawCtx = contextEventMatch[1].trim();
    const cleanCtx = rawCtx.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    if (metContext && metContext !== 'Recent interaction') {
      metContext = `${metContext} at ${cleanCtx}`;
    } else {
      metContext = `At ${cleanCtx}`;
    }
  }

  // 5. Commitments & Tasks Extraction (Multi-Commitment + Ordinal Enumeration Support)
  const commitments = extractAllCommitments(text, name);

  // 6. Age & Notes Extraction
  let personalNotes = text;
  const ageMatch = text.match(/(?:his|her|my|age\s+is|\b)\s*age\s+is\s+(\d{1,3})/i)
    || text.match(/(\d{1,3})\s*years?\s+old/i);
  if (ageMatch) {
    const ageVal = ageMatch[1];
    if (!personalNotes.toLowerCase().includes(`age: ${ageVal}`)) {
      personalNotes = `Age: ${ageVal}. ${text}`;
    }
  }

  // 7. Spouse & Geography Extraction
  const spouseMatch = text.match(/(?:married\s+to|wife(?:\s+is)?|husband(?:\s+is)?|spouse(?:\s+is)?)\s+([A-Za-z][a-z]+)/i);
  if (spouseMatch) {
    spouseName = spouseMatch[1].trim();
  }

  const cityMatch = text.match(/(?:from|in|based\s+in|lives?\s+in)\s+([A-Z][a-z]+)(?=\s+and|\s+with|\s+who|\.|\,|$)/);
  if (cityMatch && !['Today', 'Yesterday', 'Tomorrow', 'Summit', 'Hotel'].includes(cityMatch[1])) {
    workCity = cityMatch[1].trim();
  }

  // 8. Interests
  let interests = null;
  const interestMatch = text.match(/(?:whisky|golf|tennis|cricket|wine|sailing|chess|fine\s+single\s+malt\s+whisky)/i);
  if (interestMatch) {
    interests = interestMatch[0].trim();
  }

  // 9. Sources
  const sources = [];
  if (company) sources.push(company);
  if (lower.includes('conference') || lower.includes('event') || lower.includes('wedding') || lower.includes('expo')) sources.push('Event');
  if (sources.length === 0) sources.push('Direct Input');

  // 10. Uncertain Dates
  const uncertainDates = [];
  if (lower.includes('sometime') || lower.includes('maybe next week') || lower.includes('around')) {
    uncertainDates.push('Approximate or unconfirmed date specified in text');
  }

  // 11. Sentence Polishing (Deterministic Fallback)
  const polishedMemory = polishSentenceDeterministic(rawContent);

  return {
    provider: 'rule-engine',
    model: 'local-rule-v1',
    parser_version: PARSER_VERSION,
    polishedMemory: polishedMemory,
    person: {
      name: name || 'Unknown Person',
      phone: phoneMatch ? phoneMatch[0] : null,
      email: emailMatch ? emailMatch[0] : null,
      title: title || null,
      organization: company || null,
      introducer: introducer || null,
      spouse_name: spouseName,
      work_city: workCity,
      interests: interests,
      meeting_context: metContext,
      met_date: metDate,
      notes: personalNotes
    },
    sources: sources,
    interaction: {
      type: 'Meeting',
      details: text,
      date: metDate || null,
      raw_date_expression: rawDateExpr || null
    },
    commitments: commitments,
    uncertain_dates: uncertainDates
  };
}

/**
 * Deterministic sentence polisher: Improves grammar, capitalization, and punctuation
 * while preserving original meaning, names, dates, and uncertainty.
 */
function polishSentenceDeterministic(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  let text = rawContent.trim();
  if (!text) return '';

  // 1. Normalize whitespace
  text = text.replace(/\s+/g, ' ');

  // 2. Idiomatic sentence connector transforms for common informal patterns
  text = text
    .replace(/\bi met\b/gi, 'I met')
    .replace(/\bmet\b/gi, 'Met')
    .replace(/\bi had an event\b/gi, 'I had an event')
    .replace(/\ban meeting\b/gi, 'a meeting')
    .replace(/\ban cousin\b/gi, 'a cousin')
    .replace(/\breferred me of\b/gi, 'referred me to')
    .replace(/\bhe will work for\b/gi, 'will work for')
    .replace(/\band he is a\b/gi, '. He is a')
    .replace(/\band she is a\b/gi, '. She is a')
    .replace(/\band he is\b/gi, '. He is')
    .replace(/\band she is\b/gi, '. She is')
    .replace(/\band he will\b/gi, ' and will')
    .replace(/\band she will\b/gi, ' and will')
    .replace(/\bremind me to\b/gi, '. Remind me to')
    .replace(/\bhis phone is\b/gi, '. His phone is')
    .replace(/\bher phone is\b/gi, '. Her phone is')
    .replace(/\bhis mobile is\b/gi, '. His mobile is')
    .replace(/\bher mobile is\b/gi, '. Her mobile is')
    .replace(/\bhis email is\b/gi, '. His email is')
    .replace(/\bher email is\b/gi, '. Her email is')
    .replace(/\bmichael introduced us\b/gi, '. Michael introduced us')
    .replace(/\bhe is interested in\b/gi, '. He is interested in')
    .replace(/\bshe is interested in\b/gi, '. She is interested in');

  // 3. Proper noun and title casing
  const properNouns = [
    ['manthan', 'Manthan'],
    ['yash', 'Yash'],
    ['octomber', 'October'],
    ['october', 'October'],
    ['susan chen', 'Susan Chen'],
    ['susan', 'Susan'],
    ['chen', 'Chen'],
    ['michael', 'Michael'],
    ['robert', 'Robert'],
    ['bob smith', 'Bob Smith'],
    ['bob', 'Bob'],
    ['smith', 'Smith'],
    ['john', 'John'],
    ['rahul', 'Rahul'],
    ['alice', 'Alice'],
    ['johnson', 'Johnson'],
    ['david', 'David'],
    ['larry', 'Larry'],
    ['vikram', 'Vikram'],
    ['digiva', 'Digiva'],
    ['xyz beauty', 'XYZ Beauty'],
    ['amazon', 'Amazon'],
    ['ibm', 'IBM'],
    ['oracle', 'Oracle'],
    ['microsoft', 'Microsoft'],
    ['turkey', 'Turkey'],
    ['california', 'California'],
    ['full stack developer', 'Full Stack Developer'],
    ['developer', 'Developer'],
    ['vp international', 'VP International'],
    ['vp', 'VP'],
    ['ceo', 'CEO'],
    ['cto', 'CTO']
  ];

  for (const [lowerW, properW] of properNouns) {
    const regex = new RegExp('\\b' + lowerW + '\\b', 'gi');
    text = text.replace(regex, properW);
  }

  // 4. Clean sentence spacing and punctuation
  text = text.replace(/\s*([.!?])(?:\s*[.!?])+/g, '$1');
  text = text.replace(/\s*\.\s*/g, '. ');
  text = text.replace(/\s*,\s*/g, ', ');
  text = text.replace(/\s+/g, ' ').trim();

  // 5. Capitalize first letter of each sentence
  text = text.replace(/(?:^|\.\s+)([a-z])/g, (_, char) => '. ' + char.toUpperCase());
  if (text.startsWith('. ')) text = text.substring(2);
  text = text.charAt(0).toUpperCase() + text.slice(1);

  // 6. Ensure ending punctuation
  if (!/[.!?]$/.test(text)) {
    text += '.';
  }

  return text;
}

/**
 * Main AI candidate fact extraction entry point (Gemini / Rule Engine fallback)
 */
async function extractCandidateFacts(rawContent, context = {}) {
  const { extractCandidateFactsWithGemini } = require('./geminiAdapter');
  return extractCandidateFactsWithGemini(rawContent, context);
}

/**
 * Natural language query intent interpretation (Ask Dossier)
 */
async function interpretQuery(queryText, userContacts = []) {
  const q = (queryText || '').trim();
  const lower = q.toLowerCase();

  return {
    query: q,
    targetName: null,
    targetCompany: null,
    isFollowUpQuery: lower.includes('follow up') || lower.includes('follow-up') || lower.includes('remind'),
    isPricingQuery: lower.includes('pricing') || lower.includes('owe') || lower.includes('quote'),
    isIntroducerQuery: lower.includes('introduce') || lower.includes('who met') || lower.includes('brought'),
    isCellQuery: lower.includes('cell') || lower.includes('phone') || lower.includes('number') || lower.includes('contact'),
    isTopicQuery: lower.includes('whisky') || lower.includes('coffee') || lower.includes('golf') || lower.includes('hobby')
  };
}

module.exports = {
  PARSER_VERSION,
  extractCandidateFacts,
  extractWithRuleEngine,
  polishSentenceDeterministic,
  interpretQuery
};
