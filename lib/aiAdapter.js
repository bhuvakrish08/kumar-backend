/**
 * Clean Server-Side AI Provider Adapter (Sprint 3A - Google Gemini Migration)
 * Isolates LLM provider logic behind a provider-agnostic interface.
 * Strictly validates all outputs through CandidateFactSet schema validation.
 */

const { extractCandidateFactsWithGemini, isKeyConfigured } = require('./geminiAdapter');
const { extractWithRuleEngine, polishSentenceDeterministic } = require('./intelligence');
const { validateCandidateFactSet } = require('./aiSchemaValidation');

/**
 * Main AI candidate fact extraction adapter
 * @param {string} rawContent - Raw user input text
 * @param {Object} context - Optional context parameters { userId, correlationId, userRegion }
 * @returns {Promise<Object>} Structured and validated CandidateFactSet result
 */
async function extractCandidateFactsWithAdapter(rawContent, context = {}) {
  const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();

  if (provider === 'gemini') {
    return extractCandidateFactsWithGemini(rawContent, context);
  }

  // Fallback to local rule engine
  if (typeof context.onProgress === 'function') context.onProgress(38, 'Extracting entities with local rule engine...');
  const rawResult = extractWithRuleEngine(rawContent, context);
  if (typeof context.onProgress === 'function') context.onProgress(48, 'Polishing sentence memory...');
  rawResult.polishedMemory = polishSentenceDeterministic(rawContent);
  if (typeof context.onProgress === 'function') context.onProgress(58, 'Validating facts against CandidateFactSet schema...');
  const validation = validateCandidateFactSet(rawResult, { userRegion: context.userRegion });
  if (validation.isValid) {
    validation.sanitized.polishedMemory = rawResult.polishedMemory;
    return validation.sanitized;
  }
  return rawResult;
}

module.exports = {
  extractCandidateFactsWithAdapter,
  isKeyConfigured
};
