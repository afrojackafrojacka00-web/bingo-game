'use strict';

/**
 * Instant Bingo — SHARED real-time rounds (same timer + numbers for everyone).
 */

const pool = require('../../db/pool');
const config = require('../../config');
const { evaluateCard, drawNumbers, defaultWinRules, normalizeWinRules, PATTERN_CATALOG } = require('./patterns');

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

// Runtime admin overrides (not mixed with classic bingo config)
let runtimeMasterEnabled = cfg().enabled !== false; // HARD lock — players cannot force on
let runtimeEcoMode = true; // when true: pause loop when empty; real player join wakes it
let runtimeLoopRunning = cfg().enabled !== false; // is the selection/draw loop active
let runtimeSelectionSeconds = Number(cfg().selectionSeconds || 25);
let runtimeMaxCards = Number(cfg().maxCardsPerPlayer || 4);
let runtimeNumbersDrawn = Number(cfg().numbersDrawn || 20);
let runtimeDifficulty = String(cfg().difficulty || 'medium'); // easy|medium|hard|super_hard
let runtimeWinRules = defaultWinRules();
let adminDisabledAt = null;

/**
 * Difficulty with FIXED numbers drawn (default 20).
 * Controls how hard we try to complete patterns on real players' cards
 * inside the shared 20-number draw.
 * targetWinRate ≈ fraction of real cards we try to give at least one win.
 * (With many players, not everyone can win — 20 numbers is a hard limit.)
 */
const DIFFICULTY_PRESETS = {
  easy:       { targetWinRate: 0.55, label: 'Easy', hint: 'Aim ~55% of real cards win (≥1 pattern)' },
  medium:     { targetWinRate: 0.28, label: 'Medium', hint: 'Aim ~28% of real cards win' },
  hard:       { targetWinRate: 0.12, label: 'Hard', hint: 'Aim ~12% of real cards win' },
  super_hard: { targetWinRate: 0.04, label: 'Super hard', hint: 'Aim ~4% of real cards win (near pure random)' },
};

function enabled() {
  // Master switch: game allowed at all
  return runtimeMasterEnabled !== false;
}
function isLoopRunning() {
  return !!runtimeLoopRunning && enabled();
}

function connectedViewerCount() {
  try {
    if (!ioNamespace) return 0;
    // socket.io v3/v4: namespace.sockets is a Map
    if (ioNamespace.sockets && typeof ioNamespace.sockets.size === 'number') {
      return ioNamespace.sockets.size;
    }
    if (ioNamespace.sockets && ioNamespace.sockets.sockets) {
      return ioNamespace.sockets.sockets.size || 0;
    }
  } catch (_) {}
  return 0;
}

function hasViewers() {
  return connectedViewerCount() > 0;
}

/**
 * Real user opened Instant Bingo UI — start selection countdown immediately
 * (only if master is ON). Does nothing during an active DRAWING round.
 */
function wakeForPresence() {
  if (!enabled()) {
    return { ok: false, reason: 'MASTER_OFF', state: publicState() };
  }
  if (phase === 'DRAWING' || phase === 'RESULTS') {
    return { ok: true, reason: 'BUSY_DRAW', state: publicState() };
  }
  if (phase === 'SELECTING' && phaseTimer && runtimeLoopRunning) {
    return { ok: true, reason: 'ALREADY_RUNNING', state: publicState() };
  }
  runtimeLoopRunning = true;
  adminDisabledAt = null;
  startSelectionPhase();
  return { ok: true, reason: 'WOKEN', state: publicState() };
}

/**
 * User left Instant UI. Eco: sleep only if not mid-draw and no real entries.
 */
