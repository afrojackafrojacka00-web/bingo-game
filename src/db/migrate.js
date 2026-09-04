'use strict';

/**
 * Lightweight migration runner.
 * Currently runs the same idempotent schema init used at boot
 * (CREATE TABLE IF NOT EXISTS / ALTER ADD COLUMN IF NOT EXISTS).
 *
 * For future ordered SQL migrations, drop .sql files in src/db/migrations/
 * named 001_....sql, 002_....sql and extend this runner to apply them
 * once, tracking applied versions in a schema_migrations table.
 */

const pool = require('./pool');
const { initDB } = require('./init');
const fs = require('fs');
const path = require('path');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

async function runSqlMigrations() {
  const dir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const exists = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1',
      [file]
    );
    if (exists.rowCount) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);
      await client.query('COMMIT');
      console.log('Applied migration', file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

async function migrate() {
  await initDB();
  await ensureMigrationsTable();
  await runSqlMigrations();
  console.log('Migrations complete.');
}

if (require.main === module) {
  migrate()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { migrate };
