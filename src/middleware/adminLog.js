'use strict';

const pool = require('../db/pool');

async function ensureAdminActionLogSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_action_logs (
      id SERIAL PRIMARY KEY,
      actor_username VARCHAR(50) NOT NULL,
      actor_role VARCHAR(20) NOT NULL,
      action VARCHAR(80) NOT NULL,
      entity_type VARCHAR(50),
      entity_id VARCHAR(50),
      summary TEXT,
      meta JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_action_logs_created ON admin_action_logs(created_at DESC);`);
}

async function logAdminAction(admin, action, opts = {}) {
  try {
    if (!admin || !action) return;
    await ensureAdminActionLogSchema();
    await pool.query(
      `INSERT INTO admin_action_logs (actor_username, actor_role, action, entity_type, entity_id, summary, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        admin.username || 'unknown',
        admin.role || 'unknown',
        String(action).slice(0, 80),
        opts.entityType ? String(opts.entityType).slice(0, 50) : null,
        opts.entityId != null ? String(opts.entityId).slice(0, 50) : null,
        opts.summary ? String(opts.summary).slice(0, 500) : null,
        opts.meta ? JSON.stringify(opts.meta) : null,
      ]
    );
  } catch (e) {
    console.error('logAdminAction', e.message);
  }
}

module.exports = { logAdminAction, ensureAdminActionLogSchema };
