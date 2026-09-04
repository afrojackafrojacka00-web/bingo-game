'use strict';

const pool = require('../db/pool');
const config = require('../config');
const { requireAdmin } = require('../middleware/adminAuth');
const cache = require('../cache/memory');

/**
 * Attach multi-room game engine: in-memory rooms, draw loop, sockets, and
 * game-related HTTP routes (admin games, rake, game-state, settings).
 *
 * @param {object} opts
 * @param {import('express').Application} opts.app
 * @param {import('socket.io').Server} opts.io
 * @param {number[]} opts.STAKES
 * @param {number} opts.ROUND_SECONDS
 * @param {number} opts.MIN_PLAYERS
 * @param {function} opts.splitPot  optional override
 * @param {function} opts.getRoomCutPercent optional override
 */
function attachGameEngine({ app, io, STAKES, ROUND_SECONDS, MIN_PLAYERS, splitPot: splitPotFn, getRoomCutPercent: getCutFn }) {
  // Prefer injected helpers; fall back to outer names if engine body redefines
  var splitPot = splitPotFn;
  var getRoomCutPercent = getCutFn;

// -------------------- HIGH-CONCURRENCY MULTI-ROOM GAME ENGINE --------------------
const DEFAULT_GAME_PATTERN = 'any_one_line';
const DEFAULT_DRAW_INTERVAL_SECONDS = Number(process.env.DEFAULT_DRAW_INTERVAL_SECONDS || 4);
const DRAW_INTERVAL_MS = Number(process.env.DRAW_INTERVAL_MS || 2500); // legacy fallback
const ROOM_BROADCAST_MS = 250;
const MAX_CARDS_PER_PLAYER = Number(process.env.MAX_CARDS_PER_PLAYER || 500);

function createRoom(stake) {
    return {
        stake,
        status: 'WAITING',
        deadline: null,
        gameId: null,
        players: new Set(),
        selectedCards: new Map(),
        cardOwners: new Map(), // cardNumber -> username, O(1) "is this card taken" lookups
        readyPlayers: new Set(),
        playerPaid: new Map(),
        playerBalanceCache: new Map(), // soft pre-check only; the real charge at READY is authoritative
        drawn: new Set(),
        drawOrder: [],
        drawTimer: null,
        drawIndex: 0,
        lastTickSecond: null,
        winningPattern: DEFAULT_GAME_PATTERN,
        drawIntervalSeconds: DEFAULT_DRAW_INTERVAL_SECONDS,
        claimLockedCards: new Set(),
        lastNumber: null,
        winnerPayload: null,
        dirty: false, // set true by high-frequency actions; flushed by the shared broadcaster
        // Frozen once the game starts, so a player leaving mid-game never
        // changes what everyone else sees or what the winner gets paid.
        frozenTotalCards: null,
        frozenPrizePool: null,
        frozenCutPercent: 20,
        frozenHouseCut: 0,
        frozenWinnerPrize: 0
    };
}

const gameRooms = new Map(STAKES.map(stake => [stake, createRoom(stake)]));

function remainingSeconds(room) {
    if (room.status !== 'JOINING' || !room.deadline) {
        return room.status === 'WAITING' ? ROUND_SECONDS : 0;
    }
    return Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000));
}

function userCards(room, username) {
    return room.selectedCards.get(username) || new Set();
}

function getPlayerPaid(room, username) {
    return Number(room.playerPaid.get(username) || 0);
}

function setPlayerPaid(room, username, amount) {
    room.playerPaid.set(username, Number(amount));
}

function roomSnapshot(room) {
    const takenCards = [];
    for (const cards of room.selectedCards.values()) {
        takenCards.push(...Array.from(cards));
    }

    // Once a game is underway, the card/prize totals are frozen (see
    // startRoomGame). A player leaving mid-game must never change these
    // numbers for everyone else, and must never shrink the winner's payout.
    const isLiveGame = room.status === 'PLAYING' || room.status === 'FINISHING';
    let totalCards;
    if (isLiveGame && room.frozenTotalCards != null) {
        totalCards = room.frozenTotalCards;
    } else {
        totalCards = 0;
        for (const username of room.readyPlayers) {
            totalCards += userCards(room, username).size;
        }
    }
    
    
    const grossPrizePool = (isLiveGame && room.frozenPrizePool != null)
        ? room.frozenPrizePool
        : Number((totalCards * room.stake).toFixed(2));

    // While a game is live, show the winner payout (after house cut), not the full pot.
    // Lobby (JOINING/WAITING) still shows the full pot because cut is only locked at start.
    const prizePool = (isLiveGame && room.frozenWinnerPrize != null)
        ? Number(room.frozenWinnerPrize)
        : grossPrizePool;

    return {
        stake: room.stake,
        status: room.status,
        timer: remainingSeconds(room),
        deadline: room.deadline,
        serverNow: Date.now(),
        players: room.players.size,
        readyPlayers: room.readyPlayers.size,
        totalCards,
        winningPattern: room.winningPattern,
        drawIntervalSeconds: room.drawIntervalSeconds,
        prizePool,
        grossPrizePool,
        houseCut: isLiveGame && room.frozenHouseCut != null ? Number(room.frozenHouseCut) : 0,
        cutPercent: isLiveGame && room.frozenCutPercent != null ? Number(room.frozenCutPercent) : null,
        gameId: room.gameId,
        takenCards,
        lastNumber: room.lastNumber || null
    };
}

function allRoomsSnapshot() {
    return STAKES.map(stake => roomSnapshot(gameRooms.get(stake)));
}

function emitRoomsState() {
    io.emit('rooms_state', allRoomsSnapshot());
}

function roomName(stake) {
    return `stake_${stake}`;
}

async function getUserIdAndBalance(username, client = pool, lock = true) {
    const lockSql = lock ? ' FOR UPDATE' : '';
    const result = await client.query(
        `SELECT id, username, balance FROM users WHERE LOWER(username)=LOWER($1)${lockSql}`,
        [username]
    );
    return result.rows[0] || null;
}

