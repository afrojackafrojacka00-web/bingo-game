'use strict';

/**
 * Instant Bingo — solo play sessions (isolated from classic bingo).
 * Shared wallet only (same users.balance + transactions).
 *
 * Flow:
 *  1) Player picks ≤4 cards + stake
 *  2) POST /api/instant/play → charge balance, draw 20 numbers, evaluate, pay wins
 *  3) Client animates 1 number/sec with highlights (numbers already decided server-side)
 */

const pool = require('../../db/pool');
const config = require('../../config');
const { evaluateCard, drawNumbers } = require('./patterns');

const cfg = () => config.instantBingo || {};

let ioNamespace = null;

/** Fake “players online” — gradual walk between 200–400 */
let fakePlayers = 260 + Math.floor(Math.random() * 40);

function enabled() {
  return cfg().enabled !== false;
}

function stakes() {
  return cfg().stakes || config.stakes || [10, 20, 50, 100, 200, 500];
}

function tickFakePlayers() {
  const min = 200;
  const max = 400;
  const step = Math.floor(Math.random() * 21) - 8; // -8 .. +12, slight upward bias
  fakePlayers = Math.max(min, Math.min(max, fakePlayers + step));
  return fakePlayers;
}

setInterval(() => {
  tickFakePlayers();
  if (ioNamespace) {
    ioNamespace.emit('instant_players', { playing: fakePlayers });
  }
}, 8000);

