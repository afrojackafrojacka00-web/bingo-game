'use strict';

/**
 * Special Event Bingo — one admin-controlled traditional-style room.
 * Fixed prize (not pot). Separate settings from classic rooms & Instant.
 */

const pool = require('../../db/pool');
const { requireAdmin } = require('../../middleware/adminAuth');

let ioNamespace = null;
let phaseTimer = null;
let drawTimer = null;

/** @type {'IDLE'|'COUNTDOWN'|'OPEN'|'SELECTING'|'PLAYING'|'ENDED'} */
let phase = 'IDLE';
let selectionEndsAt = 0;
let countdownEndsAt = 0;
let currentSessionId = null;
let drawn = new Set();
let drawOrder = [];
let drawIndex = 0;
let lastNumber = null;
let winnerPayload = null;

// players: username -> { userId, cards: number[], paid }
const entries = new Map();
const cardOwners = new Map(); // cardNumber -> username

const DEFAULTS = {
  visible: false,
  stake: 50,
  prize: 5000,
  gameTypeLabel: 'Full House',
  promoText: 'big win today',
  winningPattern: 'any_one_line',
  drawIntervalSeconds: 4,
  selectionSeconds: 60,
  endedMessage: 'Game ended for today. Enjoy Classic & Instant Bingo until next time!',
};

let settings = { ...DEFAULTS };

// ---- Patterns (same family as classic bingo) ----
const ROWS = [
  [[0,0],[0,1],[0,2],[0,3],[0,4]],[[1,0],[1,1],[1,2],[1,3],[1,4]],[[2,0],[2,1],[2,2],[2,3],[2,4]],
  [[3,0],[3,1],[3,2],[3,3],[3,4]],[[4,0],[4,1],[4,2],[4,3],[4,4]],
];
const COLS = [
  [[0,0],[1,0],[2,0],[3,0],[4,0]],[[0,1],[1,1],[2,1],[3,1],[4,1]],[[0,2],[1,2],[2,2],[3,2],[4,2]],
  [[0,3],[1,3],[2,3],[3,3],[4,3]],[[0,4],[1,4],[2,4],[3,4],[4,4]],
];
const DIAGS = [[[0,0],[1,1],[2,2],[3,3],[4,4]],[[0,4],[1,3],[2,2],[3,1],[4,0]]];
const CORNERS = [[0,0],[0,4],[4,0],[4,4]];

// Same pattern catalog / rules family as traditional bingo
const PATTERN_NAMES = {
  any_one_line: 'Any One Line',
  any_two_lines: 'Any Two Lines',
  any_square: 'Any Square (2×2)',
  full: 'Full House',
  N: 'N', H: 'H', 'Reverse H': 'Reverse H', Z: 'Z', K: 'K', E: 'E',
  'Three Horizontal Lines': 'Three Horizontal Lines',
  'Three Vertical Lines': 'Three Vertical Lines',
  '5': '5', M: 'M', cross: 'Cross',
  vertical_line: 'One Vertical Line', horizontal_line: 'One Horizontal Line',
  'Five Dots': 'Five Dots', x: 'X', t: 'T', reverse_t: 'Reverse T',
  big_l: 'Big L', reverse_l: 'Reverse L',
  'Top Triangle': 'Top Triangle', 'Bottom Triangle': 'Bottom Triangle',
  half_above: 'Half Above', half_below: 'Half Below',
};