// Card selection can fire hundreds of times a second across all rooms, so
// this path is written to cost as few DB round trips as possible: the
// balance check and the deduction happen in one atomic UPDATE (no separate
// SELECT ... FOR UPDATE lock step), and the caller gets the fresh balance
// back from the same statement instead of needing another query.
async function chargePlayer(username, amount, type) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE users SET balance = balance - $1
             WHERE LOWER(username) = LOWER($2) AND balance >= $1
             RETURNING id, balance`,
            [amount, username]
        );

        if (!result.rowCount) {
            const exists = await client.query(
                'SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)',
                [username]
            );
            await client.query('ROLLBACK');
            throw new Error(exists.rowCount ? 'Insufficient balance.' : 'User not found.');
        }

        const { id, balance } = result.rows[0];
        await client.query(
            'INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',
            [id, -Number(amount), type]
        );
        await client.query('COMMIT');

        return { balance: Number(balance) };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* connection already rolled back */ }
        throw err;
    } finally {
        client.release();
    }
}

async function refundAmount(username, amount, reason) {
    amount = Number(amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            `UPDATE users SET balance = balance + $1
             WHERE LOWER(username) = LOWER($2)
             RETURNING id, balance`,
            [amount, username]
        );

        if (!result.rowCount) {
            await client.query('ROLLBACK');
            throw new Error('User not found');
        }

        const { id, balance } = result.rows[0];
        await client.query(
            'INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',
            [id, amount, reason]
        );
        await client.query('COMMIT');
        return Number(balance);
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) { /* connection already rolled back */ }
        throw err;
    } finally {
        client.release();
    }
}

async function refundPlayerRoomPayment(room, username, reason) {
    const amount = getPlayerPaid(room, username);
    if (amount <= 0) return;
    await refundAmount(username, amount, reason);
    room.playerPaid.set(username, 0);
}

function removePlayer(room, username) {
    room.players.delete(username);
    room.readyPlayers.delete(username);
    const cards = room.selectedCards.get(username);
    if (cards) {
        for (const cardNumber of cards) {
            if (room.cardOwners.get(cardNumber) === username) {
                room.cardOwners.delete(cardNumber);
            }
        }
    }
    room.selectedCards.delete(username);
    room.playerPaid.delete(username);
    room.playerBalanceCache.delete(username);
}

function clearDrawTimer(room) {
    if (room.drawTimer) clearInterval(room.drawTimer);
    room.drawTimer = null;
}

async function resetRoom(room, message = null) {
    clearDrawTimer(room);
    room.status = 'WAITING';
    room.deadline = null;
    room.gameId = null;
    room.players.clear();
    room.selectedCards.clear();
    room.cardOwners.clear();
    room.readyPlayers.clear();
    room.playerPaid.clear();
    room.playerBalanceCache.clear();
    room.drawn.clear();
    room.drawOrder = [];
    room.drawIndex = 0;
    room.lastTickSecond = null;
    room.winningPattern = DEFAULT_GAME_PATTERN;
    room.drawIntervalSeconds = DEFAULT_DRAW_INTERVAL_SECONDS;
    room.claimLockedCards.clear();
    room.lastNumber = null;
    room.winnerPayload = null;
    room.dirty = false;
    room.frozenTotalCards = null;
    room.frozenPrizePool = null;
    room.frozenCutPercent = 20;
    room.frozenHouseCut = 0;
    room.frozenWinnerPrize = 0;

    io.to(roomName(room.stake)).emit('room_reset', {
        stake: room.stake,
        message
    });
    emitRoomsState();
}

function shuffledBingoNumbers() {
    const a = Array.from({ length: 75 }, (_, i) => i + 1);
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}


const PATTERN_NAMES = {
  'N':'N','H':'H','Reverse H':'Reverse H','Z':'Z','K':'K','E':'E',
  'Three Horizontal Lines':'Three Horizontal Lines','Three Vertical Lines':'Three Vertical Lines',
  '5':'5','M':'M','cross':'Cross','vertical_line':'One Vertical Line','Five Dots':'Five Dots',
  'horizontal_line':'One Horizontal Line','full':'Full House','x':'X','t':'T','reverse_t':'Reverse T',
  'big_l':'Big L','reverse_l':'Reverse L','Top Triangle':'Top Triangle','Bottom Triangle':'Bottom Triangle',
  'half_above':'Half Above','half_below':'Half Below','any_square':'Any Square (2×2)',
  'any_one_line':'Any One Line','any_two_lines':'Any Two Lines'
};
const P=(...cells)=>cells;
const ROWS=Array.from({length:5},(_,r)=>P(...Array.from({length:5},(_,c)=>[r,c])));
const COLS=Array.from({length:5},(_,c)=>P(...Array.from({length:5},(_,r)=>[r,c])));
const DIAGS=[P([0,0],[1,1],[2,2],[3,3],[4,4]),P([0,4],[1,3],[2,2],[3,1],[4,0])];
const ANY_ONE_LINE_PATTERNS=[...ROWS,...COLS,...DIAGS,[[0,0],[4,0],[0,4],[4,4]],[[1,1],[3,1],[1,3],[3,3]],[[2,1],[1,2],[2,2],[3,2],[2,3]]];
const ANY_TWO_LINE_PATTERNS=[...ROWS,...COLS,...DIAGS,[[0,0],[4,0],[0,4],[4,4]],[[1,1],[3,1],[1,3],[3,3]]];
const FIXED_PATTERNS={
'N':[[0,0],[1,0],[2,0],[3,0],[4,0],[1,1],[2,2],[3,3],[4,4],[0,4],[1,4],[2,4],[3,4]],
'H':[[0,0],[1,0],[2,0],[3,0],[4,0],[2,1],[2,2],[2,3],[0,4],[1,4],[2,4],[3,4],[4,4]],
'Reverse H':[[0,0],[0,1],[0,2],[0,3],[0,4],[1,2],[2,2],[3,2],[4,0],[4,1],[4,2],[4,3],[4,4]],
'Z':[[0,0],[0,1],[0,2],[0,3],[0,4],[1,3],[2,2],[3,1],[4,0],[4,1],[4,2],[4,3],[4,4]],
'K':[[0,0],[1,0],[2,0],[3,0],[4,0],[0,3],[1,2],[2,1],[3,2],[4,3]],
'E':[[0,0],[1,0],[2,0],[3,0],[4,0],[0,1],[0,2],[0,3],[0,4],[2,1],[2,2],[2,3],[2,4],[4,1],[4,2],[4,3],[4,4]],
'Three Horizontal Lines':[[0,0],[2,0],[4,0],[0,1],[0,2],[0,3],[0,4],[2,1],[2,2],[2,3],[2,4],[4,1],[4,2],[4,3],[4,4]],
'Three Vertical Lines':[[0,0],[1,0],[2,0],[3,0],[4,0],[0,2],[1,2],[2,2],[3,2],[4,2],[0,4],[1,4],[2,4],[3,4],[4,4]],
'5':[[0,0],[1,0],[2,0],[3,4],[4,0],[0,1],[0,2],[0,3],[0,4],[2,1],[2,2],[2,3],[2,4],[4,1],[4,2],[4,3],[4,4]],
'M':[[0,0],[1,0],[2,0],[3,0],[4,0],[1,1],[2,2],[1,3],[0,4],[1,4],[2,4],[3,4],[4,4]],
'cross':[[2,0],[2,1],[3,2],[2,4],[2,2],[0,2],[1,2],[2,3],[4,2]],
'vertical_line':[[0,2],[1,2],[2,2],[3,2],[4,2]], 'Five Dots':[[0,0],[0,4],[2,2],[4,0],[4,4]], 'horizontal_line':[[2,0],[2,1],[2,2],[2,3],[2,4]],
'full':Array.from({length:25},(_,i)=>[Math.floor(i/5),i%5]).filter(([r,c])=>!(r===2&&c===2)),
'x':[[0,0],[1,1],[2,2],[3,3],[4,4],[0,4],[1,3],[3,1],[4,0]],
't':[[0,0],[0,1],[0,2],[0,3],[0,4],[1,2],[2,2],[3,2],[4,2]], 'reverse_t':[[4,0],[4,1],[4,2],[4,3],[4,4],[0,2],[1,2],[2,2],[3,2]],
'big_l':[[0,0],[1,0],[2,0],[3,0],[4,0],[4,1],[4,2],[4,3],[4,4]], 'reverse_l':[[0,0],[0,1],[0,2],[0,3],[0,4],[1,4],[2,4],[3,4],[4,4]],
'Top Triangle':[[0,0],[1,0],[2,0],[3,0],[4,0],[0,1],[1,1],[2,1],[3,1],[2,1],[0,2],[1,2],[2,2],[0,3],[1,3],[0,4]],
'Bottom Triangle':[[4,0],[4,1],[4,2],[4,3],[4,4],[3,1],[3,2],[3,3],[3,4],[2,2],[2,3],[2,4],[1,3],[1,4],[0,4]],
'half_above':Array.from({length:15},(_,i)=>[Math.floor(i/5),i%5]), 'half_below':Array.from({length:15},(_,i)=>[Math.floor(i/5)+2,i%5])
};
function getPatternsForGame(pattern){if(pattern==='any_one_line')return ANY_ONE_LINE_PATTERNS;if(pattern==='any_two_lines')return ANY_TWO_LINE_PATTERNS;if(pattern==='any_square'){const out=[];for(let r=0;r<4;r++)for(let c=0;c<4;c++)out.push([[r,c],[r,c+1],[r+1,c],[r+1,c+1]]);return out;}return FIXED_PATTERNS[pattern]?[FIXED_PATTERNS[pattern]]:[];}
function cellHit(grid,r,c,drawn){const v=grid[r][c];return v==='FREE'||v===0||(r===2&&c===2)||drawn.has(Number(v));}
function completedPatterns(grid,drawn,pattern){const done=getPatternsForGame(pattern).filter(cells=>cells.every(([r,c])=>cellHit(grid,r,c,drawn)));return pattern==='any_two_lines'?(done.length>=2?done:[]):done;}
function latestNumberIsInWinningPattern(grid,cells,latest){return !!latest&&cells.some(([r,c])=>Number(grid[r][c])===Number(latest));}
function winningClaim(grid,drawn,pattern,latest){const wins=completedPatterns(grid,drawn,pattern);if(!wins.length)return {ok:false};if(pattern==='any_two_lines'){for(let i=0;i<wins.length;i++)for(let j=i+1;j<wins.length;j++){const cells=[...new Map([...wins[i],...wins[j]].map(x=>[x.join(','),x])).values()];if(latestNumberIsInWinningPattern(grid,cells,latest))return {ok:true,cells};}return {ok:false};}for(const cells of wins)if(latestNumberIsInWinningPattern(grid,cells,latest))return {ok:true,cells};return {ok:false};}
function isWinningGrid(grid,drawn,pattern=DEFAULT_GAME_PATTERN){return completedPatterns(grid,drawn,pattern).length>0;}

const cardGridCache = new Map();

async function getCardGrid(cardNumber) {
    if (cardGridCache.has(cardNumber)) return cardGridCache.get(cardNumber);
    const result = await pool.query(
        'SELECT grid FROM bingo_cards WHERE card_number=$1',
        [cardNumber]
    );
    if (!result.rowCount) return null;
    const grid = result.rows[0].grid;
    cardGridCache.set(cardNumber, grid);
    return grid;
}

async function startRoomGame(room) {
    room.status = 'PLAYING';
    room.deadline = null;

    const settingsResult = await pool.query('SELECT winning_pattern, draw_interval_seconds FROM bingo_game_settings WHERE id=1');
    const settings = settingsResult.rows[0] || {};
    room.winningPattern = PATTERN_NAMES[settings.winning_pattern] ? settings.winning_pattern : DEFAULT_GAME_PATTERN;
    room.drawIntervalSeconds = Math.max(1, Number(settings.draw_interval_seconds || DEFAULT_DRAW_INTERVAL_SECONDS));
    room.claimLockedCards.clear();
    room.lastNumber = null;
    room.winnerPayload = null;

    const participants = Array.from(room.readyPlayers);
    let prize = 0;
    let totalCards = 0;
    for (const username of participants) {
        prize += getPlayerPaid(room, username);
        totalCards += userCards(room, username).size;
    }

    // Freeze these now. Anyone who leaves after this point still forfeits
    // their stake into the pot, but the pot itself (and what's displayed)
    // never shrinks because of it.
    // House cut % is locked here so mid-game admin changes do not affect this room.
    room.frozenPrizePool = Number(prize.toFixed(2));
    room.frozenTotalCards = totalCards;
    try {
        room.frozenCutPercent = await getRoomCutPercent(room.stake);
    } catch (_) {
        room.frozenCutPercent = 20;
    }
    const split = splitPot(room.frozenPrizePool, room.frozenCutPercent);
    room.frozenHouseCut = split.houseCut;
    room.frozenWinnerPrize = split.winnerPrize;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const sessionResult = await client.query(
            `INSERT INTO game_sessions(
                status, stake, prize_pool, winning_pattern, draw_interval_seconds,
                cut_percent, house_cut, winner_prize, player_count, card_count
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [
                'IN_PROGRESS', room.stake, room.frozenPrizePool, room.winningPattern, room.drawIntervalSeconds,
                room.frozenCutPercent, room.frozenHouseCut, room.frozenWinnerPrize,
                participants.length, totalCards
            ]
        );

        room.gameId = sessionResult.rows[0].id;

        for (const username of participants) {
            const cards = Array.from(userCards(room, username));
            const amountPaid = getPlayerPaid(room, username);

            await client.query(
                `INSERT INTO game_participants
                    (game_id,username,cards_selected,card_count,amount_paid)
                 VALUES($1,$2,$3,$4,$5)`,
                [room.gameId, username, cards, cards.length, amountPaid]
            );
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    room.drawOrder = shuffledBingoNumbers();
    room.drawIndex = 0;
    room.drawn.clear();

    io.to(roomName(room.stake)).emit('game_started', {
        stake: room.stake,
        gameId: room.gameId,
        prizePool: room.frozenWinnerPrize != null ? room.frozenWinnerPrize : room.frozenPrizePool,
        grossPrizePool: room.frozenPrizePool,
        houseCut: room.frozenHouseCut,
        cutPercent: room.frozenCutPercent,
        totalCards: room.frozenTotalCards,
        winningPattern: room.winningPattern,
        patternName: PATTERN_NAMES[room.winningPattern] || room.winningPattern,
        drawIntervalSeconds: room.drawIntervalSeconds,
        drawn: []
    });
    emitRoomsState();

    room.drawTimer = setInterval(async () => {
        if (room.status !== 'PLAYING') {
            clearDrawTimer(room);
            return;
        }

        if (room.readyPlayers.size === 0) {
            clearDrawTimer(room);
            if (room.gameId) {
                await pool.query(
                    "UPDATE game_sessions SET status='CANCELLED', ended_at=NOW() WHERE id=$1",
                    [room.gameId]
                );
            }
            await resetRoom(room, 'Game ended because all players left.');
            return;
        }

        if (room.drawIndex < room.drawOrder.length) {
            const number = room.drawOrder[room.drawIndex++];
            room.drawn.add(number);
            room.lastNumber = number;
            io.to(roomName(room.stake)).emit('number_drawn', {
                stake: room.stake,
                number,
                drawIndex: room.drawIndex,
                totalDrawn: room.drawn.size
            });
            return;
        }

                clearDrawTimer(room);
        // No winner: the full locked pot goes to the house (players already paid at READY; no refund).
        const exhaustedPot = Number(
            room.frozenPrizePool != null
                ? room.frozenPrizePool
                : (room.frozenWinnerPrize != null && room.frozenHouseCut != null
                    ? Number(room.frozenWinnerPrize) + Number(room.frozenHouseCut)
                    : 0)
        );
        if (room.gameId) {
            await pool.query(
                `UPDATE game_sessions SET
                    status = 'EXHAUSTED',
                    ended_at = NOW(),
                    winner_username = NULL,
                    house_cut = $1,
                    winner_prize = 0,
                    prize_pool = COALESCE(prize_pool, $1),
                    cut_percent = 100
                 WHERE id = $2`,
                [exhaustedPot, room.gameId]
            );
        }
        io.to(roomName(room.stake)).emit('game_ended', {
            stake: room.stake,
            winner: 'No One',
            prize: 0,
            houseCut: exhaustedPot,
            exhausted: true
        });
        await resetRoom(
            room,
            'All numbers 1-75 were called with no winner. The prize pot went to the house. Ready for the next round!'
        );
    }, room.drawIntervalSeconds * 1000);
}

