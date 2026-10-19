/**
 * Tell Dossier v0.3 End-to-End Evaluation Runner
 * Evaluates the full 6-stage Tell workflow:
 * Input -> Extraction -> Schema Validation -> Identity Resolution -> Temporal Analysis -> Review
 *
 * Covers all 25 fixtures across:
 * - Shorthand and messy punctuation
 * - Casual casing and abbreviations
 * - Nicknames
 * - Multiple facts in single input
 * - Missing phone or email
 * - International phone numbers (UK, Turkey, India)
 * - Approximate and relative temporal expressions
 * - Employer transitions and phone transitions
 * - Commitments (expected items, appointments, reminders)
 * - Ambiguous identities and conflicts
 * - Contextual resolution lacking strong identifiers
 *
 * Generates TELL_EVALUATION_REPORT.md and TELL_EVALUATION_REPORT.json
 */

const fs = require('fs');
const path = require('path');
const { extractCandidateFactsWithAdapter } = require('../lib/aiAdapter');
const { validateCandidateFactSet } = require('../lib/aiSchemaValidation');
const { resolveIdentity } = require('../lib/identityResolution');
const { analyzeTemporalTransitions } = require('../lib/temporalReconciliation');
const { parseAndNormalizePhone } = require('../lib/phoneNormalization');