const ANY_ONE_LINE_PATTERNS = ROWS.concat(COLS).concat(DIAGS).concat([
  CORNERS,
  [[1,1],[3,1],[1,3],[3,3]],
  [[2,1],[1,2],[2,2],[3,2],[2,3]],
]);
const ANY_TWO_LINE_PATTERNS = ROWS.concat(COLS).concat(DIAGS).concat([
  CORNERS,
  [[1,1],[3,1],[1,3],[3,3]],
]);
const FIXED_PATTERNS = {
  N: [[0,0],[1,0],[2,0],[3,0],[4,0],[1,1],[2,2],[3,3],[4,4],[0,4],[1,4],[2,4],[3,4]],
  H: [[0,0],[1,0],[2,0],[3,0],[4,0],[2,1],[2,2],[2,3],[0,4],[1,4],[2,4],[3,4],[4,4]],
  'Reverse H': [[0,0],[0,1],[0,2],[0,3],[0,4],[1,2],[2,2],[3,2],[4,0],[4,1],[4,2],[4,3],[4,4]],
  Z: [[0,0],[0,1],[0,2],[0,3],[0,4],[1,3],[2,2],[3,1],[4,0],[4,1],[4,2],[4,3],[4,4]],
  K: [[0,0],[1,0],[2,0],[3,0],[4,0],[0,3],[1,2],[2,1],[3,2],[4,3]],
  E: [[0,0],[1,0],[2,0],[3,0],[4,0],[0,1],[0,2],[0,3],[0,4],[2,1],[2,2],[2,3],[2,4],[4,1],[4,2],[4,3],[4,4]],
  'Three Horizontal Lines': [[0,0],[2,0],[4,0],[0,1],[0,2],[0,3],[0,4],[2,1],[2,2],[2,3],[2,4],[4,1],[4,2],[4,3],[4,4]],
  'Three Vertical Lines': [[0,0],[1,0],[2,0],[3,0],[4,0],[0,2],[1,2],[2,2],[3,2],[4,2],[0,4],[1,4],[2,4],[3,4],[4,4]],
  '5': [[0,0],[1,0],[2,0],[3,4],[4,0],[0,1],[0,2],[0,3],[0,4],[2,1],[2,2],[2,3],[2,4],[4,1],[4,2],[4,3],[4,4]],
  M: [[0,0],[1,0],[2,0],[3,0],[4,0],[1,1],[2,2],[1,3],[0,4],[1,4],[2,4],[3,4],[4,4]],
  cross: [[2,0],[2,1],[3,2],[2,4],[2,2],[0,2],[1,2],[2,3],[4,2]],
  vertical_line: [[0,2],[1,2],[2,2],[3,2],[4,2]],
  'Five Dots': [[0,0],[0,4],[2,2],[4,0],[4,4]],
  horizontal_line: [[2,0],[2,1],[2,2],[2,3],[2,4]],
  full: (function(){ const a=[]; for(let r=0;r<5;r++) for(let c=0;c<5;c++) a.push([r,c]); return a; })(),
  x: [[0,0],[1,1],[2,2],[3,3],[4,4],[0,4],[1,3],[3,1],[4,0]],
  t: [[0,0],[0,1],[0,2],[0,3],[0,4],[1,2],[2,2],[3,2],[4,2]],
  reverse_t: [[4,0],[4,1],[4,2],[4,3],[4,4],[0,2],[1,2],[2,2],[3,2]],
  big_l: [[0,0],[1,0],[2,0],[3,0],[4,0],[4,1],[4,2],[4,3],[4,4]],
  reverse_l: [[0,4],[1,4],[2,4],[3,4],[4,4],[4,0],[4,1],[4,2],[4,3]],
  'Top Triangle': [[0,0],[1,0],[2,0],[3,0],[4,0],[0,1],[1,1],[2,1],[3,1],[0,2],[1,2],[2,2],[0,3],[1,3],[0,4]],
  'Bottom Triangle': [[4,0],[4,1],[4,2],[4,3],[4,4],[3,1],[3,2],[3,3],[3,4],[2,2],[2,3],[2,4],[1,3],[1,4],[0,4]],
  half_above: [[0,0],[0,1],[0,2],[0,3],[0,4],[1,0],[1,1],[1,2],[1,3],[1,4],[2,0],[2,1],[2,2],[2,3],[2,4]],
  half_below: [[2,0],[2,1],[2,2],[2,3],[2,4],[3,0],[3,1],[3,2],[3,3],[3,4],[4,0],[4,1],[4,2],[4,3],[4,4]],
};