function sleepIfEcoIdle(force) {
  if (!runtimeEcoMode || !enabled()) return publicState();
  // Never interrupt a live draw / results — even if viewer left
  if (phase === 'DRAWING' || phase === 'RESULTS') return publicState();
  if (hasActiveRealPlayers()) return publicState();
  // Someone still on Instant page (socket connected) — keep the show running
  if (hasViewers()) return publicState();
  // Only sleep from SELECTING / IDLE when empty
  if (!force && phase !== 'SELECTING' && phase !== 'IDLE') return publicState();
  runtimeLoopRunning = false;
  stopScheduler();
  phase = 'IDLE';
  broadcast('instant_state', publicState());
  return publicState();
}
function stakes() {
  return cfg().stakes || config.stakes || [10, 20, 50, 100, 200, 500];
}
function selectionSeconds() {
  return Math.max(5, Math.min(120, Number(runtimeSelectionSeconds || cfg().selectionSeconds || 25)));
}
function maxCardsPerPlayer() {
  return Math.max(1, Math.min(8, Number(runtimeMaxCards || cfg().maxCardsPerPlayer || 4)));
}
function numbersDrawnCount() {
  return Math.max(5, Math.min(40, Number(runtimeNumbersDrawn || cfg().numbersDrawn || 20)));
}
function realPlayerCount() {
  return entries.size;
}
function hasActiveRealPlayers() {
  return entries.size > 0;
}
function tickFakePlayers() {
  // Only fluctuate while waiting for cards — freeze during live draw
  if (phase !== 'SELECTING') return fakePlayers;
  const step = Math.floor(Math.random() * 21) - 8;
  fakePlayers = Math.max(200, Math.min(400, fakePlayers + step));
  return fakePlayers;
}
function maskName(raw) {
  const s = String(raw || 'usr').replace(/[^a-zA-Z0-9]/g, '') || 'usr';
  return s.slice(0, 3).toLowerCase() + '*****';
}
function pickFakeStake() {
  // Weighted: mostly 10 & 20, some mid, few high
  const roll = Math.random();
  if (roll < 0.42) return 10;
  if (roll < 0.78) return 20;
  if (roll < 0.88) return 50;
  if (roll < 0.94) return 100;
  if (roll < 0.98) return 200;
  return 500;
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
      stake: pickFakeStake(),
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
    enabled: enabled(), masterEnabled: enabled(), ecoMode: !!runtimeEcoMode, loopRunning: isLoopRunning(),
    phase, selectionSeconds: selectionSeconds(), secondsLeft: secsLeft,
    selectionEndsAt, maxCardsPerPlayer: maxCardsPerPlayer(),
    numbersDrawn: numbersDrawnCount(), difficulty: runtimeDifficulty || 'medium', lineMultiplier: cfg().lineMultiplier || 2,
    cornersMultiplier: cfg().cornersMultiplier || 2.5, stakes: stakes(),
    playing: fakePlayers, playerCount: entries.size,
    drawnNumbers: phase === 'DRAWING' || phase === 'RESULTS' ? drawnNumbers.slice(0, drawIndex) : [],
    fullDrawn: phase === 'RESULTS' ? drawnNumbers : [], drawIndex, roundId: currentRoundId,
    fakeOpponents, players, lastResults: phase === 'RESULTS' ? lastResults : [],
    adminDisabledAt, viewers: connectedViewerCount(), winRules: runtimeWinRules,
  };
}

function broadcast(event, payload) {
  if (ioNamespace) ioNamespace.emit(event, payload || publicState());
}

function startSelectionPhase() {
  if (!enabled() || !runtimeLoopRunning) {
    phase = 'IDLE';
    runtimeLoopRunning = false;
    if (phaseTimer) { clearInterval(phaseTimer); phaseTimer = null; }
    if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
    broadcast('instant_state', publicState());
    return;
  }
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
      // Eco: sleep only when NO ONE is watching Instant (no sockets).
      // If a user is on the card-selection page (even without pressing Play),
      // keep going: draw → selection → draw…
      if (runtimeEcoMode && entries.size === 0 && !hasViewers()) {
        runtimeLoopRunning = false;
        phase = 'IDLE';
        broadcast('instant_state', publicState());
        return;
      }
      beginDrawPhase().catch((e) => { console.error('instant beginDraw', e); startSelectionPhase(); });
    }
  }, 250);
  broadcast('instant_state', publicState());
}


