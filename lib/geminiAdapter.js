/**
 * Clean Server-Side Google Gemini AI Provider Adapter (Sprint 3A)
 * 
 * Replaces OpenAI integration with the official Google Gen AI SDK (@google/genai).
 * - Provider-agnostic abstraction for sentence polishing and candidate fact extraction.
 * - Strict schema validation through CandidateFactSet schema validator.
 * - Request correlation IDs, latency measurement, timeout control, and bounded retries.
 * - Safe deterministic fallback on missing key, timeout, rate limit, or invalid response.
 * - Zero secret leakage to frontend.
 */

const { GoogleGenAI } = require('@google/genai');
const https = require('https');
const crypto = require('crypto');
const { extractWithRuleEngine, polishSentenceDeterministic, PARSER_VERSION } = require('./intelligence');
const { validateCandidateFactSet } = require('./aiSchemaValidation');

const DEFAULT_MODEL = 'gemini-3.8-flash';
const FALLBACK_GEMINI_MODEL = 'gemini-3.8-flash';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RETRIES = 2;

/**
 * Determines whether the given API key is valid or placeholder.
 */
function isKeyConfigured(key) {
  if (!key || typeof key !== 'string') return false;
  const trimmed = key.trim();
  if (trimmed === '' || trimmed.includes('your_gemini_api_key') || trimmed.includes('placeholder')) {
    return false;
  }
  return true;
}

/**
 * Categorizes provider errors for logging and telemetry.
 */
function categorizeError(err) {
  const msg = (err && err.message) ? err.message.toLowerCase() : '';
  const status = err && (err.status || err.statusCode);
  if (status === 401 || status === 403 || msg.includes('api key') || msg.includes('unauthenticated') || msg.includes('permission denied')) {
    return 'AUTH_ERROR';
  }
  if (status === 429 || msg.includes('quota') || msg.includes('rate limit') || msg.includes('resource exhausted')) {
    return 'RATE_LIMIT';
  }
  if (msg.includes('timeout') || msg.includes('aborted') || msg.includes('deadline')) {
    return 'TIMEOUT';
  }
  if (msg.includes('json') || msg.includes('parse') || msg.includes('syntax')) {
    return 'MALFORMED_RESPONSE';
  }
  if (status >= 500) {
    return 'PROVIDER_OUTAGE';
  }
  return 'NETWORK_ERROR';
}

/**
 * Builds the structured prompt for Gemini sentence polishing and entity extraction.
 */
function buildExtractionPrompt(text) {
  return `You are an intelligent memory polishing and entity extraction engine for a relationship dossier system.

TASK:
1. Polish the informal sentence for clarity, correct punctuation, capitalization, and grammar while strictly PRESERVING:
   - Original meaning and context
   - Names, companies, job titles, phone numbers, email addresses
   - Relative dates ("yesterday", "tomorrow", "next Tuesday") without inventing specific calendar dates
   - Any uncertainty, assumptions, or negations (e.g., "maybe he joined" MUST remain uncertain)
   - Attribution (who said or did what)
   - Never invent missing dates, people, or facts.
2. Extract candidate facts conforming strictly to the requested JSON schema.
3. MULTI-COMMITMENT RULES:
   - If the user enumerates multiple follow-ups, next steps, tasks, or meetings (e.g., "three follow-ups: First... Second... Third..." or "scheduled a meeting... and my follow-ups are..."), extract EVERY ONE as a distinct, individual object in the "commitments" array. NEVER combine them into a single item.
   - Set "type" to one of: "follow_up", "expected_item", "appointment", "reminder".
   - Extract "due_time" strictly from the specific date and time mentioned for that individual task.
   - NEVER confuse a person's birth date (e.g. "14 March 1998") or past interaction date with a future commitment deadline.

JSON SCHEMA:
{
  "polishedMemory": "Polished, grammatically clean natural-language memory sentence",
  "person": {
    "name": "Full Name or null",
    "phone": "Phone number as stated or null",
    "email": "Email address or null",
    "professional_role": "Job title or role (e.g. Full Stack Developer, VP International) or null",
    "organization": "Company or organization name (e.g. Digiva, XYZ Beauty) or null",
    "introducer": "Name of person who made the introduction or null",
    "meeting_context": "Brief context of meeting or location or null",
    "met_date": "Explicit date mentioned if absolute, or null (do not invent dates)",
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
  "sources": ["source tag or organization tag"],
  "interaction": {
    "type": "Meeting" | "Call" | "Email" | "Text" | "WhatsApp" | "Note",
    "details": "Summary of interaction",
    "date": "YYYY-MM-DD only if explicitly stated, otherwise null"
  },
  "commitments": [
    {
      "type": "follow_up" | "expected_item" | "appointment" | "reminder",
      "title": "Short title of task or reminder",
      "details": "Full description of task or follow-up",
      "due_time": "YYYY-MM-DD HH:MM:SS or null (do NOT invent exact hour if not mentioned)"
    }
  ],
  "uncertain_dates": ["notes on any relative or uncertain dates like 'next Tuesday'"]
}

STRICT SECURITY RULES:
- Never include system fields: owner_user_id, id, user_id, roles, permissions, authorization, sql, query, admin, commit_state.
- Return ONLY valid raw JSON without markdown code fences.

Input sentence:
"${text.replace(/"/g, '\\"')}"`;
}