function getPatternCells(pattern) {
  if (pattern === 'any_one_line') return ANY_ONE_LINE_PATTERNS;
  if (pattern === 'any_two_lines') return ANY_TWO_LINE_PATTERNS;
  if (pattern === 'any_square') {
    const out = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out.push([[r,c],[r,c+1],[r+1,c],[r+1,c+1]]);
    return out;
  }
  if (FIXED_PATTERNS[pattern]) return [FIXED_PATTERNS[pattern]];
  return ANY_ONE_LINE_PATTERNS;
}

function cellHit(grid, r, c, drawnSet) {
  const v = grid[r][c];
  return v === 'FREE' || v === 0 || (r === 2 && c === 2) || drawnSet.has(Number(v));
}

function lineDone(grid, drawnSet, cells) {
  return cells.every(([r, c]) => cellHit(grid, r, c, drawnSet));
}

function winningClaim(grid, drawnSet, pattern, latest) {
  const patterns = getPatternCells(pattern);
  if (pattern === 'any_two_lines') {
    const done = patterns.filter((cells) => lineDone(grid, drawnSet, cells));
    if (done.length < 2) return { ok: false };
    for (let i = 0; i < done.length; i++) {
      for (let j = i + 1; j < done.length; j++) {
        const map = new Map();
        done[i].concat(done[j]).forEach((p) => map.set(p.join(','), p));
        const cells = [...map.values()];
        if (latest && cells.some(([r, c]) => Number(grid[r][c]) === Number(latest))) {
          return { ok: true, cells };
        }
      }
    }
    return { ok: false };
  }
  for (const cells of patterns) {
    if (!lineDone(grid, drawnSet, cells)) continue;
    if (latest && cells.some(([r, c]) => Number(grid[r][c]) === Number(latest))) {
      return { ok: true, cells };
    }
  }
  return { ok: false };
}

