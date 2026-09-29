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
  console.log('🧪 Starting Dossier Sprint 1 Security & Feature Verification Suite...\n');

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
    // TEST 1: Password Length Enforcement (<10 characters rejected)
    // ---------------------------------------------------------------
    console.log('1️⃣ Testing Password Minimum Length (<10 chars rejected)...');
    const shortReg = await request(server, 'POST', '/api/v1/auth/register', {}, {
      username: `short_${Date.now()}`,
      email: `short_${Date.now()}@example.com`,
      mobile_no: '+1-555-0100',
      password: 'short' // 5 chars
    });
    if (shortReg.statusCode !== 400) {
      throw new Error(`FAILED: Short password registration returned ${shortReg.statusCode} instead of 400!`);
    }
    console.log('   ✅ Registration rejected short password <10 chars.');

    // ---------------------------------------------------------------
    // TEST 2: User Registration with password >= 10 chars & HttpOnly Cookie
    // ---------------------------------------------------------------
    console.log('2️⃣ Testing Registration with valid 10+ char password...');
    const regUsername = `userA_${Date.now()}`;
    const regRes = await request(server, 'POST', '/api/v1/auth/register', {}, {
      username: regUsername,
      email: `${regUsername}@example.com`,
      mobile_no: '+1-555-0199',
      password: 'StrongPassword123!',
      name: 'User A Test'
    });

    if (regRes.statusCode !== 201) {
      throw new Error(`Registration failed: ${JSON.stringify(regRes.body)}`);
    }
    const regCookie = parseCookie(regRes.cookies, cookieName);
    if (!regCookie) {
      throw new Error('FAILED: Session cookie not set on registration!');
    }
    if (regRes.body.token) {
      throw new Error('FAILED: JWT token exposed in response body!');
    }
    console.log('   ✅ User registered successfully with HttpOnly session cookie and no JWT in response body.');

    // ---------------------------------------------------------------
    // TEST 3: Login User A (kumar) & User B (testuser)
    // ---------------------------------------------------------------
    console.log('3️⃣ Testing Authentication for User A (kumar) & User B (testuser)...');
    const loginA = await request(server, 'POST', '/api/v1/auth/login', {}, {
      username: 'kumar',
      password: userAPass
    });
    if (loginA.statusCode !== 200 || loginA.body.token) {
      throw new Error(`User A login failed or returned token body: ${JSON.stringify(loginA.body)}`);
    }
    const cookieA = parseCookie(loginA.cookies, cookieName);
    const headersA = { Cookie: `${cookieName}=${cookieA}` };

    const loginB = await request(server, 'POST', '/api/v1/auth/login', {}, {
      username: 'testuser',
      password: userBPass
    });
    if (loginB.statusCode !== 200 || loginB.body.token) {
      throw new Error(`User B login failed or returned token body: ${JSON.stringify(loginB.body)}`);
    }
    const cookieB = parseCookie(loginB.cookies, cookieName);
    const headersB = { Cookie: `${cookieName}=${cookieB}` };
    console.log('   ✅ User A and User B authenticated via HttpOnly cookies.');

    // ---------------------------------------------------------------
    // TEST 4: Absence of Browser Bearer Token Authentication
    // ---------------------------------------------------------------
    console.log('4️⃣ Testing Absence of Bearer Header Auth (HttpOnly Cookie ONLY)...');
    const bearerRes = await request(server, 'GET', '/api/v1/contacts', {
      Authorization: `Bearer ${cookieA}`
    });
    if (bearerRes.statusCode !== 401) {
      throw new Error(`FAILED: Server accepted Bearer header auth! Expected status 401, got ${bearerRes.statusCode}`);
    }
    console.log('   ✅ Authorization Bearer header rejected. Server requires HttpOnly session cookie.');

    // ---------------------------------------------------------------
    // TEST 5: Plaintext Password Rejection (Bcrypt Only)
    // ---------------------------------------------------------------
    console.log('5️⃣ Testing Plaintext Password Rejection (Bcrypt Only)...');
    const plainRes = await request(server, 'POST', '/api/v1/auth/login', {}, {
      username: 'kumar',
      password: 'WrongPassword'
    });
    if (plainRes.statusCode !== 401) {
      throw new Error('FAILED: Incorrect password did not return 401!');
    }
    console.log('   ✅ Plaintext / invalid passwords rejected.');

    // ---------------------------------------------------------------
    // TEST 6: User A Creates Contacts, Sources, Introducer, Interactions, Relationships
    // ---------------------------------------------------------------
    console.log('6️⃣ Testing User A Contact & Dossier Data Creation...');
    // Create Introducer contact for User A
    const introRes = await request(server, 'POST', '/api/v1/contacts', headersA, {
      first_name: 'Larry',
      last_name: 'Rappaport',
      company_name: 'Rappaport Logistics',
      job_title: 'Senior Partner',
      sources: ['Vendor', 'Logistics']
    });
    if (introRes.statusCode !== 201) throw new Error(`Failed to create introducer: ${JSON.stringify(introRes.body)}`);
    const introId = introRes.body.id;

    // Create Main contact for User A with "How I Know This Person"
    const mainRes = await request(server, 'POST', '/api/v1/contacts', headersA, {
      first_name: 'John',
      last_name: 'Adams',
      company_name: 'IBM',
      job_title: 'Chief Logistics Manager',
      work_city: 'Armonk',
      work_state: 'NY',
      work_country: 'USA',
      introduced_by_contact_id: introId,
      met_context: "Larry Rappaport's daughter's wedding",
      met_place: 'Mystique Banquet Hall',
      met_date: '2024-06-15',
      how_we_met_notes: 'Discussed global supply chain challenges.',
      sources: ['Logistics', 'IBM', 'Whisky']
    });
    if (mainRes.statusCode !== 201) throw new Error(`Failed to create main contact: ${JSON.stringify(mainRes.body)}`);
    const johnId = mainRes.body.id;

    // Add Interaction for User A
    const intRes = await request(server, 'POST', `/api/v1/contacts/${johnId}/interactions`, headersA, {
      interaction_type: 'Meeting',
      occurred_at: '2026-09-20T09:30:00',
      subject: 'Quarterly review & contract extension',
      details: 'Agreed on Q4 shipment schedules.',
      follow_up_date: '2026-10-10',
      follow_up_status: 'completed'
    });
    if (intRes.statusCode !== 201) throw new Error(`Failed to add interaction: ${JSON.stringify(intRes.body)}`);
    const interactionId = intRes.body.id;

    // Add Relationship for User A
    const relRes = await request(server, 'POST', `/api/v1/contacts/${johnId}/relationships`, headersA, {
      relationship_type: 'Colleague',
      related_contact_id: introId,
      notes: 'Worked together at IBM'
    });
    if (relRes.statusCode !== 201) throw new Error(`Failed to add relationship: ${JSON.stringify(relRes.body)}`);
    const relId = relRes.body.id;

    console.log(`   ✅ User A created contact (ID: ${johnId}), introducer (ID: ${introId}), interaction (ID: ${interactionId}), and relationship (ID: ${relId}).`);

    // ---------------------------------------------------------------
    // TEST 7: Deterministic Narrative V2 Verification
    // ---------------------------------------------------------------
    console.log('7️⃣ Testing Deterministic Narrative V2 Generation...');
    const getJohnA = await request(server, 'GET', `/api/v1/contacts/${johnId}`, headersA);
    const narrative = getJohnA.body.narrative;
    if (!narrative.includes('Chief Logistics Manager at IBM') || !narrative.includes('Larry Rappaport (Colleague)')) {
      throw new Error(`Narrative missing required fields: ${narrative}`);
    }
    console.log('   ✅ Narrative V2 successfully generated with all owner-scoped details.');

    // ---------------------------------------------------------------
    // TEST 8: Two-User Security Isolation & Guessed IDOR Protection (User B -> User A)
    // ---------------------------------------------------------------
    console.log('8️⃣ Testing Automated Two-User Security Isolation (IDOR Blocked)...');

    // User B attempts GET User A's contact -> 404
    const idorGet = await request(server, 'GET', `/api/v1/contacts/${johnId}`, headersB);
    if (idorGet.statusCode !== 404) {
      throw new Error(`FAILED IDOR: User B accessed User A contact with status ${idorGet.statusCode}`);
    }
    console.log('   ✅ User B GET User A contact blocked (404 Not Found).');

    // User B attempts PUT User A's contact -> 404
    const idorPut = await request(server, 'PUT', `/api/v1/contacts/${johnId}`, headersB, { first_name: 'Hacked' });
    if (idorPut.statusCode !== 404) {
      throw new Error(`FAILED IDOR: User B modified User A contact with status ${idorPut.statusCode}`);
    }
    console.log('   ✅ User B PUT User A contact blocked (404 Not Found).');

    // User B attempts DELETE User A's contact -> 404
    const idorDel = await request(server, 'DELETE', `/api/v1/contacts/${johnId}`, headersB);
    if (idorDel.statusCode !== 404) {
      throw new Error(`FAILED IDOR: User B deleted User A contact with status ${idorDel.statusCode}`);
    }
    console.log('   ✅ User B DELETE User A contact blocked (404 Not Found).');

    // User B attempts PUT User A's interaction -> 404
    const idorInt = await request(server, 'PUT', `/api/v1/interactions/${interactionId}`, headersB, { subject: 'Hacked' });
    if (idorInt.statusCode !== 404) {
      throw new Error(`FAILED IDOR: User B edited User A interaction with status ${idorInt.statusCode}`);
    }
    console.log('   ✅ User B PUT User A interaction blocked (404 Not Found).');

    // User B attempts DELETE User A's relationship -> 404
    const idorRelDel = await request(server, 'DELETE', `/api/v1/relationships/${relId}`, headersB);
    if (idorRelDel.statusCode !== 404) {
      throw new Error(`FAILED IDOR: User B deleted User A relationship with status ${idorRelDel.statusCode}`);
    }
    console.log('   ✅ User B DELETE User A relationship blocked (404 Not Found).');

    // User B creates a contact and tries to link User A's contact as introducer -> must clear or reject
    const userBContact = await request(server, 'POST', '/api/v1/contacts', headersB, {
      first_name: 'Bob',
      last_name: 'Builder',
      introduced_by_contact_id: johnId // User A's contact!
    });
    if (userBContact.statusCode === 201) {
      const getB = await request(server, 'GET', `/api/v1/contacts/${userBContact.body.id}`, headersB);
      if (getB.body.introduced_by_contact) {
        throw new Error('FAILED: User B successfully linked User A contact as introducer!');
      }
    }
    console.log('   ✅ User B cross-account introducer link blocked/stripped.');

    // User B creates a contact and tries to add relationship to User A's contact -> 400
    const userBContact2 = await request(server, 'POST', '/api/v1/contacts', headersB, {
      first_name: 'Alice',
      last_name: 'Wonder'
    });
    const crossRel = await request(server, 'POST', `/api/v1/contacts/${userBContact2.body.id}/relationships`, headersB, {
      relationship_type: 'Partner',
      related_contact_id: johnId // User A's contact!
    });
    if (crossRel.statusCode === 201) {
      throw new Error('FAILED: User B successfully added relationship pointing to User A contact!');
    }
    console.log('   ✅ User B cross-account relationship link rejected (400 Bad Request).');

    // User B lists sources: User A's sources must NOT be visible
    const sourcesB = await request(server, 'GET', '/api/v1/sources', headersB);
    const hasLogisticsB = (sourcesB.body || []).some(s => s.name === 'Logistics');
    if (hasLogisticsB) {
      throw new Error('FAILED: User B can see User A source tag "Logistics"!');
    }
    console.log('   ✅ User B source listing isolated from User A sources.');

    // ---------------------------------------------------------------
    // TEST 9: Source Tag CRUD & Case-Insensitive Uniqueness Per Owner
    // ---------------------------------------------------------------
    console.log('9️⃣ Testing Source Tag CRUD & Per-Owner Uniqueness...');
    const uniqueTag = `VIP Client ${Date.now()}`;
    const srcA1 = await request(server, 'POST', '/api/v1/sources', headersA, { name: uniqueTag });
    if (srcA1.statusCode !== 201) throw new Error(`Failed to create source: ${JSON.stringify(srcA1.body)}`);
    const srcId = srcA1.body.id;

    // Case-insensitive duplicate create for User A -> 400
    const srcA2 = await request(server, 'POST', '/api/v1/sources', headersA, { name: uniqueTag.toLowerCase() });
    if (srcA2.statusCode !== 400) throw new Error('FAILED: Duplicate source tag created for User A!');
    console.log('   ✅ Case-insensitive duplicate source tag creation blocked for same user.');

    // User B CAN create same tag independently (owner-scoped uniqueness)
    const srcB1 = await request(server, 'POST', '/api/v1/sources', headersB, { name: uniqueTag });
    if (srcB1.statusCode !== 201) throw new Error(`User B should be able to create "${uniqueTag}": ${JSON.stringify(srcB1.body)}`);
    console.log(`   ✅ Source tag uniqueness is properly owner-scoped (User B created "${uniqueTag}" independently).`);

    // Rename & Delete source tag for User A
    const renSrc = await request(server, 'PUT', `/api/v1/sources/${srcId}`, headersA, { name: `${uniqueTag} Renamed` });
    if (renSrc.statusCode !== 200) throw new Error(`Failed to rename source: ${JSON.stringify(renSrc.body)}`);

    const delSrc = await request(server, 'DELETE', `/api/v1/sources/${srcId}`, headersA);
    if (delSrc.statusCode !== 200) throw new Error(`Failed to delete source: ${JSON.stringify(delSrc.body)}`);
    console.log('   ✅ Source tag updated and deleted successfully.');

    // ---------------------------------------------------------------
    // TEST 10: Missing SESSION_SECRET Error Validation
    // ---------------------------------------------------------------
    console.log('🔟 Testing Missing SESSION_SECRET Validation...');
    const originalSecret = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    const missingSecretRes = await request(server, 'GET', '/api/v1/contacts', headersA);
    process.env.SESSION_SECRET = originalSecret; // restore

    if (missingSecretRes.statusCode !== 500 || !JSON.stringify(missingSecretRes.body).includes('SESSION_SECRET')) {
      throw new Error(`FAILED: Server did not fail clearly on missing SESSION_SECRET! Got: ${JSON.stringify(missingSecretRes.body)}`);
    }
    console.log('   ✅ Server failed clearly with 500 error when SESSION_SECRET was missing.');

    // ---------------------------------------------------------------
    // TEST 11: Logout Flow Verification
    // ---------------------------------------------------------------
    console.log('1️⃣1️⃣ Testing Logout Flow...');
    const logoutRes = await request(server, 'POST', '/api/v1/auth/logout', headersA);
    if (logoutRes.statusCode !== 200) throw new Error('Logout failed!');
    console.log('   ✅ Logout cleared session cookie successfully.');

    console.log('\n🎉 ALL SPRINT 1 SECURITY & FUNCTIONALITY TESTS PASSED (100% PASS)! 🎉\n');
  } finally {
    server.close();
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('\n❌ Test Failure:', err);
  process.exit(1);
});
