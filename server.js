const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const upload = multer();


const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// PostgreSQL Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// -------------------- IN-MEMORY GAME STATE --------------------
// All active gameplay operates in RAM for sub-millisecond execution speeds
const gameState = {
    status: 'LOBBY_WAITING', // 'LOBBY_WAITING', 'GAME_ACTIVE'
    gameId: null,
    timer: 40,
    selectedCards: new Map(), // cardNumber => username
    readyPlayers: new Set()    // username
};

// -------------------- DATABASE SCHEMA INITIALIZATION --------------------
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                telegram_id BIGINT UNIQUE,
                phone_number VARCHAR(30),
                wins INT DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS bingo_cards (
                id SERIAL PRIMARY KEY,
                card_number INT UNIQUE NOT NULL,
                grid JSONB NOT NULL
            );

            CREATE TABLE IF NOT EXISTS game_sessions (
                id SERIAL PRIMARY KEY,
                status VARCHAR(20) NOT NULL,
                winner_username VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ended_at TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS game_participants (
                id SERIAL PRIMARY KEY,
                game_id INT REFERENCES game_sessions(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                cards_selected INT[] NOT NULL
            );
        `);

        // Seed 500 Bingo Cards if not already present
        const countRes = await pool.query('SELECT COUNT(*) FROM bingo_cards');
        if (parseInt(countRes.rows[0].count, 10) < 500) {
            console.log("Seeding 500 Bingo cards into database...");
            for (let i = 1; i <= 500; i++) {
                const grid = Array.from({ length: 5 }, () => Array(5).fill(0));
                for (let col = 0; col < 5; col++) {
                    const min = col * 15 + 1;
                    const nums = [];
                    while (nums.length < 5) {
                        const n = Math.floor(Math.random() * 15) + min;
                        if (!nums.includes(n)) nums.push(n);
                    }
                    for (let row = 0; row < 5; row++) grid[row][col] = nums[row];
                }
                grid[2][2] = "FREE";
                await pool.query(
                    'INSERT INTO bingo_cards (card_number, grid) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [i, JSON.stringify(grid)]
                );
            }
        }
        console.log("Database initialized cleanly.");
    } catch (err) {
        console.error("Database initialization error:", err);
    }
};
initDB();

// Helper: Verify Telegram Auth Data
function verifyTelegramAuth(initData, botToken) {
    if (!initData || !botToken) return { isValid: false, user: null };
    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');

        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a[0].localeCompare(b[0]))
            .map(([k, v]) => `${k}=${v}`)
            .join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
        const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

        if (calculatedHash !== hash) return { isValid: false, user: null };
        return { isValid: true, user: JSON.parse(params.get('user') || '{}') };
    } catch (err) {
        return { isValid: false, user: null };
    }
}

// -------------------- AUTH & USER ROUTES --------------------

app.post('/api/register', async (req, res) => {
    const { username, password, phoneNumber, initData } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: "Missing fields." });

    try {
        let telegramId = null;
        if (initData) {
            const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);
            if (isValid && user?.id) telegramId = user.id;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO users (username, password, telegram_id, phone_number) VALUES ($1, $2, $3, $4)',
            [username, hashedPassword, telegramId, phoneNumber || null]
        );
        res.json({ success: true, username });
    } catch (err) {
        res.status(400).json({ success: false, message: "Username or Telegram account taken." });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(400).json({ success: false, message: "User not found." });

        const isMatch = await bcrypt.compare(password, result.rows[0].password);
        if (!isMatch) return res.status(401).json({ success: false, message: "Invalid password." });

        res.json({ success: true, username: result.rows[0].username });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// 1. Updated Telegram Auth (Checks for existing phone number)
// 1. Updated Telegram Auth (Checks phone_verified status)
app.post('/api/telegram-auth', async (req, res) => {
    const { initData } = req.body;
    const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);
    
    if (!isValid || !user?.id) {
        return res.status(401).json({ success: false, message: "Invalid Telegram auth." });
    }

    try {
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;');

        // Check if user exists by telegram_id OR linked username
        let result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [user.id]);
        let dbUser;

        if (result.rows.length === 0 && user.username) {
            let webUser = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [user.username]);
            if (webUser.rows.length > 0) {
                await pool.query('UPDATE users SET telegram_id = $1 WHERE id = $2', [user.id, webUser.rows[0].id]);
                dbUser = webUser.rows[0];
            }
        } else if (result.rows.length > 0) {
            dbUser = result.rows[0];
        }

        if (dbUser) {
            return res.json({ 
                success: true, 
                status: 'LOGGED_IN', 
                username: dbUser.username,
                phoneVerified: !!dbUser.phone_verified 
            });
        }

        // Auto-register new Telegram user
        let baseUsername = user.username || user.first_name || `tg_${user.id}`;
        baseUsername = baseUsername.replace(/[^a-zA-Z0-9_]/g, '') || `tg_${user.id}`;

        let finalUsername = baseUsername;
        let existingName = await pool.query('SELECT id FROM users WHERE username = $1', [finalUsername]);
        if (existingName.rows.length > 0) {
            finalUsername = `${baseUsername}_${Math.floor(1000 + Math.random() * 9000)}`;
        }

        const randomPassword = crypto.randomBytes(16).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, 10);

        await pool.query(
            'INSERT INTO users (username, password, telegram_id, phone_verified) VALUES ($1, $2, $3, FALSE)',
            [finalUsername, hashedPassword, user.id]
        );

        res.json({ 
            success: true, 
            status: 'LOGGED_IN', 
            username: finalUsername,
            phoneVerified: false 
        });
    } catch (err) {
        console.error("Telegram Auth Error:", err);
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// 2. Save Verified Telegram Phone Endpoint
app.post('/api/save-telegram-phone', async (req, res) => {
    const { initData, phoneNumber } = req.body;

    const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!isValid || !user?.id) {
        return res.status(401).json({ success: false, message: "Unauthorized request." });
    }

    if (!phoneNumber) {
        return res.status(400).json({ success: false, message: "Phone number is missing." });
    }

    try {
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;');

        // Overwrite phone_number and mark phone_verified = TRUE
        await pool.query(
            'UPDATE users SET phone_number = $1, phone_verified = TRUE WHERE telegram_id = $2',
            [phoneNumber, user.id]
        );

        res.json({ success: true, message: "Telegram phone number verified and saved!" });
    } catch (err) {
        console.error("Save Telegram phone error:", err);
        res.status(500).json({ success: false, message: "Failed to save phone number." });
    }
});


app.post('/api/user/phone', async (req, res) => {
    const { username, phoneNumber } = req.body;
    try {
        await pool.query('UPDATE users SET phone_number = $1 WHERE username = $2', [phoneNumber, username]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to update phone number." });
    }
});

app.get('/api/cards/numbers', async (req, res) => {
    try {
        const result = await pool.query('SELECT card_number FROM bingo_cards ORDER BY card_number ASC');
        res.json({ success: true, cardNumbers: result.rows.map(r => r.card_number) });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to load cards." });
    }
});

app.post('/api/set-password', async (req, res) => {
    const { username, newPassword } = req.body;

    if (!username || !newPassword) {
        return res.status(400).json({ success: false, message: "Missing username or password." });
    }

    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Case-insensitive lookup using LOWER()
        const result = await pool.query(
            'UPDATE users SET password = $1 WHERE LOWER(username) = LOWER($2) RETURNING id',
            [hashedPassword, username]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ 
                success: false, 
                message: `User '${username}' not found in the database. Please ensure you are logged in.` 
            });
        }

        res.json({ success: true, message: "Password updated successfully! You can now log in on the web." });
    } catch (err) {
        console.error("Set password error:", err);
        // Sends the exact database error message to the client alert
        res.status(500).json({ success: false, message: `Database Error: ${err.message}` });
    }
});

// Broadcast Ads Endpoint
app.post('/api/admin/broadcast', upload.single('imageFile'), async (req, res) => {
    const { message, imageUrl, adminSecret } = req.body;
    
    if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ success: false, message: "Unauthorized: Incorrect secret key." });
    }

    try {
        const users = await pool.query('SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL');
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        for (const user of users.rows) {
            if (req.file) {
                // Send uploaded file directly to Telegram
                const formData = new FormData();
                formData.append('chat_id', user.telegram_id);
                formData.append('caption', message || '');
                formData.append('parse_mode', 'HTML');
                formData.append('photo', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);

                await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
                    method: 'POST',
                    body: formData
                }).catch(() => {});
            } else if (imageUrl) {
                // Send via image URL
                await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: user.telegram_id, photo: imageUrl, caption: message, parse_mode: 'HTML' })
                }).catch(() => {});
            } else {
                // Send text message
                await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: user.telegram_id, text: message, parse_mode: 'HTML' })
                }).catch(() => {});
            }
        }
        res.json({ success: true, message: "Broadcast sent successfully!" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error during broadcast." });
    }
});

// -------------------- SERVER-SIDE 40-SECOND TIMER LOOP --------------------
setInterval(async () => {
    if (gameState.status === 'LOBBY_WAITING') {
        gameState.timer--;

        if (gameState.timer <= 0) {
            // Check if at least 2 players clicked "Start Playing"
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
                // Not enough players: Wipe RAM cards and ready states for a fair fresh round
                gameState.selectedCards.clear();
                gameState.readyPlayers.clear();
                gameState.timer = 40;

                io.emit('lobby_reset', { 
                    message: "Not enough ready players. Cards reset for a fair round!" 
                });
            }
        } else {
            io.emit('timer_tick', { timer: gameState.timer, status: gameState.status });
        }
    }
}, 1000);

// -------------------- REAL-TIME SOCKET.IO ENGINE --------------------
io.on('connection', (socket) => {
    // Sync current RAM state instantly to newly connected client
    socket.emit('init_state', {
        status: gameState.status,
        timer: gameState.timer,
        takenCards: Object.fromEntries(gameState.selectedCards),
        readyPlayersCount: gameState.readyPlayers.size
    });

    // In-Memory Card Toggle (<1ms execution)
    socket.on('toggle_card', ({ cardNumber, username }) => {
        if (gameState.status !== 'LOBBY_WAITING') {
            return socket.emit('error_message', { message: "Card selection is locked during active gameplay!" });
        }

        const currentOwner = gameState.selectedCards.get(cardNumber);
        if (currentOwner) {
            if (currentOwner === username) {
                gameState.selectedCards.delete(cardNumber);
                io.emit('card_freed', { cardNumber });
            } else {
                socket.emit('error_message', { message: `Card ${cardNumber} is taken by ${currentOwner}` });
            }
        } else {
            gameState.selectedCards.set(cardNumber, username);
            io.emit('card_taken', { cardNumber, username });
        }
    });

    // Player enters ready room
    socket.on('player_ready', ({ username }) => {
        if (gameState.status !== 'LOBBY_WAITING') return;

        // Ensure user has at least 1 card selected
        const userHasCard = Array.from(gameState.selectedCards.values()).includes(username);
        if (!userHasCard) {
            return socket.emit('error_message', { message: "Please select at least one card before starting!" });
        }

        gameState.readyPlayers.add(username);
        io.emit('ready_count_updated', { readyCount: gameState.readyPlayers.size });
    });

    // Claim BINGO Win
    socket.on('claim_bingo', async ({ username }) => {
        if (gameState.status !== 'GAME_ACTIVE' || !gameState.readyPlayers.has(username)) {
            return socket.emit('error_message', { message: "Invalid Bingo claim." });
        }

        const winningUser = username;

        // 1. Asynchronously log session winner & update user score in PostgreSQL
        if (gameState.gameId) {
            pool.query('UPDATE game_sessions SET status = $1, winner_username = $2, ended_at = NOW() WHERE id = $3', ['COMPLETED', winningUser, gameState.gameId]).catch(console.error);
            pool.query('UPDATE users SET wins = wins + 1 WHERE username = $1', [winningUser]).catch(console.error);
        }

        // 2. Instantly reset In-Memory state for zero-lag transition
        gameState.selectedCards.clear();
        gameState.readyPlayers.clear();
        gameState.status = 'LOBBY_WAITING';
        gameState.timer = 40;
        gameState.gameId = null;

        // 3. Broadcast global reset event to return all clients to selection
        io.emit('game_ended', { winner: winningUser });
    });
});

server.listen(PORT, () => console.log(`Zero-Lag Bingo Server live on port ${PORT}`));