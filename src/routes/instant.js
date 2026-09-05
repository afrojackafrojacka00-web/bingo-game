'use strict';

const { moneyLimiter } = require('../middleware/rateLimiters');
const { requireAdmin } = require('../middleware/adminAuth');
const instant = require('../game/instant/engine');
const config = require('../config');
const pool = require('../db/pool');

function registerInstantRoutes(app) {
  app.get('/api/instant/status', async (req, res) => {
    try {
      const status = await instant.getStatus();
      res.json({ success: true, ...status });
    } catch (err) {
      console.error('instant status', err);
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  app.get('/api/instant/cards', async (req, res) => {
    try {
      if (!instant.enabled()) {
        return res.status(503).json({ success: false, message: 'Instant Bingo is disabled.' });
      }
      const cards = await instant.listCatalog(config.instantBingo?.catalogSize || 200);
      res.json({ success: true, cards });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  app.get('/api/instant/card/:num', async (req, res) => {
    try {
      const num = Number(req.params.num);
      const r = await pool.query('SELECT card_number, grid FROM bingo_cards WHERE card_number = $1', [num]);
      if (!r.rowCount) return res.status(404).json({ success: false, message: 'Card not found.' });
      res.json({ success: true, cardNumber: r.rows[0].card_number, grid: r.rows[0].grid });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  app.post('/api/instant/play', moneyLimiter, async (req, res) => {
    try {
      const { username, stake, cardNumbers } = req.body || {};
      if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
      const result = await instant.joinSharedRound({
        username: String(username),
        stake: Number(stake),
        cardNumbers: cardNumbers || [],
      });
      res.json(result);
    } catch (err) {
      const status = err.code === 'DISABLED' ? 503 : 400;
      res.status(status).json({ success: false, message: err.message || 'Could not join.' });
    }
  });

  app.post('/api/instant/join', moneyLimiter, async (req, res) => {
    try {
      const { username, stake, cardNumbers } = req.body || {};
      if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
      const result = await instant.joinSharedRound({
        username: String(username),
        stake: Number(stake),
        cardNumbers: cardNumbers || [],
      });
      res.json(result);
    } catch (err) {
      const status = err.code === 'DISABLED' ? 503 : 400;
      res.status(status).json({ success: false, message: err.message || 'Could not join.' });
    }
  });

  app.get('/api/instant/history', async (req, res) => {
    try {
      const username = String(req.query.username || '');
      if (!username) return res.status(400).json({ success: false, message: 'Username required.' });
      const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 30);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const history = await instant.historyForUser(username, limit, offset);
      for (const h of history) {
        try {
          const g = await pool.query('SELECT grid FROM bingo_cards WHERE card_number = $1', [h.cardNumber]);
          h.grid = g.rows[0]?.grid || null;
        } catch (_) {
          h.grid = null;
        }
      }
      res.json({ success: true, history, limit, offset, hasMore: history.length >= limit });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  app.get('/api/instant/leaderboard', async (req, res) => {
    try {
      const period = String(req.query.period || 'day');
      if (!['day', 'week', 'all'].includes(period)) {
        return res.status(400).json({ success: false, message: 'period must be day|week|all' });
      }
      const rows = await instant.getLeaderboard(period, 20);
      res.json({ success: true, period, leaders: rows });
    } catch (err) {
      console.error('instant leaderboard', err);
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  app.get('/api/instant/live', async (req, res) => {
    try {
      res.json({ success: true, state: instant.publicState(), live: instant.getLiveSession() });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  app.get('/api/admin/instant/status', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const status = await instant.getStatus();
      res.json({ success: true, ...status });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });
}

module.exports = { registerInstantRoutes };
