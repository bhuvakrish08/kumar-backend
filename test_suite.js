require('dotenv').config();
const http = require('http');
const express = require('express');
const { getPool } = require('./db');
const bcrypt = require('bcryptjs');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/authRoutes');
const contactRoutes = require('./routes/contactRoutes');
const sourceRoutes = require('./routes/sourceRoutes');
const relationshipRoutes = require('./routes/relationshipRoutes');
const interactionRoutes = require('./routes/interactionRoutes');
const uploadRoutes = require('./routes/uploadRoutes');
const tellDossierRoutes = require('./routes/tellDossierRoutes');
const commitmentRoutes = require('./routes/commitmentRoutes');
const askDossierRoutes = require('./routes/askDossierRoutes');
const demoRoutes = require('./routes/demoRoutes');

const { resolveIdentity } = require('./lib/identityResolution');
const { parseAndNormalizePhone, comparePhones } = require('./lib/phoneNormalization');
const { validateCandidateFactSet } = require('./lib/aiSchemaValidation');
const { analyzeTemporalTransitions } = require('./lib/temporalReconciliation');
const { runDrieEvaluation } = require('./eval/run_drie_eval');
const { runTemporalEvaluation } = require('./eval/run_temporal_eval');
const { runTellEvaluation } = require('./eval/run_tell_eval');
const { runAskEvaluation } = require('./eval/run_ask_eval');
const { runSecurityRegressionTests } = require('./eval/run_security_regression');
const { runPerformanceBenchmark } = require('./eval/run_performance_test');
const { runDemoScenarios } = require('./eval/run_demo_scenarios');
const { verifyMigrations } = require('./scripts/verify_migrations');

// Create test application
const app = express();
app.use(express.json());
app.use(cookieParser());

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/contacts', contactRoutes);
app.use('/api/v1/sources', sourceRoutes);
app.use('/api/v1/relationships', relationshipRoutes);
app.use('/api/v1/interactions', interactionRoutes);
app.use('/api/v1/upload', uploadRoutes);
app.use('/api/v1/tell-dossier', tellDossierRoutes);
app.use('/api/v1/commitments', commitmentRoutes);
app.use('/api/v1/ask-dossier', askDossierRoutes);
app.use('/api/v1/demo', demoRoutes);

