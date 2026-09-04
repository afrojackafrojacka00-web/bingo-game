'use strict';

/**
 * Instant Bingo (Ohio-style Multiple Bingo) — fully isolated from classic bingo.
 *
 * - Shared account / wallet / deposit / withdraw (uses same users + transactions)
 * - Own tables, own routes, own in-memory round state
 * - Kill switch: config.instantBingo.enabled or INSTANT_BINGO_ENABLED=false
 * - Deleting this folder + routes unregister leaves classic bingo untouched
 */

const pool = require('../../db/pool');
const config = require('../../config');
const { evaluateCard, drawNumbers } = require('./patterns');

const cfg = () => config.instantBingo || {};

/** @type {Map<number, object>} stake -> open round state */
const openRounds = new Map();

let ioNamespace = null;
let tickTimer = null;

function enabled() {
  return cfg().enabled !== false;
}

function stakes() {
  return cfg().stakes || config.stakes || [10, 20, 50, 100, 200, 500];
}

async function ensureSchema() {
  // Run statements one-by-one so a concurrent boot race does not abort the whole block.
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
      round_id INT NOT NULL REFERENCES instant_rounds(id) ON DELETE CASCADE,
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
    `CREATE INDEX IF NOT EXISTS idx_instant_entries_round ON instant_entries(round_id)`,
    `CREATE INDEX IF NOT EXISTS idx_instant_entries_user ON instant_entries(user_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_instant_rounds_status ON instant_rounds(status, stake)`,
  ];
  for (const sql of steps) {
    try {
      await pool.query(sql);
    } catch (err) {
      // Concurrent deploy can race on type/table create — safe to ignore "already exists"
      if (err && (err.code === '23505' || err.code === '42P07' || /already exists/i.test(err.message))) {
        continue;
      }
      throw err;
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
    `SELECT card_number FROM bingo_cards
     ORDER BY card_number ASC
     LIMIT $1`,
    [size]
  );
  return r.rows.map((row) => Number(row.card_number));
}

function roomKey(stake) {
  return Number(stake);
}

function publicRound(round) {
  if (!round) return null;
  return {
    id: round.id,
    stake: Number(round.stake),
    status: round.status,
    deadline: round.deadline,
    secondsLeft: round.deadline
      ? Math.max(0, Math.ceil((new Date(round.deadline).getTime() - Date.now()) / 1000))
      : 0,
    entryCount: round.entryCount || 0,
    drawnNumbers: round.drawnNumbers || [],
  };
}

async function getOrCreateOpenRound(stake) {
  const s = Number(stake);
  if (!stakes().includes(s)) throw new Error('Invalid stake.');

  let mem = openRounds.get(s);
  if (mem && mem.status === 'OPEN') return mem;

  const existing = await pool.query(
    `SELECT id, stake, status, deadline, drawn_numbers
     FROM instant_rounds
     WHERE stake = $1 AND status = 'OPEN'
     ORDER BY id DESC LIMIT 1`,
    [s]
  );

  if (existing.rowCount) {
    const row = existing.rows[0];
    const count = await pool.query(
      'SELECT COUNT(*)::int AS c FROM instant_entries WHERE round_id = $1',
      [row.id]
    );
    mem = {
      id: row.id,
      stake: s,
      status: 'OPEN',
      deadline: row.deadline,
      entryCount: count.rows[0].c,
      drawnNumbers: row.drawn_numbers || [],
    };
    openRounds.set(s, mem);
    return mem;
  }

  const secs = cfg().roundSeconds || 45;
  const deadline = new Date(Date.now() + secs * 1000);
  const ins = await pool.query(
    `INSERT INTO instant_rounds (stake, status, deadline)
     VALUES ($1, 'OPEN', $2)
     RETURNING id, stake, status, deadline`,
    [s, deadline]
  );
  const row = ins.rows[0];
  mem = {
    id: row.id,
    stake: s,
    status: 'OPEN',
    deadline: row.deadline,
    entryCount: 0,
    drawnNumbers: [],
  };
  openRounds.set(s, mem);
  return mem;
}

