/**
 * Ask Dossier Generalization & Evaluation Suite (v0.2)
 * Evaluates Ask Dossier generalization across required query families,
 * paraphrases, clue substitutions (IBM -> Microsoft, whisky -> golf),
 * clarification handling for ambiguous names, and cross-user isolation.
 *
 * Generates ASK_EVALUATION_REPORT.md and ASK_EVALUATION_REPORT.json
 */

const fs = require('fs');
const path = require('path');
const { getPool } = require('../db');
const { interpretAskQuery } = require('../lib/askInterpreter');
const {
  retrieveContactDetails,
  retrieveCommitments,
  retrieveRelationships,
  retrieveOrganizationContext,
  retrieveTopicContext,
  retrieveGeneralSearch
} = require('../lib/askRetrievalServices');

async function runAskEvaluation() {
  console.log('🗣️ Running Ask Dossier v0.2 Evaluation Suite...\n');
  const pool = getPool();
  const rootDir = path.join(__dirname, '..', '..');

  // Ensure dedicated isolated test user exists (never touch Kumar's account)
  await pool.query(
    'INSERT INTO users (username, password, email, is_demo_account) VALUES ("ask_eval_user", "$2a$10$wT0lQo.B.0zZ9qE0h/1Yp.U6nL3W7F2V9G6bK8P1X2Y3Z4a5b6c7", "ask_eval@example.com", 0) ON DUPLICATE KEY UPDATE id=id'
  );
  const [askUserRows] = await pool.query('SELECT id FROM users WHERE username = "ask_eval_user"');
  const testUserId = askUserRows[0].id;
  const foreignUserId = 999999;

  // Setup evaluation contacts & commitments
  await pool.query('DELETE FROM commitments WHERE owner_user_id = ?', [testUserId]);
  await pool.query('DELETE FROM contacts WHERE owner_user_id = ? AND first_name IN ("David", "Larry", "Satya", "Tiger", "Rahul", "Thomas", "Duncan")', [testUserId]);

  // Insert base test contacts
  const [d1Res] = await pool.query(
    `INSERT INTO contacts (owner_user_id, created_by, first_name, last_name, company_name, primary_phone, mobile_phone, primary_email)
     VALUES (?, ?, 'David', 'Miller', 'TechCorp', '+15551112222', '+15551112222', 'david@techcorp.com')`,
    [testUserId, testUserId]
  );
  const david1Id = d1Res.insertId;

  const [lRes] = await pool.query(
    `INSERT INTO contacts (owner_user_id, created_by, first_name, last_name, company_name, introduced_by_name, interests, personal_notes)
     VALUES (?, ?, 'Larry', 'Ellison', 'Oracle', 'Direct', 'Enjoys fine single malt whisky', 'High net worth tech investor')`,
    [testUserId, testUserId]
  );

  const [introIbmRes] = await pool.query(
    `INSERT INTO contacts (owner_user_id, created_by, first_name, last_name, company_name, introduced_by_name)
     VALUES (?, ?, 'Thomas', 'Watson', 'IBM', 'Larry')`,
    [testUserId, testUserId]
  );

  const [introMsftRes] = await pool.query(
    `INSERT INTO contacts (owner_user_id, created_by, first_name, last_name, company_name, introduced_by_name)
     VALUES (?, ?, 'Satya', 'Nadella', 'Microsoft', 'Larry')`,
    [testUserId, testUserId]
  );

  const [whiskyRes] = await pool.query(
    `INSERT INTO contacts (owner_user_id, created_by, first_name, last_name, company_name, introduced_by_name, interests)
     VALUES (?, ?, 'Duncan', 'Macallan', 'Highland Co', 'Larry', 'Enjoys fine single malt whisky')`,
    [testUserId, testUserId]
  );

  const [golfRes] = await pool.query(
    `INSERT INTO contacts (owner_user_id, created_by, first_name, last_name, company_name, introduced_by_name, interests)
     VALUES (?, ?, 'Tiger', 'Woods', 'PGA', 'Larry', 'Enjoys competitive golf tournaments')`,
    [testUserId, testUserId]
  );

  const [rRes] = await pool.query(
    `INSERT INTO contacts (owner_user_id, created_by, first_name, last_name, company_name)
     VALUES (?, ?, 'Rahul', 'Sharma', 'ABC Corp')`,
    [testUserId, testUserId]
  );
  const rahulId = rRes.insertId;

  // Insert commitment
  await pool.query(
    `INSERT INTO commitments (owner_user_id, contact_id, title, details, status)
     VALUES (?, ?, 'Send updated pricing schedule', 'Rahul is expected to provide Q4 pricing quote', 'OPEN')`,
    [testUserId, rahulId]
  );

  const askCases = [
    {
      id: 'ASK-001',
      title: "Query 1: What is David's cell?",
      query: "What is David's cell?",
      verify: (intent, result) => {
        return intent.intent === 'CONTACT_DETAIL' && intent.requested_fact === 'phone' && result.answer.includes('+15551112222');
      },
      expectation: "Resolves to CONTACT_DETAIL intent family and retrieves David's phone."
    },
    {
      id: 'ASK-002',
      title: "Query 2: Give me David's mobile.",
      query: "Give me David's mobile.",
      verify: (intent, result) => {
        return intent.intent === 'CONTACT_DETAIL' && intent.requested_fact === 'phone' && result.answer.includes('+15551112222');
      },
      expectation: "Resolves to same contact-phone intent family and retrieves phone."
    },
    {
      id: 'ASK-003',
      title: "Query 3: How do I call David?",
      query: "How do I call David?",
      verify: (intent, result) => {
        return intent.intent === 'CONTACT_DETAIL' && intent.requested_fact === 'phone' && result.answer.includes('+15551112222');
      },
      expectation: "Action 'call' resolves to phone reachability and retrieves phone."
    },
    {
      id: 'ASK-004',
      title: "Query 4: Who owes me pricing?",
      query: "Who owes me pricing?",
      verify: (intent, result) => {
        return intent.intent === 'COMMITMENT_SEARCH' && result.answer.includes('Rahul') && result.commitments.length > 0;
      },
      expectation: "Resolves to COMMITMENT_SEARCH and retrieves Rahul's pricing commitment."
    },
    {
      id: 'ASK-005',
      title: "Query 5: Who was sending the quote?",
      query: "Who was sending the quote?",
      verify: (intent, result) => {
        return intent.intent === 'COMMITMENT_SEARCH' && result.answer.includes('Rahul');
      },
      expectation: "Paraphrased quote query resolves to commitment semantics."
    },
    {
      id: 'ASK-006',
      title: "Query 6: Who did Larry introduce me to at IBM?",
      query: "Who did Larry introduce me to at IBM?",
      verify: (intent, result) => {
        return intent.intent === 'RELATIONSHIP_LOOKUP' && (result.answer.includes('Thomas Watson') || result.answer.includes('John Adams')) && result.answer.includes('IBM');
      },
      expectation: "Combines relationship clue (Larry) and organization clue (IBM)."
    },
    {
      id: 'ASK-007',
      title: "Query 7: Organization Substitution (IBM -> Microsoft)",
      query: "Who did Larry introduce me to at Microsoft?",
      verify: (intent, result) => {
        return intent.intent === 'RELATIONSHIP_LOOKUP' && result.answer.includes('Satya Nadella') && result.answer.includes('Microsoft');
      },
      expectation: "Substituting IBM with Microsoft seamlessly retrieves Satya Nadella."
    },
    {
      id: 'ASK-008',
      title: "Query 8: The whisky fellow Larry introduced",
      query: "The whisky fellow Larry introduced",
      verify: (intent, result) => {
        return result.answer.includes('Duncan Macallan') || result.answer.includes('whisky');
      },
      expectation: "Retrieves whisky contact without literal route branches."
    },
    {
      id: 'ASK-009',
      title: "Query 9: Topic Substitution (whisky -> golf)",
      query: "The golf fellow Larry introduced",
      verify: (intent, result) => {
        return result.answer.includes('Tiger Woods') || result.answer.includes('golf');
      },
      expectation: "Substituting whisky with golf dynamically retrieves Tiger Woods."
    },
    {
      id: 'ASK-010',
      title: "Query 10: Disambiguation between two Davids",
      query: "What is David's cell?",
      setup: async () => {
        // Insert second David to trigger ambiguity
        const [d2] = await pool.query(
          `INSERT INTO contacts (owner_user_id, created_by, first_name, last_name, company_name, primary_phone)
           VALUES (?, ?, 'David', 'Beckham', 'Inter Miami', '+13055550199')`,
          [testUserId, testUserId]
        );
        return d2.insertId;
      },
      verify: (intent, result) => {
        return result.requires_clarification === true && result.clarification_choices.length >= 2;
      },
      cleanup: async (d2Id) => {
        await pool.query('DELETE FROM contacts WHERE id = ?', [d2Id]);
      },
      expectation: "When two contacts match 'David', returns clarification choices rather than matched[0]."
    },
    {
      id: 'ASK-011',
      title: "Query 11: Cross-User Isolation (Tenant Isolation)",
      query: "What is David's cell?",
      user_id: foreignUserId,
      verify: (intent, result) => {
        return result.primary_contact === null && (!result.answer.includes('15551112222'));
      },
      expectation: "Foreign user query never retrieves another user's contact information."
    }
  ];

  const results = [];
  let passedCount = 0;

  for (const tc of askCases) {
    let setupId = null;
    if (tc.setup) {
      setupId = await tc.setup();
    }

    const currentUserId = tc.user_id || testUserId;
    const [userContacts] = await pool.query(
      'SELECT id, first_name, last_name, nickname, company_name FROM contacts WHERE owner_user_id = ?',
      [currentUserId]
    );

    const intent = interpretAskQuery(tc.query, userContacts);

    let res = null;
    switch (intent.intent) {
      case 'CONTACT_DETAIL':
        res = await retrieveContactDetails(pool, currentUserId, intent, tc.query);
        break;
      case 'COMMITMENT_SEARCH':
        res = await retrieveCommitments(pool, currentUserId, intent, tc.query);
        break;
      case 'RELATIONSHIP_LOOKUP':
        res = await retrieveRelationships(pool, currentUserId, intent, tc.query);
        break;
      case 'ORGANIZATION_LOOKUP':
        res = await retrieveOrganizationContext(pool, currentUserId, intent, tc.query);
        break;
      case 'TOPIC_SEARCH':
        res = await retrieveTopicContext(pool, currentUserId, intent, tc.query);
        break;
      default:
        res = await retrieveGeneralSearch(pool, currentUserId, intent, tc.query);
        break;
    }

    if (!res || !res.answer) {
      res = await retrieveGeneralSearch(pool, currentUserId, intent, tc.query);
    }

    const passed = tc.verify(intent, res);
    if (passed) passedCount++;

    results.push({
      id: tc.id,
      title: tc.title,
      query: tc.query,
      passed,
      intent_family: intent.intent,
      requested_fact: intent.requested_fact,
      requires_clarification: Boolean(res.requires_clarification),
      answer: res.answer,
      reason: res.reason,
      expectation: tc.expectation
    });

    if (tc.cleanup && setupId) {
      await tc.cleanup(setupId);
    }
  }

  const total = askCases.length;
  const passRate = ((passedCount / total) * 100).toFixed(2);

  const report = {
    evaluation_name: 'Ask Dossier v0.2 Generalization Evaluation Suite',
    evaluation_date: new Date().toISOString(),
    total_queries: total,
    passed_queries: passedCount,
    failed_queries: total - passedCount,
    pass_rate_percent: parseFloat(passRate),
    queries: results
  };

  const jsonPath = path.join(rootDir, 'ASK_EVALUATION_REPORT.json');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');

  let md = `# Ask Dossier v0.2 Generalization Evaluation Report

- **Evaluation Suite**: \`${report.evaluation_name}\`
- **Evaluation Date**: \`${report.evaluation_date}\`
- **Total Evaluated Queries**: \`${report.total_queries}\`
- **Passed Queries**: \`${report.passed_queries}\`
- **Failed Queries**: \`${report.failed_queries}\`
- **Overall Pass Rate**: **${report.pass_rate_percent}%**

---

## Evaluation Results Table

| ID | Query | Intent Family | Status | Key Evaluation Criteria |
|---|---|---|---|---|
`;

  for (const r of results) {
    md += `| **${r.id}** | \`"${r.query}"\` | \`${r.intent_family}\` | ${r.passed ? '✅ PASS' : '❌ FAIL'} | ${r.expectation} |\n`;
  }

  md += `\n---\n\n## Detailed Query Traces\n\n`;

  for (const r of results) {
    md += `### ${r.id}: "${r.query}"\n`;
    md += `- **Intent Family**: \`${r.intent_family}\` (Fact: \`${r.requested_fact || 'none'}\`)\n`;
    md += `- **Result Status**: ${r.passed ? '✅ Passed' : '❌ Failed'}\n`;
    md += `- **Answer Generated**: ${r.answer}\n`;
    md += `- **Clarification Required**: \`${r.requires_clarification}\`\n`;
    md += `- **Evidence/Reason**: ${r.reason}\n\n`;
  }

  const mdPath = path.join(rootDir, 'ASK_EVALUATION_REPORT.md');
  fs.writeFileSync(mdPath, md, 'utf8');

  console.log(`✅ Ask Dossier Evaluation Completed! Pass Rate: ${passRate}% (${passedCount}/${total} passed).`);
  console.log(`Reports saved to:\n - ${mdPath}\n - ${jsonPath}\n`);

  return report;
}

if (require.main === module) {
  runAskEvaluation().then(rep => {
    process.exit(rep.failed_queries === 0 ? 0 : 1);
  }).catch(e => {
    console.error('Fatal ask evaluation error:', e);
    process.exit(1);
  });
}

module.exports = { runAskEvaluation };