// ---- Schema / settings ----
async function ensureSchema() {
  const steps = [
    `CREATE TABLE IF NOT EXISTS special_event_settings (
      id INT PRIMARY KEY DEFAULT 1,
      visible BOOLEAN DEFAULT FALSE,
      stake NUMERIC(12,2) DEFAULT 50,
      prize NUMERIC(12,2) DEFAULT 5000,
      game_type_label TEXT DEFAULT 'Full House',
      promo_text TEXT DEFAULT 'big win today',
      winning_pattern TEXT DEFAULT 'any_one_line',
      draw_interval_seconds INT DEFAULT 4,
      selection_seconds INT DEFAULT 60,
      countdown_ends_at TIMESTAMPTZ,
      ended_message TEXT DEFAULT 'Game ended for today. Enjoy Classic & Instant Bingo until next time!',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    `INSERT INTO special_event_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
    `CREATE TABLE IF NOT EXISTS special_event_sessions (
      id SERIAL PRIMARY KEY,
      status TEXT NOT NULL,
      stake NUMERIC(12,2) NOT NULL,
      prize NUMERIC(12,2) NOT NULL,
      winning_pattern TEXT,
      draw_interval_seconds INT,
      player_count INT DEFAULT 0,
      card_count INT DEFAULT 0,
      total_paid NUMERIC(12,2) DEFAULT 0,
      house_profit NUMERIC(12,2) DEFAULT 0,
      winners JSONB,
      drawn_numbers JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ
    )`,
    `CREATE TABLE IF NOT EXISTS special_event_entries (
      id SERIAL PRIMARY KEY,
      session_id INT REFERENCES special_event_sessions(id) ON DELETE CASCADE,
      user_id INT,
      username TEXT NOT NULL,
      cards INT[] NOT NULL,
      card_count INT NOT NULL,
      amount_paid NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  ];
  for (const sql of steps) {
    try { await pool.query(sql); }
    catch (e) {
      if (e && (e.code === '23505' || e.code === '42P07' || /already exists/i.test(String(e.message)))) continue;
      console.error('special schema', e.message);
    }
  }
}

async function loadSettings() {
  try {
    const r = await pool.query(`SELECT * FROM special_event_settings WHERE id=1`);
    if (!r.rowCount) return;
    const row = r.rows[0];
    settings = {
      visible: !!row.visible,
      stake: Number(row.stake) || DEFAULTS.stake,
      prize: Number(row.prize) || DEFAULTS.prize,
      gameTypeLabel: row.game_type_label || DEFAULTS.gameTypeLabel,
      promoText: row.promo_text || DEFAULTS.promoText,
      winningPattern: row.winning_pattern || DEFAULTS.winningPattern,
      drawIntervalSeconds: Number(row.draw_interval_seconds) || DEFAULTS.drawIntervalSeconds,
      selectionSeconds: Number(row.selection_seconds) || DEFAULTS.selectionSeconds,
      endedMessage: row.ended_message || DEFAULTS.endedMessage,
    };
    if (row.countdown_ends_at) {
      countdownEndsAt = new Date(row.countdown_ends_at).getTime();
    }
  } catch (e) {
    console.error('special loadSettings', e.message);
  }
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await pool.query(
    `UPDATE special_event_settings SET
      visible=$1, stake=$2, prize=$3, game_type_label=$4, promo_text=$5,
      winning_pattern=$6, draw_interval_seconds=$7, selection_seconds=$8,
      countdown_ends_at=$9, ended_message=$10, updated_at=NOW()
     WHERE id=1`,
    [
      !!settings.visible,
      settings.stake,
      settings.prize,
      settings.gameTypeLabel,
      settings.promoText,
      settings.winningPattern,
      settings.drawIntervalSeconds,
      settings.selectionSeconds,
      countdownEndsAt ? new Date(countdownEndsAt) : null,
      settings.endedMessage,
    ]
  );
}

function broadcast(event, payload) {
  if (ioNamespace) ioNamespace.emit(event, payload || publicState());
}

function openJoiningPhase() {
  // Home countdown finished → joining/selection timer starts for everyone (even 0 players)
  phase = 'SELECTING';
  const sec = Math.max(15, Number(settings.selectionSeconds) || 60);
  // Anchor to scheduled end so all clients share the same deadline
  const base = countdownEndsAt && countdownEndsAt > 0 ? countdownEndsAt : Date.now();
  selectionEndsAt = base + sec * 1000;
  if (selectionEndsAt < Date.now()) {
    // Already past joining window
    selectionEndsAt = Date.now(); // tick will end immediately
  }
}

function publicState() {
  const now = Date.now();
  // Auto-open when event countdown has finished (absolute DB timestamp)
  if (phase === 'COUNTDOWN' && countdownEndsAt && now >= countdownEndsAt) {
    openJoiningPhase();
  }
  let countdownLeft = 0;
  if (phase === 'COUNTDOWN' && countdownEndsAt) {
    countdownLeft = Math.max(0, Math.ceil((countdownEndsAt - now) / 1000));
  }
  let selectionLeft = 0;
  if ((phase === 'OPEN' || phase === 'SELECTING') && selectionEndsAt) {
    selectionLeft = Math.max(0, Math.ceil((selectionEndsAt - now) / 1000));
  }
  const players = [];
  for (const [username, ent] of entries.entries()) {
    players.push({ username, cards: ent.cards, paid: ent.paid });
  }
  return {
    visible: !!settings.visible,
    phase,
    stake: settings.stake,
    prize: settings.prize,
    gameTypeLabel: settings.gameTypeLabel,
    promoText: settings.promoText,
    winningPattern: settings.winningPattern,
    patternName: PATTERN_NAMES[settings.winningPattern] || settings.winningPattern,
    drawIntervalSeconds: settings.drawIntervalSeconds,
    selectionSeconds: settings.selectionSeconds,
    countdownEndsAt: countdownEndsAt ? new Date(countdownEndsAt).toISOString() : null,
    countdownLeft,
    selectionEndsAt: selectionEndsAt ? new Date(selectionEndsAt).toISOString() : null,
    selectionLeft,
    sessionId: currentSessionId,
    playerCount: entries.size,
    cardCount: cardOwners.size,
    drawn: [...drawn],
    lastNumber,
    drawIndex,
    totalNumbers: drawOrder.length || 75,
    winner: winnerPayload,
    endedMessage: settings.endedMessage,
    canJoin: phase === 'OPEN' || phase === 'SELECTING',
    canPlayHome: phase === 'OPEN' || phase === 'SELECTING',
    lateMessage: phase === 'PLAYING' || phase === 'ENDED'
      ? (phase === 'PLAYING'
        ? 'The special game has already started. Come back next time!'
        : settings.endedMessage)
      : null,
    players,
    joinedPlayers: entries.size,
    takenCards: [...cardOwners.keys()].map(Number),
    serverNow: now,
  };
}

function stopTimers() {
  if (phaseTimer) { clearInterval(phaseTimer); phaseTimer = null; }
  if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
}

function shuffledNumbers() {
  const bag = [];
  for (let n = 1; n <= 75; n++) bag.push(n);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
  }
  return bag;
}

let _startingGame = false;

function tickLoop() {
  const now = Date.now();
  if (phase === 'COUNTDOWN' && countdownEndsAt && now >= countdownEndsAt) {
    entries.clear();
    cardOwners.clear();
    drawn.clear();
    drawOrder = [];
    drawIndex = 0;
    lastNumber = null;
    winnerPayload = null;
    currentSessionId = null;
    _startingGame = false;
    openJoiningPhase();
    broadcast('special_state', publicState());
    return;
  }
  // Joining window over (or stuck "Starting…" with deadline already cleared)
  const joiningOver = (phase === 'OPEN' || phase === 'SELECTING') && (
    (selectionEndsAt && now >= selectionEndsAt) ||
    (!selectionEndsAt && phase === 'SELECTING' && !_startingGame && !drawTimer)
  );
  if (joiningOver && !_startingGame) {
    selectionEndsAt = 0;
    _startingGame = true;
    if (entries.size === 0) {
      endWithNoPlayers()
        .catch((e) => console.error('special endWithNoPlayers', e))
        .finally(() => { _startingGame = false; });
    } else {
      beginPlaying()
        .catch((e) => console.error('special beginPlaying', e))
        .finally(() => { _startingGame = false; });
    }
    return;
  }
  if (phase === 'COUNTDOWN' || phase === 'OPEN' || phase === 'SELECTING') {
    broadcast('special_state', publicState());
  }
}

async function endWithNoPlayers() {
  if (phase === 'ENDED' || phase === 'PLAYING') return;
  if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
  phase = 'ENDED';
  winnerPayload = null;
  try {
    await pool.query(
      `INSERT INTO special_event_sessions
        (status, stake, prize, winning_pattern, draw_interval_seconds, player_count, card_count, total_paid, house_profit, started_at, completed_at)
       VALUES ('COMPLETED',$1,$2,$3,$4,0,0,0,0,NOW(),NOW())`,
      [settings.stake, settings.prize, settings.winningPattern, settings.drawIntervalSeconds]
    );
  } catch (e) {
    console.error('special empty session', e.message);
  }
  broadcast('special_ended', publicState());
  broadcast('special_state', publicState());
}

async function beginPlaying() {

  if (phase === 'PLAYING') return;
  stopTimers();

  if (entries.size === 0) {
    // Nobody joined — end event
    phase = 'ENDED';
    broadcast('special_state', publicState());
    broadcast('special_ended', publicState());
    return;
  }

  phase = 'PLAYING';
  // Stop joining timer only; draw timer started below
  if (phaseTimer) { clearInterval(phaseTimer); phaseTimer = null; }
  if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }

  let totalPaid = 0;
  let cardCount = 0;
  for (const ent of entries.values()) {
    totalPaid += Number(ent.paid) || 0;
    cardCount += (ent.cards || []).length;
  }
  const house = Math.max(0, totalPaid - Number(settings.prize));

  try {
    const ins = await pool.query(
      `INSERT INTO special_event_sessions
        (status, stake, prize, winning_pattern, draw_interval_seconds, player_count, card_count, total_paid, house_profit, started_at)
       VALUES ('PLAYING',$1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING id`,
      [settings.stake, settings.prize, settings.winningPattern, settings.drawIntervalSeconds,
        entries.size, cardCount, totalPaid, house]
    );
    currentSessionId = ins.rows[0].id;
    for (const [username, ent] of entries.entries()) {
      await pool.query(
        `INSERT INTO special_event_entries (session_id, user_id, username, cards, card_count, amount_paid)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [currentSessionId, ent.userId, username, ent.cards, ent.cards.length, ent.paid]
      );
    }
  } catch (e) {
    console.error('special session insert', e.message);
    currentSessionId = Date.now();
  }

  drawOrder = shuffledNumbers();
  drawIndex = 0;
  drawn.clear();
  lastNumber = null;
  winnerPayload = null;

  broadcast('special_game_started', publicState());
  broadcast('special_state', publicState());

  const intervalMs = Math.max(1500, (Number(settings.drawIntervalSeconds) || 4) * 1000);
  drawTimer = setInterval(() => {
    if (phase !== 'PLAYING') return;
    if (drawIndex >= drawOrder.length) {
      // Exhausted — end with no winner claim
      endGame(null).catch((e) => console.error(e));
      return;
    }
    const num = drawOrder[drawIndex];
    drawIndex += 1;
    drawn.add(num);
    lastNumber = num;
    broadcast('special_number', {
      number: num,
      index: drawIndex,
      total: drawOrder.length,
      drawn: [...drawn],
      state: publicState(),
    });
  }, intervalMs);
}

