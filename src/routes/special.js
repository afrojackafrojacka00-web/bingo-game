'use strict';

const { requireAdmin } = require('../middleware/adminAuth');
const special = require('../game/special/engine');
const pool = require('../db/pool');

function registerSpecialRoutes(app) {
  app.get('/api/special/status', async (req, res) => {
    try {
      res.json({ success: true, ...special.publicState() });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  app.get('/api/special/cards', async (req, res) => {
    try {
      const st = special.publicState();
      if (!st.canJoin) {
        return res.status(403).json({ success: false, message: st.lateMessage || 'Not open.', state: st });
      }
      const r = await pool.query(`SELECT card_number FROM bingo_cards ORDER BY card_number ASC LIMIT 5000`);
      res.json({ success: true, cards: r.rows.map((row) => Number(row.card_number)), state: st });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  app.post('/api/special/join', async (req, res) => {
    try {
      const username = String(req.body?.username || '').trim();
      const cardNumbers = req.body?.cardNumbers || [];
      if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
      const result = await special.joinWithCards({ username, cardNumbers });
      res.json(result);
    } catch (err) {
      const code = err.code === 'CLOSED' ? 403 : 400;
      res.status(code).json({ success: false, message: err.message || 'Failed.', state: special.publicState() });
    }
  });

  app.post('/api/special/claim', async (req, res) => {
    try {
      const username = String(req.body?.username || '').trim();
      const cardNumber = Number(req.body?.cardNumber);
      if (!username || !cardNumber) return res.status(400).json({ success: false, message: 'Invalid claim.' });
      const result = await special.claimWin({ username, cardNumber });
      res.json(result);
    } catch (err) {
      res.status(400).json({ success: false, message: err.message || 'Claim failed.' });
    }
  });

  app.get('/api/special/card/:num', async (req, res) => {
    try {
      const grid = await special.getCardGrid(Number(req.params.num));
      if (!grid) return res.status(404).json({ success: false, message: 'Not found' });
      res.json({ success: true, cardNumber: Number(req.params.num), grid });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  // Admin
  app.get('/api/admin/special', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, ...(await special.adminGet()) });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  app.post('/api/admin/special', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const data = await special.adminUpdate(req.body || {});
      res.json({ success: true, ...data });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message || 'Failed.' });
    }
  });

  app.get('/api/admin/special/history', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 100);
      const from = req.query.from ? String(req.query.from) : null;
      const to = req.query.to ? String(req.query.to) : null;
      const params = [];
      let where = 'WHERE 1=1';
      if (from) { params.push(from); where += ` AND COALESCE(completed_at, started_at, created_at) >= $${params.length}::date`; }
      if (to) { params.push(to); where += ` AND COALESCE(completed_at, started_at, created_at) < ($${params.length}::date + INTERVAL '1 day')`; }
      params.push(limit);
      const r = await pool.query(
        `SELECT id, status, stake, prize, player_count, card_count, total_paid, house_profit, winners, created_at, started_at, completed_at
         FROM special_event_sessions ${where}
         ORDER BY id DESC LIMIT $${params.length}`,
        params
      );
      res.json({ success: true, rows: r.rows });
    } catch (err) {
      console.error('special history', err);
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  app.get('/api/admin/special/session/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const id = Number(req.params.id);
      const s = await pool.query(`SELECT * FROM special_event_sessions WHERE id=$1`, [id]);
      if (!s.rowCount) return res.status(404).json({ success: false, message: 'Not found' });
      const e = await pool.query(
        `SELECT id, username, cards, card_count, amount_paid, created_at FROM special_event_entries WHERE session_id=$1 ORDER BY id ASC`,
        [id]
      );
      res.json({ success: true, session: s.rows[0], entries: e.rows });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });
}

module.exports = { registerSpecialRoutes };
