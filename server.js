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
const io = new Server(server, {
    cors: { origin: "*" },
    transports: ['websocket', 'polling'],
    perMessageDeflate: false,
    maxHttpBufferSize: 1e5,
    pingInterval: 25000,
    pingTimeout: 20000
});
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
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    // Tuned for a single server instance handling many concurrent rooms.
    // The old default (max: 10) becomes a bottleneck once a few hundred
    // players are toggling cards at once — each toggle used to cost several
    // round trips per click, so raise the ceiling and fail fast instead of
    // queueing forever if the DB is genuinely overloaded.
    max: Number(process.env.PG_POOL_MAX || 30),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
});

// -------------------- GAME CONFIG --------------------
const STAKES = [10, 20, 50, 100, 200, 500];
const ROUND_SECONDS = 40;
const MIN_PLAYERS = 2;

// -------------------- DATABASE SCHEMA INITIALIZATION --------------------
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
                balance NUMERIC(10,2) DEFAULT 0.00,
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

            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                message TEXT,
                image_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS user_notification_reads (
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                last_read_id INT DEFAULT 0,
                PRIMARY KEY (user_id)
            );

            CREATE TABLE IF NOT EXISTS user_notifications (
                id BIGSERIAL PRIMARY KEY,
                user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                message TEXT,
                image_url TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                read_at TIMESTAMP NULL
            );

            -- Indexes for high-speed searches and fast admin/user rendering
            CREATE INDEX IF NOT EXISTS idx_notifications_id_desc ON notifications(id DESC);
            CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created ON user_notifications(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_user_notifications_unread ON user_notifications(user_id) WHERE read_at IS NULL;
            CREATE INDEX IF NOT EXISTS idx_notifications_user_reads ON notifications(id DESC, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username));
            CREATE INDEX IF NOT EXISTS idx_game_participants_game ON game_participants(game_id);
            CREATE INDEX IF NOT EXISTS idx_game_participants_username ON game_participants(LOWER(username));
            CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_game_sessions_status_created ON game_sessions(status, created_at DESC);
        `);

        // Migration columns for existing tables
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(10,2) DEFAULT 0.00;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS wins INT DEFAULT 0;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;');
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(5) DEFAULT 'en';");

await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS stake NUMERIC(10,2) DEFAULT 0;');
await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS prize_pool NUMERIC(10,2) DEFAULT 0;');
        await pool.query("ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS winning_pattern VARCHAR(100) DEFAULT 'any_one_line';");
        await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS draw_interval_seconds INT DEFAULT 4;');
        await pool.query(`CREATE TABLE IF NOT EXISTS bingo_game_settings (id INT PRIMARY KEY CHECK (id=1), winning_pattern VARCHAR(100) NOT NULL DEFAULT 'any_one_line', draw_interval_seconds INT NOT NULL DEFAULT 4, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        await pool.query(`INSERT INTO bingo_game_settings(id,winning_pattern,draw_interval_seconds) VALUES(1,'any_one_line',4) ON CONFLICT (id) DO NOTHING;`);
        await pool.query('ALTER TABLE game_participants ADD COLUMN IF NOT EXISTS card_count INT DEFAULT 1;');
        await pool.query('ALTER TABLE game_participants ADD COLUMN IF NOT EXISTS amount_paid NUMERIC(10,2) DEFAULT 0;');

        // Winning-card detail, so History can show which card won and let the
        // user open it up and see the actual winning grid + pattern.
        await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS winning_card_number INT;');
        await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS winning_cells JSONB;');
        await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS drawn_numbers INT[];');


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
        console.log("Database initialized cleanly with indexes.");
    } catch (err) {
        console.error("Database initialization error:", err);
    }
};
initDB();

async function createNotificationBaseline(client, userId) {
    const result = await client.query('SELECT COALESCE(MAX(id), 0) AS last_id FROM notifications');
    const lastReadId = Number(result.rows[0].last_id || 0);
    await client.query(`
        INSERT INTO user_notification_reads (user_id, last_read_id)
        VALUES ($1, $2)
        ON CONFLICT (user_id) DO NOTHING
    `, [userId, lastReadId]);
}