async function endGame(winners) {
  if (phase === 'ENDED') return;
  stopTimers();
  phase = 'ENDED';

  const list = Array.isArray(winners) ? winners : [];
  winnerPayload = {
    winners: list,
    prize: settings.prize,
    prizeEach: list.length ? Number((settings.prize / list.length).toFixed(2)) : 0,
  };

  // Pay winners
  if (list.length && currentSessionId) {
    const each = Number((settings.prize / list.length).toFixed(2));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const w of list) {
        const ent = entries.get(w.username);
        if (!ent) continue;
        await client.query(`UPDATE users SET balance = balance + $1 WHERE id=$2`, [each, ent.userId]);
        await client.query(
          `INSERT INTO transactions(user_id, amount, type) VALUES ($1,$2,'SPECIAL_EVENT_WIN')`,
          [ent.userId, each]
        );
      }
      await client.query(
        `UPDATE special_event_sessions SET status='COMPLETED', winners=$1::jsonb, drawn_numbers=$2::jsonb, completed_at=NOW() WHERE id=$3`,
        [JSON.stringify(winnerPayload), JSON.stringify([...drawn]), currentSessionId]
      );
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      console.error('special pay winners', e.message);
    } finally {
      client.release();
    }
  } else if (currentSessionId) {
    try {
      await pool.query(
        `UPDATE special_event_sessions SET status='COMPLETED', winners=$1::jsonb, drawn_numbers=$2::jsonb, completed_at=NOW() WHERE id=$3`,
        [JSON.stringify(winnerPayload), JSON.stringify([...drawn]), currentSessionId]
      );
    } catch (_) {}
  }

  broadcast('special_ended', publicState());
  broadcast('special_state', publicState());
}

