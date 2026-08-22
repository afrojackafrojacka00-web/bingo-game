const { notifyBalanceChange } = require('./notificationSocket');

const CARD_PRICE = 10.00;
const WIN_PRIZE = 50.00;

const gameState = {
    status: 'LOBBY_WAITING', // LOBBY_WAITING, GAME_ACTIVE
    gameId: null,
    timer: 40,
    selectedCards: new Map(), // cardNumber => username
    readyPlayers: new Set(),  // set of usernames
    calledNumbers: [],        // numbers drawn in active game
    numberDrawInterval: null
};

// Check if a 5x5 grid has a winning Bingo pattern against called numbers
function checkBingoWin(grid, calledNumbersSet) {
    const isMarked = (val) => val === "FREE" || calledNumbersSet.has(parseInt(val, 10));

    // Check 5 Rows
    for (let r = 0; r < 5; r++) {
        if (grid[r].every(isMarked)) return true;
    }
    // Check 5 Columns
    for (let c = 0; c < 5; c++) {
        let colWin = true;
        for (let r = 0; r < 5; r++) {
            if (!isMarked(grid[r][c])) { colWin = false; break; }
        }
        if (colWin) return true;
    }
    // Main Diagonal
    if ([0, 1, 2, 3, 4].every(i => isMarked(grid[i][i]))) return true;
    // Anti Diagonal
    if ([0, 1, 2, 3, 4].every(i => isMarked(grid[i][4 - i]))) return true;

    return false;
}

function startNumberDrawing(io, pool) {
    const numberPool = Array.from({ length: 75 }, (_, i) => i + 1);
    // Shuffle pool
    for (let i = numberPool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [numberPool[i], numberPool[j]] = [numberPool[j], numberPool[i]];
    }

    gameState.calledNumbers = [];
    
    if (gameState.numberDrawInterval) clearInterval(gameState.numberDrawInterval);

    gameState.numberDrawInterval = setInterval(async () => {
        if (gameState.status !== 'GAME_ACTIVE' || numberPool.length === 0) {
            clearInterval(gameState.numberDrawInterval);
            return;
        }

        const nextNum = numberPool.pop();
        gameState.calledNumbers.push(nextNum);

        io.emit('number_called', {
            number: nextNum,
            history: gameState.calledNumbers
        });

        // Save draw history to DB
        if (gameState.gameId) {
            pool.query('UPDATE game_sessions SET called_numbers = $1 WHERE id = $2', [gameState.calledNumbers, gameState.gameId]).catch(() => {});
        }
    }, 3500);
}