async function createPersonalNotification(client, userId, message, imageUrl = null) {
    await client.query(
        `INSERT INTO user_notifications (user_id, message, image_url)
         VALUES ($1, $2, $3)`,
        [userId, message || '', imageUrl]
    );
}

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

// Helper: send Telegram API request and fail loudly when Telegram rejects it.
async function telegramApi(method, botToken, payload) {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
        throw new Error(data.description || `Telegram ${method} failed`);
    }
    return data;
}

// Helper: Send Telegram Welcome Photo & Message
async function sendTelegramWelcomeMessage(telegramId, username, phoneNumber) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken || !telegramId) return false;

    const baseUrl = (process.env.APP_URL ||
        (process.env.RENDER_EXTERNAL_HOSTNAME
            ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
            : '')).replace(/\/$/, '');

    const imageUrl = baseUrl ? `${baseUrl}/images/welcome.jpg` : '';
    const captionText =
        `ለስለተመዘገብ እናመሰግናለን ${username}! 🎉\n\n` +
        `10 ብር ስጦታ አለዎት።\n\n` +
        `የአካውንት ዝርዝሮች\n` +
        `ስም: ${username}\n` +
        `ስልክ: ${phoneNumber || '-'}\n` +
        `ቀሪ ሒሳብ: 10.00 ብር`;

    try {
        if (imageUrl) {
            try {
                await telegramApi('sendPhoto', botToken, {
                    chat_id: telegramId,
                    photo: imageUrl,
                    caption: captionText
                });
                return true;
            } catch (photoError) {
                console.error('Welcome photo failed, using text fallback:', photoError.message);
            }
        }

        await telegramApi('sendMessage', botToken, {
            chat_id: telegramId,
            text: captionText
        });
        return true;
    } catch (err) {
        console.error('Failed to send Telegram welcome message:', err.message);
        return false;
    }
}

// -------------------- AUTH & USER ROUTES --------------------

