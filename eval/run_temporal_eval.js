/**
 * Temporal Reconciliation Evaluation Suite & Report Generator
 * Evaluates temporal transitions, precision parsing, observation vs effective time,
 * and historical/future employment rules across comprehensive temporal fixtures.
 *
 * Generates TEMPORAL_EVALUATION_REPORT.md and TEMPORAL_EVALUATION_REPORT.json
 */

const fs = require('fs');
const path = require('path');
const { analyzeTemporalTransitions, extractTemporalDetails } = require('../lib/temporalReconciliation');

const TEMPORAL_FIXTURES = [
  {
    id: 'TEMP-001',
    title: 'Left Company and Joined New Company (Unspecified Date)',
    input_text: 'John left IBM and joined Amazon.',
    extracted_person: { name: 'John Doe' },
    existing_contact: null,
    verify: (result) => {
      const hist = result.historyTransitions;
      const ibm = hist.find(h => h.value_payload.company_name === 'IBM');
      const amazon = hist.find(h => h.value_payload.company_name === 'Amazon');
      return (
        ibm && !ibm.is_current && ibm.confidence_status === 'HISTORICAL' && ibm.effective_time === null &&
        amazon && amazon.is_current && amazon.confidence_status === 'CONFIRMED' && amazon.effective_time === null
      );
    },
    critical_expectation: 'IBM is historical and Amazon is current; effective date is null/unknown (never invented).'
  },
  {
    id: 'TEMP-002',
    title: 'Left Company in Month and Joined on Specific Day',
    input_text: 'John left IBM in June and joined Amazon July 1.',
    extracted_person: { name: 'John Doe' },
    existing_contact: null,
    verify: (result) => {
      const hist = result.historyTransitions;
      const ibm = hist.find(h => h.value_payload.company_name === 'IBM');
      const amazon = hist.find(h => h.value_payload.company_name === 'Amazon');
      return (
        ibm && ibm.temporal_precision === 'month' && ibm.raw_time_expression.toLowerCase().includes('june') &&
        amazon && amazon.temporal_precision === 'day' && amazon.raw_time_expression.toLowerCase().includes('july 1')
      );
    },
    critical_expectation: 'Preserves distinct month precision for IBM and day precision for Amazon.'
  },
  {
    id: 'TEMP-003',
    title: 'Used to Work At Company (Historical Only)',
    input_text: "He used to work at L'Oreal.",
    extracted_person: { name: 'John Doe', organization: "L'Oreal" },
    existing_contact: null,
    verify: (result) => {
      const hist = result.historyTransitions;
      const loreal = hist.find(h => h.value_payload.company_name === "L'Oreal");
      const hasCurrent = hist.some(h => h.is_current);
      return loreal && !loreal.is_current && loreal.confidence_status === 'HISTORICAL' && !hasCurrent;
    },
    critical_expectation: "Historical-only employment; does NOT update current company."
  },
  {
    id: 'TEMP-004',
    title: 'Future / Uncertain Employment Intention',
    input_text: 'He may join Amazon next month.',
    extracted_person: { name: 'John Doe' },
    existing_contact: null,
    verify: (result) => {
      const hist = result.historyTransitions;
      const amazon = hist.find(h => h.value_payload.company_name === 'Amazon');
      return amazon && !amazon.is_current && amazon.confidence_status === 'FUTURE' && amazon.raw_time_expression === 'next month';
    },
    critical_expectation: 'Categorized as FUTURE/UNCERTAIN; does NOT update current employment.'
  },
  {
    id: 'TEMP-005',
    title: 'Project Collaboration without Employment Transition',
    input_text: 'He works with Amazon on a project.',
    extracted_person: { name: 'John Doe' },
    existing_contact: null,
    verify: (result) => {
      return result.historyTransitions.length === 0 && !result.isTemporalEmployerChange;
    },
    critical_expectation: 'Project collaboration is not inferred as an employment transition.'
  },
  {
    id: 'TEMP-006',
    title: 'Phone Number Transition for Existing Contact',
    input_text: 'His new mobile is +1 (555) 987-6543.',
    extracted_person: { name: 'John Doe', phone: '+15559876543' },
    existing_contact: { id: 101, first_name: 'John', last_name: 'Doe', primary_phone: '+15551112222' },
    verify: (result) => {
      const hist = result.historyTransitions;
      const oldP = hist.find(h => h.fact_type === 'phone' && !h.is_current);
      const newP = hist.find(h => h.fact_type === 'phone' && h.is_current);
      return (
        oldP && oldP.value_payload.phone === '+15551112222' && oldP.confidence_status === 'HISTORICAL' &&
        newP && newP.value_payload.phone === '+15559876543' && newP.confidence_status === 'CONFIRMED'
      );
    },
    critical_expectation: 'Old phone becomes historical fact and new phone becomes confirmed current fact.'
  },
  {
    id: 'TEMP-007',
    title: 'Email Address Transition for Existing Contact',
    input_text: 'His new email is john.updated@corp.com.',
    extracted_person: { name: 'John Doe', email: 'john.updated@corp.com' },
    existing_contact: { id: 101, first_name: 'John', last_name: 'Doe', primary_email: 'john.old@corp.com' },
    verify: (result) => {
      const hist = result.historyTransitions;
      const oldE = hist.find(h => h.fact_type === 'email' && !h.is_current);
      const newE = hist.find(h => h.fact_type === 'email' && h.is_current);
      return (
        oldE && oldE.value_payload.email === 'john.old@corp.com' && oldE.confidence_status === 'HISTORICAL' &&
        newE && newE.value_payload.email === 'john.updated@corp.com' && newE.confidence_status === 'CONFIRMED'
      );
    },
    critical_expectation: 'Previous email preserved as historical; new email accepted as confirmed.'
  },
  {
    id: 'TEMP-008',
    title: 'Departed Last Year and Now At New Employer',
    input_text: 'Sarah departed from Microsoft last year and is now at Google.',
    extracted_person: { name: 'Sarah Connor' },
    existing_contact: null,
    verify: (result) => {
      const hist = result.historyTransitions;
      const ms = hist.find(h => h.value_payload.company_name === 'Microsoft');
      const google = hist.find(h => h.value_payload.company_name === 'Google');
      return (
        ms && !ms.is_current && ms.temporal_precision === 'relative' && ms.raw_time_expression === 'last year' &&
        google && google.is_current && google.confidence_status === 'CONFIRMED'
      );
    },
    critical_expectation: 'Relative precision preserved for past departure and new employer confirmed.'
  },
  {
    id: 'TEMP-009',
    title: 'Former Employee Years Ago (Preserved Relative Uncertainty)',
    input_text: 'Robert was previously at Meta years ago.',
    extracted_person: { name: 'Robert Fox' },
    existing_contact: null,
    verify: (result) => {
      const hist = result.historyTransitions;
      const meta = hist.find(h => h.value_payload.company_name === 'Meta');
      return meta && !meta.is_current && meta.confidence_status === 'HISTORICAL' && meta.raw_time_expression === 'years ago';
    },
    critical_expectation: 'Preserves "years ago" expression and classifies Meta as historical.'
  },
  {
    id: 'TEMP-010',
    title: 'Planning to Join Netflix Soon',
    input_text: 'Michael is planning to join Netflix soon.',
    extracted_person: { name: 'Michael Scott' },
    existing_contact: null,
    verify: (result) => {
      const hist = result.historyTransitions;
      const netflix = hist.find(h => h.value_payload.company_name === 'Netflix');
      return netflix && !netflix.is_current && netflix.confidence_status === 'FUTURE' && netflix.raw_time_expression === 'soon';
    },
    critical_expectation: 'Classifies upcoming transition as FUTURE with relative precision "soon".'
  }
];