function initGameSocket(io, pool) {
    // Lobby Countdown Loop
    setInterval(async () => {
        if (gameState.status === 'LOBBY_WAITING') {
            gameState.timer--;

            if (gameState.timer <= 0) {
                if (gameState.readyPlayers.size >= 2) {
                    // Process entry fees for ready players
                    const validPlayers = [];
                    for (const username of gameState.readyPlayers) {
                        const userRes = await pool.query('SELECT id, balance FROM users WHERE LOWER(username) = LOWER($1)', [username]);
                        if (userRes.rows.length > 0 && parseFloat(userRes.rows[0].balance) >= CARD_PRICE) {
                            const user = userRes.rows[0];
                            const newBal = parseFloat(user.balance) - CARD_PRICE;
                            await pool.query('UPDATE users SET balance = $1 WHERE id = $2', [newBal, user.id]);
                            await notifyBalanceChange(pool, io, user.id, username, -CARD_PRICE, newBal, 'GAME_ENTRY_FEE');
                            validPlayers.push(username);
                        } else {
                            io.to(`user_${username.toLowerCase()}`).emit('error_message', { message: "Insufficient balance to join game!" });
                        }
                    }

                    if (validPlayers.length >= 2) {
                        gameState.status = 'GAME_ACTIVE';

                        try {
                            const sessionRes = await pool.query(
                                'INSERT INTO game_sessions (status) VALUES ($1) RETURNING id',
                                ['IN_PROGRESS']
                            );
                            gameState.gameId = sessionRes.rows[0].id;

                            const playerCardMap = {};
                            gameState.selectedCards.forEach((username, cardNumber) => {
                                if (validPlayers.includes(username)) {
                                    if (!playerCardMap[username]) playerCardMap[username] = [];
                                    playerCardMap[username].push(cardNumber);
                                }
                            });

                            for (const [username, cards] of Object.entries(playerCardMap)) {
                                await pool.query(
                                    'INSERT INTO game_participants (game_id, username, cards_selected) VALUES ($1, $2, $3)',
                                    [gameState.gameId, username, cards]
                                );
                            }
                        } catch (err) {
                            console.error("Error setting up game session:", err);
                        }

                        io.emit('game_started', {
                            gameId: gameState.gameId,
                            players: validPlayers
                        });

                        startNumberDrawing(io, pool);
                    } else {
                        gameState.selectedCards.clear();
                        gameState.readyPlayers.clear();
                        gameState.timer = 40;
                        io.emit('lobby_reset', { message: "Not enough eligible players with balance. Resetting cards." });
                    }
                } else {
                    gameState.selectedCards.clear();
                    gameState.readyPlayers.clear();
                    gameState.timer = 40;
                    io.emit('lobby_reset', { message: "Not enough ready players. Resetting lobby." });
                }
            } else {
                io.emit('timer_tick', { timer: gameState.timer, status: gameState.status });
            }
        }
    }, 1000);

    io.on('connection', (socket) => {
        socket.emit('init_state', {
            status: gameState.status,
            timer: gameState.timer,
            takenCards: Object.fromEntries(gameState.selectedCards),
            readyPlayersCount: gameState.readyPlayers.size,
            calledNumbers: gameState.calledNumbers
        });

        socket.on('toggle_card', ({ cardNumber, username }) => {
            if (gameState.status !== 'LOBBY_WAITING') {
                return socket.emit('error_message', { message: "Card selection locked during active gameplay!" });
            }

            const currentOwner = gameState.selectedCards.get(cardNumber);
            if (currentOwner) {
                if (currentOwner === username) {
                    gameState.selectedCards.delete(cardNumber);
                    io.emit('card_freed', { cardNumber });
                } else {
                    socket.emit('error_message', { message: `Card ${cardNumber} taken by ${currentOwner}` });
                }
            } else {
                gameState.selectedCards.set(cardNumber, username);
                io.emit('card_taken', { cardNumber, username });
            }
        });

        socket.on('player_ready', ({ username }) => {
            if (gameState.status !== 'LOBBY_WAITING') return;

            const userHasCard = Array.from(gameState.selectedCards.values()).includes(username);
            if (!userHasCard) {
                return socket.emit('error_message', { message: "Select at least one card first!" });
            }

            gameState.readyPlayers.add(username);
            io.emit('ready_count_updated', { readyCount: gameState.readyPlayers.size });
        });

        socket.on('claim_bingo', async ({ username, cardNumber }) => {
            if (gameState.status !== 'GAME_ACTIVE' || !gameState.readyPlayers.has(username)) {
                return socket.emit('error_message', { message: "Invalid Bingo claim state." });
            }

            try {
                // Fetch candidate card grid from DB
                const cardRes = await pool.query('SELECT grid FROM bingo_cards WHERE card_number = $1', [cardNumber]);
                if (cardRes.rows.length === 0) {
                    return socket.emit('error_message', { message: "Invalid card selection." });
                }

                const grid = cardRes.rows[0].grid;
                const calledSet = new Set(gameState.calledNumbers);

                // Server-side verification
                const isValidWin = checkBingoWin(grid, calledSet);

                if (!isValidWin) {
                    return socket.emit('error_message', { message: "False Bingo claim! Keep playing." });
                }

                if (gameState.numberDrawInterval) clearInterval(gameState.numberDrawInterval);

                if (gameState.gameId) {
                    await pool.query(
                        'UPDATE game_sessions SET status = $1, winner_username = $2, ended_at = NOW() WHERE id = $3',
                        ['COMPLETED', username, gameState.gameId]
                    );

                    const userRes = await pool.query(
                        'UPDATE users SET wins = wins + 1, balance = balance + $1 WHERE username = $2 RETURNING id, balance',
                        [WIN_PRIZE, username]
                    );

                    if (userRes.rows.length > 0) {
                        const { id: userId, balance: newBalance } = userRes.rows[0];
                        await notifyBalanceChange(pool, io, userId, username, WIN_PRIZE, newBalance, 'BINGO_WIN');
                    }
                }

                const winner = username;
                gameState.selectedCards.clear();
                gameState.readyPlayers.clear();
                gameState.calledNumbers = [];
                gameState.status = 'LOBBY_WAITING';
                gameState.timer = 40;
                gameState.gameId = null;

                io.emit('game_ended', { winner, cardNumber });
            } catch (err) {
                console.error("Error evaluating Bingo claim:", err);
                socket.emit('error_message', { message: "Error validating claim." });
            }
        });
    });
}

module.exports = initGameSocket;