/**
 * Fixed-size shared draw (usually 20), shaped by difficulty.
 *
 * Strategy:
 *  1. List every real player's cards.
 *  2. Pick a subset as "intended winners" using targetWinRate.
 *  3. For each, force the numbers of ONE completable pattern (prefer 1 line / corners).
 *  4. Fill the rest of the 20 slots with pure random numbers.
 *
 * Hundreds of players: we cannot make everyone win with only 20 numbers.
 * We sample winners fairly (shuffle), so over many rounds each player gets turns.
 * Cap forced winners so forced numbers still fit in `count` slots.
 */
async function buildDrawForRound(count) {
  const n = Math.max(5, Math.min(40, Number(count) || 20));
  const diff = String(runtimeDifficulty || 'medium');
  const preset = DIFFICULTY_PRESETS[diff] || DIFFICULTY_PRESETS.medium;
  const targetRate = Math.max(0, Math.min(1, Number(preset.targetWinRate) || 0));

  // Load all real cards in this round
  const cardEntries = []; // { username, cardNumber, grid }
  for (const [username, ent] of entries.entries()) {
    for (const cardNumber of ent.cards || []) {
      try {
        const grid = await getCardGrid(cardNumber);
        if (grid) cardEntries.push({ username, cardNumber, grid });
      } catch (_) {}
    }
  }

  // Pure random if no real cards or super-low rate roll with empty set
  const forced = new Set();
  if (cardEntries.length && targetRate > 0) {
    // Shuffle cards for fairness across rounds
    for (let i = cardEntries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = cardEntries[i]; cardEntries[i] = cardEntries[j]; cardEntries[j] = t;
    }
    // How many cards to try to make win this round
    let want = Math.max(0, Math.round(cardEntries.length * targetRate));
    // Always try at least 1 on easy/medium when someone is playing
    if (want < 1 && (diff === 'easy' || diff === 'medium') && cardEntries.length) want = 1;
    // Cap: each pattern needs up to 5 unique numbers; keep room for randomness
    const maxForcedCards = Math.max(1, Math.floor((n * 0.75) / 3)); // rough cap
    want = Math.min(want, maxForcedCards, cardEntries.length);

    const { ROWS, COLS, DIAGONALS, CORNERS } = require('./patterns');
    const patterns = [];
    // Prefer cheaper patterns first so more winners fit in 20 numbers
    ROWS.forEach((cells, idx) => patterns.push({ id: 'row' + idx, cells }));
    COLS.forEach((cells, idx) => patterns.push({ id: 'col' + idx, cells }));
    DIAGONALS.forEach((cells, idx) => patterns.push({ id: 'diag' + idx, cells }));
    patterns.push({ id: 'corners', cells: CORNERS });

    let made = 0;
    for (let ci = 0; ci < cardEntries.length && made < want; ci++) {
      const { grid } = cardEntries[ci];
      // Shuffle patterns so different lines win, not always top row
      const pats = patterns.slice();
      for (let i = pats.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = pats[i]; pats[i] = pats[j]; pats[j] = t;
      }
      let chosen = null;
      let needed = [];
      for (const p of pats) {
        const nums = [];
        let ok = true;
        for (const [r, c] of p.cells) {
          if (r === 2 && c === 2) continue; // FREE center
          const v = Number(grid[r][c]);
          if (!v || v < 1 || v > 75) { ok = false; break; }
          nums.push(v);
        }
        if (!ok) continue;
        // unique nums for this pattern
        const uniq = [...new Set(nums)];
        // Would adding these exceed n?
        const next = new Set(forced);
        uniq.forEach((x) => next.add(x));
        if (next.size <= n) {
          chosen = p;
          needed = uniq;
          break;
        }
      }
      if (chosen) {
        needed.forEach((x) => forced.add(x));
        made += 1;
      }
    }
  }

  // Fill remaining slots randomly
  const picked = [...forced];
  const seen = new Set(picked);
  const bag = [];
  for (let num = 1; num <= 75; num++) if (!seen.has(num)) bag.push(num);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
  }
  for (const num of bag) {
    if (picked.length >= n) break;
    picked.push(num);
  }
  // Shuffle final order so forced numbers are not all at the start
  for (let i = picked.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = picked[i]; picked[i] = picked[j]; picked[j] = t;
  }
  return picked.slice(0, n);
}

