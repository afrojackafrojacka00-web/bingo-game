'use strict';

const { Pool } = require('pg');
const config = require('../config');

/**
 * Shared PostgreSQL pool — one pool for Classic + Instant + Special.
 * Tune with env: PG_POOL_MAX, PG_POOL_IDLE_MS, PG_POOL_CONN_TIMEOUT_MS, PG_STATEMENT_TIMEOUT_MS
 */
const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: Math.max(10, Number(config.pgPoolMax) || 40),
  idleTimeoutMillis: Number(config.pgPoolIdleMs) || 30000,
  connectionTimeoutMillis: Number(config.pgPoolConnectionTimeoutMs) || 5000,
  allowExitOnIdle: false,
  application_name: 'bingo-game',
});

// Per-connection statement timeout so one slow query cannot pin a client forever
const stmtMs = Math.max(0, Number(config.pgStatementTimeoutMs) || 15000);
if (stmtMs > 0) {
  pool.on('connect', (client) => {
    client.query(`SET statement_timeout = ${stmtMs}`).catch(() => {});
  });
}

pool.on('error', (err) => {
  console.error('Unexpected idle client error on pool', err);
});

module.exports = pool;