// 1. Web Registration Endpoint
app.post('/api/register', async (req, res) => {
    const { username, password, phoneNumber } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Missing fields.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const hashedPassword = await bcrypt.hash(password, 12);
        const userRes = await client.query(
            `INSERT INTO users (username, password, telegram_id, phone_number, balance)
             VALUES ($1, $2, NULL, $3, 0.00)
             RETURNING id, username`,
            [username, hashedPassword, phoneNumber || null]
        );

        const userId = userRes.rows[0].id;

        // Old global notifications must not appear for this new account.
        await createNotificationBaseline(client, userId);

        // This welcome belongs only to this new website account.
        await createPersonalNotification(
            client,
            userId,
            `Welcome ${userRes.rows[0].username}! 🎉\n\nYour account has been created successfully.\n\nBalance: 0.00 Birr.`,
            null
        );

        await client.query('COMMIT');
        res.json({ success: true, username: userRes.rows[0].username });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Registration error:', err);
        res.status(400).json({ success: false, message: 'Username already taken or registration failed.' });
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

        await createNotificationBaseline(client, newUserRes.rows[0].id);

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

// 6. Get User Details (Balance, Phone, Username, Language)
app.get('/api/user-details', async (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ success: false, message: "Username required." });

    try {
        const result = await pool.query(
            'SELECT username, phone_number, balance, preferred_language FROM users WHERE LOWER(username) = LOWER($1)',
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

// 6b. Update Preferred Language (English / Amharic)
app.post('/api/user/language', async (req, res) => {
    const { username, language } = req.body;
    if (!username || !['en', 'am'].includes(language)) {
        return res.status(400).json({ success: false, message: "Invalid language." });
    }

    try {
        const result = await pool.query(
            'UPDATE users SET preferred_language = $1 WHERE LOWER(username) = LOWER($2) RETURNING username',
            [language, username]
        );
        if (!result.rowCount) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Set language error:', err);
        res.status(500).json({ success: false, message: "Failed to save language." });
    }
});

// 6c. Game History — completed games this user actually joined (not every game)
app.get('/api/history', async (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ success: false, message: "Username required." });

    // Paged like a feed instead of dumping everything at once.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 15, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    try {
        const result = await pool.query(
            `SELECT
                gs.id,
                gs.stake,
                gs.prize_pool,
                gs.winner_username,
                gs.winning_card_number,
                gs.status,
                gs.created_at,
                gs.ended_at,
                gp.card_count,
                gp.amount_paid,
                (SELECT COUNT(*) FROM game_participants gp2 WHERE gp2.game_id = gs.id) AS player_count
             FROM game_participants gp
             JOIN game_sessions gs ON gs.id = gp.game_id
             WHERE LOWER(gp.username) = LOWER($1)
               AND gs.status IN ('COMPLETED', 'EXHAUSTED')
             ORDER BY gs.created_at DESC
             LIMIT $2 OFFSET $3`,
            [username, limit + 1, offset]
        );
        const hasMore = result.rows.length > limit;
        const page = result.rows.slice(0, limit);

        const history = page.map(row => ({
            gameId: row.id,
            stake: Number(row.stake),
            prizePool: Number(row.prize_pool),
            winner: row.winner_username || null,
            won: !!row.winner_username && row.winner_username.toLowerCase() === username.toLowerCase(),
            winningCardNumber: row.winning_card_number || null,
            players: Number(row.player_count),
            cardCount: Number(row.card_count),
            amountPaid: Number(row.amount_paid),
            date: row.ended_at || row.created_at
        }));

        res.json({ success: true, history, hasMore });
    } catch (err) {
        console.error('History fetch error:', err);
        res.status(500).json({ success: false, message: "Server error fetching history." });
    }
});

// Detail for a single past game: the winning card's grid, the winning
// pattern's cells, and the numbers that had been drawn — everything needed
// to redraw exactly what the winner saw when they won.
app.get('/api/history/:gameId', async (req, res) => {
    const gameId = Number(req.params.gameId);
    if (!Number.isInteger(gameId)) {
        return res.status(400).json({ success: false, message: 'Invalid game id.' });
    }

    try {
        const result = await pool.query(
            `SELECT gs.id, gs.stake, gs.prize_pool, gs.winner_username, gs.winning_pattern,
                    gs.winning_card_number, gs.winning_cells, gs.drawn_numbers, gs.ended_at,
                    bc.grid
             FROM game_sessions gs
             LEFT JOIN bingo_cards bc ON bc.card_number = gs.winning_card_number
             WHERE gs.id = $1`,
            [gameId]
        );

        if (!result.rowCount || !result.rows[0].winning_card_number) {
            return res.status(404).json({ success: false, message: 'No winning card recorded for this game.' });
        }

        const row = result.rows[0];
        res.json({
            success: true,
            game: {
                gameId: row.id,
                stake: Number(row.stake),
                prizePool: Number(row.prize_pool),
                winner: row.winner_username,
                patternName: PATTERN_NAMES[row.winning_pattern] || row.winning_pattern,
                cardNumber: row.winning_card_number,
                grid: row.grid,
                winningCells: row.winning_cells || [],
                drawnNumbers: row.drawn_numbers || [],
                date: row.ended_at
            }
        });
    } catch (err) {
        console.error('History detail fetch error:', err);
        res.status(500).json({ success: false, message: 'Server error fetching game detail.' });
    }
});

// 6d. Wallet — current balance plus recent transaction log
app.get('/api/wallet', async (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ success: false, message: "Username required." });

    // Paged like a feed instead of dumping everything at once — cheaper on
    // the DB and on rendering when someone has a long transaction history.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    try {
        const userResult = await pool.query(
            'SELECT id, balance FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        if (!userResult.rowCount) {
            return res.status(404).json({ success: false, message: "User not found." });
        }

        const user = userResult.rows[0];
        // Fetch one extra row purely to know whether another page exists,
        // without a separate COUNT(*) query.
        const txResult = await pool.query(
            'SELECT amount, type, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
            [user.id, limit + 1, offset]
        );
        const hasMore = txResult.rows.length > limit;
        const page = txResult.rows.slice(0, limit);

        res.json({
            success: true,
            balance: Number(user.balance),
            hasMore,
            transactions: page.map(t => ({
                amount: Number(t.amount),
                type: t.type,
                date: t.created_at
            }))
        });
    } catch (err) {
        console.error('Wallet fetch error:', err);
        res.status(500).json({ success: false, message: "Server error fetching wallet." });
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

const fs = require('fs');

const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

// Configure Cloudinary API Credentials
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure Multer Storage Engine to upload directly to Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'announcements',
    // Compress quality automatically and convert to efficient web formats
    transformation: [
      { width: 800, crop: 'limit' }, // Scales down images larger than 800px width
      { quality: 'auto', fetch_format: 'auto' } // Reduces file size without visible loss
    ]
  }
});

