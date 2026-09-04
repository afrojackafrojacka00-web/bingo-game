'use strict';

/**
 * Instant Bingo — SHARED real-time rounds (same timer + numbers for everyone).
 */

const pool = require('../../db/pool');
const config = require('../../config');
const { evaluateCard, drawNumbers } = require('./patterns');

const cfg = () => config.instantBingo || {};

let ioNamespace = null;
let phaseTimer = null;
let drawTimer = null;
let phase = 'SELECTING';
let selectionEndsAt = 0;
let currentRoundId = null;
let currentStakeDefault = 10;
let drawnNumbers = [];
let drawIndex = 0;
const entries = new Map();
let lastResults = [];
let fakePlayers = 260 + Math.floor(Math.random() * 40);
let fakeOpponents = [];

const FAKE_PREFIXES = [
  'abh', 'dkb', 'mel', 'yon', 'sara', 'bem', 'kal', 'nah', 'tes', 'lid',
  'daw', 'hel', 'rob', 'sol', 'mir', 'abe', 'fen', 'gat', 'hir', 'jem',
];

function enabled() {
  return cfg().enabled !== false;
}
function stakes() {
  return cfg().stakes || config.stakes || [10, 20, 50, 100, 200, 500];
}
function selectionSeconds() {
  return Number(cfg().selectionSeconds || 25);
}
function tickFakePlayers() {
  const step = Math.floor(Math.random() * 21) - 8;
  fakePlayers = Math.max(200, Math.min(400, fakePlayers + step));
  return fakePlayers;
}
function maskName(raw) {
  const s = String(raw || 'usr').replace(/[^a-zA-Z0-9]/g, '') || 'usr';
  return s.slice(0, 3).toLowerCase() + '*****';
}
function rebuildFakeOpponents(catalog) {
  const nums = (catalog && catalog.length) ? catalog : Array.from({ length: 50 }, (_, i) => i + 1);
  const list = [];
  for (let i = 0; i < 15; i++) {
    const prefix = FAKE_PREFIXES[Math.floor(Math.random() * FAKE_PREFIXES.length)];
    list.push({
      id: 'fake_' + i,
      username: maskName(prefix + Math.floor(Math.random() * 90)),
      cardNumber: nums[Math.floor(Math.random() * nums.length)],
      fake: true,
    });
  }
  fakeOpponents = list;
  return list;
}

async function ensureSchema() {
  const steps = [
    `CREATE TABLE IF NOT EXISTS instant_rounds (
      id SERIAL PRIMARY KEY, stake NUMERIC(10,2) NOT NULL DEFAULT 0,
      status VARCHAR(20) NOT NULL DEFAULT 'OPEN', drawn_numbers INT[] DEFAULT '{}',
      deadline TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(),
      drawn_at TIMESTAMPTZ, completed_at TIMESTAMPTZ)`,
    `CREATE TABLE IF NOT EXISTS instant_entries (
      id SERIAL PRIMARY KEY, round_id INT REFERENCES instant_rounds(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id), username VARCHAR(50) NOT NULL,
      card_number INT NOT NULL, stake NUMERIC(10,2) NOT NULL, paid NUMERIC(10,2) NOT NULL,
      pattern VARCHAR(40), multiplier NUMERIC(6,2) DEFAULT 0, prize NUMERIC(10,2) DEFAULT 0,
      winning_cells JSONB, created_at TIMESTAMPTZ DEFAULT NOW())`,
    `ALTER TABLE instant_entries ALTER COLUMN round_id DROP NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_instant_entries_round ON instant_entries(round_id)`,
    `CREATE INDEX IF NOT EXISTS idx_instant_entries_user ON instant_entries(user_id, created_at DESC)`,
  ];
  for (const sql of steps) {
    try { await pool.query(sql); }
    catch (err) {
      if (err && (err.code === '23505' || err.code === '42P07' || /already exists/i.test(String(err.message)))) continue;
      console.error('instant schema', err.message);
    }
  }
}

async function getCardGrid(cardNumber) {
  const r = await pool.query('SELECT grid FROM bingo_cards WHERE card_number = $1', [cardNumber]);
  return r.rows[0]?.grid || null;
}
async function listCatalog(limit) {
  const size = limit || cfg().catalogSize || 200;
  const r = await pool.query(`SELECT card_number FROM bingo_cards ORDER BY card_number ASC LIMIT $1`, [size]);
  return r.rows.map((row) => Number(row.card_number));
}