/**
 * Join: pay stake per card, up to maxCards. Same card number allowed for different players.
 */
async function joinRound({ username, stake, cardNumbers }) {
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

  const round = await getOrCreateOpenRound(s);
  if (round.status !== 'OPEN') throw new Error('This round is locked. Try the next one.');
  if (round.deadline && new Date(round.deadline).getTime() <= Date.now()) {
    await settleRound(s);
    return joinRound({ username, stake, cardNumbers });
  }

  const totalCost = Number((s * cards.length).toFixed(2));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query(
      `SELECT id, balance FROM users WHERE LOWER(username) = LOWER($1) FOR UPDATE`,
      [username]
    );
    if (!user.rowCount) throw new Error('User not found.');
    const userId = user.rows[0].id;
    const balance = Number(user.rows[0].balance);
    if (balance < totalCost) throw new Error('Insufficient balance.');

    // One entry per card per user per round
    for (const cardNumber of cards) {
      const dup = await client.query(
        `SELECT id FROM instant_entries
         WHERE round_id = $1 AND user_id = $2 AND card_number = $3`,
        [round.id, userId, cardNumber]
      );
      if (dup.rowCount) {
        throw new Error(`You already joined this round with card #${cardNumber}.`);
      }
    }

    await client.query(
      `UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance`,
      [totalCost, userId]
    );
    await client.query(
      `INSERT INTO transactions(user_id, amount, type) VALUES ($1, $2, $3)`,
      [userId, -totalCost, 'INSTANT_BINGO_BUY']
    );

    for (const cardNumber of cards) {
      await client.query(
        `INSERT INTO instant_entries (round_id, user_id, username, card_number, stake, paid)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [round.id, userId, username, cardNumber, s, s]
      );
    }

    await client.query('COMMIT');

    const bal = await pool.query('SELECT balance FROM users WHERE id = $1', [userId]);
    round.entryCount = (round.entryCount || 0) + cards.length;
    broadcastRound(s);

    return {
      success: true,
      round: publicRound(round),
      cards,
      paid: totalCost,
      balance: Number(bal.rows[0].balance),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function settleRound(stake) {
  const s = Number(stake);
  const mem = openRounds.get(s);
  if (!mem || mem.status !== 'OPEN') return null;

  mem.status = 'DRAWING';
  openRounds.set(s, mem);

  const numbersCount = cfg().numbersDrawn || 20;
  const drawn = drawNumbers(numbersCount, 75);
  const lineMult = cfg().lineMultiplier || 2;
  const cornerMult = cfg().cornersMultiplier || 2.5;

  const client = await pool.connect();
  const results = [];
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE instant_rounds
       SET status = 'COMPLETED', drawn_numbers = $1, drawn_at = NOW(), completed_at = NOW()
       WHERE id = $2 AND status = 'OPEN'`,
      [drawn, mem.id]
    );

    const entries = await client.query(
      `SELECT e.*, u.id AS uid
       FROM instant_entries e
       JOIN users u ON u.id = e.user_id
       WHERE e.round_id = $1`,
      [mem.id]
    );

    for (const entry of entries.rows) {
      const grid = await getCardGrid(entry.card_number);
      const evalResult = evaluateCard(grid, drawn, lineMult, cornerMult);
      let prize = 0;
      if (evalResult.hit) {
        prize = Number((Number(entry.paid) * evalResult.multiplier).toFixed(2));
        await client.query(
          `UPDATE users SET balance = balance + $1 WHERE id = $2`,
          [prize, entry.user_id]
        );
        await client.query(
          `INSERT INTO transactions(user_id, amount, type) VALUES ($1, $2, $3)`,
          [entry.user_id, prize, 'INSTANT_BINGO_WIN']
        );
      }
      await client.query(
        `UPDATE instant_entries
         SET pattern = $1, multiplier = $2, prize = $3, winning_cells = $4
         WHERE id = $5`,
        [
          evalResult.pattern,
          evalResult.multiplier,
          prize,
          JSON.stringify(evalResult.winningCells || []),
          entry.id,
        ]
      );
      results.push({
        username: entry.username,
        cardNumber: entry.card_number,
        pattern: evalResult.pattern,
        multiplier: evalResult.multiplier,
        prize,
        hit: evalResult.hit,
      });
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    mem.status = 'OPEN';
    openRounds.set(s, mem);
    console.error('instant settleRound error', err);
    throw err;
  } finally {
    client.release();
  }

  openRounds.delete(s);
  const payload = {
    stake: s,
    roundId: mem.id,
    drawnNumbers: drawn,
    results,
  };
  if (ioNamespace) {
    ioNamespace.to(`instant:${s}`).emit('instant_round_result', payload);
    ioNamespace.emit('instant_round_result', payload);
  }

  // Open next round immediately
  await getOrCreateOpenRound(s);
  broadcastRound(s);
  return payload;
}

function broadcastRound(stake) {
  if (!ioNamespace) return;
  const mem = openRounds.get(Number(stake));
  ioNamespace.emit('instant_round_update', publicRound(mem));
}

async function getStatus() {
  const out = {
    enabled: enabled(),
    maxCardsPerPlayer: cfg().maxCardsPerPlayer || 4,
    numbersDrawn: cfg().numbersDrawn || 20,
    catalogSize: cfg().catalogSize || 200,
    lineMultiplier: cfg().lineMultiplier || 2,
    cornersMultiplier: cfg().cornersMultiplier || 2.5,
    roundSeconds: cfg().roundSeconds || 45,
    stakes: stakes(),
    rounds: [],
  };
  if (!out.enabled) return out;

  for (const s of stakes()) {
    try {
      const r = await getOrCreateOpenRound(s);
      out.rounds.push(publicRound(r));
    } catch (e) {
      /* ignore */
    }
  }
  return out;
}

async function historyForUser(username, limit = 20) {
  const r = await pool.query(
    `SELECT e.id, e.round_id, e.card_number, e.stake, e.paid, e.pattern, e.multiplier,
            e.prize, e.winning_cells, e.created_at, r.drawn_numbers, r.completed_at
     FROM instant_entries e
     JOIN instant_rounds r ON r.id = e.round_id
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

function startScheduler() {
  if (tickTimer) return;
  tickTimer = setInterval(async () => {
    if (!enabled()) return;
    for (const s of stakes()) {
      const mem = openRounds.get(s);
      if (!mem || mem.status !== 'OPEN' || !mem.deadline) continue;
      if (new Date(mem.deadline).getTime() <= Date.now()) {
        try {
          await settleRound(s);
        } catch (err) {
          console.error('instant scheduler settle', s, err.message);
        }
      }
    }
  }, 1000);
}

function stopScheduler() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/**
 * Attach isolated Socket.IO namespace `/instant` so classic bingo sockets are untouched.
 */
function attachInstantGame(io) {
  if (!io) return;
  ensureSchema().catch((e) => console.error('instant schema', e));
  ioNamespace = io.of('/instant');
  ioNamespace.on('connection', (socket) => {
    socket.on('instant_subscribe', async (stake) => {
      const s = Number(stake);
      if (!stakes().includes(s)) return;
      socket.join(`instant:${s}`);
      try {
        const r = await getOrCreateOpenRound(s);
        socket.emit('instant_round_update', publicRound(r));
      } catch (e) {
        /* ignore */
      }
    });
  });
  startScheduler();
  console.log('Instant Bingo namespace /instant ready (isolated from classic bingo)');
}

module.exports = {
  enabled,
  ensureSchema,
  attachInstantGame,
  getStatus,
  listCatalog,
  joinRound,
  settleRound,
  historyForUser,
  getOrCreateOpenRound,
  publicRound,
  stopScheduler,
  evaluateCard,
  drawNumbers,
};