// One scheduler handles every room. The deadline is absolute server time.
setInterval(async () => {
    for (const room of gameRooms.values()) {
        // Flush any high-frequency updates (card taps) at a bounded rate
        // instead of broadcasting to the whole room on every single tap —
        // this is what keeps a "click storm" from many simultaneous players
        // from turning into a socket broadcast storm.
        if (room.dirty) {
            room.dirty = false;
            io.to(roomName(room.stake)).emit('room_state', roomSnapshot(room));
        }

        if (room.status !== 'JOINING') continue;

        const seconds = remainingSeconds(room);
        if (seconds !== room.lastTickSecond) {
            room.lastTickSecond = seconds;
            const snapshot = roomSnapshot(room);
            io.to(roomName(room.stake)).emit('room_tick', snapshot);
            emitRoomsState();
        }

        if (room.deadline && Date.now() < room.deadline) continue;

        if (room.readyPlayers.size >= MIN_PLAYERS) {
            // Refund players who did not press READY, then start with ready players.
            for (const username of Array.from(room.players)) {
                if (!room.readyPlayers.has(username)) {
                    try {
                        await refundPlayerRoomPayment(room, username, 'GAME_REFUND_UNREADY');
                    } catch (err) {
                        console.error('Unready refund error:', err);
                    }
                    removePlayer(room, username);
                }
            }

            try {
                await startRoomGame(room);
            } catch (err) {
                console.error('Start game error:', err);

                for (const username of Array.from(room.players)) {
                    try {
                        await refundPlayerRoomPayment(room, username, 'GAME_REFUND_START_ERROR');
                    } catch (refundErr) {
                        console.error('Start refund error:', refundErr);
                    }
                }

                await resetRoom(room, 'The game could not start. Your card payments were refunded.');
            }
        } else {
            // Not enough ready players: refund every selected card payment.
            for (const username of Array.from(room.players)) {
                try {
                    await refundPlayerRoomPayment(
                        room,
                        username,
                        'GAME_REFUND_NOT_ENOUGH_PLAYERS'
                    );
                } catch (err) {
                    console.error('Not enough players refund error:', err);
                }
            }

            await resetRoom(
                room,
                'Not enough ready players. Your card payments were refunded.'
            );
        }
    }
}, ROOM_BROADCAST_MS);



