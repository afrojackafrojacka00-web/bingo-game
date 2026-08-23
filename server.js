const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
// const upload = multer();

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

// PostgreSQL Connection Pool
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// -------------------- IN-MEMORY GAME STATE --------------------
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
                phone_verified BOOLEAN DEFAULT FALSE,
                balance NUMERIC(10,2) DEFAULT 10.00,
                wins INT DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                amount NUMERIC(10,2) NOT NULL,
                type VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

        // Migration columns for existing tables
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(10,2) DEFAULT 10.00;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;');

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

// Helper: Send Telegram Welcome Photo & Message
async function sendTelegramWelcomeMessage(telegramId, username, phoneNumber) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken || !telegramId) return;

    const baseUrl = process.env.APP_URL || (process.env.RENDER_EXTERNAL_HOSTNAME ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}` : '');
    const imageUrl = baseUrl ? `${baseUrl}/images/welcome.jpg` : '';

    const captionText = `ለስለተመዘገብ እናመሰግናለን ${username}! 10 ብር ስጦታ አለዎት .\n\n` +
                        `የአካውንት ዝርዝሮች\n` +
                        `ስም: ${username}\n` +
                        `ስልክ: ${phoneNumber}\n` +
                        `ቀሪ ሒሳብ: 10`;

    try {
        if (imageUrl) {
            await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: telegramId,
                    photo: imageUrl,
                    caption: captionText
                })
            });
        } else {
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: telegramId,
                    text: captionText
                })
            });
        }
    } catch (err) {
        console.error("Failed to send Telegram welcome message:", err);
    }
}

// -------------------- AUTH & USER ROUTES --------------------

// 1. Web Registration Endpoint
app.post('/api/register', async (req, res) => {
    const { username, password, phoneNumber, initData } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: "Missing fields." });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let telegramId = null;
        if (initData) {
            const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);
            if (isValid && user?.id) telegramId = user.id;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const userRes = await client.query(
            'INSERT INTO users (username, password, telegram_id, phone_number, balance) VALUES ($1, $2, $3, $4, 10.00) RETURNING id, username',
            [username, hashedPassword, telegramId, phoneNumber || null]
        );

        const userId = userRes.rows[0].id;

        // Record 10 Birr Welcome Transaction
        await client.query(
            'INSERT INTO transactions (user_id, amount, type) VALUES ($1, $2, $3)',
            [userId, 10.00, 'WELCOME_BONUS']
        );

        await client.query('COMMIT');
        res.json({ success: true, username: userRes.rows[0].username });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: "Username or Telegram account taken." });
    } finally {
        client.release();
    }
});

// 2. Web Login Endpoint
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (result.rows.length === 0) return res.status(400).json({ success: false, message: "User not found." });

        const isMatch = await bcrypt.compare(password, result.rows[0].password);
        if (!isMatch) return res.status(401).json({ success: false, message: "Invalid password." });

        res.json({ success: true, username: result.rows[0].username });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// 3. Telegram Auto-Authentication Endpoint
app.post('/api/telegram-auth', async (req, res) => {
    const { initData } = req.body;
    const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);
    
    if (!isValid || !user?.id) {
        return res.status(401).json({ success: false, message: "Invalid Telegram auth." });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        let result = await client.query('SELECT * FROM users WHERE telegram_id = $1', [user.id]);
        let dbUser;

        if (result.rows.length === 0 && user.username) {
            let webUser = await client.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [user.username]);
            if (webUser.rows.length > 0) {
                await client.query('UPDATE users SET telegram_id = $1 WHERE id = $2', [user.id, webUser.rows[0].id]);
                dbUser = webUser.rows[0];
            }
        } else if (result.rows.length > 0) {
            dbUser = result.rows[0];
        }

        if (dbUser) {
            await client.query('COMMIT');
            return res.json({ 
                success: true, 
                status: 'LOGGED_IN', 
                username: dbUser.username,
                phoneVerified: !!dbUser.phone_verified 
            });
        }

        // Register new Telegram user
        let baseUsername = user.username || user.first_name || `tg_${user.id}`;
        baseUsername = baseUsername.replace(/[^a-zA-Z0-9_]/g, '') || `tg_${user.id}`;

        let finalUsername = baseUsername;
        let existingName = await client.query('SELECT id FROM users WHERE username = $1', [finalUsername]);
        if (existingName.rows.length > 0) {
            finalUsername = `${baseUsername}_${Math.floor(1000 + Math.random() * 9000)}`;
        }

        const randomPassword = crypto.randomBytes(16).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, 10);

        const newUserRes = await client.query(
            'INSERT INTO users (username, password, telegram_id, phone_verified, balance) VALUES ($1, $2, $3, FALSE, 10.00) RETURNING id',
            [finalUsername, hashedPassword, user.id]
        );

        // Record initial 10 Birr Welcome Transaction
        await client.query(
            'INSERT INTO transactions (user_id, amount, type) VALUES ($1, $2, $3)',
            [newUserRes.rows[0].id, 10.00, 'WELCOME_BONUS']
        );

        await client.query('COMMIT');

        res.json({ 
            success: true, 
            status: 'LOGGED_IN', 
            username: finalUsername,
            phoneVerified: false 
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Telegram Auth Error:", err);
        res.status(500).json({ success: false, message: "Server error." });
    } finally {
        client.release();
    }
});

// 4. Save Verified Telegram Phone Endpoint
app.post('/api/save-telegram-phone', async (req, res) => {
    const { initData, phoneNumber } = req.body;

    const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!isValid || !user?.id) {
        return res.status(401).json({ success: false, message: "Unauthorized request." });
    }

    if (!phoneNumber) {
        return res.status(400).json({ success: false, message: "Phone number is missing." });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const checkUser = await client.query('SELECT id, username, phone_verified FROM users WHERE telegram_id = $1', [user.id]);
        if (checkUser.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: "User not found." });
        }

        const isAlreadyVerified = checkUser.rows[0].phone_verified;
        const username = checkUser.rows[0].username;
        const userId = checkUser.rows[0].id;

        // Overwrite phone_number and mark phone_verified = TRUE
        await client.query(
            'UPDATE users SET phone_number = $1, phone_verified = TRUE WHERE telegram_id = $2',
            [phoneNumber, user.id]
        );

        // Ensure WELCOME_BONUS transaction is recorded if missing
        if (!isAlreadyVerified) {
            const hasBonus = await client.query(
                "SELECT id FROM transactions WHERE user_id = $1 AND type = 'WELCOME_BONUS'",
                [userId]
            );

            if (hasBonus.rows.length === 0) {
                await client.query(
                    'INSERT INTO transactions (user_id, amount, type) VALUES ($1, $2, $3)',
                    [userId, 10.00, 'WELCOME_BONUS']
                );
            }
        }

        await client.query('COMMIT');

        // Dispatch Telegram photo & message asynchronously
        sendTelegramWelcomeMessage(user.id, username, phoneNumber);

        res.json({ success: true, message: "Telegram phone number verified and saved!" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Save Telegram phone error:", err);
        res.status(500).json({ success: false, message: "Failed to save phone number." });
    } finally {
        client.release();
    }
});

// 5. Update Phone Number Endpoint
app.post('/api/user/phone', async (req, res) => {
    const { username, phoneNumber } = req.body;
    try {
        await pool.query('UPDATE users SET phone_number = $1 WHERE username = $2', [phoneNumber, username]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to update phone number." });
    }
});

// 6. Get User Details (Balance, Phone, Username)
app.get('/api/user-details', async (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ success: false, message: "Username required." });

    try {
        const result = await pool.query(
            'SELECT username, phone_number, balance FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// 7. Get All Bingo Card Numbers
app.get('/api/cards/numbers', async (req, res) => {
    try {
        const result = await pool.query('SELECT card_number FROM bingo_cards ORDER BY card_number ASC');
        res.json({ success: true, cardNumbers: result.rows.map(r => r.card_number) });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to load cards." });
    }
});

// 8. Set Password Endpoint
app.post('/api/set-password', async (req, res) => {
    const { username, newPassword } = req.body;

    if (!username || !newPassword) {
        return res.status(400).json({ success: false, message: "Missing username or password." });
    }

    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
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
        res.status(500).json({ success: false, message: `Database Error: ${err.message}` });
    }
});

// // 9. Broadcast Ads Endpoint (Supports Text, Photo URL, or Uploaded File)
// app.post('/api/admin/broadcast', upload.single('imageFile'), async (req, res) => {
//     const { message, imageUrl, adminSecret } = req.body;
    
//     if (adminSecret !== process.env.ADMIN_SECRET) {
//         return res.status(403).json({ success: false, message: "Unauthorized: Incorrect secret key." });
//     }

//     try {
//         const users = await pool.query('SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL');
//         const botToken = process.env.TELEGRAM_BOT_TOKEN;

//         for (const user of users.rows) {
//             if (req.file) {
//                 const formData = new FormData();
//                 formData.append('chat_id', user.telegram_id);
//                 formData.append('caption', message || '');
//                 formData.append('parse_mode', 'HTML');
//                 formData.append('photo', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);

//                 await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
//                     method: 'POST',
//                     body: formData
//                 }).catch(() => {});
//             } else if (imageUrl) {
//                 await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
//                     method: 'POST',
//                     headers: { 'Content-Type': 'application/json' },
//                     body: JSON.stringify({ chat_id: user.telegram_id, photo: imageUrl, caption: message, parse_mode: 'HTML' })
//                 }).catch(() => {});
//             } else {
//                 await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
//                     method: 'POST',
//                     headers: { 'Content-Type': 'application/json' },
//                     body: JSON.stringify({ chat_id: user.telegram_id, text: message, parse_mode: 'HTML' })
//                 }).catch(() => {});
//             }
//         }
//         res.json({ success: true, message: "Broadcast sent successfully!" });
//     } catch (err) {
//         res.status(500).json({ success: false, message: "Server error during broadcast." });
//     }
// });


const fs = require('fs');

// Ensure public/uploads folder exists
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Save uploaded files to server disk
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
// const upload = multer({ storage });
// Memory storage handles uploads directly in RAM (No disk required)
// const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

// Serve static uploaded images
app.use('/uploads', express.static(uploadDir));

// Memory storage handles uploads directly in RAM (No disk required)
const upload = multer({ limits: { fileSize: 5 * 1024 * 1024 } });

// 1. Create Broadcast (Base64 stored in DB for Web, Direct Buffer to Telegram)
app.post('/api/admin/broadcast', upload.single('imageFile'), async (req, res) => {
    const { message, imageUrl, adminSecret } = req.body;
    
    if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ success: false, message: "Unauthorized admin key." });
    }

    try {
        let finalImageUrl = imageUrl || null;

        // Convert uploaded image to Base64 Data URL for web persistence
        if (req.file) {
            finalImageUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
        }

        // Save persistent post in Database
        await pool.query(
            'INSERT INTO notifications (message, image_url) VALUES ($1, $2)',
            [message, finalImageUrl]
        );

        // Telegram Broadcast
        const users = await pool.query('SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL');
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        for (const user of users.rows) {
            if (req.file) {
                const formData = new FormData();
                formData.append('chat_id', user.telegram_id);
                formData.append('caption', message || '');
                formData.append('parse_mode', 'HTML');
                formData.append('photo', new Blob([req.file.buffer], { type: req.file.mimetype }), req.file.originalname);
                await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: formData }).catch(() => {});
            } else if (imageUrl) {
                await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: user.telegram_id, photo: imageUrl, caption: message, parse_mode: 'HTML' })
                }).catch(() => {});
            } else {
                await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ chat_id: user.telegram_id, text: message, parse_mode: 'HTML' })
                }).catch(() => {});
            }
        }

        res.json({ success: true, message: "Broadcast sent to Telegram and published on Web!" });
    } catch (err) {
        console.error("Broadcast error:", err);
        res.status(500).json({ success: false, message: "Server error during broadcast." });
    }
});

// 2. Get All Notifications for Admin Dashboard
app.get('/api/admin/notifications', async (req, res) => {
    const adminSecret = req.headers['x-admin-secret'];
    if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ success: false, message: "Unauthorized." });
    }

    try {
        const result = await pool.query('SELECT * FROM notifications ORDER BY id DESC');
        res.json({ success: true, notifications: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to fetch posts." });
    }
});

// 3. Edit Notification Post
app.put('/api/admin/notifications/:id', async (req, res) => {
    const { id } = req.params;
    const { message, imageUrl, adminSecret } = req.body;

    if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ success: false, message: "Unauthorized." });
    }

    try {
        await pool.query(
            'UPDATE notifications SET message = $1, image_url = $2 WHERE id = $3',
            [message, imageUrl || null, id]
        );
        res.json({ success: true, message: "Post updated successfully!" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to update post." });
    }
});

// 4. Delete Notification Post
app.delete('/api/admin/notifications/:id', async (req, res) => {
    const { id } = req.params;
    const adminSecret = req.headers['x-admin-secret'];

    if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ success: false, message: "Unauthorized." });
    }

    try {
        await pool.query('DELETE FROM notifications WHERE id = $1', [id]);
        res.json({ success: true, message: "Post deleted successfully!" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to delete post." });
    }
});

// -------------------- SERVER-SIDE 40-SECOND TIMER LOOP --------------------
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
    socket.emit('init_state', {
        status: gameState.status,
        timer: gameState.timer,
        takenCards: Object.fromEntries(gameState.selectedCards),
        readyPlayersCount: gameState.readyPlayers.size
    });

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

    socket.on('player_ready', ({ username }) => {
        if (gameState.status !== 'LOBBY_WAITING') return;

        const userHasCard = Array.from(gameState.selectedCards.values()).includes(username);
        if (!userHasCard) {
            return socket.emit('error_message', { message: "Please select at least one card before starting!" });
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
            pool.query('UPDATE users SET wins = wins + 1 WHERE username = $1', [winningUser]).catch(console.error);
        }

        gameState.selectedCards.clear();
        gameState.readyPlayers.clear();
        gameState.status = 'LOBBY_WAITING';
        gameState.timer = 40;
        gameState.gameId = null;

        io.emit('game_ended', { winner: winningUser });
    });
});

server.listen(PORT, () => console.log(`Zero-Lag Bingo Server live on port ${PORT}`));