function publicState() {
  const secsLeft = phase === 'SELECTING'
    ? Math.max(0, Math.ceil((selectionEndsAt - Date.now()) / 1000)) : 0;
  const players = [];
  for (const [username, ent] of entries.entries()) {
    players.push({ username: maskName(username), realUsername: username, cards: ent.cards, stake: ent.stake, fake: false });
  }
  return {
    enabled: enabled(), phase, selectionSeconds: selectionSeconds(), secondsLeft: secsLeft,
    selectionEndsAt, maxCardsPerPlayer: cfg().maxCardsPerPlayer || 4,
    numbersDrawn: cfg().numbersDrawn || 20, lineMultiplier: cfg().lineMultiplier || 2,
    cornersMultiplier: cfg().cornersMultiplier || 2.5, stakes: stakes(),
    playing: fakePlayers, playerCount: entries.size,
    drawnNumbers: phase === 'DRAWING' || phase === 'RESULTS' ? drawnNumbers.slice(0, drawIndex) : [],
    fullDrawn: phase === 'RESULTS' ? drawnNumbers : [], drawIndex, roundId: currentRoundId,
    fakeOpponents, players, lastResults: phase === 'RESULTS' ? lastResults : [],
  };
}

function broadcast(event, payload) {
  if (ioNamespace) ioNamespace.emit(event, payload || publicState());
}

function startSelectionPhase() {
  phase = 'SELECTING';
  entries.clear();
  drawnNumbers = [];
  drawIndex = 0;
  lastResults = [];
  currentRoundId = null;
  selectionEndsAt = Date.now() + selectionSeconds() * 1000;
  tickFakePlayers();
  listCatalog(cfg().catalogSize || 200).then((cat) => rebuildFakeOpponents(cat)).catch(() => rebuildFakeOpponents([]));
  if (phaseTimer) clearInterval(phaseTimer);
  if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
  phaseTimer = setInterval(() => {
    if (phase !== 'SELECTING') return;
    const left = selectionEndsAt - Date.now();
    broadcast('instant_state', publicState());
    if (left <= 0) {
      clearInterval(phaseTimer);
      phaseTimer = null;
      beginDrawPhase().catch((e) => { console.error('instant beginDraw', e); startSelectionPhase(); });
    }
  }, 250);
  broadcast('instant_state', publicState());
}

async function beginDrawPhase() {
  phase = 'DRAWING';
  drawIndex = 0;
  drawnNumbers = drawNumbers(cfg().numbersDrawn || 20, 75);
  try {
    const ins = await pool.query(
      `INSERT INTO instant_rounds (stake, status, drawn_numbers, drawn_at) VALUES ($1,'DRAWING',$2,NOW()) RETURNING id`,
      [currentStakeDefault, drawnNumbers]
    );
    currentRoundId = ins.rows[0].id;
  } catch (e) {
    console.error('instant round insert', e.message);
    currentRoundId = Date.now();
  }
  broadcast('instant_draw_start', { ...publicState(), drawnNumbers, drawIntervalMs: 1000 });
  await settleAllEntries();
  drawTimer = setInterval(() => {
    drawIndex += 1;
    const num = drawnNumbers[drawIndex - 1];
    broadcast('instant_number', {
      index: drawIndex, total: drawnNumbers.length, number: num,
      called: drawnNumbers.slice(0, drawIndex), playing: fakePlayers,
    });
    if (drawIndex >= drawnNumbers.length) {
      clearInterval(drawTimer);
      drawTimer = null;
      phase = 'RESULTS';
      broadcast('instant_draw_end', { drawnNumbers, results: lastResults, playing: fakePlayers });
      setTimeout(() => startSelectionPhase(), 1200);
    }
  }, 1000);
}

