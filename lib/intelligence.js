/**
 * Server-Side Provider-Neutral Intelligence Service
 * Performs extraction and intent parsing.
 * NEVER writes directly to database or selects owner_user_id.
 */

const http = require('http');
const https = require('https');

const PARSER_VERSION = '2.0.0';

/**
 * Natural language rule engine fallback for entity extraction
 */
function extractWithRuleEngine(rawContent, context = {}) {
  const text = (rawContent || '').trim();
  const lower = text.toLowerCase();

  // Flexible Phone Match (Standard, International, 10-digit, spaced/hyphenated)
  const phoneMatch = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3,4}\)?[-.\s]?\d{3}[-.\s]?\d{4}/)
    || text.match(/\b(?:\+91[-.\s]?)?[6-9]\d{9}\b/)
    || text.match(/\b\d{5}[-.\s]?\d{5}\b/);

  // Email Match
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

  let name = null;
  let company = null;
  let title = null;
  let introducer = null;
  let metDate = null;
  let metContext = null;

  // 1. Name Extraction Patterns
  // Pattern A: "I met Dr. Rahul Patel", "Met Mr. John Smith", "Spoke with Sanjay", "Connected with Priya"
  const metPattern = /(?:i\s+met|met|spoke\s+with|talked\s+to|connected\s+with|contact:?)\s+((?:Dr\.|Mr\.|Mrs\.|Ms\.|Prof\.|Er\.)?\s*[A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?)/i;
  const metMatch = text.match(metPattern);
  if (metMatch) {
    name = metMatch[1].trim();
    name = name.replace(/[;,!?]/g, '').replace(/\s+(?:today|yesterday|tomorrow|tommorow|this|at|from|with|for|and|who|he|she)$/i, '').trim();
  }

  // Pattern B: "Yesterday i met Yashesh Patel." or capitalized name at start/phrase
  if (!name) {
    const namePhraseMatch = text.match(/(?:met|with|to)\s+((?:Dr\.|Mr\.|Mrs\.|Ms\.|Prof\.|Er\.)?\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/);
    if (namePhraseMatch) {
      name = namePhraseMatch[1].trim();
    }
  }

  // Pattern C: Capitalized words fallback
  if (!name) {
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[^a-zA-Z]/g, '');
      if (w.length > 2 && /^[A-Z][a-z]+$/.test(w) && !['Today', 'Yesterday', 'Tomorrow', 'Phone', 'Email', 'He', 'She', 'They', 'His', 'Her', 'Met', 'Also', 'Owner', 'CEO', 'CTO'].includes(w)) {
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
    name = name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  // 2. Title & Organization Extraction
  // Pattern A: "owner of GURU Exim", "CEO of IBM", "co-founder at Google", "manager for Digiva"
  const titleOrgMatch = text.match(/(?:is(?:\s+\b(?:a|an|the)\b)?|works?\s+as(?:\s+\b(?:a|an|the)\b)?|title\s+is)?\s*\b(owner|founder|co-founder|ceo|cto|cfo|coo|manager|director|president|vice president|vp|partner|head|lead|developer|engineer|consultant|designer|analyst)\s+(?:of|at|for|in)\s+([A-Za-z0-9][A-Za-z0-9&.\s]{1,30}?)(?=\s+and|\s+his|\s+her|\s+he|\s+she|\s+phone|\s+email|\.|\,|$)/i);
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
      if (candidateComp && !['today', 'yesterday', 'tomorrow', 'lunch', 'dinner', 'coffee', 'the office'].includes(candidateComp.toLowerCase())) {
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
  // Patterns: "introduced by Sarah", "referred by Bob", "rajni sir introduced me to yashesh patel", "brought by Alex", "connected via Mehta"
  const introMatch = text.match(/(?:introduced\s+by|referred\s+by|met\s+through|connected\s+via|brought\s+by)\s+([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?(?:\s+(?:sir|ji|ma'am|madam))?)/i)
    || text.match(/([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?(?:\s+(?:sir|ji|ma'am|madam))?)\s+introduced\s+(?:me|us)?\s*(?:to\s+([A-Za-z][a-z]+(?:\s+[A-Za-z][a-z]+)?))?/i);
  if (introMatch) {
    let rawIntro = introMatch[1].trim();
    if (rawIntro && !['i', 'he', 'she', 'they', 'who', 'and', 'also', 'at', 'who'].includes(rawIntro.toLowerCase())) {
      introducer = rawIntro.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    }
  }

  // 4. Meeting Context & Relative Dates
  if (lower.includes('today')) {
    metDate = new Date().toISOString().split('T')[0];
    metContext = 'Met today';
  } else if (lower.includes('yesterday')) {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    metDate = d.toISOString().split('T')[0];
    metContext = 'Met yesterday';
  } else {
    metContext = 'Recent interaction';
  }

  // Check specific venue/event context: "at jaybhai wedding", "at Club baby loan hotel", "at the conference"
  const contextEventMatch = text.match(/at\s+([A-Za-z0-9\s]{2,35}?\s+(?:wedding|party|event|conference|summit|meetup|office|hotel|dinner|lunch|cafe|reception|expo|club))/i);
  if (contextEventMatch) {
    const rawCtx = contextEventMatch[1].trim();
    const cleanCtx = rawCtx.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    if (metContext && metContext !== 'Recent interaction') {
      metContext = `${metContext} at ${cleanCtx}`;
    } else {
      metContext = `At ${cleanCtx}`;
    }
  }

  // 5. Commitments & Tasks Extraction
  const commitments = [];
  const commitmentPatterns = [
    { regex: /(?:will\s+schedule|schedule|scheduling)\s+([^.\n]+)/i, type: 'appointment' },
    { regex: /(?:meet\s*up|meetup)\s+at\s+([^.\n]+)/i, type: 'appointment' },
    { regex: /(?:will\s+send|sending|to\s+send|share|share\s+catalog|send\s+pricing|provide)\s+([^.\n]+)/i, type: 'expected_item' },
    { regex: /(?:follow\s*up|follow-up)\s+([^.\n]+)/i, type: 'follow_up' },
    { regex: /(?:call|meeting|appointment|remind\s+me\s+to)\s+([^.\n]+)/i, type: 'reminder' }
  ];

  for (const item of commitmentPatterns) {
    const match = text.match(item.regex);
    if (match) {
      let titleDetails = match[0].trim();
      let dueTime = null;
      if (lower.includes('tomorrow') || lower.includes('tommorow')) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        dueTime = d.toISOString().split('T')[0] + ' 10:00:00';
      } else if (lower.includes('next week')) {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        dueTime = d.toISOString().split('T')[0] + ' 10:00:00';
      }
      commitments.push({
        type: item.type,
        title: titleDetails,
        details: match[1] ? match[1].trim() : titleDetails,
        due_time: dueTime
      });
    }
  }

  // Clean trailing contact info clauses from commitment titles
  const cleanCommitmentList = [];
  for (let i = 0; i < commitments.length; i++) {
    const com = commitments[i];
    let title = com.title
      .replace(/\s+(?:and\s+)?(?:his\s+|her\s+|my\s+)?(?:email|phone|mobile|number|contact|\w+\s+email|\w+\s+phone)\s+is.*$/i, '')
      .replace(/\s+and\s+at\s+.*$/i, '')
      .replace(/[.,;!?]$/, '')
      .trim();

    if (!title || title.length < 4) continue;

    com.title = title;
    if (com.details) {
      com.details = com.details
        .replace(/\s+(?:and\s+)?(?:his\s+|her\s+|my\s+)?(?:email|phone|mobile|number|contact|\w+\s+email|\w+\s+phone)\s+is.*$/i, '')
        .replace(/\s+and\s+at\s+.*$/i, '')
        .replace(/[.,;!?]$/, '')
        .trim();
    }
    cleanCommitmentList.push(com);
  }

  // Deduplicate commitments
  const deduplicatedCommitments = [];
  for (let i = 0; i < cleanCommitmentList.length; i++) {
    const current = cleanCommitmentList[i];
    const isSub = cleanCommitmentList.some((other, j) => {
      if (i === j) return false;
      const curLower = current.title.toLowerCase();
      const othLower = other.title.toLowerCase();
      return othLower.includes(curLower) && othLower.length > curLower.length;
    });

    if (!isSub && !deduplicatedCommitments.some(f => f.title.toLowerCase() === current.title.toLowerCase())) {
      deduplicatedCommitments.push(current);
    }
  }

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

  // 7. Sources
  const sources = [];
  if (company) sources.push(company);
  if (lower.includes('conference') || lower.includes('event') || lower.includes('wedding') || lower.includes('expo')) sources.push('Event');
  if (sources.length === 0) sources.push('Direct Input');

  // 8. Uncertain Dates
  const uncertainDates = [];
  if (lower.includes('sometime') || lower.includes('maybe next week') || lower.includes('around')) {
    uncertainDates.push('Approximate or unconfirmed date specified in text');
  }

  return {
    provider: 'rule-engine',
    model: 'local-rule-v1',
    parser_version: PARSER_VERSION,
    person: {
      name: name || 'Unknown Person',
      phone: phoneMatch ? phoneMatch[0] : null,
      email: emailMatch ? emailMatch[0] : null,
      title: title || null,
      organization: company || null,
      introducer: introducer || null,
      meeting_context: metContext,
      met_date: metDate,
      notes: personalNotes
    },
    sources: sources,
    interaction: {
      type: 'Meeting',
      details: text,
      date: metDate || new Date().toISOString().split('T')[0]
    },
    commitments: deduplicatedCommitments,
    uncertain_dates: uncertainDates
  };
}

/**
 * Main AI candidate fact extraction entry point
 */
async function extractCandidateFacts(rawContent, context = {}) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your_openai_api_key')) {
    // Fall back to rule-based parser engine deterministically
    return extractWithRuleEngine(rawContent, context);
  }

  try {
    const prompt = `You are an entity extraction engine for a CRM dossier system.
Extract candidate contact facts and commitments from the input text.
Output MUST be strict JSON matching this schema:
{
  "person": {
    "name": "Full Name or null",
    "phone": "Phone number or null",
    "email": "Email address or null",
    "title": "Job title or null",
    "organization": "Company/Org name or null",
    "introducer": "Introduced by person name or null",
    "meeting_context": "Brief context of meeting or null",
    "met_date": "YYYY-MM-DD or null",
    "notes": "Relevant context notes"
  },
  "sources": ["source tag 1", "source tag 2"],
  "interaction": {
    "type": "Meeting/Call/Email/Note",
    "details": "Summary of interaction",
    "date": "YYYY-MM-DD"
  },
  "commitments": [
    {
      "type": "follow_up|expected_item|appointment|reminder",
      "title": "Title or task detail",
      "details": "Full description",
      "due_time": "YYYY-MM-DD HH:MM:SS or null"
    }
  ],
  "uncertain_dates": ["list of ambiguous date notes"]
}

Input text: "${rawContent.replace(/"/g, '\\"')}"`;

    const requestData = JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You extract structured facts for a CRM system in strict JSON.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1
    });

    const parsedResponse = await new Promise((resolve, reject) => {
      const req = https.request('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(requestData)
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = JSON.parse(body);
              const content = JSON.parse(json.choices[0].message.content);
              resolve(content);
            } catch (e) {
              reject(e);
            }
          } else {
            reject(new Error(`OpenAI HTTP ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(requestData);
      req.end();
    });

    return {
      provider: 'openai',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      parser_version: PARSER_VERSION,
      person: parsedResponse.person || {},
      sources: parsedResponse.sources || [],
      interaction: parsedResponse.interaction || null,
      commitments: parsedResponse.commitments || [],
      uncertain_dates: parsedResponse.uncertain_dates || []
    };

  } catch (err) {
    console.warn('OpenAI API call failed, falling back to rule engine:', err.message);
    return extractWithRuleEngine(rawContent, context);
  }
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
  interpretQuery
};