async function ensureSchema() {
  const steps = [
    `CREATE TABLE IF NOT EXISTS instant_rounds (
      id SERIAL PRIMARY KEY,
      stake NUMERIC(10,2) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
      drawn_numbers INT[] DEFAULT '{}',
      deadline TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      drawn_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS instant_entries (
      id SERIAL PRIMARY KEY,
      round_id INT REFERENCES instant_rounds(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id),
      username VARCHAR(50) NOT NULL,
      card_number INT NOT NULL,
      stake NUMERIC(10,2) NOT NULL,
      paid NUMERIC(10,2) NOT NULL,
      pattern VARCHAR(40),
      multiplier NUMERIC(6,2) DEFAULT 0,
      prize NUMERIC(10,2) DEFAULT 0,
      winning_cells JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `ALTER TABLE instant_entries ALTER COLUMN round_id DROP NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_instant_entries_round ON instant_entries(round_id)`,
    `CREATE INDEX IF NOT EXISTS idx_instant_entries_user ON instant_entries(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_instant_rounds_status ON instant_rounds(status, stake)`,
  ];
  for (const sql of steps) {
    try {
      await pool.query(sql);
    } catch (err) {
      if (err && (err.code === '23505' || err.code === '42P07' || /already exists/i.test(String(err.message)))) {
        continue;
      }
      // DROP NOT NULL may fail on fresh table without NOT NULL — ignore
      if (err && err.code === '42804') continue;
      console.error('instant schema step', err.message);
    }
  }
}

async function getCardGrid(cardNumber) {
  const r = await pool.query(
    'SELECT grid FROM bingo_cards WHERE card_number = $1',
    [cardNumber]
  );
  return r.rows[0]?.grid || null;
}

async function listCatalog(limit) {
  const size = limit || cfg().catalogSize || 200;
  const r = await pool.query(
    `SELECT card_number FROM bingo_cards ORDER BY card_number ASC LIMIT $1`,
    [size]
  );
  return r.rows.map((row) => Number(row.card_number));
}

/**
 * Solo play: charge stake×cards, draw 20 numbers, evaluate, credit wins.
 * Same card numbers allowed for different players (no exclusivity).
 */
async function startPlay({ username, stake, cardNumbers }) {
  if (!enabled()) {
    const err = new Error('Instant Bingo is temporarily unavailable.');
    err.code = 'DISABLED';
    throw err;
  }

  const maxCards = cfg().maxCardsPerPlayer || 4;
  const cards = [...new Set((cardNumbers || []).map(Number))].filter((n) => n > 0);
  if (!cards.length) throw new Error('Select at least one card.');
  if (cards.length > maxCards) throw new Error(`You can play at most ${maxCards} cards.`);

  const s = Number(stake);
  if (!stakes().includes(s)) throw new Error('Invalid stake.');

  const catalog = await listCatalog(cfg().catalogSize || 200);
  const catalogSet = new Set(catalog);
  for (const c of cards) {
    if (!catalogSet.has(c)) throw new Error(`Card #${c} is not in the Instant catalog.`);
  }

  const totalCost = Number((s * cards.length).toFixed(2));
  const numbersCount = cfg().numbersDrawn || 20;
  const lineMult = cfg().lineMultiplier || 2;
  const cornerMult = cfg().cornersMultiplier || 2.5;
  const drawn = drawNumbers(numbersCount, 75);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const user = await client.query(
      `SELECT id, balance FROM users WHERE LOWER(username) = LOWER($1) FOR UPDATE`,
      [username]
    );
    if (!user.rowCount) throw new Error('User not found.');
    const userId = user.rows[0].id;
    const balanceBefore = Number(user.rows[0].balance);
    if (balanceBefore < totalCost) throw new Error('Insufficient balance.');

    const charge = await client.query(
      `UPDATE users SET balance = balance - $1
       WHERE id = $2 AND balance >= $1
       RETURNING balance`,
      [totalCost, userId]
    );
    if (!charge.rowCount) throw new Error('Insufficient balance.');

    await client.query(
      `INSERT INTO transactions(user_id, amount, type) VALUES ($1, $2, $3)`,
      [userId, -totalCost, 'INSTANT_BINGO_BUY']
    );

    // Solo “round” row for history grouping
    const roundIns = await client.query(
      `INSERT INTO instant_rounds (stake, status, drawn_numbers, drawn_at, completed_at)
       VALUES ($1, 'COMPLETED', $2, NOW(), NOW())
       RETURNING id`,
      [s, drawn]
    );
    const roundId = roundIns.rows[0].id;

    const cardResults = [];
    let totalPrize = 0;

    for (const cardNumber of cards) {
      const grid = await getCardGrid(cardNumber);
      if (!grid) throw new Error(`Card #${cardNumber} grid not found.`);

      const evalResult = evaluateCard(grid, drawn, lineMult, cornerMult);
      const prize = evalResult.hit
        ? Number((s * evalResult.multiplier).toFixed(2))
        : 0;
      totalPrize += prize;

      await client.query(
        `INSERT INTO instant_entries
          (round_id, user_id, username, card_number, stake, paid, pattern, multiplier, prize, winning_cells)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          roundId,
          userId,
          username,
          cardNumber,
          s,
          s,
          evalResult.pattern,
          evalResult.multiplier,
          prize,
          JSON.stringify(evalResult.winningCells || []),
        ]
      );

      cardResults.push({
        cardNumber,
        grid,
        pattern: evalResult.pattern,
        multiplier: evalResult.multiplier,
        prize,
        hit: evalResult.hit,
        winningCells: evalResult.winningCells || [],
      });
    }

    if (totalPrize > 0) {
      await client.query(
        `UPDATE users SET balance = balance + $1 WHERE id = $2`,
        [totalPrize, userId]
      );
      await client.query(
        `INSERT INTO transactions(user_id, amount, type) VALUES ($1, $2, $3)`,
        [userId, totalPrize, 'INSTANT_BINGO_WIN']
      );
    }

    await client.query('COMMIT');

    const bal = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);

    return {
      success: true,
      sessionId: roundId,
      stake: s,
      paid: totalCost,
      totalPrize,
      balance: Number(bal.rows[0].balance),
      drawnNumbers: drawn,
      cards: cardResults,
      drawIntervalMs: 1000,
      numbersDrawn: numbersCount,
      playing: fakePlayers,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getStatus() {
  tickFakePlayers();
  return {
    enabled: enabled(),
    maxCardsPerPlayer: cfg().maxCardsPerPlayer || 4,
    numbersDrawn: cfg().numbersDrawn || 20,
    catalogSize: cfg().catalogSize || 200,
    lineMultiplier: cfg().lineMultiplier || 2,
    cornersMultiplier: cfg().cornersMultiplier || 2.5,
    selectionSeconds: cfg().selectionSeconds || 25,
    drawIntervalMs: 1000,
    stakes: stakes(),
    playing: fakePlayers,
  };
}

async function historyForUser(username, limit = 20) {
  const r = await pool.query(
    `SELECT e.id, e.round_id, e.card_number, e.stake, e.paid, e.pattern, e.multiplier,
            e.prize, e.winning_cells, e.created_at, r.drawn_numbers, r.completed_at
     FROM instant_entries e
     LEFT JOIN instant_rounds r ON r.id = e.round_id
     WHERE LOWER(e.username) = LOWER($1)
     ORDER BY e.id DESC
     LIMIT $2`,
    [username, limit]
  );
  return r.rows.map((row) => ({
    id: row.id,
    roundId: row.round_id,
    cardNumber: row.card_number,
    stake: Number(row.stake),
    paid: Number(row.paid),
    pattern: row.pattern,
    multiplier: Number(row.multiplier || 0),
    prize: Number(row.prize || 0),
    drawnNumbers: row.drawn_numbers || [],
    winningCells: row.winning_cells || [],
    date: row.completed_at || row.created_at,
  }));
}

function attachInstantGame(io) {
  if (!io) return;
  ensureSchema().catch((e) => console.error('instant schema', e));
  ioNamespace = io.of('/instant');
  ioNamespace.on('connection', (socket) => {
    socket.emit('instant_players', { playing: fakePlayers });
  });
  console.log('Instant Bingo namespace /instant ready (solo play + shared wallet)');
}

function stopScheduler() {
  /* no shared-round timer anymore */
}

// Legacy no-ops so old route names do not crash if referenced
async function joinRound(opts) {
  return startPlay(opts);
}
async function settleRound() {
  return null;
}

module.exports = {
  enabled,
  ensureSchema,
  attachInstantGame,
  getStatus,
  listCatalog,
  startPlay,
  joinRound,
  settleRound,
  historyForUser,
  stopScheduler,
  evaluateCard,
  drawNumbers,
  getFakePlayers: () => fakePlayers,
};
