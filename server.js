const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
// Serve static frontend files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve main web page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// PostgreSQL Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Helper: Generate 5x5 Bingo Card Grid
function generateBingoCard() {
    const grid = Array.from({ length: 5 }, () => Array(5).fill(0));
    for (let col = 0; col < 5; col++) {
        const min = col * 15 + 1;
        const numbers = [];
        while (numbers.length < 5) {
            const num = Math.floor(Math.random() * 15) + min;
            if (!numbers.includes(num)) numbers.push(num);
        }
        for (let row = 0; row < 5; row++) {
            grid[row][col] = numbers[row];
        }
    }
    grid[2][2] = "FREE";
    return grid;
}

// Auto-initialize Database Schema & Seed 500 Bingo Cards
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
            ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id BIGINT UNIQUE;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30);

            CREATE TABLE IF NOT EXISTS bingo_cards (
                id SERIAL PRIMARY KEY,
                card_number INT UNIQUE NOT NULL,
                grid JSONB NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS selected_cards (
                card_number INT PRIMARY KEY,
                username VARCHAR(50) NOT NULL
            );
        `);

        const countRes = await pool.query('SELECT COUNT(*) FROM bingo_cards');
        const currentCount = parseInt(countRes.rows[0].count, 10);

        if (currentCount < 500) {
            console.log(`Seeding database with Bingo cards (Current: ${currentCount})...`);
            for (let i = currentCount + 1; i <= 500; i++) {
                const cardGrid = generateBingoCard();
                await pool.query(
                    'INSERT INTO bingo_cards (card_number, grid) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [i, JSON.stringify(cardGrid)]
                );
            }
            console.log("Successfully seeded 500 Bingo cards!");
        } else {
            console.log("Database initialized. 500 Bingo cards ready.");
        }
    } catch (err) {
        console.error("Database initialization error:", err);
    }
};
initDB();

// Cryptographic validation for Telegram initData
function verifyTelegramAuth(initData, botToken) {
    if (!initData || !botToken) return { isValid: false, user: null };

    try {
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        params.delete('hash');

        const dataCheckString = Array.from(params.entries())
            .sort(([a], [b]) => a[0].localeCompare(b[0]))
            .map(([key, val]) => `${key}=${val}`)
            .join('\n');

        const secretKey = crypto.createHmac('sha256', 'WebAppData')
            .update(botToken)
            .digest();

        const calculatedHash = crypto.createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

        if (calculatedHash !== hash) return { isValid: false, user: null };

        const user = JSON.parse(params.get('user') || '{}');
        return { isValid: true, user };
    } catch (err) {
        return { isValid: false, user: null };
    }
}

// -------------------- AUTH & USER ROUTES --------------------

app.post('/api/register', async (req, res) => {
    const { username, password, phoneNumber, initData } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: "Username and password required." });

    try {
        let telegramId = null;
        if (initData) {
            const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);
            if (isValid && user?.id) telegramId = user.id;
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, password, telegram_id, phone_number) VALUES ($1, $2, $3, $4) RETURNING id, username',
            [username, hashedPassword, telegramId, phoneNumber || null]
        );

        res.json({ success: true, username: result.rows[0].username, message: "Registration successful!" });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ success: false, message: "Username or Telegram account in use." });
        res.status(500).json({ success: false, message: "Server error during registration." });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password, initData } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: "Username and password required." });

    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(400).json({ success: false, message: "User not found." });

        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ success: false, message: "Invalid password." });

        if (initData && !user.telegram_id) {
            const { isValid, user: tgUser } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);
            if (isValid && tgUser?.id) {
                await pool.query('UPDATE users SET telegram_id = $1 WHERE id = $2', [tgUser.id, user.id]);
            }
        }

        res.json({ success: true, username: user.username, message: "Login successful!" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error during login." });
    }
});

app.post('/api/telegram-auth', async (req, res) => {
    const { initData } = req.body;
    const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);

    if (!isValid || !user?.id) return res.status(401).json({ success: false, message: "Invalid Telegram authentication." });

    try {
        const result = await pool.query('SELECT * FROM users WHERE telegram_id = $1', [user.id]);
        if (result.rows.length > 0) {
            return res.json({ success: true, status: 'LOGGED_IN', username: result.rows[0].username });
        } else {
            return res.json({ success: true, status: 'NEEDS_CHOICE', telegramUsername: user.username || user.first_name || `player_${user.id}` });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "Database error." });
    }
});

app.post('/api/telegram-quick-start', async (req, res) => {
    const { initData } = req.body;
    const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);

    if (!isValid || !user?.id) return res.status(401).json({ success: false, message: "Invalid Telegram session." });

    const defaultUsername = user.username || user.first_name || `player_${user.id}`;

    try {
        const newUser = await pool.query(
            'INSERT INTO users (username, password, telegram_id) VALUES ($1, $2, $3) RETURNING username',
            [defaultUsername, 'TELEGRAM_NATIVE_USER', user.id]
        );
        res.json({ success: true, username: newUser.rows[0].username });
    } catch (err) {
        res.status(500).json({ success: false, message: "Username taken or creation failed." });
    }
});

app.post('/api/telegram-link', async (req, res) => {
    const { initData, username, password } = req.body;
    const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);

    if (!isValid || !user?.id) return res.status(401).json({ success: false, message: "Invalid Telegram session." });

    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(400).json({ success: false, message: "Account not found." });

        const dbUser = result.rows[0];
        const passwordMatch = await bcrypt.compare(password, dbUser.password);
        if (!passwordMatch) return res.status(401).json({ success: false, message: "Incorrect password." });

        await pool.query('UPDATE users SET telegram_id = $1 WHERE id = $2', [user.id, dbUser.id]);
        res.json({ success: true, username: dbUser.username });
    } catch (err) {
        res.status(500).json({ success: false, message: "Account linking failed." });
    }
});

app.post('/api/user/phone', async (req, res) => {
    const { username, phoneNumber } = req.body;
    if (!username || !phoneNumber) return res.status(400).json({ success: false, message: "Missing data." });

    try {
        await pool.query('UPDATE users SET phone_number = $1 WHERE username = $2', [phoneNumber, username]);
        res.json({ success: true, message: "Phone number saved successfully." });
    } catch (err) {
        res.status(500).json({ success: false, message: "Database update error." });
    }
});

app.get('/api/cards/numbers', async (req, res) => {
    try {
        const result = await pool.query('SELECT card_number FROM bingo_cards ORDER BY card_number ASC');
        const cardNumbers = result.rows.map(row => row.card_number);
        res.json({ success: true, cardNumbers });
    } catch (err) {
        res.status(500).json({ success: false, message: "Error fetching card numbers." });
    }
});

// -------------------- TELEGRAM BROADCAST / ADS ENDPOINT --------------------

app.post('/api/admin/broadcast', async (req, res) => {
    const { message, imageUrl, adminSecret } = req.body;

    if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ success: false, message: "Unauthorized." });
    }

    try {
        const users = await pool.query('SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL');
        const botToken = process.env.TELEGRAM_BOT_TOKEN;

        let successCount = 0;
        for (const user of users.rows) {
            try {
                if (imageUrl) {
                    await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: user.telegram_id,
                            photo: imageUrl,
                            caption: message,
                            parse_mode: 'HTML'
                        })
                    });
                } else {
                    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: user.telegram_id,
                            text: message,
                            parse_mode: 'HTML'
                        })
                    });
                }
                successCount++;
            } catch (err) {
                console.error(`Failed to send ad to ${user.telegram_id}`);
            }
        }

        res.json({ success: true, message: `Ad sent to ${successCount} Telegram users.` });
    } catch (err) {
        res.status(500).json({ success: false, message: "Broadcast failed." });
    }
});

// -------------------- REAL-TIME SOCKET.IO --------------------

io.on('connection', async (socket) => {
    try {
        const takenRes = await pool.query('SELECT card_number, username FROM selected_cards');
        const takenCards = {};
        takenRes.rows.forEach(row => {
            takenCards[row.card_number] = row.username;
        });
        socket.emit('init_state', { takenCards });
    } catch (err) {
        console.error("Socket Init Error:", err);
    }

    socket.on('toggle_card', async ({ cardNumber, username }) => {
        if (!cardNumber || !username) return;

        try {
            const check = await pool.query('SELECT username FROM selected_cards WHERE card_number = $1', [cardNumber]);

            if (check.rows.length > 0) {
                if (check.rows[0].username === username) {
                    await pool.query('DELETE FROM selected_cards WHERE card_number = $1', [cardNumber]);
                    io.emit('card_freed', { cardNumber });
                } else {
                    socket.emit('error_message', { message: `Card ${cardNumber} is already claimed by ${check.rows[0].username}` });
                }
            } else {
                await pool.query('INSERT INTO selected_cards (card_number, username) VALUES ($1, $2)', [cardNumber, username]);
                io.emit('card_taken', { cardNumber, username });
            }
        } catch (err) {
            console.error("Toggle Card Error:", err);
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});