async function getCardGrid(cardNumber) {
  const r = await pool.query('SELECT grid FROM bingo_cards WHERE card_number=$1', [cardNumber]);
  return r.rowCount ? r.rows[0].grid : null;
}

async function joinWithCards({ username, cardNumbers }) {
  if (phase !== 'OPEN' && phase !== 'SELECTING') {
    const err = new Error(phase === 'PLAYING' || phase === 'ENDED'
      ? 'The special game has already started. Come back next time!'
      : 'Special game is not open yet.');
    err.code = 'CLOSED';
    throw err;
  }
  // Already READY — no more card changes (same as traditional)
  if (entries.has(username)) {
    const err = new Error('You are already READY. Cards are locked.');
    err.code = 'LOCKED';
    throw err;
  }
  const cards = [...new Set((cardNumbers || []).map(Number))].filter((n) => n > 0);
  if (!cards.length) throw new Error('Select at least one card.');
  if (cards.length > 50) throw new Error('Too many cards.');

  for (const c of cards) {
    const owner = cardOwners.get(c);
    if (owner && owner !== username) throw new Error('Card #' + c + ' is taken.');
  }
  // Reserve immediately (sync) so two players cannot take the same card
  for (const c of cards) {
    if (cardOwners.has(c) && cardOwners.get(c) !== username) {
      throw new Error('Card #' + c + ' is taken.');
    }
    cardOwners.set(c, username);
  }

  const stake = Number(settings.stake);
  const totalCost = Number((stake * cards.length).toFixed(2));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query(`SELECT id, balance FROM users WHERE LOWER(username)=LOWER($1) FOR UPDATE`, [username]);
    if (!user.rowCount) throw new Error('User not found.');
    const userId = user.rows[0].id;

    const charge = await client.query(
      `UPDATE users SET balance = balance - $1 WHERE id=$2 AND balance >= $1 RETURNING balance`,
      [totalCost, userId]
    );
    if (!charge.rowCount) throw new Error('Insufficient balance.');
    await client.query(`INSERT INTO transactions(user_id,amount,type) VALUES ($1,$2,'SPECIAL_EVENT_BUY')`, [userId, -totalCost]);
    await client.query('COMMIT');

    entries.set(username, { userId, cards, paid: totalCost, ready: true });

    if (phase === 'OPEN') phase = 'SELECTING';
    if (!selectionEndsAt) {
      selectionEndsAt = Date.now() + (Number(settings.selectionSeconds) || 60) * 1000;
    }

    broadcast('special_state', publicState());
    return {
      success: true,
      balance: Number(charge.rows[0].balance),
      cards,
      paid: totalCost,
      state: publicState(),
    };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    // Release reservation if READY failed
    cards.forEach((c) => { if (cardOwners.get(c) === username) cardOwners.delete(c); });
    throw e;
  } finally {
    client.release();
  }
}