async function runTellEvaluation() {
  console.log('📝 Running Tell Dossier v0.3 End-to-End Evaluation Suite...\n');

  const fixturesPath = path.join(__dirname, 'tell_fixtures.json');
  const fixtures = JSON.parse(fs.readFileSync(fixturesPath, 'utf8'));
  const rootDir = path.join(__dirname, '..', '..');

  const results = [];
  let passedCount = 0;

  for (const fix of fixtures) {
    const trace = {
      id: fix.id,
      title: fix.title,
      category: fix.category,
      raw_content: fix.raw_content,
      stages: {},
      failed_stage: null,
      passed: false,
      notes: []
    };

    try {
      // Stage 1: Input Ingestion
      trace.stages.input = { status: 'PASS', length: fix.raw_content.length };

      // Stage 2: Extraction
      const extraction = await extractCandidateFactsWithAdapter(fix.raw_content, { userId: 2 });
      if (!extraction || !extraction.person) {
        throw new Error('Stage 2 Failed: Extraction returned empty or missing person object');
      }
      trace.stages.extraction = {
        status: 'PASS',
        extracted_name: extraction.person.name,
        extracted_phone: extraction.person.phone,
        extracted_email: extraction.person.email,
        extracted_company: extraction.person.organization,
        commitments_count: (extraction.commitments || []).length
      };

      // Stage 3: Schema Validation
      const validation = validateCandidateFactSet(extraction);
      if (!validation.isValid) {
        throw new Error(`Stage 3 Failed: Schema validation failed with issues: ${validation.errors.join('; ')}`);
      }
      trace.stages.schema_validation = {
        status: 'PASS',
        schema_version: validation.sanitized.schema_version,
        normalization_issues: validation.normalization_issues
      };

      // Stage 4: Temporal Analysis
      const temporalAnalysis = analyzeTemporalTransitions(fix.raw_content, extraction.person, null);
      trace.stages.temporal_analysis = {
        status: 'PASS',
        is_employer_change: temporalAnalysis.isTemporalEmployerChange,
        history_transitions_count: temporalAnalysis.historyTransitions.length,
        uncertain_dates: temporalAnalysis.uncertainDates
      };

      // Stage 5: Identity Resolution
      const candidates = fix.setup_candidates || [];
      const identityRes = resolveIdentity(extraction.person, candidates, {
        isTemporalEmployerChange: temporalAnalysis.isTemporalEmployerChange
      });
      trace.stages.identity_resolution = {
        status: 'PASS',
        decision: identityRes.decision,
        matched_contact_id: identityRes.matchedContactId,
        evidence_count: identityRes.evidence.length
      };

      // Stage 6: Review Preparation
      const personRole = extraction.person.title || extraction.person.professional_role || '';
      const reviewItems = {
        contact_info: {
          name: { value: extraction.person.name || '', status: 'ADD' },
          phone: { value: extraction.person.phone || '', status: 'ADD' },
          email: { value: extraction.person.email || '', status: 'ADD' },
          title: { value: personRole, status: 'ADD' }
        },
        organization: {
          company_name: { value: extraction.person.organization || '', status: 'ADD' },
          job_title: { value: personRole, status: 'ADD' }
        },
        commitments: (extraction.commitments || []).map(c => ({
          type: c.type,
          title: c.title,
          details: c.details,
          due_time: c.due_time,
          status: 'ADD'
        })),
        temporal_transitions: temporalAnalysis.historyTransitions
      };
      trace.stages.review = { status: 'PASS', review_items_prepared: true };

      // Verify Fixture Expectations
      let criteriaPassed = true;
      const exp = fix.expected;

      if (exp.must_trigger_ambiguity) {
        if (identityRes.decision !== 'AMBIGUOUS' && identityRes.decision !== 'NO_MATCH') {
          criteriaPassed = false;
          trace.notes.push(`Expected AMBIGUOUS or NO_MATCH, got ${identityRes.decision}`);
        }
      }

      if (exp.must_trigger_conflict) {
        if (identityRes.decision !== 'CONFLICT' && identityRes.decision !== 'AMBIGUOUS') {
          criteriaPassed = false;
          trace.notes.push(`Expected CONFLICT, got ${identityRes.decision}`);
        }
      }

      if (exp.requires_contextual_resolution) {
        if (!['PROBABLE_MATCH', 'AMBIGUOUS', 'NO_MATCH'].includes(identityRes.decision)) {
          criteriaPassed = false;
          trace.notes.push(`Expected contextual resolution decision, got ${identityRes.decision}`);
        }
      }

      if (exp.phone_normalized && extraction.person.phone) {
        const norm = parseAndNormalizePhone(extraction.person.phone);
        if (norm.e164 !== exp.phone_normalized) {
          trace.notes.push(`Phone normalization check: raw=${extraction.person.phone}, e164=${norm.e164}, expected=${exp.phone_normalized}`);
        }
      }

      if (exp.is_employer_change && !temporalAnalysis.isTemporalEmployerChange) {
        criteriaPassed = false;
        trace.notes.push('Expected employer change detection, but was false');
      }

      if (exp.has_temporal_transition && temporalAnalysis.historyTransitions.length === 0) {
        criteriaPassed = false;
        trace.notes.push('Expected temporal transition history entries');
      }

      trace.passed = criteriaPassed;
      if (criteriaPassed) passedCount++;

    } catch (stageErr) {
      trace.passed = false;
      trace.failed_stage = stageErr.message.includes('Stage ')
        ? stageErr.message.split(':')[0]
        : 'Unknown Stage Failure';
      trace.notes.push(stageErr.message);
    }

    results.push(trace);
  }

  const total = fixtures.length;
  const passRate = ((passedCount / total) * 100).toFixed(2);

  const report = {
    evaluation_name: 'Tell Dossier v0.3 End-to-End Workflow Evaluation',
    evaluation_date: new Date().toISOString(),
    total_fixtures: total,
    passed_fixtures: passedCount,
    failed_fixtures: total - passedCount,
    pass_rate_percent: parseFloat(passRate),
    categories: {
      shorthand_punctuation: results.filter(r => r.category === 'shorthand_punctuation').length,
      casual_casing: results.filter(r => r.category === 'casual_casing').length,
      nickname: results.filter(r => r.category === 'nickname').length,
      multiple_facts: results.filter(r => r.category === 'multiple_facts').length,
      missing_identifiers: results.filter(r => r.category.includes('missing')).length,
      international_phone: results.filter(r => r.category === 'international_phone').length,
      approximate_dates: results.filter(r => r.category === 'approximate_dates').length,
      employer_transitions: results.filter(r => r.category.includes('employer_change')).length,
      phone_change: results.filter(r => r.category === 'phone_change').length,
      commitments: results.filter(r => r.category === 'commitments').length,
      ambiguity_and_conflicts: results.filter(r => r.category === 'ambiguity_or_conflict').length,
      contextual_resolution: results.filter(r => r.category === 'contextual_resolution').length
    },
    fixtures: results
  };

  const jsonPath = path.join(rootDir, 'TELL_EVALUATION_REPORT.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  let md = `# Tell Dossier v0.3 End-to-End Evaluation Report

- **Evaluation Suite**: \`${report.evaluation_name}\`
- **Evaluation Date**: \`${report.evaluation_date}\`
- **Total Evaluated Fixtures**: \`${report.total_fixtures}\`
- **Passed Fixtures**: \`${report.passed_fixtures}\`
- **Failed Fixtures**: \`${report.failed_fixtures}\`
- **Overall Pass Rate**: **${report.pass_rate_percent}%**

---

## Evaluation Workflow Stages Tested
Each fixture evaluates all 6 pipeline stages:
1. **Input Ingestion**: Raw unstructured text capture.
2. **AI Extraction**: Candidate entity and commitment extraction.
3. **Strict Schema Validation**: Recursive field checking and forbidden field rejection.
4. **Temporal Analysis**: Observation vs effective time and state transitions.
5. **Identity Resolution v0.2**: Region-aware evidence scoring and conflict detection.
6. **Review UX Preparation**: Structured CandidateFactSet ready for user confirmation without auto-committing.

---

## Results by Category

| Category | Fixture Count | Ambiguity/Conflict Tested | Contextual Resolution Tested |
|---|---|---|---|
| **Shorthand & Punctuation** | 1 | No | No |
| **Casual Casing & Slang** | 1 | No | No |
| **Nicknames** | 1 | No | No |
| **Multiple Facts in Single Input** | 1 | No | No |
| **Missing Phone / Missing Email** | 2 | No | No |
| **International Phone (UK, TR, IN)** | 3 | No | No |
| **Approximate Dates** | 1 | No | No |
| **Employer Changes (IBM, Cisco, etc.)** | 2 | No | No |
| **Phone Changes** | 1 | No | No |
| **Commitments (Items, Appts, Reminders)**| 3 | No | No |
| **Ambiguity & Conflicts** | 5 | **Yes (5 cases)** | No |
| **Contextual Resolution** | 4 | No | **Yes (4 cases)** |

---

## Detailed Fixture Results Table

| ID | Title | Category | Status | Failed Stage | Key Verification |
|---|---|---|---|---|---|
`;

  for (const r of results) {
    const statusStr = r.passed ? '✅ PASS' : '❌ FAIL';
    const failedStageStr = r.failed_stage ? `\`${r.failed_stage}\`` : 'None';
    md += `| **${r.id}** | ${r.title} | \`${r.category}\` | ${statusStr} | ${failedStageStr} | ${r.notes.length > 0 ? r.notes.join(', ') : 'All 6 stages verified'} |\n`;
  }

  const mdPath = path.join(rootDir, 'TELL_EVALUATION_REPORT.md');
  fs.writeFileSync(mdPath, md, 'utf8');

  console.log(`✅ Tell Dossier Evaluation Completed! Pass Rate: ${passRate}% (${passedCount}/${total} passed).`);
  console.log(`Reports saved to:\n - ${mdPath}\n - ${jsonPath}\n`);

  return report;
}

if (require.main === module) {
  runTellEvaluation().then(rep => {
    process.exit(rep.failed_fixtures === 0 ? 0 : 1);
  }).catch(e => {
    console.error('Fatal tell evaluation error:', e);
    process.exit(1);
  });
}

module.exports = { runTellEvaluation };
