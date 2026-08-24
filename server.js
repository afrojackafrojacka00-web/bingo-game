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
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
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

            -- Indexes for high-speed searches and fast admin/user rendering
            CREATE INDEX IF NOT EXISTS idx_notifications_id_desc ON notifications(id DESC);
            CREATE INDEX IF NOT EXISTS idx_notifications_user_reads ON notifications(id DESC, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username));
            CREATE INDEX IF NOT EXISTS idx_game_participants_game ON game_participants(game_id);
            CREATE INDEX IF NOT EXISTS idx_transactions_user_created ON transactions(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_game_sessions_status_created ON game_sessions(status, created_at DESC);
        `);

        // Migration columns for existing tables
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(10,2) DEFAULT 10.00;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;');

await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS stake NUMERIC(10,2) DEFAULT 0;');
await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS prize_pool NUMERIC(10,2) DEFAULT 0;');


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
        return res.status(403).json({ success: false, message: "Unauthorized key." });
    }

    try {
        let finalImageUrl = imageUrl || null;

        if (req.file && req.file.path) {
            finalImageUrl = req.file.path;
        }

        // 1. Insert into Database for Web/App Notifications (ONLY if BOTH or APP_ONLY)
        if (destination === 'BOTH' || destination === 'APP_ONLY') {
            await pool.query(
                'INSERT INTO notifications (message, image_url) VALUES ($1, $2)',
                [message || '', finalImageUrl]
            );
        }

        // 2. Broadcast to Telegram users (ONLY if BOTH or TELEGRAM_ONLY)
        if (destination === 'BOTH' || destination === 'TELEGRAM_ONLY') {
            const botToken = process.env.TELEGRAM_BOT_TOKEN;
            if (botToken) {
                const users = await pool.query('SELECT telegram_id FROM users WHERE telegram_id IS NOT NULL');
                
                for (const user of users.rows) {
                    if (finalImageUrl) {
                        await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                chat_id: user.telegram_id, 
                                photo: finalImageUrl, 
                                caption: message || '', 
                                parse_mode: 'HTML' 
                            })
                        }).catch(() => {});
                    } else if (message) {
                        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ 
                                chat_id: user.telegram_id, 
                                text: message, 
                                parse_mode: 'HTML' 
                            })
                        }).catch(() => {});
                    }
                }
            }
        }

        res.json({ success: true, message: "Broadcast posted successfully!" });
    } catch (err) {
        console.error("BROADCAST ERROR DETAILED:", err);
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

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

    try {
        // Fetch top 20 latest posts ordered by newest first
        const result = await pool.query(
            'SELECT id, message, image_url, created_at FROM notifications ORDER BY id DESC LIMIT 20'
        );

        res.json({
            success: true,
            notifications: result.rows,
            unreadCount: result.rows.length
        });
    } catch (err) {
        console.error("Notification Fetch Error:", err);
        res.status(500).json({ success: false, message: "Server error fetching posts." });
    }
});



// -------------------- HIGH-CONCURRENCY MULTI-ROOM GAME ENGINE --------------------
// One room per stake. Users may select ANY number of cards from the 500-card catalog.
// Cards are NOT globally exclusive: thousands of users can own the same card number.
const DRAW_INTERVAL_MS = Number(process.env.DRAW_INTERVAL_MS || 2500);
const ROOM_BROADCAST_MS = 1000;
const MAX_CARDS_PER_PLAYER = Number(process.env.MAX_CARDS_PER_PLAYER || 500); // set 0 for no limit, catalog currently has 500

function createRoom(stake) {
    return {
        stake,
        status: 'WAITING',
        deadline: null,
        gameId: null,
        players: new Set(),
        selectedCards: new Map(), // username => Set(cardNumber)
        readyPlayers: new Set(),
        drawn: new Set(),
        drawOrder: [],
        drawTimer: null,
        drawIndex: 0,
        lastTickSecond: null
    };
}

const gameRooms = new Map(STAKES.map(stake => [stake, createRoom(stake)]));

function remainingSeconds(room) {
    if (room.status !== 'JOINING' || !room.deadline) return room.status === 'WAITING' ? ROUND_SECONDS : 0;
    return Math.max(0, Math.ceil((room.deadline - Date.now()) / 1000));
}
function roomSnapshot(room) {
    const activeCount = room.status === 'PLAYING' ? room.readyPlayers.size : room.players.size;
    
    // Collect all taken cards across all players in this room
    const takenCards = [];
    for (const cards of room.selectedCards.values()) {
        takenCards.push(...Array.from(cards));
    }

    return { 
        stake: room.stake, 
        status: room.status, 
        timer: remainingSeconds(room), 
        players: room.players.size,
        readyPlayers: room.readyPlayers.size, 
        prizePool: Number((activeCount * room.stake).toFixed(2)), 
        gameId: room.gameId,
        takenCards 
    };
}
function allRoomsSnapshot() { return STAKES.map(stake => roomSnapshot(gameRooms.get(stake))); }
function emitRoomsState() { io.emit('rooms_state', allRoomsSnapshot()); }
function roomName(stake) { return `stake_${stake}`; }

async function getUserIdAndBalance(username, client = pool) {
    const result = await client.query('SELECT id, username, balance FROM users WHERE LOWER(username)=LOWER($1) FOR UPDATE', [username]);
    return result.rows[0] || null;
}
async function refundStake(stake, username, reason) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const user = await getUserIdAndBalance(username, client);
        if (!user) throw new Error('User not found');
        await client.query('UPDATE users SET balance=balance+$1 WHERE id=$2', [stake, user.id]);
        await client.query('INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)', [user.id, stake, reason]);
        await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}
function userCards(room, username) { return room.selectedCards.get(username) || new Set(); }
function removePlayer(room, username) { room.players.delete(username); room.readyPlayers.delete(username); room.selectedCards.delete(username); }
function clearDrawTimer(room) { if (room.drawTimer) clearInterval(room.drawTimer); room.drawTimer=null; }
async function resetRoom(room, message=null) {
    clearDrawTimer(room); room.status='WAITING'; room.deadline=null; room.gameId=null; room.players.clear(); room.selectedCards.clear(); room.readyPlayers.clear(); room.drawn.clear(); room.drawOrder=[]; room.drawIndex=0; room.lastTickSecond=null;
    io.to(roomName(room.stake)).emit('room_reset',{stake:room.stake,message});
    emitRoomsState();
}
function shuffledBingoNumbers() { const a=Array.from({length:75},(_,i)=>i+1); for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }
function isWinningGrid(grid, drawn) {
    const hit=(v,r,c)=>v==='FREE'||drawn.has(Number(v));
    for(let r=0;r<5;r++) if([0,1,2,3,4].every(c=>hit(grid[r][c],r,c))) return true;
    for(let c=0;c<5;c++) if([0,1,2,3,4].every(r=>hit(grid[r][c],r,c))) return true;
    if([0,1,2,3,4].every(i=>hit(grid[i][i],i,i))) return true;
    if([0,1,2,3,4].every(i=>hit(grid[i][4-i],i,4-i))) return true;
    return false;
}
const cardGridCache = new Map();
async function getCardGrid(cardNumber) {
    if(cardGridCache.has(cardNumber)) return cardGridCache.get(cardNumber);
    const r=await pool.query('SELECT grid FROM bingo_cards WHERE card_number=$1',[cardNumber]);
    if(!r.rowCount) return null; const grid=r.rows[0].grid; cardGridCache.set(cardNumber,grid); return grid;
}
async function startRoomGame(room) {
    room.status='PLAYING'; room.deadline=null;
    const participants=Array.from(room.readyPlayers);
    const prize=participants.length*room.stake;
    const client=await pool.connect();
    try {
        await client.query('BEGIN');
        const sr=await client.query('INSERT INTO game_sessions(status,stake,prize_pool) VALUES($1,$2,$3) RETURNING id',['IN_PROGRESS',room.stake,prize]);
        room.gameId=sr.rows[0].id;
        for(const username of participants) {
            const cards=Array.from(userCards(room,username));
            await client.query('INSERT INTO game_participants(game_id,username,cards_selected) VALUES($1,$2,$3)',[room.gameId,username,cards]);
        }
        await client.query('COMMIT');
    } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    room.drawOrder=shuffledBingoNumbers(); room.drawIndex=0; room.drawn.clear();
    io.to(roomName(room.stake)).emit('game_started',{stake:room.stake,gameId:room.gameId,prizePool:prize,drawn:[]});
    emitRoomsState();
    room.drawTimer = setInterval(async () => {
    if (room.status !== 'PLAYING') {
        clearDrawTimer(room);
        return;
    }

    // 1. If all active/ready players disconnected or left, reset the room automatically
    if (room.readyPlayers.size === 0) {
        clearDrawTimer(room);
        if (room.gameId) {
            await pool.query("UPDATE game_sessions SET status = 'CANCELLED', ended_at = NOW() WHERE id = $1", [room.gameId]);
        }
        await resetRoom(room, "Game ended because all players left.");
        return;
    }

    // 2. Draw next number
    if (room.drawIndex < room.drawOrder.length) {
        const number = room.drawOrder[room.drawIndex++];
        room.drawn.add(number);
        io.to(roomName(room.stake)).emit('number_drawn', { stake: room.stake, number, drawIndex: room.drawIndex });
    } else {
        // 3. All 75 numbers called and no winner claimed
        clearDrawTimer(room);
        if (room.gameId) {
            await pool.query("UPDATE game_sessions SET status = 'EXHAUSTED', ended_at = NOW() WHERE id = $1", [room.gameId]);
        }
        io.to(roomName(room.stake)).emit('game_ended', { stake: room.stake, winner: 'No One', prize: 0 });
        await resetRoom(room, "All numbers 1-75 were called with no winner. Ready for the next round!");
    }
}, DRAW_INTERVAL_MS);
}

// Single scheduler: six rooms, no per-player timers. Only room subscribers receive room ticks.
setInterval(async()=>{
    for(const room of gameRooms.values()) {
        if(room.status!=='JOINING') continue;
        const seconds=remainingSeconds(room);
        if(seconds!==room.lastTickSecond){room.lastTickSecond=seconds;io.to(roomName(room.stake)).emit('room_tick',roomSnapshot(room));}
        if(room.deadline && Date.now()<room.deadline) continue;
        const unready=Array.from(room.players).filter(u=>!room.readyPlayers.has(u));
        for(const u of unready){try{await refundStake(room.stake,u,'GAME_REFUND_UNREADY');}catch(e){console.error('refund',e)} removePlayer(room,u);}
        if(room.readyPlayers.size>=MIN_PLAYERS){
            try{await startRoomGame(room);}catch(e){console.error('start game',e);for(const u of Array.from(room.players)){try{await refundStake(room.stake,u,'GAME_REFUND_START_ERROR')}catch(x){console.error(x)}} await resetRoom(room,'The game could not start. Stakes were refunded.');}
        } else {
            for(const u of Array.from(room.players)){try{await refundStake(room.stake,u,'GAME_REFUND_NOT_ENOUGH_PLAYERS')}catch(e){console.error(e)}}
            await resetRoom(room,'Not enough ready players. Your stake was refunded.');
        }
    }
},ROOM_BROADCAST_MS);

io.on('connection',(socket)=>{
    socket.emit('rooms_state',allRoomsSnapshot());
    socket.on('rooms_state_request',()=>socket.emit('rooms_state',allRoomsSnapshot()));
    socket.on('subscribe_room',({stake,username},cb=()=>{})=>{
        stake=Number(stake); const room=gameRooms.get(stake); if(!room) return cb({success:false});
        socket.join(roomName(stake));
        cb({success:true,state:{...roomSnapshot(room),selectedCards:Array.from(userCards(room,username)),drawn:Array.from(room.drawn)}});
    });
    socket.on('unsubscribe_room',({stake})=>socket.leave(roomName(Number(stake))));
    socket.on('join_room',async({stake,username},cb=()=>{})=>{
        stake=Number(stake); const room=gameRooms.get(stake); if(!room||!username) return cb({success:false,message:'Invalid game room.'});
        if(room.status==='PLAYING') return cb({success:false,message:'This game is already playing.'});
        for(const [otherStake,r] of gameRooms) if(otherStake!==stake&&r.players.has(username)) return cb({success:false,message:`You are already in the ${otherStake} Birr room.`});
        if(room.players.has(username)){socket.join(roomName(stake));return cb({success:true,alreadyJoined:true,room:roomSnapshot(room)});}
        const client=await pool.connect();
        try{await client.query('BEGIN');const user=await getUserIdAndBalance(username,client);if(!user)throw new Error('User not found.');if(Number(user.balance)<stake)throw new Error('Insufficient balance.');await client.query('UPDATE users SET balance=balance-$1 WHERE id=$2',[stake,user.id]);await client.query('INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',[user.id,-stake,'GAME_ENTRY']);await client.query('COMMIT');
            room.players.add(username);room.selectedCards.set(username,new Set());if(room.status==='WAITING'){room.status='JOINING';room.deadline=Date.now()+ROUND_SECONDS*1000;room.lastTickSecond=null;}socket.join(roomName(stake));io.to(roomName(stake)).emit('room_state',roomSnapshot(room));emitRoomsState();cb({success:true,room:roomSnapshot(room),balance:Number(user.balance)-stake});
        }catch(e){await client.query('ROLLBACK');cb({success:false,message:e.message||'Unable to join room.'});}finally{client.release();}
    });
    socket.on('leave_room', async ({ stake, username }, cb = () => {}) => {
    stake = Number(stake);
    const room = gameRooms.get(stake);
    if (!room || !room.players.has(username)) return cb({ success: false, message: 'You are not in this room.' });
    
    if (room.status === 'PLAYING') {
        removePlayer(room, username);
        socket.leave(roomName(stake));
        io.to(roomName(stake)).emit('room_state', roomSnapshot(room));
        emitRoomsState();
        return cb({ success: true, message: 'You left the playing game. Stake forfeited.' });
    }

    try {
        await refundStake(stake, username, 'GAME_REFUND_LEFT_ROOM');
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
    } catch (e) {
        cb({ success: false, message: 'Refund failed. Please try again.' });
    }
});
    socket.on('toggle_card', ({ stake, cardNumber, username }, cb = () => {}) => {
    stake = Number(stake);
    cardNumber = Number(cardNumber);
    const room = gameRooms.get(stake);
    
    if (!room || room.status !== 'JOINING' || !room.players.has(username)) {
        return cb({ success: false, message: 'Card selection is closed.' });
    }
    if (!Number.isInteger(cardNumber) || cardNumber < 1 || cardNumber > 500) {
        return cb({ success: false, message: 'Invalid card number.' });
    }
    if (room.readyPlayers.has(username)) {
        return cb({ success: false, message: 'You are already ready.' });
    }

    const cards = userCards(room, username);

    if (cards.has(cardNumber)) {
        cards.delete(cardNumber);
    } else {
        // Check if another player in the room already claimed this card
        for (const [owner, ownerCards] of room.selectedCards.entries()) {
            if (owner !== username && ownerCards.has(cardNumber)) {
                return cb({ success: false, message: `Card ${cardNumber} is already taken by another player!` });
            }
        }
        
        if (MAX_CARDS_PER_PLAYER > 0 && cards.size >= MAX_CARDS_PER_PLAYER) {
            return cb({ success: false, message: `Maximum ${MAX_CARDS_PER_PLAYER} cards.` });
        }
        cards.add(cardNumber);
    }

    room.selectedCards.set(username, cards);
    socket.emit('my_cards', { stake, cards: Array.from(cards) });
    
    // Broadcast updated taken cards list to everyone in the room
    io.to(roomName(stake)).emit('room_state', roomSnapshot(room));
    cb({ success: true, count: cards.size });
});
    socket.on('player_ready',({stake,username},cb=()=>{})=>{stake=Number(stake);const room=gameRooms.get(stake);if(!room||room.status!=='JOINING'||!room.players.has(username))return cb({success:false,message:'Room is not accepting READY.'});if(!userCards(room,username).size)return cb({success:false,message:'Select at least one card.'});room.readyPlayers.add(username);io.to(roomName(stake)).emit('room_state',roomSnapshot(room));emitRoomsState();cb({success:true});});
    socket.on('claim_bingo',async({stake,username,cardNumber},cb=()=>{})=>{
        stake=Number(stake);cardNumber=Number(cardNumber);const room=gameRooms.get(stake);if(!room||room.status!=='PLAYING'||!room.readyPlayers.has(username)||!userCards(room,username).has(cardNumber))return cb({success:false,message:'Invalid Bingo claim.'});
        try{const grid=await getCardGrid(cardNumber);if(!grid||!isWinningGrid(grid,room.drawn))return cb({success:false,message:'That card does not have Bingo yet.'});
            // Lock the room synchronously before the first DB await so concurrent claims cannot both win.
            room.status='FINISHING';clearDrawTimer(room);const prize=room.readyPlayers.size*room.stake;const client=await pool.connect();try{await client.query('BEGIN');const user=await getUserIdAndBalance(username,client);if(!user)throw new Error('Winner not found');await client.query('UPDATE game_sessions SET status=$1,winner_username=$2,ended_at=NOW() WHERE id=$3',['COMPLETED',username,room.gameId]);await client.query('UPDATE users SET wins=wins+1,balance=balance+$1 WHERE id=$2',[prize,user.id]);await client.query('INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',[user.id,prize,'GAME_WIN']);await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');room.status='PLAYING';throw e;}finally{client.release();}
            io.to(roomName(stake)).emit('game_ended',{stake,winner:username,prize,cardNumber});await resetRoom(room,`Game finished. ${username} won ${prize} Birr!`);cb({success:true});
        }catch(e){console.error('claim',e);cb({success:false,message:e.message||'Unable to complete claim.'});}
    });
});

server.listen(PORT,()=>console.log(`Bingo server listening on ${PORT}`));