// ---------------- ROOM RAKE (HOUSE CUT) ----------------
app.get('/api/admin/rake-settings', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const r = await pool.query('SELECT stake, cut_percent, updated_at FROM room_rake_settings ORDER BY stake ASC');
        res.json({
            success: true,
            settings: r.rows.map(row => ({
                stake: Number(row.stake),
                cutPercent: Number(row.cut_percent),
                updatedAt: row.updated_at
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.post('/api/admin/rake-settings', async (req, res) => {
    const { adminSecret, settings } = req.body || {};
    if (!requireAdmin(req, res)) return;
    if (!Array.isArray(settings) || !settings.length) {
        return res.status(400).json({ success: false, message: 'settings array required.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const row of settings) {
            const stake = Number(row.stake);
            const cut = Number(row.cutPercent);
            if (![10, 20, 50, 100, 200, 500].includes(stake)) continue;
            if (!Number.isFinite(cut) || cut < 0 || cut > 100) {
                throw new Error('Cut percent must be 0–100 for stake ' + stake);
            }
            await client.query(
                `INSERT INTO room_rake_settings(stake, cut_percent, updated_at) VALUES($1,$2,NOW())
                 ON CONFLICT (stake) DO UPDATE SET cut_percent = EXCLUDED.cut_percent, updated_at = NOW()`,
                [stake, cut]
            );
        }
        await client.query('COMMIT');
        const r = await pool.query('SELECT stake, cut_percent FROM room_rake_settings ORDER BY stake ASC');
        res.json({
            success: true,
            settings: r.rows.map(row => ({ stake: Number(row.stake), cutPercent: Number(row.cut_percent) }))
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: err.message || 'Failed to save.' });
    } finally {
        client.release();
    }
});

app.get('/api/admin/house-profit', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const stake = req.query.stake ? Number(req.query.stake) : null;
    const params = [];
    const where = ["status IN ('COMPLETED', 'EXHAUSTED')"];
    if (from) { params.push(from); where.push(`created_at >= $${params.length}::date`); }
    if (to) { params.push(to); where.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    if (stake && Number.isFinite(stake)) { params.push(stake); where.push(`stake = $${params.length}`); }
    const wsql = where.join(' AND ');
    try {
        const summary = await pool.query(
            `SELECT
                COUNT(*)::int AS games,
                COALESCE(SUM(prize_pool),0)::float AS total_pots,
                COALESCE(SUM(house_cut),0)::float AS total_house,
                COALESCE(SUM(winner_prize),0)::float AS total_paid_winners,
                COALESCE(SUM(card_count),0)::int AS total_cards,
                                COALESCE(SUM(player_count),0)::int AS total_player_seats,
                COUNT(*) FILTER (WHERE status = 'EXHAUSTED')::int AS exhausted_games,
                COALESCE(SUM(house_cut) FILTER (WHERE status = 'EXHAUSTED'),0)::float AS exhausted_house
             FROM game_sessions WHERE ${wsql}`,
            params
        );
        const byStake = await pool.query(
            `SELECT stake,
                COUNT(*)::int AS games,
                COALESCE(SUM(house_cut),0)::float AS house,
                COALESCE(SUM(prize_pool),0)::float AS pots,
                COALESCE(AVG(cut_percent),0)::float AS avg_cut
             FROM game_sessions WHERE ${wsql}
             GROUP BY stake ORDER BY stake ASC`,
            params
        );
        const byDay = await pool.query(
            `SELECT created_at::date AS day,
                COUNT(*)::int AS games,
                COALESCE(SUM(house_cut),0)::float AS house
             FROM game_sessions WHERE ${wsql}
             GROUP BY created_at::date ORDER BY day DESC LIMIT 60`,
            params
        );
        const todayByStake = await pool.query(
            `SELECT stake, COUNT(*)::int AS games, COALESCE(SUM(house_cut),0)::float AS house
             FROM game_sessions
             WHERE status IN ('COMPLETED', 'EXHAUSTED') AND created_at >= CURRENT_DATE
             GROUP BY stake ORDER BY stake ASC`
        );
        res.json({
            success: true,
            summary: summary.rows[0],
            byStake: byStake.rows.map(r => ({
                stake: Number(r.stake), games: r.games, house: r.house, pots: r.pots, avgCut: r.avg_cut
            })),
            byDay: byDay.rows.map(r => ({ day: r.day, games: r.games, house: r.house })),
            todayByStake: todayByStake.rows.map(r => ({
                stake: Number(r.stake), games: r.games, house: r.house
            }))
        });
    } catch (err) {
        console.error('house-profit', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});


app.get('/api/admin/request-stats', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const type = String(req.query.type || 'deposit').toLowerCase();
    const table = type === 'withdraw' ? 'withdraw_requests' : type === 'transfer' ? 'transfer_requests' : 'deposit_requests';
    try {
        const r = await pool.query(`
            SELECT
              COUNT(*) FILTER (WHERE status = 'APPROVED' AND created_at >= CURRENT_DATE)::int AS approved_today,
              COUNT(*) FILTER (WHERE status = 'APPROVED' AND created_at >= date_trunc('week', CURRENT_TIMESTAMP))::int AS approved_week,
              COUNT(*) FILTER (WHERE status = 'APPROVED' AND created_at >= date_trunc('month', CURRENT_TIMESTAMP))::int AS approved_month,
              COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'REJECTED' AND created_at >= CURRENT_DATE)::int AS rejected_today
            FROM ${table}
        `);
        res.json({ success: true, type, stats: r.rows[0] });
    } catch (err) {
        console.error('request-stats', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.get('/api/admin/games', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const offset = (page - 1) * limit;
    const status = req.query.status ? String(req.query.status).toUpperCase() : '';
    const stake = req.query.stake ? Number(req.query.stake) : null;
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;
    const q = req.query.q ? String(req.query.q).trim() : '';

    const params = [];
    const where = [];
    if (status === 'LIVE' || status === 'IN_PROGRESS') {
        where.push("status = 'IN_PROGRESS'");
    } else if (status === 'COMPLETED') {
        where.push("status = 'COMPLETED'");
    } else if (status) {
        where.push(`status = $${params.length + 1}`);
        params.push(status);
    }
    if (stake && Number.isFinite(stake)) {
        params.push(stake);
        where.push(`stake = $${params.length}`);
    }
    if (from) { params.push(from); where.push(`created_at >= $${params.length}::date`); }
    if (to) { params.push(to); where.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    if (q) {
        params.push('%' + q + '%');
        // Match either the legacy single winner column or any row in game_winners
        where.push(`(
            LOWER(COALESCE(winner_username,'')) LIKE LOWER($${params.length})
            OR EXISTS (
                SELECT 1 FROM game_winners gw
                WHERE gw.game_id = game_sessions.id
                  AND LOWER(gw.username) LIKE LOWER($${params.length})
            )
        )`);
    }
    const wsql = where.length ? ('WHERE ' + where.join(' AND ')) : '';
    try {
        const countR = await pool.query(`SELECT COUNT(*)::int AS c FROM game_sessions ${wsql}`, params);
        const listParams = params.concat([limit, offset]);
        const list = await pool.query(
            `SELECT id, status, stake, prize_pool, house_cut, winner_prize, cut_percent,
                    player_count, card_count, winner_username, winning_card_number,
                    winning_pattern, created_at, ended_at
             FROM game_sessions ${wsql}
             ORDER BY created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            listParams
        );
        const ids = list.rows.map(r => r.id);
        let partsByGame = {};
        let winnersByGame = {};
        if (ids.length) {
            const pr = await pool.query(
                `SELECT game_id, username, cards_selected, card_count, amount_paid
                 FROM game_participants WHERE game_id = ANY($1::int[])
                 ORDER BY username ASC`,
                [ids]
            );
            for (const row of pr.rows) {
                if (!partsByGame[row.game_id]) partsByGame[row.game_id] = [];
                partsByGame[row.game_id].push({
                    username: row.username,
                    cards: row.cards_selected,
                    cardCount: Number(row.card_count || (row.cards_selected || []).length),
                    amountPaid: Number(row.amount_paid || 0)
                });
            }

            const wr = await pool.query(
                `SELECT game_id, username, display_name, card_number, prize, winning_cells
                 FROM game_winners WHERE game_id = ANY($1::int[])
                 ORDER BY id ASC`,
                [ids]
            );
            for (const row of wr.rows) {
                if (!winnersByGame[row.game_id]) winnersByGame[row.game_id] = [];
                winnersByGame[row.game_id].push({
                    username: row.username,
                    displayName: row.display_name || row.username,
                    cardNumber: row.card_number,
                    prize: Number(row.prize || 0),
                    winningCells: row.winning_cells || []
                });
            }
        }

        // Live rooms from memory (current lobby / playing not only DB)
        const liveRooms = [];
        for (const stakeKey of STAKES) {
            const room = gameRooms.get(stakeKey);
            if (!room) continue;
            if (room.status === 'WAITING' && room.players.size === 0) continue;
            const players = [];
            for (const uname of room.readyPlayers) {
                const cards = Array.from(userCards(room, uname));
                players.push({
                    username: uname,
                    cards,
                    cardCount: cards.length,
                    amountPaid: getPlayerPaid(room, uname)
                });
            }
            // also players who selected but not ready?
            for (const uname of room.players) {
                if (room.readyPlayers.has(uname)) continue;
                const cards = Array.from(userCards(room, uname));
                players.push({
                    username: uname,
                    cards,
                    cardCount: cards.length,
                    amountPaid: getPlayerPaid(room, uname),
                    notReady: true
                });
            }
            liveRooms.push({
                stake: stakeKey,
                status: room.status,
                gameId: room.gameId,
                prizePool: room.frozenPrizePool != null ? room.frozenPrizePool : null,
                cutPercent: room.frozenCutPercent,
                houseCut: room.frozenHouseCut,
                winnerPrize: room.frozenWinnerPrize,
                playerCount: players.length,
                cardCount: players.reduce((s, p) => s + p.cardCount, 0),
                players,
                deadline: room.deadline
            });
        }

        res.json({
            success: true,
            page,
            limit,
            total: countR.rows[0].c,
            liveRooms: (!status || status === 'LIVE' || status === 'IN_PROGRESS') ? liveRooms : [],
            games: list.rows.map(r => {
                const winners = winnersByGame[r.id] || [];
                const winnerCount = winners.length;
                // Prefer game_winners rows; fall back to legacy single-winner columns
                let winnerDisplay = null;
                let winningCard = r.winning_card_number;
                let totalWinnerPrize = Number(r.winner_prize || 0);
                if (winnerCount > 0) {
                    winnerDisplay = winners.map(w => w.displayName || w.username).join(', ');
                    totalWinnerPrize = winners.reduce((s, w) => s + (Number(w.prize) || 0), 0);
                    if (winnerCount === 1) winningCard = winners[0].cardNumber;
                } else if (r.winner_username) {
                    winnerDisplay = r.winner_username;
                }
                return {
                    id: r.id,
                    status: r.status,
                    stake: Number(r.stake),
                    prizePool: Number(r.prize_pool || 0),
                    houseCut: Number(r.house_cut || 0),
                    winnerPrize: totalWinnerPrize,
                    cutPercent: Number(r.cut_percent || 0),
                    playerCount: Number(r.player_count || 0),
                    cardCount: Number(r.card_count || 0),
                    winner: winnerDisplay,
                    winnerCount,
                    winners,
                    winningCard,
                    pattern: r.winning_pattern,
                    createdAt: r.created_at,
                    endedAt: r.ended_at,
                    participants: partsByGame[r.id] || []
                };
            })
        });
    } catch (err) {
        console.error('admin games', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.get('/api/admin/game-settings', async (req,res)=>{ if (!requireAdmin(req, res)) return; const r=await pool.query('SELECT winning_pattern,draw_interval_seconds FROM bingo_game_settings WHERE id=1'); const s=r.rows[0]||{winning_pattern:DEFAULT_GAME_PATTERN,draw_interval_seconds:DEFAULT_DRAW_INTERVAL_SECONDS}; res.json({success:true,winningPattern:s.winning_pattern,drawIntervalSeconds:s.draw_interval_seconds,patterns:PATTERN_NAMES}); });
app.post('/api/admin/game-settings', async (req,res)=>{ const {adminSecret,winningPattern,drawIntervalSeconds}=req.body; if (!requireAdmin(req, res)) return; if(!PATTERN_NAMES[winningPattern])return res.status(400).json({success:false,message:'Invalid pattern.'}); const seconds=Number(drawIntervalSeconds); if(!Number.isInteger(seconds)||seconds<1||seconds>60)return res.status(400).json({success:false,message:'Interval must be 1-60 seconds.'}); await pool.query(`INSERT INTO bingo_game_settings(id,winning_pattern,draw_interval_seconds,updated_at) VALUES(1,$1,$2,NOW()) ON CONFLICT(id) DO UPDATE SET winning_pattern=EXCLUDED.winning_pattern,draw_interval_seconds=EXCLUDED.draw_interval_seconds,updated_at=NOW()`,[winningPattern,seconds]); res.json({success:true,winningPattern,drawIntervalSeconds:seconds}); });
app.get('/api/game-state', async (req,res)=>{ const stake=Number(req.query.stake), username=String(req.query.username||''); const room=gameRooms.get(stake); if(!room||!username||!room.readyPlayers.has(username))return res.status(403).json({success:false,ended:true,message:'This game has ended.'}); const cards=[]; for(const cardNumber of Array.from(userCards(room,username))) { const grid=await getCardGrid(cardNumber); if(grid)cards.push({cardNumber,grid,locked:room.claimLockedCards.has(cardNumber)}); } res.json({success:true,room:{...roomSnapshot(room),drawn:Array.from(room.drawn),lastNumber:room.lastNumber,patternName:PATTERN_NAMES[room.winningPattern]||room.winningPattern},cards,winnerPayload:room.winnerPayload||null}); });

io.on('connection', socket => {
    socket.emit('rooms_state', allRoomsSnapshot());

    socket.on('rooms_state_request', () => {
        socket.emit('rooms_state', allRoomsSnapshot());
    });

    socket.on('subscribe_room', ({ stake, username }, cb = () => {}) => {
        stake = Number(stake);
        const room = gameRooms.get(stake);
        if (!room) return cb({ success: false });

        socket.join(roomName(stake));

        cb({
            success: true,
            state: {
                ...roomSnapshot(room),
                selectedCards: Array.from(userCards(room, username)),
                drawn: Array.from(room.drawn),
                amountPaid: getPlayerPaid(room, username),
                isReady: room.readyPlayers.has(username),
                playerInRoom: room.players.has(username)
            }
        });
    });

    socket.on('unsubscribe_room', ({ stake }) => {
        socket.leave(roomName(Number(stake)));
    });

    socket.on('join_room', async ({ stake, username }, cb = () => {}) => {
        stake = Number(stake);
        const room = gameRooms.get(stake);

        if (!room || !username) {
            return cb({ success: false, message: 'Invalid game room.' });
        }

        if (room.status === 'PLAYING') {
            return cb({ success: false, message: 'This game is already playing.' });
        }

        for (const [otherStake, otherRoom] of gameRooms) {
            if (otherStake !== stake && otherRoom.players.has(username)) {
                return cb({
                    success: false,
                    message: `You are already in the ${otherStake} Birr room.`
                });
            }
        }

        if (room.players.has(username)) {
            socket.join(roomName(stake));
            return cb({
                success: true,
                alreadyJoined: true,
                room: roomSnapshot(room)
            });
        }

        try {
            const userResult = await pool.query(
                'SELECT balance FROM users WHERE LOWER(username)=LOWER($1)',
                [username]
            );
            if (!userResult.rowCount) throw new Error('User not found.');

            const balance = Number(userResult.rows[0].balance);
            if (balance < stake) throw new Error('Insufficient balance.');

            room.players.add(username);
            room.selectedCards.set(username, new Set());
            room.playerPaid.set(username, 0);
            room.playerBalanceCache.set(username, balance);

            if (room.status === 'WAITING') {
                room.status = 'JOINING';
                room.deadline = Date.now() + ROUND_SECONDS * 1000;
                room.lastTickSecond = null;
            }

            socket.join(roomName(stake));

            const snapshot = roomSnapshot(room);
            io.to(roomName(stake)).emit('room_state', snapshot);
            emitRoomsState();

            cb({
                success: true,
                room: snapshot,
                balance
            });
        } catch (err) {
            cb({
                success: false,
                message: err.message || 'Unable to join room.'
            });
        }
    });

    socket.on('leave_room', async ({ stake, username }, cb = () => {}) => {
        stake = Number(stake);
        const room = gameRooms.get(stake);

        if (!room || !room.players.has(username)) {
            return cb({
                success: false,
                message: 'You are not in this room.'
            });
        }

        if (room.status === 'PLAYING') {
            removePlayer(room, username);
            socket.leave(roomName(stake));
            io.to(roomName(stake)).emit('room_state', roomSnapshot(room));
            emitRoomsState();
            return cb({
                success: true,
                message: 'You left the playing game. Entry payment was forfeited.'
            });
        }

        try {
            await refundPlayerRoomPayment(room, username, 'GAME_REFUND_LEFT_ROOM');
            removePlayer(room, username);
            socket.leave(roomName(stake));

            if (!room.players.size) {
                room.status = 'WAITING';
                room.deadline = null;
                room.lastTickSecond = null;
            }

            io.to(roomName(stake)).emit('room_state', roomSnapshot(room));
            emitRoomsState();
            cb({ success: true });
        } catch (err) {
            console.error('Leave room error:', err);
            cb({
                success: false,
                message: 'Refund failed. Please try again.'
            });
        }
    });

    socket.on('toggle_card', ({ stake, cardNumber, username }, cb = () => {}) => {
        stake = Number(stake);
        cardNumber = Number(cardNumber);
        const room = gameRooms.get(stake);

        if (!room || room.status !== 'JOINING' || !room.players.has(username)) {
            return cb({
                success: false,
                message: 'Card selection is closed.'
            });
        }

        if (!Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > 500) {
            return cb({
                success: false,
                message: 'Invalid card number.'
            });
        }

        if (room.readyPlayers.has(username)) {
            return cb({
                success: false,
                message: 'You are already ready.'
            });
        }

        const cards = userCards(room, username);
        // Selecting/deselecting a card is just reserving it — no money moves
        // and nothing is written to the database here. The player is only
        // ever actually charged once, in one transaction, when they press
        // READY (see the player_ready handler), and refunded in one
        // transaction if they later leave. That keeps the transactions
        // table free of a row for every single tap during browsing.
        const cachedBalance = room.playerBalanceCache.get(username) || 0;

        if (cards.has(cardNumber)) {
            cards.delete(cardNumber);
            if (room.cardOwners.get(cardNumber) === username) {
                room.cardOwners.delete(cardNumber);
            }
            room.selectedCards.set(username, cards);

            socket.emit('my_cards', {
                stake,
                cards: Array.from(cards)
            });

            room.dirty = true;

            return cb({
                success: true,
                count: cards.size,
                balance: cachedBalance
            });
        }

        // O(1) instead of scanning every player's card set on every tap.
        const owner = room.cardOwners.get(cardNumber);
        if (owner && owner !== username) {
            return cb({
                success: false,
                message: `Card ${cardNumber} is already taken by another player!`
            });
        }

        if (MAX_CARDS_PER_PLAYER > 0 && cards.size >= MAX_CARDS_PER_PLAYER) {
            return cb({
                success: false,
                message: `Maximum ${MAX_CARDS_PER_PLAYER} cards.`
            });
        }

        // Soft check against the balance seen at join time so a player can't
        // reserve far more cards than they could ever pay for — the real,
        // authoritative check happens atomically when READY charges them.
        if ((cards.size + 1) * stake > cachedBalance) {
            return cb({
                success: false,
                message: 'Insufficient balance to select another card.'
            });
        }

        cards.add(cardNumber);
        room.cardOwners.set(cardNumber, username);
        room.selectedCards.set(username, cards);

        socket.emit('my_cards', {
            stake,
            cards: Array.from(cards)
        });

        room.dirty = true;

        cb({
            success: true,
            count: cards.size,
            balance: cachedBalance
        });
    });

    socket.on('player_ready', async ({ stake, username }, cb = () => {}) => {
        stake = Number(stake);
        const room = gameRooms.get(stake);

        if (!room || room.status !== 'JOINING' || !room.players.has(username)) {
            return cb({
                success: false,
                message: 'Room is not accepting READY.'
            });
        }

        if (room.readyPlayers.has(username)) {
            return cb({ success: false, message: 'You are already ready.' });
        }

        const cards = userCards(room, username);
        if (!cards.size) {
            return cb({
                success: false,
                message: 'Select at least one card.'
            });
        }

        // The one and only charge for this round: the whole selection is
        // paid for in a single transaction right here, instead of one
        // transaction per card tap during selection.
        const amount = cards.size * stake;
        try {
            const charge = await chargePlayer(username, amount, 'GAME_CARD_ENTRY');
            setPlayerPaid(room, username, amount);
            room.readyPlayers.add(username);
            io.to(roomName(stake)).emit('room_state', roomSnapshot(room));
            emitRoomsState();
            cb({ success: true, balance: charge.balance });
        } catch (err) {
            cb({ success: false, message: err.message || 'Could not charge entry fee.' });
        }
    });

        socket.on('claim_bingo', async ({ stake, username, cardNumber }, cb = () => {}) => {
        stake=Number(stake); cardNumber=Number(cardNumber); const room=gameRooms.get(stake);
        if(!room||(room.status!=='PLAYING'&&room.status!=='FINISHING')||!room.readyPlayers.has(username)||!userCards(room,username).has(cardNumber)) return cb({success:false,message:'Invalid Bingo claim.'});
        if(room.claimLockedCards.has(cardNumber)) return cb({success:false,locked:true,message:'This card is locked for the rest of this game.'});
        try {
            const grid=await getCardGrid(cardNumber);
            const claim=grid?winningClaim(grid,room.drawn,room.winningPattern,room.lastNumber):{ok:false};
            if(!claim.ok){ room.claimLockedCards.add(cardNumber); socket.emit('card_locked',{stake,cardNumber,message:'BINGO claim was not valid for the latest called number. This card is locked for this round.'}); return cb({success:false,locked:true,message:'Invalid or late BINGO claim. This card is now locked for this game.'}); }
            // Valid win on the current number — don't pay out yet. Collect it
            // and give any other player who completed on this exact same
            // number a brief window to have their claim land too, so a real
            // tie gets detected instead of paying out whoever's message
            // happened to arrive first.
            if(!room.pendingWinners) room.pendingWinners=[];
            room.pendingWinners.push({username,cardNumber,grid,claim});
            room.claimLockedCards.add(cardNumber);
            cb({success:true,queued:true});
            if(room.status==='PLAYING'){
                room.status='FINISHING'; clearDrawTimer(room);
                setTimeout(()=>finalizeWinners(room,stake).catch(err=>console.error('finalizeWinners',err)), 700);
            }
        } catch(err){ console.error('claim',err); cb({success:false,message:err.message||'Unable to complete claim.'}); }
    });
});

async function finalizeWinners(room, stake) {
    const winners = room.pendingWinners || [];
    room.pendingWinners = [];
    if (!winners.length) { room.status='PLAYING'; return; }

    // Same house-cut math as before, taken ONCE from the whole pot —
    // never per winner. Only the remaining winner pool gets divided
    // evenly across everyone who tied.
    const grossPot = room.frozenPrizePool != null ? room.frozenPrizePool : (()=>{let p=0;for(const player of room.readyPlayers)p+=getPlayerPaid(room,player);return p;})();
    const cutPct = room.frozenCutPercent != null ? room.frozenCutPercent : 20;
    const potSplit = splitPot(grossPot, cutPct);
    const houseCut = potSplit.houseCut;
    const share = potSplit.winnerPrize / winners.length;
    const drawnNumbers = Array.from(room.drawn);
    const payloads = [];

    // Store the FULL post-cut winner pool on the session (not per-player share).
    // Per-player amounts live in game_winners.prize so admin/history can show splits correctly.
    const primary = winners[0];
    let primaryDisplay = primary.username;
    try {
        const dn = await pool.query('SELECT display_name FROM users WHERE LOWER(username)=LOWER($1)', [primary.username]);
        if (dn.rowCount && dn.rows[0].display_name) primaryDisplay = dn.rows[0].display_name;
    } catch (e) {}
    const winnerLabel = winners.length > 1
        ? winners.map(w => w.username).join(', ')
        : primary.username;

    try {
        await pool.query(
            `UPDATE game_sessions SET status=$1, winner_username=$2, ended_at=NOW(),
                winning_card_number=$3, winning_cells=$4, drawn_numbers=$5,
                house_cut=$6, winner_prize=$7, cut_percent=$8, prize_pool=$9
             WHERE id=$10`,
            [
                'COMPLETED',
                winnerLabel,
                primary.cardNumber,
                JSON.stringify(primary.claim.cells),
                drawnNumbers,
                houseCut,
                potSplit.winnerPrize,
                potSplit.cutPercent,
                grossPot,
                room.gameId
            ]
        );
    } catch (err) {
        console.error('finalizeWinners session update', err);
    }

    for (const w of winners) {
        try {
            let winnerDisplay = w.username;
            try {
                const dn = await pool.query('SELECT display_name FROM users WHERE LOWER(username)=LOWER($1)', [w.username]);
                if (dn.rowCount && dn.rows[0].display_name) winnerDisplay = dn.rows[0].display_name;
            } catch (e) {}

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const user = await getUserIdAndBalance(w.username, client);
                if (!user) throw new Error('Winner not found');
                await client.query('UPDATE users SET wins=wins+1,balance=balance+$1 WHERE id=$2', [share, user.id]);
                await client.query('INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)', [user.id, share, 'GAME_WIN']);
                await client.query('INSERT INTO game_winners(game_id,username,display_name,card_number,winning_cells,prize) VALUES($1,$2,$3,$4,$5,$6)',
                    [room.gameId, w.username, winnerDisplay, w.cardNumber, JSON.stringify(w.claim.cells), share]);
                await client.query('COMMIT');
            } catch (err) { await client.query('ROLLBACK'); throw err; } finally { client.release(); }
            payloads.push({ winner: w.username, winnerDisplay, prize: share, cardNumber: w.cardNumber, grid: w.grid, winningCells: w.claim.cells });
        } catch (err) { console.error('finalizeWinners payout error for', w.username, err); }
    }

    const winnerPayload = { stake, winners: payloads, split: payloads.length > 1, prizePool: grossPot, houseCut, cutPercent: potSplit.cutPercent, lastNumber: room.lastNumber, patternName: PATTERN_NAMES[room.winningPattern]||room.winningPattern };
    room.winnerPayload = winnerPayload;
    io.to(roomName(stake)).emit('game_won', winnerPayload);
    const summary = payloads.map(p => `${p.winnerDisplay} (${p.prize.toFixed(2)} Birr)`).join(' & ');
    setTimeout(async () => {
        io.to(roomName(stake)).emit('game_ended', { stake, winners: payloads });
        await resetRoom(room, payloads.length > 1 ? `Game finished — split pot: ${summary}!` : `Game finished. ${summary} won!`);
    }, 5000);
}



  return {
    gameRooms,
    PATTERN_NAMES,
    DEFAULT_GAME_PATTERN,
    DEFAULT_DRAW_INTERVAL_SECONDS,
    userCards,
    roomSnapshot,
    allRoomsSnapshot,
    getCardGrid,
    getPlayerPaid,
  };
}

module.exports = { attachGameEngine };
