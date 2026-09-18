require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool } = require('./db');

async function seedDatabase() {
  console.log('🌱 Populating database seed data from migrations/seed_data.sql...');
  try {
    const sqlPath = path.join(__dirname, 'migrations', 'seed_data.sql');
    const sqlContent = fs.readFileSync(sqlPath, 'utf8');

    const pool = getPool();
    const statements = sqlContent
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0);

    for (const statement of statements) {
      await pool.query(statement);
    }

    console.log('✅ Database seeded with contacts, sources, interactions, and relationships successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Failed to seed database:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  seedDatabase();
}

module.exports = { seedDatabase };