async function claimWin({ username, cardNumber }) {
  if (phase !== 'PLAYING') throw new Error('No active special game.');
  const ent = entries.get(username);
  if (!ent || !(ent.cards || []).includes(Number(cardNumber))) throw new Error('Not your card.');
  const grid = await getCardGrid(cardNumber);
  if (!grid) throw new Error('Card not found.');
  const result = winningClaim(grid, drawn, settings.winningPattern, lastNumber);
  if (!result.ok) throw new Error('Not a valid win on the latest number.');

  // Collect all valid claims on same number within a short window — for simplicity pay this winner;
  // if multiple claim almost together, split fixed prize among unique usernames who claimed validly.
  // Simple approach: first valid claim locks; scan all cards of all players for same latest number.
  const winners = [];
  for (const [uname, e] of entries.entries()) {
    for (const cn of e.cards || []) {
      const g = await getCardGrid(cn);
      if (!g) continue;
      const w = winningClaim(g, drawn, settings.winningPattern, lastNumber);
      if (w.ok) {
        winners.push({ username: uname, cardNumber: cn, cells: w.cells });
      }
    }
  }
  // Unique by username for payout split
  const byUser = new Map();
  winners.forEach((w) => { if (!byUser.has(w.username)) byUser.set(w.username, w); });
  await endGame([...byUser.values()]);
  return { success: true, winners: [...byUser.values()], state: publicState() };
}

