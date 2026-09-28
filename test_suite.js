const http = require('http');
const express = require('express');
const { getPool } = require('./db');
const bcrypt = require('bcryptjs');

// We will launch a test runner against the actual express app logic
const app = express();
const cors = require('cors');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/authRoutes');
const contactRoutes = require('./routes/contactRoutes');
const sourceRoutes = require('./routes/sourceRoutes');
const relationshipRoutes = require('./routes/relationshipRoutes');
const interactionRoutes = require('./routes/interactionRoutes');

app.use(express.json());
app.use(cookieParser());
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/contacts', contactRoutes);
app.use('/api/v1/sources', sourceRoutes);
app.use('/api/v1/relationships', relationshipRoutes);
app.use('/api/v1/interactions', interactionRoutes);

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
  for (const c of cookieArray) {
    const parts = c.split(';')[0].split('=');
    if (parts[0].trim() === name) {
      return parts.slice(1).join('=');
    }
  }
  return null;
}

async function runTests() {
  console.log('🧪 Starting Dossier Security & Feature Test Suite...\n');
  const pool = getPool();

  // Ensure test users exist with known bcrypt password 'password123'
  const hash = await bcrypt.hash('password123', 10);
  await pool.query(
    'INSERT INTO users (id, username, password, email) VALUES (2, "kumar", ?, "kumar@example.com") ON DUPLICATE KEY UPDATE password = ?',
    [hash, hash]
  );
  await pool.query(
    'INSERT INTO users (id, username, password, email) VALUES (3, "testuser", ?, "testuser@example.com") ON DUPLICATE KEY UPDATE password = ?',
    [hash, hash]
  );

  const server = app.listen(0);
  const cookieName = 'kumarda_session';

  try {
    // ---------------------------------------------------------------
    // TEST 0: User Registration with username, email, mobile_no, password
    // ---------------------------------------------------------------
    console.log('0️⃣ Testing User Registration with username, email, mobile_no & password...');
    const regUsername = `reguser_${Date.now()}`;
    const regRes = await request(server, 'POST', '/api/v1/auth/register', {}, {
      username: regUsername,
      email: `${regUsername}@example.com`,
      mobile_no: '+1-555-0199',
      password: 'password123',
      name: 'Registration Test User'
    });

    if (regRes.statusCode !== 201) {
      throw new Error(`Registration failed with status ${regRes.statusCode}: ${JSON.stringify(regRes.body)}`);
    }
    const regCookie = parseCookie(regRes.cookies, cookieName);
    if (!regCookie) {
      throw new Error(`FAILED: ${cookieName} cookie not set on registration response!`);
    }
    if (!regRes.body.user || regRes.body.user.username !== regUsername) {
      throw new Error(`FAILED: Registration returned invalid user object: ${JSON.stringify(regRes.body)}`);
    }
    console.log(`   ✅ User ${regUsername} registered successfully, issued HttpOnly cookie & user object.\n`);

    // ---------------------------------------------------------------
    // TEST 1: Login kumar & verify secure HttpOnly cookie (no JWT in JSON)
    // ---------------------------------------------------------------
    console.log('1️⃣ Testing Secure Login for User kumar...');
    const loginRes = await request(server, 'POST', '/api/v1/auth/login', {}, {
      username: 'kumar',
      password: 'password123'
    });

    if (loginRes.statusCode !== 200) {
      throw new Error(`Login failed with status ${loginRes.statusCode}: ${JSON.stringify(loginRes.body)}`);
    }
    if (loginRes.body.token) {
      throw new Error('FAILED: JWT token was returned in JSON response! It must only be in HttpOnly cookie.');
    }
    const sessionCookie = parseCookie(loginRes.cookies, cookieName);
    if (!sessionCookie) {
      throw new Error(`FAILED: ${cookieName} cookie not set on response!`);
    }
    const rawSetCookie = loginRes.cookies.find(c => c.startsWith(`${cookieName}=`));
    if (!rawSetCookie.toLowerCase().includes('httponly')) {
      throw new Error('FAILED: Cookie is missing HttpOnly flag!');
    }
    console.log('   ✅ User kumar logged in successfully with HttpOnly cookie (no JWT in body).\n');

    const authHeadersKumar = {
      Cookie: `${cookieName}=${sessionCookie}`
    };

    // ---------------------------------------------------------------
    // TEST 2: Create Contact with "How I Know This Person" & SOURCE tags
    // ---------------------------------------------------------------
    console.log('2️⃣ Testing Contact Creation with "How I Know This Person" & Sources...');
    // Create first contact to act as introducer
    const c1Res = await request(server, 'POST', '/api/v1/contacts', authHeadersKumar, {
      first_name: 'Larry',
      last_name: 'Rappaport',
      company_name: 'Rappaport Logistics',
      job_title: 'Senior Partner',
      sources: ['Vendor', 'Logistics', 'Friend']
    });
    if (c1Res.statusCode !== 201) {
      throw new Error(`Failed to create introducer contact: ${JSON.stringify(c1Res.body)}`);
    }
    const introducerId = c1Res.body.id;
    console.log(`   ✅ Created contact Larry Rappaport (ID: ${introducerId}).`);

    // Create second contact linked to Larry with duplicate sources to test deduplication
    const c2Res = await request(server, 'POST', '/api/v1/contacts', authHeadersKumar, {
      first_name: 'John',
      last_name: 'Adams',
      company_name: 'IBM',
      job_title: 'Chief Logistics Manager',
      work_city: 'Armonk',
      work_state: 'NY',
      work_country: 'USA',
      introduced_by_contact_id: introducerId,
      met_context: "Larry Rappaport's daughter's wedding",
      met_place: 'Mystique Banquet Hall',
      met_date: '2024-06-15',
      how_we_met_notes: 'Discussed global supply chain challenges over dinner table 4.',
      sources: ['Logistics', 'logistics', '  Logistics  ', 'Whisky', 'IBM', ''] // test deduplication & empty filtering
    });

    if (c2Res.statusCode !== 201) {
      throw new Error(`Failed to create contact John Adams: ${JSON.stringify(c2Res.body)}`);
    }
    const johnId = c2Res.body.id;
    console.log(`   ✅ Created contact John Adams (ID: ${johnId}) with linked introducer Larry Rappaport.`);

    // Verify John Adams details & deduplicated sources
    const getJohn = await request(server, 'GET', `/api/v1/contacts/${johnId}`, authHeadersKumar);
    if (getJohn.statusCode !== 200) {
      throw new Error(`Failed to fetch John Adams: ${JSON.stringify(getJohn.body)}`);
    }
    const sources = getJohn.body.sources;
    const sourceNames = sources.map(s => s.name.toLowerCase());
    if (sourceNames.filter(s => s === 'logistics').length !== 1) {
      throw new Error(`FAILED: Duplicate source 'Logistics' found in: ${JSON.stringify(sources)}`);
    }
    if (sourceNames.includes('')) {
      throw new Error('FAILED: Empty source was saved!');
    }
    console.log('   ✅ Sources properly deduplicated without duplicates or empty tags:', sources.map(s => s.name));

    // Check linked introducer
    if (!getJohn.body.introduced_by_contact || getJohn.body.introduced_by_contact.id !== introducerId) {
      throw new Error(`FAILED: Introducer contact not properly linked: ${JSON.stringify(getJohn.body.introduced_by_contact)}`);
    }
    console.log(`   ✅ Introducer properly linked: ${getJohn.body.introduced_by_contact.first_name} ${getJohn.body.introduced_by_contact.last_name}`);

    // ---------------------------------------------------------------
    // TEST 3: Interactions Timeline with Edit & Follow-up
    // ---------------------------------------------------------------
    console.log('\n3️⃣ Testing Interaction Timeline, Editing, and Follow-up...');
    const addIntRes = await request(server, 'POST', `/api/v1/contacts/${johnId}/interactions`, authHeadersKumar, {
      interaction_type: 'Call',
      occurred_at: '2026-09-20T14:30:00',
      subject: 'Quarterly review discussion',
      details: 'Agreed on Q4 shipment schedules.',
      follow_up_date: '2026-10-05',
      follow_up_status: 'pending'
    });
    if (addIntRes.statusCode !== 201) {
      throw new Error(`Failed to add interaction: ${JSON.stringify(addIntRes.body)}`);
    }
    const interactionId = addIntRes.body.id;
    console.log(`   ✅ Added interaction (ID: ${interactionId}) with pending follow-up for 2026-10-05.`);

    // Test Editing Interaction
    const editIntRes = await request(server, 'PUT', `/api/v1/interactions/${interactionId}`, authHeadersKumar, {
      interaction_type: 'Meeting',
      occurred_at: '2026-09-20T15:00:00',
      subject: 'Quarterly review & contract extension',
      details: 'Agreed on Q4 shipment schedules and signed addendum.',
      follow_up_date: '2026-10-10',
      follow_up_status: 'completed'
    });
    if (editIntRes.statusCode !== 200) {
      throw new Error(`Failed to edit interaction: ${JSON.stringify(editIntRes.body)}`);
    }
    console.log('   ✅ Interaction successfully edited via PUT /api/v1/interactions/:id.');

    // ---------------------------------------------------------------
    // TEST 4: Relationships between contacts of the same user
    // ---------------------------------------------------------------
    console.log('\n4️⃣ Testing Relationships between same-user contacts...');
    const relRes = await request(server, 'POST', `/api/v1/contacts/${johnId}/relationships`, authHeadersKumar, {
      relationship_type: 'Colleague',
      related_contact_id: introducerId,
      notes: 'Worked together at IBM prior to 2020'
    });
    if (relRes.statusCode !== 201) {
      throw new Error(`Failed to add relationship: ${JSON.stringify(relRes.body)}`);
    }
    console.log('   ✅ Connected John Adams and Larry Rappaport as Colleagues.');

    // ---------------------------------------------------------------
    // TEST 5: Verify Narrative Summary incorporates all elements deterministically
    // ---------------------------------------------------------------
    console.log('\n5️⃣ Testing Deterministic Narrative Engine Summary...');
    const getJohnUpdated = await request(server, 'GET', `/api/v1/contacts/${johnId}`, authHeadersKumar);
    const narrative = getJohnUpdated.body.narrative;
    console.log(`   📝 Generated narrative:\n   "${narrative}"\n`);

    if (!narrative.includes('Chief Logistics Manager at IBM')) {
      throw new Error('Narrative missing job title / company!');
    }
    if (!narrative.includes('Mystique Banquet Hall')) {
      throw new Error('Narrative missing meeting place!');
    }
    if (!narrative.includes('SOURCE tag')) {
      throw new Error('Narrative missing SOURCE tags!');
    }
    if (!narrative.includes('Larry Rappaport (Colleague)')) {
      throw new Error('Narrative missing relationship information!');
    }
    if (!narrative.includes('meeting regarding "Quarterly review & contract extension"')) {
      throw new Error('Narrative missing interaction details!');
    }
    console.log('   ✅ Narrative summary successfully integrates contact info, meeting context, sources, relationships, and interactions!');

    // ---------------------------------------------------------------
    // TEST 6: User Isolation & IDOR Protection with User 3 (testuser)
    // ---------------------------------------------------------------
    console.log('\n6️⃣ Testing Multi-tenancy & IDOR Protection for User testuser...');
    const testUserLogin = await request(server, 'POST', '/api/v1/auth/login', {}, {
      username: 'testuser',
      password: 'password123'
    });
    const testUserCookie = parseCookie(testUserLogin.cookies, cookieName);
    const authHeadersTestUser = {
      Cookie: `${cookieName}=${testUserCookie}`
    };

    // testuser lists contacts: should be empty!
    const testUserList = await request(server, 'GET', '/api/v1/contacts', authHeadersTestUser);
    if (testUserList.body.length !== 0) {
      throw new Error(`FAILED: testuser sees ${testUserList.body.length} contacts! Expected 0.`);
    }
    console.log('   ✅ testuser contact list is completely empty (User A cannot see User B contacts).');

    // testuser tries to access John Adams (ID: johnId): MUST return 404
    const idorGet = await request(server, 'GET', `/api/v1/contacts/${johnId}`, authHeadersTestUser);
    if (idorGet.statusCode !== 404) {
      throw new Error(`FAILED IDOR: testuser accessed kumar's contact with status ${idorGet.statusCode}!`);
    }
    console.log('   ✅ IDOR GET blocked: changing ID in URL returns 404.');

    // testuser tries to update John Adams: MUST return 404
    const idorPut = await request(server, 'PUT', `/api/v1/contacts/${johnId}`, authHeadersTestUser, {
      first_name: 'Hacked'
    });
    if (idorPut.statusCode !== 404) {
      throw new Error(`FAILED IDOR: testuser updated kumar's contact with status ${idorPut.statusCode}!`);
    }
    console.log('   ✅ IDOR PUT blocked: updating another user contact returns 404.');

    // testuser tries to delete John Adams: MUST return 404
    const idorDel = await request(server, 'DELETE', `/api/v1/contacts/${johnId}`, authHeadersTestUser);
    if (idorDel.statusCode !== 404) {
      throw new Error(`FAILED IDOR: testuser deleted kumar's contact with status ${idorDel.statusCode}!`);
    }
    console.log('   ✅ IDOR DELETE blocked: deleting another user contact returns 404.');

    // testuser tries to edit kumar's interaction: MUST return 404
    const idorInt = await request(server, 'PUT', `/api/v1/interactions/${interactionId}`, authHeadersTestUser, {
      subject: 'Hacked interaction'
    });
    if (idorInt.statusCode !== 404) {
      throw new Error(`FAILED IDOR: testuser edited kumar's interaction!`);
    }
    console.log('   ✅ IDOR interaction edit blocked: returns 404.');

    // testuser creates their own contact and tries to connect it to kumar's contact: MUST fail!
    const testUserContact = await request(server, 'POST', '/api/v1/contacts', authHeadersTestUser, {
      first_name: 'Alice',
      last_name: 'Smith'
    });
    const aliceId = testUserContact.body.id;

    const crossRel = await request(server, 'POST', `/api/v1/contacts/${aliceId}/relationships`, authHeadersTestUser, {
      relationship_type: 'Colleague',
      related_contact_id: johnId // belongs to kumar!
    });
    if (crossRel.statusCode === 201) {
      throw new Error('FAILED: testuser was able to link to kumar\'s contact in relationship!');
    }
    console.log(`   ✅ Cross-user relationship linking rejected with status ${crossRel.statusCode}: ${crossRel.body.error}`);

    // testuser sources: verify testuser has 0 sources despite kumar having sources
    const testUserSources = await request(server, 'GET', '/api/v1/sources', authHeadersTestUser);
    if (testUserSources.body.length !== 0) {
      throw new Error(`FAILED: testuser sees ${testUserSources.body.length} sources! Expected 0.`);
    }
    console.log('   ✅ testuser has 0 sources (User A sources completely isolated from User B).');

    // ---------------------------------------------------------------
    // TEST 8: Source Management Module (Create, Rename, Delete)
    // ---------------------------------------------------------------
    console.log('\n8️⃣ Testing Source Tag CRUD (Create, Rename, Delete)...');
    
    // Create new source tag
    const createSrc = await request(server, 'POST', '/api/v1/sources', authHeadersKumar, { name: 'VIP Investor' });
    if (createSrc.statusCode !== 201) {
      throw new Error(`FAILED to create source tag: ${JSON.stringify(createSrc.body)}`);
    }
    const newSrcId = createSrc.body.id;
    console.log(`   ✅ Source tag created (ID: ${newSrcId}, Name: "${createSrc.body.name}")`);

    // Duplicate create should fail
    const dupSrc = await request(server, 'POST', '/api/v1/sources', authHeadersKumar, { name: 'vip investor' });
    if (dupSrc.statusCode !== 400) {
      throw new Error(`FAILED: Duplicate source creation returned ${dupSrc.statusCode} instead of 400`);
    }
    console.log(`   ✅ Duplicate source creation blocked: ${dupSrc.body.error}`);

    // Update source name
    const updateSrc = await request(server, 'PUT', `/api/v1/sources/${newSrcId}`, authHeadersKumar, { name: 'Strategic Partner' });
    if (updateSrc.statusCode !== 200 || updateSrc.body.name !== 'Strategic Partner') {
      throw new Error(`FAILED to update source name: ${JSON.stringify(updateSrc.body)}`);
    }
    console.log(`   ✅ Source tag renamed to "${updateSrc.body.name}"`);

    // Delete source tag
    const delSrc = await request(server, 'DELETE', `/api/v1/sources/${newSrcId}`, authHeadersKumar);
    if (delSrc.statusCode !== 200) {
      throw new Error(`FAILED to delete source tag: ${JSON.stringify(delSrc.body)}`);
    }
    console.log(`   ✅ Source tag deleted successfully.`);

    console.log('\n🎉 ALL SECURITY & FUNCTIONALITY TESTS PASSED SUCCESSFULLY! 🎉\n');
  } finally {
    server.close();
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('\n❌ Test Failed:', err);
  process.exit(1);
});