async function runTemporalEvaluation() {
  console.log('⏳ Running Temporal Reconciliation Evaluation Suite...\n');

  const results = [];
  let passedCount = 0;

  for (const fixture of TEMPORAL_FIXTURES) {
    const analysis = analyzeTemporalTransitions(fixture.input_text, fixture.extracted_person, fixture.existing_contact);
    const passed = fixture.verify(analysis);

    if (passed) passedCount++;

    results.push({
      id: fixture.id,
      title: fixture.title,
      input: fixture.input_text,
      passed,
      critical_expectation: fixture.critical_expectation,
      transitions_found: analysis.historyTransitions.length,
      transitions: analysis.historyTransitions
    });
  }

  const total = TEMPORAL_FIXTURES.length;
  const passRate = ((passedCount / total) * 100).toFixed(2);

  const report = {
    evaluation_name: 'DRIE Temporal Reconciliation Suite v0.2',
    evaluation_date: new Date().toISOString(),
    total_fixtures: total,
    passed_fixtures: passedCount,
    failed_fixtures: total - passedCount,
    pass_rate_percent: parseFloat(passRate),
    fixtures: results
  };

  // Write JSON report to repository root
  const rootDir = path.join(__dirname, '..', '..');
  const jsonPath = path.join(rootDir, 'TEMPORAL_EVALUATION_REPORT.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  // Build Markdown report
  let md = `# DRIE Temporal Reconciliation Evaluation Report

- **Evaluation Suite**: \`${report.evaluation_name}\`
- **Evaluation Date**: \`${report.evaluation_date}\`
- **Total Test Fixtures**: \`${report.total_fixtures}\`
- **Passed Fixtures**: \`${report.passed_fixtures}\`
- **Failed Fixtures**: \`${report.failed_fixtures}\`
- **Pass Rate**: **${report.pass_rate_percent}%**

---

## Evaluation Fixture Results

| ID | Title | Result | Critical Expectation |
|---|---|---|---|
`;

  for (const f of results) {
    md += `| **${f.id}** | ${f.title} | ${f.passed ? '✅ PASS' : '❌ FAIL'} | ${f.critical_expectation} |\n`;
  }

  md += `\n---\n\n## Detailed Fixture Analysis\n\n`;

  for (const f of results) {
    md += `### ${f.id}: ${f.title}\n`;
    md += `- **Input Text**: \`"${f.input}"\`\n`;
    md += `- **Evaluation Status**: ${f.passed ? '✅ Passed' : '❌ Failed'}\n`;
    md += `- **Critical Expectation**: ${f.critical_expectation}\n`;
    md += `- **Recorded Transitions**:\n`;
    for (const t of f.transitions) {
      md += `  - **${t.fact_type}** (${t.is_current ? 'CURRENT' : 'HISTORICAL/FUTURE'}): \`${JSON.stringify(t.value_payload)}\` | Precision: \`${t.temporal_precision}\` | Raw Expression: \`${t.raw_time_expression || 'none'}\` | Effective Time: \`${t.effective_time || 'null'}\`\n`;
    }
    md += `\n`;
  }

  const mdPath = path.join(rootDir, 'TEMPORAL_EVALUATION_REPORT.md');
  fs.writeFileSync(mdPath, md, 'utf8');

  console.log(`✅ Temporal Evaluation Completed! Pass Rate: ${passRate}% (${passedCount}/${total} passed).`);
  console.log(`Reports saved to:\n - ${mdPath}\n - ${jsonPath}\n`);

  return report;
}

if (require.main === module) {
  runTemporalEvaluation().then(rep => {
    process.exit(rep.failed_fixtures === 0 ? 0 : 1);
  }).catch(e => {
    console.error('Fatal temporal evaluation error:', e);
    process.exit(1);
  });
}

module.exports = { runTemporalEvaluation };
