const { notifyBalanceChange } = require('./notificationSocket');

const gameState = {
    status: 'LOBBY_WAITING',
    gameId: null,
    timer: 40,
    selectedCards: new Map(),
    readyPlayers: new Set()
};

function initGameSocket(io, pool) {
    setInterval(async () => {
        if (gameState.status === 'LOBBY_WAITING') {
            gameState.timer--;

            if (gameState.timer <= 0) {
                if (gameState.readyPlayers.size >= 2) {
                    gameState.status = 'GAME_ACTIVE';

                    try {
                        const sessionRes = await pool.query(
                            'INSERT INTO game_sessions (status) VALUES ($1) RETURNING id',
                            ['IN_PROGRESS']
                        );
                        gameState.gameId = sessionRes.rows[0].id;

                        const playerCardMap = {};
                        gameState.selectedCards.forEach((username, cardNumber) => {
                            if (gameState.readyPlayers.has(username)) {
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
                        console.error("Error creating session in DB:", err);
                    }

                    io.emit('game_started', {
                        gameId: gameState.gameId,
                        players: Array.from(gameState.readyPlayers)
                    });
                } else {
                    gameState.selectedCards.clear();
                    gameState.readyPlayers.clear();
                    gameState.timer = 40;

                    io.emit('lobby_reset', { message: "Not enough ready players. Resetting cards." });
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
            readyPlayersCount: gameState.readyPlayers.size
        });

        socket.on('toggle_card', ({ cardNumber, username }) => {
            if (gameState.status !== 'LOBBY_WAITING') {
                return socket.emit('error_message', { message: "Selection locked during active gameplay!" });
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

        socket.on('claim_bingo', async ({ username }) => {
            if (gameState.status !== 'GAME_ACTIVE' || !gameState.readyPlayers.has(username)) {
                return socket.emit('error_message', { message: "Invalid Bingo claim." });
            }

            const winningUser = username;

            if (gameState.gameId) {
                pool.query('UPDATE game_sessions SET status = $1, winner_username = $2, ended_at = NOW() WHERE id = $3', ['COMPLETED', winningUser, gameState.gameId]).catch(console.error);

                const winReward = 50.00;
                const updatedUser = await pool.query(
                    'UPDATE users SET wins = wins + 1, balance = balance + $1 WHERE username = $2 RETURNING id, balance',
                    [winReward, winningUser]
                );

                if (updatedUser.rows.length > 0) {
                    const { id: userId, balance: newBalance } = updatedUser.rows[0];
                    notifyBalanceChange(pool, io, userId, winningUser, winReward, newBalance, 'BINGO_WIN');
                }
            }

            gameState.selectedCards.clear();
            gameState.readyPlayers.clear();
            gameState.status = 'LOBBY_WAITING';
            gameState.timer = 40;
            gameState.gameId = null;

            io.emit('game_ended', { winner: winningUser });
        });
    });
}

module.exports = initGameSocket;