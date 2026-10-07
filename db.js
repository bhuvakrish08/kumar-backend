const mysql = require('mysql2/promise');

let pool;

function getPool() {
  if (!pool) {
    const config = {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'kumarda_contacts',
      waitForConnections: true,
      connectionLimit: 10,
      maxIdle: 10,
      idleTimeout: 60000,
      queueLimit: 0,
      charset: 'utf8mb4',
      timezone: 'Z'
    };

    if (process.env.DB_SSL === 'true') {
      config.ssl = {
        rejectUnauthorized: false
      };
    }

    pool = mysql.createPool(config);
  }
  return pool;
}

module.exports = { getPool };
