/**
 * Clean Server-Side AI Provider Adapter (Sprint 2 Hardened)
 * Isolates LLM provider logic behind a provider-agnostic interface.
 * Strictly validates all outputs through CandidateFactSet schema validation.
 */

const https = require('https');
const { extractWithRuleEngine, PARSER_VERSION } = require('./intelligence');
const { validateCandidateFactSet } = require('./aiSchemaValidation');

/**
 * Main AI candidate fact extraction adapter
 * @param {string} rawContent - Raw user input text
 * @param {Object} context - Optional context parameters
 * @returns {Object} Structured and validated CandidateFactSet result
 */
async function extractCandidateFactsWithAdapter(rawContent, context = {}) {
  const text = (rawContent || '').trim();
  const apiKey = process.env.OPENAI_API_KEY;
  const modelName = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  // Fallback to local rule engine if API key is not configured or placeholder
  if (!apiKey || apiKey.trim() === '' || apiKey.includes('your_openai_api_key')) {
    const rawResult = extractWithRuleEngine(text, context);
    const validation = validateCandidateFactSet(rawResult);
    if (validation.isValid) {
      return validation.sanitized;
    }
    return rawResult;
  }

  try {
    const prompt = `Extract candidate contact facts and commitments from the input text in strict JSON.
JSON Schema:
{
  "person": {
    "name": "Full Name or null",
    "phone": "Phone number or null",
    "email": "Email address or null",
    "professional_role": "Job title/role (e.g. Full Stack Developer) or null",
    "organization": "Company/Org name (e.g. Digiva) or null",
    "introducer": "Introduced by person name or null",
    "meeting_context": "Brief context of meeting or null",
    "met_date": "YYYY-MM-DD or null",
    "notes": "Relevant context notes"
  },
  "people": [
    {
      "name": "Full Name or null",
      "phone": "Phone number or null",
      "email": "Email address or null",
      "professional_role": "Job title or null",
      "organization": "Company name or null"
    }
  ],
  "sources": ["source tag 1"],
  "interaction": {
    "type": "Meeting|Call|Email|Text|WhatsApp|Note",
    "details": "Summary",
    "date": "YYYY-MM-DD"
  },
  "commitments": [
    {
      "type": "follow_up|expected_item|appointment|reminder",
      "title": "Task title",
      "details": "Full description",
      "due_time": "YYYY-MM-DD HH:MM:SS or null"
    }
  ],
  "uncertain_dates": ["notes on ambiguous dates"]
}

Do NOT include owner_user_id, id, roles, permissions, authorization, or system fields.

Input text: "${text.replace(/"/g, '\\"')}"`;

    const requestData = JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: 'You are an entity extraction engine for a CRM dossier system.' },
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

    const extractedPerson = parsedResponse.person || (Array.isArray(parsedResponse.people) && parsedResponse.people.length > 0 ? parsedResponse.people[0] : {});
    if (extractedPerson) {
      const roleVal = extractedPerson.title || extractedPerson.professional_role || null;
      extractedPerson.title = roleVal;
      extractedPerson.professional_role = roleVal;
    }

    const candidateResult = {
      provider: 'openai',
      model: modelName,
      parser_version: PARSER_VERSION,
      person: extractedPerson,
      people: Array.isArray(parsedResponse.people) ? parsedResponse.people : (parsedResponse.person ? [parsedResponse.person] : []),
      sources: parsedResponse.sources || [],
      interaction: parsedResponse.interaction || null,
      commitments: parsedResponse.commitments || [],
      uncertain_dates: parsedResponse.uncertain_dates || []
    };

    // STRICT VALIDATION STEP
    const validation = validateCandidateFactSet(candidateResult);

    if (validation.isValid) {
      return validation.sanitized;
    } else {
      console.warn('AI Output failed strict schema validation, falling back to rule engine:', validation.errors);
      return extractWithRuleEngine(text, context);
    }

  } catch (err) {
    console.warn('AI provider call failed, using deterministic rule engine fallback:', err.message);
    const fallbackRaw = extractWithRuleEngine(text, context);
    const fallbackVal = validateCandidateFactSet(fallbackRaw);
    return fallbackVal.isValid ? fallbackVal.sanitized : fallbackRaw;
  }
}

module.exports = {
  extractCandidateFactsWithAdapter
};
