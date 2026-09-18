require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool } = require('./db');

async function initDatabase() {
  console.log('🔄 Initializing database schema from migrations/init_schema.sql...');
  try {
    const sqlPath = path.join(__dirname, 'migrations', 'init_schema.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');

    const pool = getPool();
    const statements = sqlContent
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const statement of statements) {
      await pool.query(statement);
    }

    console.log('✅ Database schema and seed data initialized successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to initialize database schema:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  initDatabase();
}

module.exports = { initDatabase };