// ---- Admin ----
async function adminGet() {
  return { ...publicState(), settings: { ...settings }, patternOptions: PATTERN_NAMES };
}

async function adminUpdate(body) {
  const patch = {};
  if (body.visible != null) patch.visible = !!body.visible;
  if (body.stake != null) patch.stake = Math.max(1, Number(body.stake));
  if (body.prize != null) patch.prize = Math.max(0, Number(body.prize));
  if (body.gameTypeLabel != null) patch.gameTypeLabel = String(body.gameTypeLabel).slice(0, 80);
  if (body.promoText != null) patch.promoText = String(body.promoText).slice(0, 120);
  if (body.winningPattern != null && (PATTERN_NAMES[body.winningPattern] || body.winningPattern === 'full')) patch.winningPattern = body.winningPattern;
  if (body.drawIntervalSeconds != null) patch.drawIntervalSeconds = Math.max(1, Math.min(30, Number(body.drawIntervalSeconds)));
  if (body.selectionSeconds != null) patch.selectionSeconds = Math.max(15, Math.min(300, Number(body.selectionSeconds)));
  if (body.endedMessage != null) patch.endedMessage = String(body.endedMessage).slice(0, 240);

  // Schedule countdown: hours + minutes from now
  if (body.countdownHours != null || body.countdownMinutes != null || body.countdownEndsAt != null) {
    if (body.countdownEndsAt) {
      countdownEndsAt = new Date(body.countdownEndsAt).getTime();
    } else {
      const h = Number(body.countdownHours) || 0;
      const m = Number(body.countdownMinutes) || 0;
      countdownEndsAt = Date.now() + (h * 3600 + m * 60) * 1000;
    }
    if (phase === 'IDLE' || phase === 'ENDED' || phase === 'COUNTDOWN') {
      phase = 'COUNTDOWN';
      entries.clear();
      cardOwners.clear();
      stopTimers();
      if (drawTimer) { clearInterval(drawTimer); drawTimer = null; }
    }
  }

  if (body.startOpenNow) {
    countdownEndsAt = Date.now();
    entries.clear();
    cardOwners.clear();
    drawn.clear();
    winnerPayload = null;
    openJoiningPhase();
  }

  if (body.resetEnded) {
    phase = 'IDLE';
    countdownEndsAt = 0;
    selectionEndsAt = 0;
    entries.clear();
    cardOwners.clear();
    drawn.clear();
    winnerPayload = null;
    currentSessionId = null;
    stopTimers();
  }

  await saveSettings(patch);
  broadcast('special_state', publicState());
  return adminGet();
}

function attachSpecialGame(io) {
  ensureSchema()
    .then(() => loadSettings())
    .then(() => {
      if (settings.visible && countdownEndsAt && countdownEndsAt > Date.now()) {
        phase = 'COUNTDOWN';
      } else if (settings.visible && countdownEndsAt && countdownEndsAt <= Date.now() && phase === 'IDLE') {
        phase = 'OPEN';
      }
      phaseTimer = setInterval(tickLoop, 1000);
      console.log('Special Event Bingo ready');
    })
    .catch((e) => console.error('special boot', e));

  ioNamespace = io.of('/special');
  ioNamespace.on('connection', (socket) => {
    socket.emit('special_state', publicState());
    socket.on('special_sync', () => socket.emit('special_state', publicState()));
  });
}

module.exports = {
  ensureSchema,
  attachSpecialGame,
  publicState,
  joinWithCards,
  claimWin,
  getCardGrid,
  adminGet,
  adminUpdate,
  PATTERN_NAMES,
};