const upload = multer({ storage });

app.post('/api/admin/broadcast', upload.single('imageFile'), async (req, res) => {
    const { message, imageUrl, adminSecret, destination } = req.body;

    if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ success: false, message: 'Unauthorized key.' });
    }

    try {
        let finalImageUrl = imageUrl || null;
        if (req.file && req.file.path) finalImageUrl = req.file.path;

        if (destination === 'BOTH' || destination === 'APP_ONLY') {
            await pool.query(
                'INSERT INTO notifications (message, image_url) VALUES ($1, $2)',
                [message || '', finalImageUrl]
            );
        }

        let sentCount = 0;
        let failedCount = 0;

        if (destination === 'BOTH' || destination === 'TELEGRAM_ONLY') {
            const botToken = process.env.TELEGRAM_BOT_TOKEN;
            if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN is missing.');

            const users = await pool.query(
                'SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL'
            );

            for (const user of users.rows) {
                try {
                    if (finalImageUrl) {
                        await telegramApi('sendPhoto', botToken, {
                            chat_id: user.telegram_id,
                            photo: finalImageUrl,
                            caption: message || ''
                        });
                    } else if (message) {
                        await telegramApi('sendMessage', botToken, {
                            chat_id: user.telegram_id,
                            text: message
                        });
                    }
                    sentCount++;
                } catch (err) {
                    failedCount++;
                    console.error(`Telegram send failed for ${user.telegram_id}:`, err.message);
                }
            }
        }

        res.json({
            success: true,
            message: 'Broadcast posted successfully!',
            telegram: { sent: sentCount, failed: failedCount }
        });
    } catch (err) {
        console.error('BROADCAST ERROR DETAILED:', err);
        res.status(500).json({ success: false, message: `Server Error: ${err.message}` });
    }
});


// 2. Get All Posts for Admin Dashboard
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

// Delete Notification Post & Remove Image File from Disk
app.delete('/api/admin/notifications/:id', async (req, res) => {
    const { id } = req.params;
    const adminSecret = req.headers['x-admin-secret'];

    if (adminSecret !== process.env.ADMIN_SECRET) {
        return res.status(403).json({ success: false, message: "Unauthorized." });
    }

    try {
        // Fetch image URL before deleting
        const fileQuery = await pool.query('SELECT image_url FROM notifications WHERE id = $1', [id]);
        
        if (fileQuery.rows.length > 0 && fileQuery.rows[0].image_url) {
            const imageUrl = fileQuery.rows[0].image_url;
            
            // If it's a local upload, delete the physical file from disk
            if (imageUrl.startsWith('/uploads/')) {
                const filePath = path.join(__dirname, 'public', imageUrl);
                fs.unlink(filePath, (err) => {
                    if (err) console.error("Could not delete file from uploads folder:", err);
                });
            }
        }

        await pool.query('DELETE FROM notifications WHERE id = $1', [id]);
        res.json({ success: true, message: "Post and local file deleted successfully!" });
    } catch (err) {
        console.error("Delete error:", err);
        res.status(500).json({ success: false, message: "Failed to delete post." });
    }
});