async function beginDrawPhase() {
  phase = 'DRAWING';
  drawIndex = 0;
  drawnNumbers = await buildDrawForRound(numbersDrawnCount());
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
  lastResults = [];
  for (const [username, ent] of entries.entries()) {
    for (const cardNumber of ent.cards) {
      const grid = await getCardGrid(cardNumber);
      const evalResult = evaluateCard(grid, drawnNumbers, runtimeWinRules);
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
  // HARD off (master): nobody can play
  if (!enabled()) {
    const err = new Error('Instant Bingo is turned off by admin.');
    err.code = 'DISABLED';
    throw err;
  }
  // Eco / paused loop: real player joining wakes the loop
  if (!runtimeLoopRunning || phase === 'IDLE') {
    runtimeLoopRunning = true;
    adminDisabledAt = null;
    startSelectionPhase();
  }
  if (phase !== 'SELECTING') throw new Error('Round already started — wait for the next selection.');
  const maxCards = maxCardsPerPlayer();
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
async function getStatus(opts) {
  if (opts && opts.wake) wakeForPresence();
  if (phase === 'SELECTING') tickFakePlayers();
  return publicState();
}
function getLiveSession() {
  if (phase === 'DRAWING' || phase === 'RESULTS') {
    return { sessionId: currentRoundId, drawnNumbers, drawIndex, phase, cards: lastResults, drawIntervalMs: 1000 };
  }
  return null;
}

async function historyForUser(username, limit = 15, offset = 0) {
  const lim = Math.min(Math.max(Number(limit) || 15, 1), 30);
  const off = Math.max(Number(offset) || 0, 0);
  const r = await pool.query(
    `SELECT e.id, e.round_id, e.card_number, e.stake, e.paid, e.pattern, e.multiplier,
            e.prize, e.winning_cells, e.created_at, r.drawn_numbers, r.completed_at
     FROM instant_entries e LEFT JOIN instant_rounds r ON r.id = e.round_id
     WHERE LOWER(e.username)=LOWER($1) ORDER BY e.id DESC LIMIT $2 OFFSET $3`,
    [username, lim, off]);
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
  ensureSchema().then(() => {
    if (enabled() && !runtimeEcoMode) {
      runtimeLoopRunning = true;
      startSelectionPhase();
    } else if (enabled() && runtimeEcoMode) {
      runtimeLoopRunning = false;
      phase = 'IDLE';
      console.log('Instant Bingo eco mode: idle until a real player joins');
    }
  }).catch((e) => console.error('instant boot', e));
  ioNamespace = io.of('/instant');
  ioNamespace.on('connection', (socket) => {
    // Viewer opened Instant — ensure loop is running so countdown is never stuck
    if (enabled()) {
      wakeForPresence();
    }
    socket.emit('instant_state', publicState());
    if (phase === 'DRAWING') {
      socket.emit('instant_draw_start', { ...publicState(), drawnNumbers, drawIntervalMs: 1000, resume: true, drawIndex });
    }
    socket.on('instant_sync', () => {
      if (enabled()) wakeForPresence();
      socket.emit('instant_state', publicState());
      if (phase === 'DRAWING') {
        socket.emit('instant_draw_start', { ...publicState(), drawnNumbers, drawIntervalMs: 1000, resume: true, drawIndex });
      }
    });
    socket.on('instant_watch', () => {
      if (enabled()) wakeForPresence();
      socket.emit('instant_state', publicState());
      if (phase === 'DRAWING') {
        socket.emit('instant_draw_start', { ...publicState(), drawnNumbers, drawIntervalMs: 1000, resume: true, drawIndex });
      }
    });
    socket.on('disconnect', () => {
      // Small delay so refresh/reconnect does not flash sleep
      setTimeout(() => {
        if (runtimeEcoMode && enabled() && !hasViewers() && !hasActiveRealPlayers()) {
          if (phase === 'SELECTING' || phase === 'IDLE') {
            sleepIfEcoIdle(true);
          }
        }
      }, 4000);
    });
  });
  setInterval(() => { if (phase === 'SELECTING') tickFakePlayers(); }, 8000);
  console.log('Instant Bingo shared real-time rounds ready');
}

function stopScheduler() {
  if (phaseTimer) { clearInterval(phaseTimer); phaseTimer = null; }
  if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
}

/**
 * MASTER switch — hard off. Players cannot force the game on.
 */
function adminSetMasterEnabled(on) {
  const want = !!on;
  if (!want) {
    if (hasActiveRealPlayers()) {
      const err = new Error('Cannot hard-off while real players are in this round (' + entries.size + ' player(s)).');
      err.code = 'BUSY';
      throw err;
    }
    runtimeMasterEnabled = false;
    runtimeLoopRunning = false;
    adminDisabledAt = new Date().toISOString();
    stopScheduler();
    phase = 'IDLE';
    entries.clear();
    drawnNumbers = [];
    drawIndex = 0;
    broadcast('instant_state', publicState());
    return { masterEnabled: false, enabled: false, message: 'Instant Bingo HARD OFF. Players cannot start it.' };
  }
  runtimeMasterEnabled = true;
  adminDisabledAt = null;
  // When turning master on, start loop unless eco mode prefers idle until a player joins
  if (!runtimeEcoMode) {
    runtimeLoopRunning = true;
    startSelectionPhase();
  } else {
    runtimeLoopRunning = false;
    phase = 'IDLE';
    stopScheduler();
    broadcast('instant_state', publicState());
  }
  return {
    masterEnabled: true,
    enabled: true,
    ecoMode: runtimeEcoMode,
    loopRunning: runtimeLoopRunning,
    message: runtimeEcoMode
      ? 'Master ON + Eco: waiting for a real player to start.'
      : 'Master ON + 24/7 loop running.',
  };
}

/** @deprecated alias */
function adminSetEnabled(on) { return adminSetMasterEnabled(on); }

/**
 * Eco mode: when ON, loop pauses when no real players; a join wakes it.
 * When OFF, 24/7 continuous selection/draw (while master is on).
 */
function adminSetEcoMode(on) {
  runtimeEcoMode = !!on;
  if (!enabled()) {
    broadcast('instant_state', publicState());
    return { ecoMode: runtimeEcoMode, message: 'Eco saved, but master is HARD OFF.' };
  }
  if (!runtimeEcoMode) {
    // 24/7 — ensure loop running
    runtimeLoopRunning = true;
    if (phase === 'IDLE' || !phaseTimer) startSelectionPhase();
    else broadcast('instant_state', publicState());
    return { ecoMode: false, loopRunning: true, message: '24/7 mode: loop always runs.' };
  }
  // Eco on: if no real players, pause
  if (!hasActiveRealPlayers() && phase === 'SELECTING') {
    runtimeLoopRunning = false;
    stopScheduler();
    phase = 'IDLE';
    broadcast('instant_state', publicState());
    return { ecoMode: true, loopRunning: false, message: 'Eco ON: paused until a real player joins.' };
  }
  broadcast('instant_state', publicState());
  return { ecoMode: true, loopRunning: runtimeLoopRunning, message: 'Eco ON: pauses when empty, players can wake it.' };
}

function adminSetSelectionSeconds(seconds) {
  const n = Math.max(5, Math.min(120, Number(seconds)));
  if (!Number.isFinite(n)) throw new Error('Invalid selection seconds.');
  runtimeSelectionSeconds = n;
  // If currently selecting, extend/shorten deadline relative to remaining is complex —
  // apply on next round; also nudge current if SELECTING
  if (phase === 'SELECTING' && selectionEndsAt) {
    const left = Math.max(0, selectionEndsAt - Date.now());
    // keep remaining time but clamp to new max on next full cycle; optional soft update:
    selectionEndsAt = Date.now() + Math.min(left, n * 1000);
  }
  broadcast('instant_state', publicState());
  return { selectionSeconds: selectionSeconds() };
}

function adminSetMaxCards(n) {
  runtimeMaxCards = Math.max(1, Math.min(8, Number(n) || 4));
  broadcast('instant_state', publicState());
  return { maxCardsPerPlayer: maxCardsPerPlayer() };
}

function adminSetNumbersDrawn(n) {
  runtimeNumbersDrawn = Math.max(5, Math.min(40, Number(n) || 20));
  broadcast('instant_state', publicState());
  return { numbersDrawn: numbersDrawnCount() };
}

function adminSetDifficulty(level) {
  const key = String(level || '').toLowerCase().replace(/\s+/g, '_');
  const preset = DIFFICULTY_PRESETS[key];
  if (!preset) {
    throw new Error('Invalid difficulty. Use easy, medium, hard, or super_hard.');
  }
  runtimeDifficulty = key;
  // Numbers drawn stays independent (default 20) — difficulty only shapes WHO can win
  broadcast('instant_state', publicState());
  return {
    difficulty: runtimeDifficulty,
    numbersDrawn: numbersDrawnCount(),
    targetWinRate: preset.targetWinRate,
    label: preset.label,
    hint: preset.hint,
  };
}


function adminGetWinRules() {
  return { rules: runtimeWinRules, catalog: PATTERN_CATALOG };
}

function adminSetWinRules(rules) {
  runtimeWinRules = normalizeWinRules(rules);
  broadcast('instant_state', publicState());
  return { rules: runtimeWinRules };
}

function adminGetControlState() {
  const preset = DIFFICULTY_PRESETS[runtimeDifficulty] || DIFFICULTY_PRESETS.medium;
  return {
    winRules: runtimeWinRules,

    enabled: enabled(),
    masterEnabled: enabled(),
    ecoMode: !!runtimeEcoMode,
    loopRunning: isLoopRunning(),
    phase,
    selectionSeconds: selectionSeconds(),
    maxCardsPerPlayer: maxCardsPerPlayer(),
    numbersDrawn: numbersDrawnCount(),
    difficulty: runtimeDifficulty || 'medium',
    difficultyLabel: preset.label,
    difficultyHint: preset.hint,
    difficultyPresets: DIFFICULTY_PRESETS,
    realPlayers: realPlayerCount(),
    hasActiveRealPlayers: hasActiveRealPlayers(),
    playingDisplay: fakePlayers,
    roundId: currentRoundId,
    adminDisabledAt,
    stakes: stakes(),
    secondsLeft: phase === 'SELECTING' ? Math.max(0, Math.ceil((selectionEndsAt - Date.now()) / 1000)) : 0,
    players: publicState().players || [],
  };
}

async function adminSearchHistory({ q, limit = 20, offset = 0 }) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const off = Math.max(Number(offset) || 0, 0);
  const query = String(q || '').trim();
  if (!query) {
    const r = await pool.query(
      `SELECT e.id, e.username, e.card_number, e.stake, e.paid, e.pattern, e.multiplier,
              e.prize, e.winning_cells, e.created_at, r.drawn_numbers, r.completed_at, r.id AS round_id,
              u.phone_number, u.display_name
       FROM instant_entries e
       LEFT JOIN instant_rounds r ON r.id = e.round_id
       LEFT JOIN users u ON LOWER(u.username) = LOWER(e.username)
       ORDER BY e.id DESC LIMIT $1 OFFSET $2`, [lim, off]);
    return { rows: mapAdminHistory(r.rows), hasMore: r.rows.length >= lim };
  }
  const like = '%' + query.replace(/%/g, '') + '%';
  const r = await pool.query(
    `SELECT e.id, e.username, e.card_number, e.stake, e.paid, e.pattern, e.multiplier,
            e.prize, e.winning_cells, e.created_at, r.drawn_numbers, r.completed_at, r.id AS round_id,
            u.phone_number, u.display_name
     FROM instant_entries e
     LEFT JOIN instant_rounds r ON r.id = e.round_id
     LEFT JOIN users u ON LOWER(u.username) = LOWER(e.username)
     WHERE LOWER(e.username) LIKE LOWER($1)
        OR COALESCE(u.phone_number,'') LIKE $1
        OR COALESCE(u.display_name,'') ILIKE $1
     ORDER BY e.id DESC LIMIT $2 OFFSET $3`, [like, lim, off]);
  return { rows: mapAdminHistory(r.rows), hasMore: r.rows.length >= lim };
}

function mapAdminHistory(rows) {
  return (rows || []).map((row) => ({
    id: row.id,
    username: row.username,
    phone: row.phone_number || null,
    displayName: row.display_name || null,
    cardNumber: row.card_number,
    stake: Number(row.stake),
    paid: Number(row.paid),
    pattern: row.pattern,
    multiplier: Number(row.multiplier || 0),
    prize: Number(row.prize || 0),
    winningCells: row.winning_cells || [],
    drawnNumbers: row.drawn_numbers || [],
    roundId: row.round_id,
    date: row.completed_at || row.created_at,
  }));
}

async function adminRoundHistory({ limit = 20, offset = 0 }) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const off = Math.max(Number(offset) || 0, 0);
  const r = await pool.query(
    `SELECT r.id, r.stake, r.status, r.drawn_numbers, r.created_at, r.drawn_at, r.completed_at,
            (SELECT COUNT(*) FROM instant_entries e WHERE e.round_id = r.id) AS entry_count,
            (SELECT COALESCE(SUM(e.paid),0) FROM instant_entries e WHERE e.round_id = r.id) AS total_paid,
            (SELECT COALESCE(SUM(e.prize),0) FROM instant_entries e WHERE e.round_id = r.id) AS total_prize
     FROM instant_rounds r
     ORDER BY r.id DESC LIMIT $1 OFFSET $2`, [lim, off]);
  return {
    rows: r.rows.map((row) => ({
      id: row.id,
      stake: Number(row.stake),
      status: row.status,
      drawnNumbers: row.drawn_numbers || [],
      entryCount: Number(row.entry_count || 0),
      totalPaid: Number(row.total_paid || 0),
      totalPrize: Number(row.total_prize || 0),
      house: Number(row.total_paid || 0) - Number(row.total_prize || 0),
      createdAt: row.created_at,
      drawnAt: row.drawn_at,
      completedAt: row.completed_at,
    })),
    hasMore: r.rows.length >= lim,
  };
}

async function adminStats() {
  const day = await pool.query(
    `SELECT COUNT(*)::int AS plays,
            COALESCE(SUM(paid),0)::float AS volume,
            COALESCE(SUM(prize),0)::float AS paid_out,
            COUNT(*) FILTER (WHERE prize > 0)::int AS wins
     FROM instant_entries WHERE created_at >= date_trunc('day', NOW())`);
  const all = await pool.query(
    `SELECT COUNT(*)::int AS plays,
            COALESCE(SUM(paid),0)::float AS volume,
            COALESCE(SUM(prize),0)::float AS paid_out
     FROM instant_entries`);
  const d = day.rows[0] || {};
  const a = all.rows[0] || {};
  return {
    today: { plays: d.plays || 0, volume: d.volume || 0, paidOut: d.paid_out || 0, wins: d.wins || 0, house: (d.volume || 0) - (d.paid_out || 0) },
    allTime: { plays: a.plays || 0, volume: a.volume || 0, paidOut: a.paid_out || 0, house: (a.volume || 0) - (a.paid_out || 0) },
    control: adminGetControlState(),
  };
}

module.exports = {
  enabled, ensureSchema, attachInstantGame, getStatus, wakeForPresence, sleepIfEcoIdle, listCatalog, startPlay,
  joinRound: joinSharedRound, joinSharedRound, settleRound: async () => null,
  historyForUser, getLeaderboard, getLiveSession, stopScheduler, evaluateCard, drawNumbers,
  getFakePlayers: () => fakePlayers, publicState,
  adminSetEnabled, adminSetMasterEnabled, adminSetEcoMode, adminSetSelectionSeconds, adminSetMaxCards, adminSetNumbersDrawn, adminSetDifficulty,
  adminGetControlState, adminGetWinRules, adminSetWinRules, adminSearchHistory, adminRoundHistory, adminStats,
  realPlayerCount, hasActiveRealPlayers,
};
