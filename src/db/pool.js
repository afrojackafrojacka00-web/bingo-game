'use strict';

const { Pool } = require('pg');
const config = require('../config');

/** Shared PostgreSQL pool — import this everywhere instead of creating new pools. */
const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: config.pgPoolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected idle client error on pool', err);
});

module.exports = pool;