app.get('/api/notifications', async (req, res) => {
    const { username } = req.query;
    if (!username) {
        return res.status(400).json({ success: false, message: 'Username required.' });
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    try {
        const userResult = await pool.query(
            `SELECT id, created_at FROM users WHERE LOWER(username) = LOWER($1)`,
            [username]
        );
        if (!userResult.rowCount) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        const user = userResult.rows[0];
        const readResult = await pool.query(
            'SELECT last_read_id FROM user_notification_reads WHERE user_id = $1',
            [user.id]
        );
        const lastReadId = Number(readResult.rows[0]?.last_read_id || 0);

        // Global announcements are visible only if created after this account.
        const globalResult = await pool.query(
            `SELECT id, message, image_url, created_at, false AS personal,
                    CASE WHEN id > $2 THEN true ELSE false END AS unread
             FROM notifications
             WHERE created_at >= $1
             ORDER BY created_at DESC
             LIMIT 50`,
            [user.created_at, lastReadId]
        );

        // Personal notifications, including the website welcome message.
        const personalResult = await pool.query(
            `SELECT id, message, image_url, created_at, true AS personal,
                    CASE WHEN read_at IS NULL THEN true ELSE false END AS unread
             FROM user_notifications
             WHERE user_id = $1
             ORDER BY created_at DESC
             LIMIT 50`,
            [user.id]
        );

        const notifications = [...globalResult.rows, ...personalResult.rows]
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
            .slice(0, 50);

        const unreadCount = notifications.filter(n => n.unread).length;

        res.json({ success: true, notifications, unreadCount });
    } catch (err) {
        console.error('Notification Fetch Error:', err);
        res.status(500).json({ success: false, message: 'Server error fetching notifications.' });
    }
});

app.post('/api/notifications/mark-read', async (req, res) => {
    const { username } = req.body;
    if (!username) {
        return res.status(400).json({ success: false, message: 'Username required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const userResult = await client.query(
            'SELECT id, created_at FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        if (!userResult.rowCount) throw new Error('User not found.');

        const user = userResult.rows[0];
        const latest = await client.query(
            'SELECT COALESCE(MAX(id), 0) AS latest_id FROM notifications WHERE created_at >= $1',
            [user.created_at]
        );

        await client.query(
            `INSERT INTO user_notification_reads (user_id, last_read_id)
             VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET
             last_read_id = GREATEST(user_notification_reads.last_read_id, EXCLUDED.last_read_id)`,
            [user.id, Number(latest.rows[0].latest_id || 0)]
        );

        await client.query(
            'UPDATE user_notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL',
            [user.id]
        );

        await client.query('COMMIT');
        res.json({ success: true, unreadCount: 0 });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Mark notification read error:', err);
        res.status(500).json({ success: false, message: 'Could not mark notifications as read.' });
    } finally {
        client.release();
    }
});

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
        frozenPrizePool: null
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

    const prizePool = (isLiveGame && room.frozenPrizePool != null)
        ? room.frozenPrizePool
        : Number((totalCards * room.stake).toFixed(2));

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
    room.frozenPrizePool = Number(prize.toFixed(2));
    room.frozenTotalCards = totalCards;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const sessionResult = await client.query(
            'INSERT INTO game_sessions(status,stake,prize_pool,winning_pattern,draw_interval_seconds) VALUES($1,$2,$3,$4,$5) RETURNING id',
            ['IN_PROGRESS', room.stake, prize, room.winningPattern, room.drawIntervalSeconds]
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
        prizePool: room.frozenPrizePool,
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
        if (room.gameId) {
            await pool.query(
                "UPDATE game_sessions SET status='EXHAUSTED', ended_at=NOW() WHERE id=$1",
                [room.gameId]
            );
        }
        io.to(roomName(room.stake)).emit('game_ended', {
            stake: room.stake,
            winner: 'No One',
            prize: 0
        });
        await resetRoom(
            room,
            'All numbers 1-75 were called with no winner. Ready for the next round!'
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


app.get('/api/admin/game-settings', async (req,res)=>{ if(req.headers['x-admin-secret']!==process.env.ADMIN_SECRET) return res.status(403).json({success:false,message:'Unauthorized.'}); const r=await pool.query('SELECT winning_pattern,draw_interval_seconds FROM bingo_game_settings WHERE id=1'); const s=r.rows[0]||{winning_pattern:DEFAULT_GAME_PATTERN,draw_interval_seconds:DEFAULT_DRAW_INTERVAL_SECONDS}; res.json({success:true,winningPattern:s.winning_pattern,drawIntervalSeconds:s.draw_interval_seconds,patterns:PATTERN_NAMES}); });
app.post('/api/admin/game-settings', async (req,res)=>{ const {adminSecret,winningPattern,drawIntervalSeconds}=req.body; if(adminSecret!==process.env.ADMIN_SECRET)return res.status(403).json({success:false,message:'Unauthorized.'}); if(!PATTERN_NAMES[winningPattern])return res.status(400).json({success:false,message:'Invalid pattern.'}); const seconds=Number(drawIntervalSeconds); if(!Number.isInteger(seconds)||seconds<1||seconds>60)return res.status(400).json({success:false,message:'Interval must be 1-60 seconds.'}); await pool.query(`INSERT INTO bingo_game_settings(id,winning_pattern,draw_interval_seconds,updated_at) VALUES(1,$1,$2,NOW()) ON CONFLICT(id) DO UPDATE SET winning_pattern=EXCLUDED.winning_pattern,draw_interval_seconds=EXCLUDED.draw_interval_seconds,updated_at=NOW()`,[winningPattern,seconds]); res.json({success:true,winningPattern,drawIntervalSeconds:seconds}); });
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
        if(!room||room.status!=='PLAYING'||!room.readyPlayers.has(username)||!userCards(room,username).has(cardNumber)) return cb({success:false,message:'Invalid Bingo claim.'});
        if(room.claimLockedCards.has(cardNumber)) return cb({success:false,locked:true,message:'This card is locked for the rest of this game.'});
        try {
            const grid=await getCardGrid(cardNumber);
            const claim=grid?winningClaim(grid,room.drawn,room.winningPattern,room.lastNumber):{ok:false};
            if(!claim.ok){ room.claimLockedCards.add(cardNumber); socket.emit('card_locked',{stake,cardNumber,message:'BINGO claim was not valid for the latest called number. This card is locked for this round.'}); return cb({success:false,locked:true,message:'Invalid or late BINGO claim. This card is now locked for this game.'}); }
            room.status='FINISHING'; clearDrawTimer(room);
            // Pay the full pool that was locked in when the game started —
            // never recomputed from whoever is still in readyPlayers, so a
            // player leaving mid-game can never shrink the winner's payout.
            const prize = room.frozenPrizePool != null ? room.frozenPrizePool : (()=>{let p=0;for(const player of room.readyPlayers)p+=getPlayerPaid(room,player);return p;})();
            const drawnNumbers = Array.from(room.drawn);
            const client=await pool.connect(); try { await client.query('BEGIN'); const user=await getUserIdAndBalance(username,client); if(!user)throw new Error('Winner not found'); await client.query('UPDATE game_sessions SET status=$1,winner_username=$2,ended_at=NOW(),winning_card_number=$3,winning_cells=$4,drawn_numbers=$5 WHERE id=$6',['COMPLETED',username,cardNumber,JSON.stringify(claim.cells),drawnNumbers,room.gameId]); await client.query('UPDATE users SET wins=wins+1,balance=balance+$1 WHERE id=$2',[prize,user.id]); await client.query('INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',[user.id,prize,'GAME_WIN']); await client.query('COMMIT'); } catch(err){await client.query('ROLLBACK');room.status='PLAYING';throw err;} finally{client.release();}
            const winnerPayload={stake,winner:username,prize,cardNumber,grid,winningCells:claim.cells,lastNumber:room.lastNumber,patternName:PATTERN_NAMES[room.winningPattern]||room.winningPattern};
            room.winnerPayload=winnerPayload;
            cb({success:true,...winnerPayload}); io.to(roomName(stake)).emit('game_won',winnerPayload);
            setTimeout(async()=>{ io.to(roomName(stake)).emit('game_ended',{stake,winner:username,prize,cardNumber}); await resetRoom(room,`Game finished. ${username} won ${prize} Birr!`); },5000);
        } catch(err){ console.error('claim',err); cb({success:false,message:err.message||'Unable to complete claim.'}); }
    });
});

server.listen(PORT,()=>console.log(`Bingo server listening on ${PORT}`));








