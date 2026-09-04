'use strict';

/**
 * Instant Bingo HTTP API — registered only when the module is loaded.
 * Unregister / delete this file + game/instant to remove the product.
 */

const { moneyLimiter } = require('../middleware/rateLimiters');
const { requireAdmin } = require('../middleware/adminAuth');
const instant = require('../game/instant/engine');
const config = require('../config');

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
      const cards = await instant.listCatalog(
        config.instantBingo?.catalogSize || 200
      );
      res.json({ success: true, cards });
    } catch (err) {
      console.error('instant cards', err);
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  app.post('/api/instant/join', moneyLimiter, async (req, res) => {
    try {
      const { username, stake, cardNumbers } = req.body || {};
      if (!username) {
        return res.status(400).json({ success: false, message: 'Username required.' });
      }
      const result = await instant.joinRound({
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
      if (!username) {
        return res.status(400).json({ success: false, message: 'Username required.' });
      }
      const history = await instant.historyForUser(username, 30);
      res.json({ success: true, history });
    } catch (err) {
      console.error('instant history', err);
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });

  /** Admin: force-settle a stake’s open round (same 20 numbers for everyone in it). */
  app.post('/api/admin/instant/settle', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const stake = Number(req.body?.stake);
      const payload = await instant.settleRound(stake);
      res.json({ success: true, result: payload });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message || 'Settle failed.' });
    }
  });

  app.get('/api/admin/instant/status', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
      const status = await instant.getStatus();
      res.json({ success: true, ...status, configEnabled: config.instantBingo?.enabled });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Server error.' });
    }
  });
}

module.exports = { registerInstantRoutes };