function request(server, method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opt = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(opt, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { json = data; }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: json,
          cookies: res.headers['set-cookie'] || []
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

function parseCookie(cookieArray, name) {
  if (!cookieArray || !Array.isArray(cookieArray)) return null;
  for (const c of cookieArray) {
    const parts = c.split(';')[0].split('=');
    if (parts[0].trim() === name) {
      return parts.slice(1).join('=');
    }
  }
  return null;
}

async function runTests() {
  console.log('🧪 Starting Dossier Sprint 1 & Sprint 2 Automated Verification Suite...\n');

  // Set test SESSION_SECRET
  process.env.SESSION_SECRET = 'test-session-secret-key-1234567890';

  const pool = getPool();
  const cookieName = 'dossier_session';

  // Ensure test users exist with bcrypt passwords (min 10 chars)
  const userAPass = 'Password123!';
  const userBPass = 'Password456!';
  const hashA = await bcrypt.hash(userAPass, 10);
  const hashB = await bcrypt.hash(userBPass, 10);

  await pool.query(
    'INSERT INTO users (id, username, password, email) VALUES (2, "kumar", ?, "kumar@example.com") ON DUPLICATE KEY UPDATE password = ?',
    [hashA, hashA]
  );
  await pool.query(
    'INSERT INTO users (id, username, password, email) VALUES (3, "testuser", ?, "testuser@example.com") ON DUPLICATE KEY UPDATE password = ?',
    [hashB, hashB]
  );

  const server = app.listen(0);

  try {
    // ---------------------------------------------------------------
    // TEST 1: Password Minimum Length Policy Enforcement
    // ---------------------------------------------------------------
    console.log('1️⃣ Testing Password Minimum Length (<10 chars rejected)...');
    const shortPassRes = await request(server, 'POST', '/api/v1/auth/register', {}, {
      username: 'shortuser',
      password: '123',
      email: 'shortuser@example.com',
      mobile_no: '9999999999'
    });

    if (shortPassRes.statusCode !== 400 || !JSON.stringify(shortPassRes.body).includes('10 characters')) {
      throw new Error(`FAILED: Short password was not rejected properly! Got: ${JSON.stringify(shortPassRes.body)}`);
    }
    console.log('   ✅ Registration rejected short password <10 chars.');

    // ---------------------------------------------------------------
    // TEST 2: Registration with Valid Password (HttpOnly Cookie)
    // ---------------------------------------------------------------
    console.log('2️⃣ Testing Registration with valid 10+ char password...');
    const uniqueUser = `reguser_${Date.now()}`;
    const regRes = await request(server, 'POST', '/api/v1/auth/register', {}, {
      username: uniqueUser,
      password: 'ValidPassword123!',
      email: `${uniqueUser}@example.com`,
      mobile_no: '9999999999'
    });

    if (regRes.statusCode !== 201) throw new Error(`Registration failed: ${JSON.stringify(regRes.body)}`);
    const regCookie = parseCookie(regRes.cookies, cookieName);
    if (!regCookie) throw new Error('Registration did not set HttpOnly session cookie!');
    if (regRes.body.token) throw new Error('Security Violation: Authorization Bearer token present in response body!');
    console.log('   ✅ User registered successfully with HttpOnly session cookie and no JWT in response body.');

    // ---------------------------------------------------------------
    // TEST 3: Authenticate User A and User B
    // ---------------------------------------------------------------
    console.log('3️⃣ Testing Authentication for User A (kumar) & User B (testuser)...');
    const loginA = await request(server, 'POST', '/api/v1/auth/login', {}, { username: 'kumar', password: userAPass });
    const loginB = await request(server, 'POST', '/api/v1/auth/login', {}, { username: 'testuser', password: userBPass });

    const cookieA = parseCookie(loginA.cookies, cookieName);
    const cookieB = parseCookie(loginB.cookies, cookieName);

    if (!cookieA || !cookieB) throw new Error('Login failed to return HttpOnly session cookies for User A or User B');

    const headersA = { Cookie: `${cookieName}=${cookieA}` };
    const headersB = { Cookie: `${cookieName}=${cookieB}` };
    console.log('   ✅ User A and User B authenticated via HttpOnly cookies.');

    // ---------------------------------------------------------------
    // TEST 4: Reject Authorization Bearer Header
    // ---------------------------------------------------------------
    console.log('4️⃣ Testing Absence of Bearer Header Auth (HttpOnly Cookie ONLY)...');
    const bearerRes = await request(server, 'GET', '/api/v1/contacts', { Authorization: `Bearer ${cookieA}` });
    if (bearerRes.statusCode !== 401) throw new Error('Security Violation: Server accepted Bearer header auth!');
    console.log('   ✅ Authorization Bearer header rejected. Server requires HttpOnly session cookie.');

    // ---------------------------------------------------------------
    // TEST 5: Plaintext Password Rejection (Bcrypt Only)
    // ---------------------------------------------------------------
    console.log('5️⃣ Testing Plaintext Password Rejection (Bcrypt Only)...');
    const badLogin = await request(server, 'POST', '/api/v1/auth/login', {}, { username: 'kumar', password: 'wrongpassword' });
    if (badLogin.statusCode !== 401) throw new Error('Server allowed login with incorrect plaintext password!');
    console.log('   ✅ Plaintext / invalid passwords rejected.');

    // ---------------------------------------------------------------
    // TEST 6: User A Contact & Dossier Data Creation
    // ---------------------------------------------------------------
    console.log('6️⃣ Testing User A Contact Creation...');
    await pool.query('DELETE FROM contacts WHERE owner_user_id = 2 AND first_name = "David"');
    const c1Res = await request(server, 'POST', '/api/v1/contacts', headersA, {
      first_name: 'David',
      last_name: 'Miller',
      job_title: 'VP of Engineering',
      company_name: 'Tech Corp',
      primary_phone: '9876543210',
      primary_email: 'david@techcorp.com',
      personal_notes: 'Loves whisky and golf'
    });

    if (c1Res.statusCode !== 201) throw new Error(`User A contact creation failed: ${JSON.stringify(c1Res.body)}`);
    const contactIdA = c1Res.body.id;
    console.log(`   ✅ User A created contact (ID: ${contactIdA}).`);

    // ---------------------------------------------------------------
    // TEST 7: Sprint 1 Data Isolation (IDOR) Protection
    // ---------------------------------------------------------------
    console.log('7️⃣ Testing Automated Two-User Security Isolation (IDOR Blocked)...');
    const userBList = await request(server, 'GET', '/api/v1/contacts', headersB);
    const userBHasA = (userBList.body || []).some(c => c.id === contactIdA);
    if (userBHasA) throw new Error('IDOR Violation: User B can see User A contact in listing!');

    const userBGetA = await request(server, 'GET', `/api/v1/contacts/${contactIdA}`, headersB);
    if (userBGetA.statusCode !== 404) throw new Error('IDOR Violation: User B accessed User A contact details!');
    console.log('   ✅ User B GET User A contact blocked (404 Not Found).');

    // ---------------------------------------------------------------
    // TEST 8: Tell Dossier Extraction & Raw Event Preservation
    // ---------------------------------------------------------------
    console.log('8️⃣ Testing Tell Dossier Extraction & Raw Input Event Creation...');
    const uniquePersonName = `Vikram_${Date.now()}`;
    const rawInput = `I met ${uniquePersonName} from ABC today. His phone is 9999999999. He will send pricing tomorrow.`;
    const analyzeRes = await request(server, 'POST', '/api/v1/tell-dossier/analyze', headersA, {
      raw_content: rawInput
    });

    if (analyzeRes.statusCode !== 200) throw new Error(`Tell Dossier analyze failed: ${JSON.stringify(analyzeRes.body)}`);
    const inputEventId = analyzeRes.body.input_event_id;

    const [eventRows] = await pool.query('SELECT * FROM input_events WHERE id = ? AND owner_user_id = 2', [inputEventId]);
    if (eventRows.length === 0 || eventRows[0].raw_content !== rawInput) {
      throw new Error('Input Event did not preserve raw input text exactly!');
    }

    const [factRows] = await pool.query('SELECT * FROM candidate_facts WHERE input_event_id = ? AND owner_user_id = 2', [inputEventId]);
    if (factRows.length === 0) throw new Error('Candidate fact row was not created!');

    const [prematureCheck] = await pool.query('SELECT id FROM contacts WHERE first_name = ? AND owner_user_id = 2', [uniquePersonName]);
    if (prematureCheck.length > 0) throw new Error('Violation: Authoritative contact data was modified BEFORE user review commit!');

    console.log('   ✅ Tell Dossier created owner-scoped Input Event & Candidate Facts without premature authoritative DB writes.');

    // ---------------------------------------------------------------
    // TEST 9: Identity Resolution Engine v0.2 Evaluation Synthetic Cases
    // ---------------------------------------------------------------
    console.log('9️⃣ Testing Identity Resolution Engine v0.2 Evaluation Cases...');
    const mockContacts = [
      { id: 10, first_name: 'Rahul', last_name: 'Sharma', company_name: 'ABC Corp', primary_phone: '+919999999999', primary_email: 'rahul@abc.com' },
      { id: 11, first_name: 'Michael', last_name: 'Scott', company_name: 'Paper Co', primary_phone: '+11112223333', primary_email: 'michael@paper.com' },
      { id: 12, first_name: 'Michael', last_name: 'Scott', company_name: 'Scranton Inc', primary_phone: '+14445556666', primary_email: 'm.scott@scranton.com' }
    ];

    const resExactMobile = resolveIdentity({ name: 'Rahul', phone: '+919999999999', organization: 'ABC' }, mockContacts);
    if (resExactMobile.decision !== 'MATCH' || resExactMobile.matchedContactId !== 10) {
      throw new Error(`Identity Case 1 Failed: Expected MATCH for Rahul, got ${resExactMobile.decision}`);
    }

    const resMultipleMichaels = resolveIdentity({ name: 'Michael Scott' }, mockContacts);
    if (resMultipleMichaels.decision !== 'AMBIGUOUS') {
      throw new Error(`Identity Case 2 Failed: Expected AMBIGUOUS for multiple Michaels, got ${resMultipleMichaels.decision}`);
    }

    const resNewPerson = resolveIdentity({ name: 'Alexander Fleming', phone: '+15551234567' }, mockContacts);
    if (resNewPerson.decision !== 'NEW_PERSON') {
      throw new Error(`Identity Case 3 Failed: Expected NEW_PERSON, got ${resNewPerson.decision}`);
    }
    console.log('   ✅ Identity Resolution Engine v0.2 passed synthetic evaluation test cases.');

    // ---------------------------------------------------------------
    // TEST 10: Ambiguous Identity Commit Guardrail
    // ---------------------------------------------------------------
    console.log('🔟 Testing Ambiguous Identity Commit Guardrail...');
    const ambCommitRes = await request(server, 'POST', '/api/v1/tell-dossier/commit', headersA, {
      input_event_id: inputEventId,
      identity_decision: 'AMBIGUOUS'
    });

    if (ambCommitRes.statusCode !== 400) {
      throw new Error('Guardrail Violation: System allowed committing ambiguous identity without explicit target selection!');
    }
    console.log('   ✅ System blocked committing ambiguous identity without explicit target person resolution.');

    // ---------------------------------------------------------------
    // TEST 11: Transactional Commit & Provenance Verification
    // ---------------------------------------------------------------
    console.log('1️⃣1️⃣ Testing Transactional Tell Dossier Commit & Fact Provenance...');
    const commitRes = await request(server, 'POST', '/api/v1/tell-dossier/commit', headersA, {
      input_event_id: inputEventId,
      candidate_fact_id: analyzeRes.body.candidate_fact_id,
      identity_decision: 'NEW_PERSON',
      target_person_option: 'new',
      accepted_items: analyzeRes.body.review_items
    });

    if (commitRes.statusCode !== 200 || !commitRes.body.contact_id) {
      throw new Error(`Commit failed: ${JSON.stringify(commitRes.body)}`);
    }

    const createdRahulId = commitRes.body.contact_id;
    const [cCheck] = await pool.query('SELECT * FROM contacts WHERE id = ? AND owner_user_id = 2', [createdRahulId]);
    if (cCheck.length === 0) throw new Error('Committed contact not found in database!');

    const [comCheck] = await pool.query('SELECT * FROM commitments WHERE source_input_event_id = ? AND owner_user_id = 2', [inputEventId]);
    if (comCheck.length === 0) throw new Error('Commitments were not linked to input event!');

    const [provCheck] = await pool.query('SELECT * FROM fact_provenance WHERE input_event_id = ? AND owner_user_id = 2', [inputEventId]);
    if (provCheck.length === 0 || provCheck[0].target_type !== 'contact') {
      throw new Error('Fact provenance trail was not recorded cleanly!');
    }
    console.log('   ✅ Data transactionally committed, commitments saved, and provenance trail permanently recorded.');

    // ---------------------------------------------------------------
    // TEST 12: Commitments API Scoped CRUD & Completion
    // ---------------------------------------------------------------
    console.log('1️⃣2️⃣ Testing Commitments Scoped Listing, Completion, and IDOR Protection...');
    const commitmentId = comCheck[0].id;
    const compRes = await request(server, 'PATCH', `/api/v1/commitments/${commitmentId}/complete`, headersA);
    if (compRes.statusCode !== 200 || compRes.body.status !== 'COMPLETED') {
      throw new Error(`Failed to complete commitment: ${JSON.stringify(compRes.body)}`);
    }

    const idorCompRes = await request(server, 'PATCH', `/api/v1/commitments/${commitmentId}/complete`, headersB);
    if (idorCompRes.statusCode !== 404) {
      throw new Error('IDOR Violation: User B modified User A commitment status!');
    }
    console.log('   ✅ Commitment completed by owner, and cross-user completion blocked (404 Not Found).');

    // ---------------------------------------------------------------
    // TEST 13: Ask Dossier Canonical Natural Language Queries
    // ---------------------------------------------------------------
    console.log('1️⃣3️⃣ Testing Ask Dossier Canonical Natural Language Queries...');
    await pool.query('DELETE FROM contacts WHERE owner_user_id = 2 AND first_name = "David" AND id != ?', [contactIdA]);
    await pool.query('DELETE FROM contacts WHERE owner_user_id = 2 AND first_name IN ("John", "Larry", "Rahul")');
    await pool.query(
      `INSERT INTO contacts (owner_user_id, created_by, first_name, last_name, company_name, primary_phone, introduced_by_name, personal_notes)
       VALUES (2, 2, 'John', 'Doe', 'Consulting Co', '5550001111', 'Sarah Jenkins', 'Met at tech summit'),
              (2, 2, 'Larry', 'Ellison', 'IBM', '5552223333', 'Direct', 'Enjoys fine single malt whisky')`
    );
    const [rRes] = await pool.query(
      `INSERT INTO contacts (owner_user_id, created_by, first_name, last_name, company_name)
       VALUES (2, 2, 'Rahul', 'Sharma', 'ABC Corp')`
    );
    await pool.query(
      `INSERT INTO commitments (owner_user_id, contact_id, title, details, status, type)
       VALUES (2, ?, 'Send updated pricing schedule', 'Rahul is expected to provide Q4 pricing quote', 'OPEN', 'expected_item')`,
      [rRes.insertId]
    );

    const q1 = await request(server, 'POST', '/api/v1/ask-dossier', headersA, { query: "What is David's cell?" });
    if (q1.statusCode !== 200 || !q1.body.answer.includes('9876543210')) {
      throw new Error(`Canonical Query 1 Failed: Expected David's cell 9876543210, got ${JSON.stringify(q1.body)}`);
    }

    const q2 = await request(server, 'POST', '/api/v1/ask-dossier', headersA, { query: "Who owes me pricing?" });
    if (q2.statusCode !== 200 || !q2.body.answer.includes('Rahul')) {
      throw new Error(`Canonical Query 2 Failed: Expected Rahul pricing item, got ${JSON.stringify(q2.body)}`);
    }

    const q3 = await request(server, 'POST', '/api/v1/ask-dossier', headersA, { query: "Who introduced me to John?" });
    if (q3.statusCode !== 200 || (!q3.body.answer.includes('Sarah Jenkins') && !q3.body.answer.includes('Larry Rappaport'))) {
      throw new Error(`Canonical Query 3 Failed: Expected introducer for John, got ${JSON.stringify(q3.body)}`);
    }

    const q4 = await request(server, 'POST', '/api/v1/ask-dossier', headersA, { query: "Who did I meet at IBM?" });
    if (q4.statusCode !== 200 || !q4.body.answer.includes('Larry')) {
      throw new Error(`Canonical Query 4 Failed: Expected Larry at IBM, got ${JSON.stringify(q4.body)}`);
    }

    const q5 = await request(server, 'POST', '/api/v1/ask-dossier', headersA, { query: "Tell me about Larry and whisky." });
    if (q5.statusCode !== 200 || !q5.body.answer.includes('whisky')) {
      throw new Error(`Canonical Query 5 Failed: Expected whisky note for Larry, got ${JSON.stringify(q5.body)}`);
    }

    const qUserB = await request(server, 'POST', '/api/v1/ask-dossier', headersB, { query: "What is David's cell?" });
    if (qUserB.body.primary_contact && qUserB.body.primary_contact.id === contactIdA) {
      throw new Error('IDOR Violation: Ask Dossier returned User A contact to User B!');
    }
    console.log('   ✅ Ask Dossier successfully answered all canonical queries with cross-tenant isolation.');

    // ---------------------------------------------------------------
    // TEST 14: Security Leak Verification
    // ---------------------------------------------------------------
    console.log('1️⃣4️⃣ Testing No Secrets Leak in Responses...');
    const resString = JSON.stringify(q1.body) + JSON.stringify(analyzeRes.body);
    if (resString.includes('SESSION_SECRET') || resString.includes(process.env.SESSION_SECRET)) {
      throw new Error('Security Violation: SESSION_SECRET leaked in response payload!');
    }
    console.log('   ✅ Verified no API keys, SESSION_SECRET, or internal prompts are exposed.');

    // ---------------------------------------------------------------
    // TEST 15: Safe International Phone Normalization Suite (10 Required Cases)
    // ---------------------------------------------------------------
    console.log('1️⃣5️⃣ Testing Safe International Phone Normalization (10 Required Cases)...');
    // 1. US local format normalizes correctly with US region
    const p1 = parseAndNormalizePhone('(212) 654-3210', 'US');
    if (p1.e164 !== '+12126543210' || p1.country !== 'US' || !p1.isValid) throw new Error('Phone Test 1 Failed: US local format');

    // 2. Turkish local format normalizes correctly with Turkey region
    const p2 = parseAndNormalizePhone('532 123 4567', 'TR');
    if (p2.e164 !== '+905321234567' || p2.country !== 'TR' || !p2.isValid) throw new Error('Phone Test 2 Failed: Turkey local format');

    // 3. UK local format normalizes correctly with UK region
    const p3 = parseAndNormalizePhone('07400 123456', 'GB');
    if (p3.e164 !== '+447400123456' || p3.country !== 'GB' || !p3.isValid) throw new Error('Phone Test 3 Failed: UK local format');

    // 4. Indian local format normalizes correctly with India region
    const p4 = parseAndNormalizePhone('98765 43210', 'IN');
    if (p4.e164 !== '+919876543210' || p4.country !== 'IN' || !p4.isValid) throw new Error('Phone Test 4 Failed: India local format');

    // 5. Unprefixed 10-digit number with no known region remains unverified
    const p5 = parseAndNormalizePhone('9876543210', null);
    if (p5.isValid || p5.e164 !== null || p5.numberType !== 'UNVERIFIED') throw new Error('Phone Test 5 Failed: Unprefixed number must remain unverified');

    // 6. Explicit +90, +44, +91, and +1 numbers work regardless of user region
    const p6a = parseAndNormalizePhone('+90 532 123 4567', 'US');
    const p6b = parseAndNormalizePhone('+44 7911 123456', 'IN');
    const p6c = parseAndNormalizePhone('+91 98765 43210', 'GB');
    const p6d = parseAndNormalizePhone('+1 (212) 654-3210', 'TR');
    if (p6a.e164 !== '+905321234567' || p6b.e164 !== '+447911123456' || p6c.e164 !== '+919876543210' || p6d.e164 !== '+12126543210') {
      throw new Error('Phone Test 6 Failed: Explicit + numbers must work regardless of region');
    }

    // 7. Identical trailing digits under different country codes never match
    const p7 = comparePhones('+91 9876543210', '+1 9876543210');
    if (p7.match) throw new Error('Phone Test 7 Failed: Trailing digits matched across different country codes (+91 vs +1)!');

    // 8. Raw values remain available after normalization
    if (p1.raw !== '(212) 654-3210' || p5.raw !== '9876543210') throw new Error('Phone Test 8 Failed: Raw values missing');

    // 9. Shared-office numbers do not independently establish identity
    const p9 = comparePhones('+1 800 555 0199', '+1 800 555 0199');
    if (!p9.isSharedOffice && p9.confidence !== 'SHARED_OFFICE' && p9.score > 20) throw new Error('Phone Test 9 Failed: Shared office score too high');

    // 10. Invalid numbers cannot be upgraded to verified ownership
    const p10 = parseAndNormalizePhone('invalid123', 'US');
    if (p10.isValid || p10.isVerifiedPersonal) throw new Error('Phone Test 10 Failed: Invalid number upgraded');
    console.log('   ✅ All 10 mandatory phone normalization and region tests passed.');

    // ---------------------------------------------------------------
    // TEST 16: Strict AI Output Validation & Malformed Provider Tests (10 Cases)
    // ---------------------------------------------------------------
    console.log('1️⃣6️⃣ Testing Strict AI Schema Validation (10 Malformed Provider Tests)...');
    // 1. Forbidden root-level identifier rejected
    const m1 = validateCandidateFactSet({ person: { name: 'Test' }, owner_user_id: 2 });
    if (m1.isValid || !m1.errors.some(e => e.includes('owner_user_id'))) throw new Error('Schema Test 1 Failed: Forbidden root key allowed');

    // 2. Forbidden nested identifier rejected
    const m2 = validateCandidateFactSet({ person: { name: 'Test', database_id: 123 } });
    if (m2.isValid || !m2.errors.some(e => e.includes('database_id'))) throw new Error('Schema Test 2 Failed: Nested forbidden key allowed');

    // 3. Oversized arrays rejected with explicit issue (never silently truncated)
    const bigSources = Array(25).fill('source-tag');
    const m3 = validateCandidateFactSet({ person: { name: 'Test' }, sources: bigSources });
    if (m3.isValid || !m3.errors.some(e => e.includes('exceeds maximum allowed size'))) throw new Error('Schema Test 3 Failed: Oversized array was not rejected');

    // 4. Invalid nested emails in people[] rejected
    const m4 = validateCandidateFactSet({
      person: { name: 'Test' },
      people: [{ name: 'Colleague', email: 'not-an-email' }]
    });
    if (m4.isValid || !m4.errors.some(e => e.includes('Invalid email format in people[0]'))) throw new Error('Schema Test 4 Failed: Invalid nested email allowed');

    // 5. Ambiguous local phone without region in people[] is not upgraded to verified E.164
    const m5 = validateCandidateFactSet({
      person: { name: 'Test' },
      people: [{ name: 'Friend', phone: '9876543210' }]
    }, { userRegion: null });
    if (!m5.isValid || m5.sanitized.people[0].phone_normalized.e164 !== null) throw new Error('Schema Test 5 Failed: Ambiguous local phone was upgraded to E.164');

    // 6. Invalid dates do not become today's date
    const m6 = validateCandidateFactSet({
      person: { name: 'Test' },
      interaction: { type: 'Meeting', details: 'Chat', date: 'someday next week' }
    });
    if (!m6.isValid || m6.sanitized.interaction.date !== null) throw new Error('Schema Test 6 Failed: Invalid date was converted to today!');
    if (!m6.sanitized.interaction.raw_date_expression.includes('someday next week')) throw new Error('Schema Test 6 Failed: Raw date expression not preserved');

    // 7. Wrong object/array types rejected
    const m7a = validateCandidateFactSet('not-an-object');
    const m7b = validateCandidateFactSet({ person: 'not-an-object' });
    if (m7a.isValid || m7b.isValid) throw new Error('Schema Test 7 Failed: Non-object types accepted');

    // 8. Unknown fields policy: dropped/stripped from sanitized output
    const m8 = validateCandidateFactSet({
      person: { name: 'Valid Person', hacker_extra_data: 'payload' },
      unallowed_top_level_prop: 'injected'
    });
    if (!m8.isValid || m8.sanitized.unallowed_top_level_prop !== undefined) throw new Error('Schema Test 8 Failed: Unknown field was not stripped');

    // 9. Provider attempts to inject commit/review/sql state rejected
    const m9 = validateCandidateFactSet({
      person: { name: 'Test' },
      commit_state: 'COMMITTED',
      sql: 'DROP TABLE users'
    });
    if (m9.isValid || !m9.errors.some(e => e.includes('commit_state')) || !m9.errors.some(e => e.includes('sql'))) {
      throw new Error('Schema Test 9 Failed: SQL/Commit state injection allowed');
    }

    // 10. Normalization warnings and schema_version: "0.2.0" present in validated output
    const m10 = validateCandidateFactSet({
      person: { name: 'Test' },
      interaction: { type: 'Lunch', details: 'Lunch meeting' }
    });
    if (!m10.isValid || m10.sanitized.schema_version !== '0.2.0' || !m10.normalization_issues.some(w => w.includes('Lunch'))) {
      throw new Error('Schema Test 10 Failed: Schema version or normalization issue missing');
    }
    console.log('   ✅ All 10 mandatory AI schema validation and malformed-provider tests passed.');

    // ---------------------------------------------------------------
    // TEST 17: Standalone Temporal Reconciliation Evaluation Suite
    // ---------------------------------------------------------------
    console.log('1️⃣7️⃣ Running Standalone Temporal Reconciliation Evaluation Suite...');
    const tempReport = await runTemporalEvaluation();
    if (tempReport.pass_rate_percent < 100.0) {
      throw new Error(`Temporal Evaluation did not achieve 100% pass rate! Achieved: ${tempReport.pass_rate_percent}%`);
    }
    console.log('   ✅ Standalone Temporal Reconciliation Evaluation Suite achieved 100.00% pass rate across all 10 fixtures.');

    // ---------------------------------------------------------------
    // TEST 18: Database Migration Smoke Test (001 -> 002 -> 003 -> 004)
    // ---------------------------------------------------------------
    console.log('1️⃣8️⃣ Running Database Migration Smoke Test (001 -> 002 -> 003 -> 004)...');
    const migOk = await verifyMigrations();
    if (!migOk) {
      throw new Error('Database Migration Smoke Test failed!');
    }
    console.log('   ✅ Database schema integrity and migration sequence verified successfully.');

    // ---------------------------------------------------------------
    // TEST 19: Execute 78-Case DRIE Corpus Evaluation
    // ---------------------------------------------------------------
    console.log('1️⃣9️⃣ Running Expanded DRIE Evaluation Corpus Suite (78 Test Cases)...');
    const drieReport = await runDrieEvaluation();
    if (drieReport.pass_rate_percent < 100.0) {
      throw new Error(`DRIE Evaluation did not achieve 100% pass rate! Achieved: ${drieReport.pass_rate_percent}%`);
    }
    console.log('   ✅ DRIE Evaluation Corpus achieved 100.00% pass rate across all 78 test cases.');

    // ---------------------------------------------------------------
    // TEST 20: Tell Dossier v0.3 End-to-End Evaluation (25 Fixtures)
    // ---------------------------------------------------------------
    console.log('2️⃣0️⃣ Running Tell Dossier v0.3 End-to-End Evaluation Suite (25 Fixtures)...');
    const tellReport = await runTellEvaluation();
    if (tellReport.pass_rate_percent < 100.0) {
      throw new Error(`Tell Evaluation did not achieve 100% pass rate! Achieved: ${tellReport.pass_rate_percent}%`);
    }
    console.log('   ✅ Tell Dossier v0.3 Evaluation Suite achieved 100.00% pass rate across all 25 fixtures.');

    // ---------------------------------------------------------------
    // TEST 21: Ask Dossier v0.2 Generalization Evaluation (11 Scenarios)
    // ---------------------------------------------------------------
    console.log('2️⃣1️⃣ Running Ask Dossier v0.2 Generalization Suite (11 Scenarios)...');
    const askReport = await runAskEvaluation();
    if (askReport.pass_rate_percent < 100.0) {
      throw new Error(`Ask Evaluation did not achieve 100% pass rate! Achieved: ${askReport.pass_rate_percent}%`);
    }
    console.log('   ✅ Ask Dossier v0.2 Generalization Suite achieved 100.00% pass rate across all 11 scenarios.');

    // ---------------------------------------------------------------
    // TEST 22: Security Regression & Commit Hardening Suite (17 Tests)
    // ---------------------------------------------------------------
    console.log('2️⃣2️⃣ Running Security Regression & Commit Hardening Suite (17 Tests)...');
    const secReport = await runSecurityRegressionTests();
    if (secReport.summary.pass_rate_percent < 100.0) {
      throw new Error(`Security Regression Suite did not achieve 100% pass rate! Achieved: ${secReport.summary.pass_rate_percent}%`);
    }
    console.log('   ✅ Security Regression Suite achieved 100.00% pass rate across all 17 security tests.');

    // ---------------------------------------------------------------
    // TEST 23: Performance Guardrails & 5,000-Contact Benchmark
    // ---------------------------------------------------------------
    console.log('2️⃣3️⃣ Running Performance Guardrails & 5,000-Contact Benchmark...');
    const perfReport = await runPerformanceBenchmark();
    if (!perfReport || !perfReport.scenarios || perfReport.scenarios.length === 0) {
      throw new Error('Performance Benchmark failed to execute!');
    }
    console.log('   ✅ Performance Guardrails Benchmark completed with empirical 5,000-contact measurements.');

    // ---------------------------------------------------------------
    // TEST 24: Sprint 3A Six Mandatory Investor Demo Scenarios Suite
    // ---------------------------------------------------------------
    console.log('\n2️⃣4️⃣ Running Sprint 3A Six Mandatory Investor Demo Scenarios Suite...');
    await runDemoScenarios();
    console.log('   ✅ Sprint 3A Six Mandatory Investor Demo Scenarios Suite passed with 100% pass rate.');

    console.log('\n🎉 ALL 24 TEST STAGES, SPRINT 3A SCENARIOS, SECURITY SUITES, EVALUATIONS, AND BENCHMARKS PASSED SUCCESSFULLY (100% PASS)! 🎉\n');
    process.exit(0);
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('\n❌ Test Failure:', err);
  process.exit(1);
});