/**
 * Strips markdown code blocks if the model wrapped output in \`\`\`json ... \`\`\`.
 */
function cleanJsonText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) {
    cleaned = cleaned.substring(7);
  } else if (cleaned.startsWith('```')) {
    cleaned = cleaned.substring(3);
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }
  return cleaned.trim();
}

/**
 * Executes a call to Google Gemini with timeout and retry handling.
 */
async function callGeminiWithRetry(apiKey, modelName, promptText, correlationId, onProgress = null) {
  const ai = new GoogleGenAI({ apiKey });
  let lastErr = null;

  let currentModel = (modelName === 'gemini-2.5-flash') ? FALLBACK_GEMINI_MODEL : modelName;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startTime = Date.now();
    try {
      if (typeof onProgress === 'function') {
        onProgress(attempt === 0 ? 44 : 49, `Querying Gemini ${currentModel}${attempt > 0 ? ` (retry ${attempt})` : ''}...`);
      }
      // Execute generateContent with timeout control
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Gemini request timed out after ${DEFAULT_TIMEOUT_MS}ms`)), DEFAULT_TIMEOUT_MS);
      });

      const callPromise = ai.models.generateContent({
        model: currentModel,
        contents: promptText,
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1
        }
      });

      const response = await Promise.race([callPromise, timeoutPromise]);
      const latencyMs = Date.now() - startTime;
      const rawText = response.text ? response.text.trim() : '';

      const parsed = JSON.parse(cleanJsonText(rawText));

      console.log(`[Gemini Adapter] [${correlationId}] Success (${latencyMs}ms, model: ${currentModel})`);
      return { parsed, latencyMs };

    } catch (err) {
      lastErr = err;
      const latencyMs = Date.now() - startTime;
      const category = categorizeError(err);

      console.warn(`[Gemini Adapter] [${correlationId}] Attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (${category}, ${latencyMs}ms): ${err.message}`);

      // If model is deprecated or not found, switch to fallback model
      if ((err.message.includes('not available') || err.message.includes('404') || err.message.includes('NOT_FOUND')) && currentModel !== FALLBACK_GEMINI_MODEL) {
        console.warn(`[Gemini Adapter] [${correlationId}] Model ${currentModel} unavailable. Switching to ${FALLBACK_GEMINI_MODEL}.`);
        currentModel = FALLBACK_GEMINI_MODEL;
        continue;
      }

      // Do not retry on authentication, quota exhaustion, or non-retryable errors
      if (category === 'AUTH_ERROR' || category === 'RATE_LIMIT' || category === 'MALFORMED_RESPONSE' || attempt === MAX_RETRIES) {
        break;
      }

      // Exponential backoff
      await new Promise(r => setTimeout(r, 400 * Math.pow(2, attempt)));
    }
  }

  throw lastErr;
}

/**
 * Main adapter function for candidate fact extraction and sentence polishing.
 * @param {string} rawContent - Raw informal text input
 * @param {Object} context - Context options { userId, correlationId, userRegion }
 * @returns {Promise<Object>} Validated CandidateFactSet with polishedMemory
 */
async function extractCandidateFactsWithGemini(rawContent, context = {}) {
  const text = (rawContent || '').trim();
  const correlationId = context.correlationId || crypto.randomUUID();
  const apiKey = process.env.GEMINI_API_KEY;
  const modelName = process.env.GEMINI_MODEL || DEFAULT_MODEL;

  // Fallback to local rule engine if API key is missing or placeholder
  if (!isKeyConfigured(apiKey)) {
    console.log(`[Gemini Adapter] [${correlationId}] GEMINI_API_KEY unconfigured or placeholder. Using deterministic fallback.`);
    if (typeof context.onProgress === 'function') context.onProgress(38, 'Extracting entities with local rule engine...');
    const rawResult = extractWithRuleEngine(text, context);
    if (typeof context.onProgress === 'function') context.onProgress(48, 'Polishing sentence memory...');
    rawResult.polishedMemory = polishSentenceDeterministic(text);
    rawResult.provider = 'rule-engine';
    rawResult.model = 'local-rule-v1';

    if (typeof context.onProgress === 'function') context.onProgress(56, 'Validating candidate facts against schema...');
    const validation = validateCandidateFactSet(rawResult, { userRegion: context.userRegion });
    if (validation.isValid) {
      validation.sanitized.polishedMemory = rawResult.polishedMemory;
      return validation.sanitized;
    }
    return rawResult;
  }

  try {
    if (typeof context.onProgress === 'function') context.onProgress(36, 'Connecting to Google Gemini API...');
    const promptText = buildExtractionPrompt(text);
    const { parsed, latencyMs } = await callGeminiWithRetry(apiKey, modelName, promptText, correlationId, context.onProgress);
    if (typeof context.onProgress === 'function') context.onProgress(58, 'Validating candidate facts against schema...');

    // Format person fields
    const extractedPerson = parsed.person || (Array.isArray(parsed.people) && parsed.people.length > 0 ? parsed.people[0] : {});
    if (extractedPerson) {
      const roleVal = extractedPerson.professional_role || extractedPerson.title || null;
      extractedPerson.title = roleVal;
      extractedPerson.professional_role = roleVal;
    }

    const candidateResult = {
      provider: 'gemini',
      model: modelName,
      parser_version: PARSER_VERSION,
      polishedMemory: typeof parsed.polishedMemory === 'string' && parsed.polishedMemory.trim() 
        ? parsed.polishedMemory.trim() 
        : polishSentenceDeterministic(text),
      person: extractedPerson,
      people: Array.isArray(parsed.people) ? parsed.people : (parsed.person ? [parsed.person] : []),
      sources: parsed.sources || (extractedPerson.organization ? [extractedPerson.organization] : ['Direct Input']),
      interaction: parsed.interaction || null,
      commitments: parsed.commitments || [],
      uncertain_dates: parsed.uncertain_dates || []
    };

    // Strict Server-Side Schema Validation
    const validation = validateCandidateFactSet(candidateResult, { userRegion: context.userRegion });

    if (validation.isValid) {
      validation.sanitized.polishedMemory = candidateResult.polishedMemory;
      return validation.sanitized;
    } else {
      console.warn(`[Gemini Adapter] [${correlationId}] Schema validation rejected Gemini output:`, validation.errors);
      const fallbackResult = extractWithRuleEngine(text, context);
      fallbackResult.polishedMemory = candidateResult.polishedMemory || polishSentenceDeterministic(text);
      const fallbackVal = validateCandidateFactSet(fallbackResult, { userRegion: context.userRegion });
      if (fallbackVal.isValid) {
        fallbackVal.sanitized.polishedMemory = fallbackResult.polishedMemory;
        return fallbackVal.sanitized;
      }
      return fallbackResult;
    }

  } catch (err) {
    const category = categorizeError(err);
    console.warn(`[Gemini Adapter] [${correlationId}] Provider execution failed (${category}): ${err.message}. Executing deterministic fallback.`);
    
    if (typeof context.onProgress === 'function') context.onProgress(50, 'Switching to deterministic rule engine...');
    const fallbackRaw = extractWithRuleEngine(text, context);
    if (typeof context.onProgress === 'function') context.onProgress(56, 'Polishing sentence memory...');
    fallbackRaw.polishedMemory = polishSentenceDeterministic(text);
    fallbackRaw.provider = 'rule-engine';
    fallbackRaw.model = 'local-rule-v1';

    if (typeof context.onProgress === 'function') context.onProgress(60, 'Validating candidate facts against schema...');
    const fallbackVal = validateCandidateFactSet(fallbackRaw, { userRegion: context.userRegion });
    if (fallbackVal.isValid) {
      fallbackVal.sanitized.polishedMemory = fallbackRaw.polishedMemory;
      return fallbackVal.sanitized;
    }
    return fallbackRaw;
  }
}

module.exports = {
  extractCandidateFactsWithGemini,
  categorizeError,
  isKeyConfigured,
  DEFAULT_MODEL
};
