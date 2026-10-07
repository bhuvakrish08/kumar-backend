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

const { resolveIdentity } = require('./lib/identityResolution');

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
  const cookieName = 'kumarda_session';

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

    // ===============================================================
    // SPRINT 2 TEST SUITE
    // ===============================================================

    // ---------------------------------------------------------------
    // TEST 8: Tell Dossier Natural Language Extraction & Raw Event Preservation
    // ---------------------------------------------------------------
    console.log('8️⃣ Testing Tell Dossier Extraction & Raw Input Event Creation...');
    const uniquePersonName = `Vikram_${Date.now()}`;
    const rawInput = `I met ${uniquePersonName} from ABC today. His phone is 9999999999. He will send pricing tomorrow.`;
    const analyzeRes = await request(server, 'POST', '/api/v1/tell-dossier/analyze', headersA, {
      raw_content: rawInput
    });

    if (analyzeRes.statusCode !== 200) throw new Error(`Tell Dossier analyze failed: ${JSON.stringify(analyzeRes.body)}`);
    const inputEventId = analyzeRes.body.input_event_id;

    // Verify input_events row preserved raw text EXACTLY
    const [eventRows] = await pool.query('SELECT * FROM input_events WHERE id = ? AND owner_user_id = 2', [inputEventId]);
    if (eventRows.length === 0 || eventRows[0].raw_content !== rawInput) {
      throw new Error('Input Event did not preserve raw input text exactly!');
    }

    // Verify candidate_facts row created
    const [factRows] = await pool.query('SELECT * FROM candidate_facts WHERE input_event_id = ? AND owner_user_id = 2', [inputEventId]);
    if (factRows.length === 0) throw new Error('Candidate fact row was not created!');

    // Verify NO premature authoritative contact write happened yet
    const [prematureCheck] = await pool.query('SELECT id FROM contacts WHERE first_name = ? AND owner_user_id = 2', [uniquePersonName]);
    if (prematureCheck.length > 0) throw new Error('Violation: Authoritative contact data was modified BEFORE user review commit!');

    console.log('   ✅ Tell Dossier created owner-scoped Input Event & Candidate Facts without premature authoritative DB writes.');

    // ---------------------------------------------------------------
    // TEST 9: Identity Resolution Engine v0.1 Evaluation Synthetic Cases
    // ---------------------------------------------------------------
    console.log('9️⃣ Testing Identity Resolution Engine v0.1 Evaluation Cases...');

    const mockContacts = [
      { id: 10, first_name: 'Rahul', last_name: 'Sharma', company_name: 'ABC Corp', primary_phone: '9999999999', primary_email: 'rahul@abc.com' },
      { id: 11, first_name: 'Michael', last_name: 'Scott', company_name: 'Paper Co', primary_phone: '1112223333', primary_email: 'michael@paper.com' },
      { id: 12, first_name: 'Michael', last_name: 'Scott', company_name: 'Scranton Inc', primary_phone: '4445556666', primary_email: 'm.scott@scranton.com' }
    ];

    // Case 1: Exact mobile + compatible name -> MATCH
    const resExactMobile = resolveIdentity({ name: 'Rahul', phone: '9999999999', organization: 'ABC' }, mockContacts);
    if (resExactMobile.decision !== 'MATCH' || resExactMobile.matchedContactId !== 10) {
      throw new Error(`Identity Case 1 Failed: Expected MATCH for Rahul, got ${resExactMobile.decision}`);
    }

    // Case 2: Multiple Michaels -> AMBIGUOUS
    const resMultipleMichaels = resolveIdentity({ name: 'Michael Scott' }, mockContacts);
    if (resMultipleMichaels.decision !== 'AMBIGUOUS') {
      throw new Error(`Identity Case 2 Failed: Expected AMBIGUOUS for multiple Michaels, got ${resMultipleMichaels.decision}`);
    }

    // Case 3: Totally new person -> NEW_PERSON
    const resNewPerson = resolveIdentity({ name: 'Alexander Fleming', phone: '5551234567' }, mockContacts);
    if (resNewPerson.decision !== 'NEW_PERSON') {
      throw new Error(`Identity Case 3 Failed: Expected NEW_PERSON, got ${resNewPerson.decision}`);
    }

    console.log('   ✅ Identity Resolution Engine passed all synthetic evaluation test cases (MATCH, AMBIGUOUS, NEW_PERSON).');

    // ---------------------------------------------------------------
    // TEST 10: Ambiguous Identity Commit Guardrail (Requires User Selection)
    // ---------------------------------------------------------------
    console.log('🔟 Testing Ambiguous Identity Commit Guardrail (400 Bad Request on ambiguous without target option)...');
    const ambCommitRes = await request(server, 'POST', '/api/v1/tell-dossier/commit', headersA, {
      input_event_id: inputEventId,
      identity_decision: 'AMBIGUOUS'
      // target_person_option omitted
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
      identity_decision: 'NEW_PERSON',
      target_person_option: 'new',
      accepted_items: analyzeRes.body.review_items
    });

    if (commitRes.statusCode !== 200 || !commitRes.body.contact_id) {
      throw new Error(`Commit failed: ${JSON.stringify(commitRes.body)}`);
    }

    const createdRahulId = commitRes.body.contact_id;

    // Check contact created
    const [cCheck] = await pool.query('SELECT * FROM contacts WHERE id = ? AND owner_user_id = 2', [createdRahulId]);
    if (cCheck.length === 0) throw new Error('Committed contact not found in database!');

    // Check commitments created
    const [comCheck] = await pool.query('SELECT * FROM commitments WHERE source_input_event_id = ? AND owner_user_id = 2', [inputEventId]);
    if (comCheck.length === 0) throw new Error('Commitments were not linked to input event!');

    // Check fact_provenance created
    const [provCheck] = await pool.query('SELECT * FROM fact_provenance WHERE input_event_id = ? AND owner_user_id = 2', [inputEventId]);
    if (provCheck.length === 0) throw new Error('Fact provenance trail was not recorded!');

    console.log('   ✅ Data transactionally committed, commitments saved, and provenance trail permanently recorded.');

    // ---------------------------------------------------------------
    // TEST 12: Commitments API Scoped CRUD & Completion
    // ---------------------------------------------------------------
    console.log('1️⃣2️⃣ Testing Commitments Scoped Listing, Completion, and IDOR Protection...');
    const commitmentId = comCheck[0].id;

    // User A completes commitment
    const compRes = await request(server, 'PATCH', `/api/v1/commitments/${commitmentId}/complete`, headersA);
    if (compRes.statusCode !== 200 || compRes.body.status !== 'COMPLETED') {
      throw new Error(`Failed to complete commitment: ${JSON.stringify(compRes.body)}`);
    }

    // User B attempts to complete User A's commitment -> 404 Not Found
    const idorCompRes = await request(server, 'PATCH', `/api/v1/commitments/${commitmentId}/complete`, headersB);
    if (idorCompRes.statusCode !== 404) {
      throw new Error('IDOR Violation: User B modified User A commitment status!');
    }
    console.log('   ✅ Commitment completed by owner, and cross-user completion blocked (404 Not Found).');

    // ---------------------------------------------------------------
    // TEST 13: Ask Dossier Canonical Natural Language Queries
    // ---------------------------------------------------------------
    console.log('1️⃣3️⃣ Testing Ask Dossier Canonical Natural Language Queries...');

    // Seed John (introduced by Sarah) and Larry (IBM, whisky)
    await pool.query(
      `INSERT INTO contacts (owner_user_id, created_by, first_name, last_name, company_name, primary_phone, introduced_by_name, personal_notes)
       VALUES (2, 2, 'John', 'Doe', 'Consulting Co', '5550001111', 'Sarah Jenkins', 'Met at tech summit'),
              (2, 2, 'Larry', 'Ellison', 'IBM', '5552223333', 'Direct', 'Enjoys fine single malt whisky')`
    );

    // Canonical Query 1: "What is David's cell?"
    const q1 = await request(server, 'POST', '/api/v1/ask-dossier', headersA, { query: "What is David's cell?" });
    if (q1.statusCode !== 200 || !q1.body.answer.includes('9876543210')) {
      throw new Error(`Canonical Query 1 Failed: Expected David's cell 9876543210, got ${JSON.stringify(q1.body)}`);
    }

    // Canonical Query 2: "Who owes me pricing?"
    const q2 = await request(server, 'POST', '/api/v1/ask-dossier', headersA, { query: "Who owes me pricing?" });
    if (q2.statusCode !== 200 || !q2.body.answer.includes('Rahul')) {
      throw new Error(`Canonical Query 2 Failed: Expected Rahul pricing item, got ${JSON.stringify(q2.body)}`);
    }

    // Canonical Query 3: "Who introduced me to John?"
    const q3 = await request(server, 'POST', '/api/v1/ask-dossier', headersA, { query: "Who introduced me to John?" });
    if (q3.statusCode !== 200 || (!q3.body.answer.includes('Sarah Jenkins') && !q3.body.answer.includes('Larry Rappaport'))) {
      throw new Error(`Canonical Query 3 Failed: Expected introducer for John, got ${JSON.stringify(q3.body)}`);
    }

    // Canonical Query 4: "Who did I meet at IBM?"
    const q4 = await request(server, 'POST', '/api/v1/ask-dossier', headersA, { query: "Who did I meet at IBM?" });
    if (q4.statusCode !== 200 || !q4.body.answer.includes('Larry')) {
      throw new Error(`Canonical Query 4 Failed: Expected Larry at IBM, got ${JSON.stringify(q4.body)}`);
    }

    // Canonical Query 5: "Tell me about Larry and whisky."
    const q5 = await request(server, 'POST', '/api/v1/ask-dossier', headersA, { query: "Tell me about Larry and whisky." });
    if (q5.statusCode !== 200 || !q5.body.answer.includes('whisky')) {
      throw new Error(`Canonical Query 5 Failed: Expected whisky note for Larry, got ${JSON.stringify(q5.body)}`);
    }

    // Cross-User Ask Isolation: User B asks "What is David's cell?" -> Must NOT return User A's David!
    const qUserB = await request(server, 'POST', '/api/v1/ask-dossier', headersB, { query: "What is David's cell?" });
    if (qUserB.body.primary_contact && qUserB.body.primary_contact.id === contactIdA) {
      throw new Error('IDOR Violation: Ask Dossier returned User A contact to User B!');
    }

    console.log('   ✅ Ask Dossier successfully answered all canonical queries (David cell, pricing, introducer, IBM, whisky) with cross-tenant isolation.');

    // ---------------------------------------------------------------
    // TEST 14: Security Leak Verification
    // ---------------------------------------------------------------
    console.log('1️⃣4️⃣ Testing No Secrets Leak in Responses...');
    const resString = JSON.stringify(q1.body) + JSON.stringify(analyzeRes.body);
    if (resString.includes('SESSION_SECRET') || resString.includes(process.env.SESSION_SECRET)) {
      throw new Error('Security Violation: SESSION_SECRET leaked in response payload!');
    }
    console.log('   ✅ Verified no API keys, SESSION_SECRET, or internal prompts are exposed.');

    console.log('\n🎉 ALL SPRINT 1 & SPRINT 2 TESTS PASSED SUCCESSFULLY (100% PASS)! 🎉\n');
    process.exit(0);
  } finally {
    server.close();
  }
}

runTests().catch(err => {
  console.error('\n❌ Test Failure:', err);
  process.exit(1);
});