async function settleAllEntries() {
  const lineMult = cfg().lineMultiplier || 2;
  const cornerMult = cfg().cornersMultiplier || 2.5;
  lastResults = [];
  for (const [username, ent] of entries.entries()) {
    for (const cardNumber of ent.cards) {
      const grid = await getCardGrid(cardNumber);
      const evalResult = evaluateCard(grid, drawnNumbers, lineMult, cornerMult);
      const prize = evalResult.hit ? Number((Number(ent.stake) * evalResult.multiplier).toFixed(2)) : 0;
      try {
        if (currentRoundId) {
          await pool.query(
            `INSERT INTO instant_entries (round_id,user_id,username,card_number,stake,paid,pattern,multiplier,prize,winning_cells)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [currentRoundId, ent.userId, username, cardNumber, ent.stake, ent.stake,
              evalResult.pattern, evalResult.multiplier, prize, JSON.stringify(evalResult.winningCells || [])]
          );
        }
        if (prize > 0) {
          await pool.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [prize, ent.userId]);
          await pool.query(`INSERT INTO transactions(user_id,amount,type) VALUES ($1,$2,'INSTANT_BINGO_WIN')`, [ent.userId, prize]);
        }
      } catch (e) { console.error('instant settle', e.message); }
      lastResults.push({
        username, cardNumber, pattern: evalResult.pattern, multiplier: evalResult.multiplier,
        prize, hit: evalResult.hit, winningCells: evalResult.winningCells || [], grid,
      });
    }
  }
  try {
    if (currentRoundId) {
      await pool.query(`UPDATE instant_rounds SET status='COMPLETED', completed_at=NOW() WHERE id=$1`, [currentRoundId]);
    }
  } catch (_) {}
}

async function joinSharedRound({ username, stake, cardNumbers }) {
  if (!enabled()) { const err = new Error('Instant Bingo is temporarily unavailable.'); err.code = 'DISABLED'; throw err; }
  if (phase !== 'SELECTING') throw new Error('Round already started — wait for the next selection.');
  const maxCards = cfg().maxCardsPerPlayer || 4;
  const cards = [...new Set((cardNumbers || []).map(Number))].filter((n) => n > 0);
  if (!cards.length) throw new Error('Select at least one card.');
  if (cards.length > maxCards) throw new Error('Max ' + maxCards + ' cards.');
  const s = Number(stake);
  if (!stakes().includes(s)) throw new Error('Invalid stake.');
  const catalog = await listCatalog(cfg().catalogSize || 200);
  const set = new Set(catalog);
  for (const c of cards) if (!set.has(c)) throw new Error('Card #' + c + ' not in catalog.');
  const totalCost = Number((s * cards.length).toFixed(2));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query(`SELECT id, balance FROM users WHERE LOWER(username)=LOWER($1) FOR UPDATE`, [username]);
    if (!user.rowCount) throw new Error('User not found.');
    const userId = user.rows[0].id;
    if (Number(user.rows[0].balance) < totalCost) throw new Error('Insufficient balance.');
    if (entries.has(username)) {
      const prev = entries.get(username);
      await client.query(`UPDATE users SET balance = balance + $1 WHERE id = $2`, [prev.paid, userId]);
      await client.query(`INSERT INTO transactions(user_id,amount,type) VALUES ($1,$2,'INSTANT_BINGO_REFUND')`, [userId, prev.paid]);
    }
    const charge = await client.query(
      `UPDATE users SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance`, [totalCost, userId]);
    if (!charge.rowCount) throw new Error('Insufficient balance.');
    await client.query(`INSERT INTO transactions(user_id,amount,type) VALUES ($1,$2,'INSTANT_BINGO_BUY')`, [userId, -totalCost]);
    await client.query('COMMIT');
    entries.set(username, { userId, cards, stake: s, paid: totalCost });
    currentStakeDefault = s;
    broadcast('instant_state', publicState());
    return {
      success: true, balance: Number(charge.rows[0].balance), paid: totalCost, cards, stake: s,
      phase, secondsLeft: Math.max(0, Math.ceil((selectionEndsAt - Date.now()) / 1000)), state: publicState(),
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function startPlay(opts) { return joinSharedRound(opts); }
async function getStatus() { tickFakePlayers(); return publicState(); }
function getLiveSession() {
  if (phase === 'DRAWING' || phase === 'RESULTS') {
    return { sessionId: currentRoundId, drawnNumbers, drawIndex, phase, cards: lastResults, drawIntervalMs: 1000 };
  }
  return null;
}

async function historyForUser(username, limit = 20) {
  const r = await pool.query(
    `SELECT e.id, e.round_id, e.card_number, e.stake, e.paid, e.pattern, e.multiplier,
            e.prize, e.winning_cells, e.created_at, r.drawn_numbers, r.completed_at
     FROM instant_entries e LEFT JOIN instant_rounds r ON r.id = e.round_id
     WHERE LOWER(e.username)=LOWER($1) ORDER BY e.id DESC LIMIT $2`, [username, limit]);
  return r.rows.map((row) => ({
    id: row.id, roundId: row.round_id, cardNumber: row.card_number, stake: Number(row.stake),
    paid: Number(row.paid), pattern: row.pattern, multiplier: Number(row.multiplier || 0),
    prize: Number(row.prize || 0), drawnNumbers: row.drawn_numbers || [],
    winningCells: row.winning_cells || [], date: row.completed_at || row.created_at,
  }));
}

async function getLeaderboard(period = 'day', limit = 20) {
  let sinceSql = '';
  if (period === 'day') sinceSql = "AND e.created_at >= date_trunc('day', NOW())";
  else if (period === 'week') sinceSql = "AND e.created_at >= date_trunc('week', NOW())";
  const r = await pool.query(
    `SELECT e.username, e.card_number, e.stake, e.paid, e.prize, e.multiplier, e.pattern,
            e.winning_cells, e.created_at, r.drawn_numbers, bc.grid
     FROM instant_entries e
     LEFT JOIN instant_rounds r ON r.id = e.round_id
     LEFT JOIN bingo_cards bc ON bc.card_number = e.card_number
     WHERE e.prize > 0 ${sinceSql}
     ORDER BY e.prize DESC, e.created_at DESC LIMIT $1`, [Math.max(limit, 5)]);
  const leaders = r.rows.map((row) => ({
    username: maskName(row.username), cardNumber: row.card_number, stake: Number(row.stake),
    paid: Number(row.paid), prize: Number(row.prize), multiplier: Number(row.multiplier || 0),
    pattern: row.pattern, winningCells: row.winning_cells || [], drawnNumbers: row.drawn_numbers || [],
    grid: row.grid || null, date: row.created_at, fake: false,
  }));
  while (leaders.length < 15) {
    const prefix = FAKE_PREFIXES[Math.floor(Math.random() * FAKE_PREFIXES.length)];
    const mult = Math.random() > 0.7 ? 2.5 : 2;
    const stake = stakes()[Math.floor(Math.random() * stakes().length)];
    const cardNumber = 1 + Math.floor(Math.random() * 80);
    let grid = null;
    try { grid = await getCardGrid(cardNumber); } catch (_) {}
    leaders.push({
      username: maskName(prefix), cardNumber, stake, paid: stake, prize: Number((stake * mult).toFixed(2)),
      multiplier: mult, pattern: mult === 2.5 ? 'four_corners' : 'any_one_line',
      winningCells: mult === 2.5 ? [[0,0],[0,4],[4,0],[4,4]] : [[0,0],[0,1],[0,2],[0,3],[0,4]],
      drawnNumbers: [], grid, date: new Date(), fake: true,
    });
  }
  return leaders.slice(0, 20);
}

function attachInstantGame(io) {
  if (!io) return;
  ensureSchema().then(() => startSelectionPhase()).catch((e) => console.error('instant boot', e));
  ioNamespace = io.of('/instant');
  ioNamespace.on('connection', (socket) => {
    socket.emit('instant_state', publicState());
    socket.on('instant_sync', () => socket.emit('instant_state', publicState()));
    socket.on('instant_watch', () => {
      socket.emit('instant_state', publicState());
      if (phase === 'DRAWING') {
        socket.emit('instant_draw_start', { ...publicState(), drawnNumbers, drawIntervalMs: 1000, resume: true, drawIndex });
      }
    });
  });
  setInterval(() => { tickFakePlayers(); }, 8000);
  console.log('Instant Bingo shared real-time rounds ready');
}

function stopScheduler() {
  if (phaseTimer) clearInterval(phaseTimer);
  if (drawTimer) clearInterval(drawTimer);
}

module.exports = {
  enabled, ensureSchema, attachInstantGame, getStatus, listCatalog, startPlay,
  joinRound: joinSharedRound, joinSharedRound, settleRound: async () => null,
  historyForUser, getLeaderboard, getLiveSession, stopScheduler, evaluateCard, drawNumbers,
  getFakePlayers: () => fakePlayers, publicState,
};
