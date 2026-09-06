'use strict';

const { requireAdmin } = require('../middleware/adminAuth');
const { moneyLimiter, gameActionLimiter } = require('../middleware/rateLimiters');
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

  app.post('/api/special/join', moneyLimiter, gameActionLimiter, async (req, res) => {
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

  app.get('/api/special/history', async (req, res) => {
    try {
      const username = String(req.query.username || '').trim();
      if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
      const limit = Number(req.query.limit) || 20;
      const offset = Number(req.query.offset) || 0;
      const rows = await special.historyForUser(username, limit, offset);
      res.json({ success: true, rows, hasMore: rows.length >= limit });
    } catch (err) {
      console.error('special user history', err);
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  app.post('/api/special/claim', gameActionLimiter, async (req, res) => {
    try {
      const username = String(req.body?.username || '').trim();
      const cardNumber = Number(req.body?.cardNumber);
      if (!username || !cardNumber) return res.status(400).json({ success: false, message: 'Invalid claim.' });
      const result = await special.claimWin({ username, cardNumber });
      res.json(result);
    } catch (err) {
      res.status(400).json({
        success: false,
        message: err.message || 'Claim failed.',
        locked: !!err.locked,
      });
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
      const limit = Math.min(Number(req.query.limit) || 50, 300);
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

  // Player-facing session detail (winning card)
  app.get('/api/special/session/:id', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const s = await pool.query(
        `SELECT id, status, stake, prize, player_count, card_count, total_paid, house_profit, winners, winning_pattern, completed_at, started_at
         FROM special_event_sessions WHERE id=$1`,
        [id]
      );
      if (!s.rowCount) return res.status(404).json({ success: false, message: 'Not found' });
      res.json({ success: true, session: s.rows[0] });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });
}


  // ---- Special notify image management (local public/uploads) ----
  const fs = require('fs');
  const path = require('path');
  const multer = require('multer');
  const uploadsDir = path.join(require('../config').publicDir, 'uploads');
  try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch (_) {}

  const specialUpload = multer({
    storage: multer.diskStorage({
      destination: function (_req, _file, cb) { cb(null, uploadsDir); },
      filename: function (_req, file, cb) {
        const safe = String(file.originalname || 'special.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, safe.toLowerCase().endsWith('.jpg') || safe.toLowerCase().endsWith('.jpeg') || safe.toLowerCase().endsWith('.png') || safe.toLowerCase().endsWith('.webp')
          ? safe
          : (safe + '.jpg'));
      }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: function (_req, file, cb) {
      if (/^image\//.test(file.mimetype)) cb(null, true);
      else cb(new Error('Images only'));
    }
  });

  app.get('/api/admin/special/uploads', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const files = fs.readdirSync(uploadsDir)
        .filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(uploadsDir, f));
          return { name: f, url: '/uploads/' + f, size: st.size, mtime: st.mtime };
        })
        .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
      res.json({ success: true, files });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/admin/special/uploads', (req, res) => {
    if (!requireAdmin(req, res)) return;
    specialUpload.single('image')(req, res, async (err) => {
      if (err) return res.status(400).json({ success: false, message: err.message });
      if (!req.file) return res.status(400).json({ success: false, message: 'No file' });
      const url = '/uploads/' + req.file.filename;
      // optional: set as active notify image
      if (req.body && (req.body.setActive === '1' || req.body.setActive === true || req.body.setActive === 'true')) {
        try {
          await special.adminUpdate({ notifyImage: url });
        } catch (_) {}
      }
      res.json({ success: true, url, name: req.file.filename });
    });
  });

  app.delete('/api/admin/special/uploads/:name', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const name = path.basename(String(req.params.name || ''));
      if (!name || name.startsWith('.')) return res.status(400).json({ success: false, message: 'Invalid name' });
      const fp = path.join(uploadsDir, name);
      if (!fp.startsWith(uploadsDir)) return res.status(400).json({ success: false, message: 'Invalid path' });
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  app.post('/api/admin/special/notify-test', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const kind = req.body && req.body.kind === 'joining' ? 'joining' : 'countdown';
      // force by clearing dedupe key via temporary override
      const result = await special.notifySpecialEvent(kind, { force: true });
      res.json({ success: true, result });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });


module.exports = { registerSpecialRoutes };
