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

  // Basic regexes
  const phoneMatch = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

  // Extract name candidate
  let name = null;
  let company = null;
  let title = null;
  let introducer = null;
  let metDate = null;
  let metContext = null;

  // Common pattern: "I met Rahul from ABC today" or "Met John at Google"
  const metPattern = /(?:i\s+met|met|spoke\s+with|talked\s+to|connected\s+with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i;
  const metMatch = text.match(metPattern);
  if (metMatch) {
    name = metMatch[1].trim();
  }

  // If no met pattern, look for capitalized words that aren't common words
  if (!name) {
    const words = text.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[^a-zA-Z]/g, '');
      if (w.length > 2 && /^[A-Z][a-z]+$/.test(w) && !['Today', 'Yesterday', 'Tomorrow', 'Phone', 'Email', 'He', 'She', 'They', 'His', 'Her', 'Met'].includes(w)) {
        name = w;
        if (i + 1 < words.length && /^[A-Z][a-z]+$/.test(words[i+1].replace(/[^a-zA-Z]/g, ''))) {
          name += ' ' + words[i+1].replace(/[^a-zA-Z]/g, '');
        }
        break;
      }
    }
  }

  // Extract company: "from ABC", "at IBM", "works at Microsoft"
  const companyPattern = /(?:from|at|works?\s+at|with)\s+([A-Z0-9][a-zA-C0-9&.\s]{1,20}?)(?=\s+today|\s+yesterday|\s+tomorrow|\.|\,|$|\s+his|\s+her|\s+he|\s+she)/i;
  const companyMatch = text.match(companyPattern);
  if (companyMatch) {
    const candidateComp = companyMatch[1].trim();
    if (!['today', 'yesterday', 'tomorrow', 'lunch', 'dinner', 'coffee', 'the office'].includes(candidateComp.toLowerCase())) {
      company = candidateComp;
    }
  }

  // Extract Title: "VP of Sales", "CEO", "Manager", "Engineer", "Director", "Founder"
  const titleMatch = text.match(/(?:is\s+a|as\s+a|works\s+as\s+a?|title\s+is)\s+([A-Za-z\s]{2,30}?)(?=\s+at|\s+from|\.|\,|$)/i);
  if (titleMatch) {
    title = titleMatch[1].trim();
  }

  // Extract Introducer: "introduced by Sarah", "referred by Bob"
  const introMatch = text.match(/(?:introduced\s+by|referred\s+by|met\s+through)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  if (introMatch) {
    introducer = introMatch[1].trim();
  }

  // Extract Meeting context & dates
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

  // Extract commitments/reminders
  const commitments = [];
  // e.g. "He will send pricing tomorrow", "Follow up next Tuesday", "Call him on Friday"
  const commitmentPatterns = [
    { regex: /(?:will\s+send|sending|to\s+send)\s+([^.\n]+)/i, type: 'expected_item' },
    { regex: /(?:follow\s*up|follow-up)\s+([^.\n]+)/i, type: 'follow_up' },
    { regex: /(?:call|meeting|appointment|remind\s+me\s+to)\s+([^.\n]+)/i, type: 'reminder' }
  ];

  for (const item of commitmentPatterns) {
    const match = text.match(item.regex);
    if (match) {
      let titleDetails = match[0].trim();
      let dueTime = null;
      if (lower.includes('tomorrow')) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        dueTime = d.toISOString().split('T')[0] + ' 10:00:00';
      }
      commitments.push({
        type: item.type,
        title: titleDetails,
        details: match[1].trim(),
        due_time: dueTime
      });
    }
  }

  // Sources suggestions
  const sources = [];
  if (company) sources.push(company);
  if (lower.includes('conference') || lower.includes('event')) sources.push('Event');
  if (sources.length === 0) sources.push('Direct Input');

  // Uncertain dates detection
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
      notes: text
    },
    sources: sources,
    interaction: {
      type: 'Meeting',
      details: text,
      date: metDate || new Date().toISOString().split('T')[0]
    },
    commitments: commitments,
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
