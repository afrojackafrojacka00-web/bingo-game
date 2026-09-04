'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const helmet = require('helmet');
const compression = require('compression');
const fs = require('fs');
const { verifyDeposit } = require('../paymentVerification');

const config = require('./config');
const pool = require('./db/pool');
const { initDB } = require('./db/init');
const { adminAuth, requireAdmin } = require('./middleware/adminAuth');
const { generalLimiter, authLimiter, moneyLimiter } = require('./middleware/rateLimiters');
const cache = require('./cache/memory');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
    perMessageDeflate: false,
    maxHttpBufferSize: 1e5,
    pingInterval: 25000,
    pingTimeout: 20000
});
const PORT = config.port;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(config.publicDir, {
    maxAge: config.isProd ? '1h' : 0,
    etag: true
}));

app.use('/api/', generalLimiter);

app.get('/', (req, res) => {
    res.sendFile(path.join(config.publicDir, 'index.html'));
});

const STAKES = config.stakes;
const ROUND_SECONDS = config.roundSeconds;
const MIN_PLAYERS = config.minPlayers;

initDB().catch((err) => console.error('initDB failed', err));

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
    if (!initData || !botToken) return { isValid: false, user: null, startParam: null };
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

        if (calculatedHash !== hash) return { isValid: false, user: null, startParam: null };
        return {
            isValid: true,
            user: JSON.parse(params.get('user') || '{}'),
            // Present when the Mini App was opened via a direct link like
            // t.me/<bot>/<app>?startapp=ref_<username> — this is how a
            // referral code reaches us on Telegram without needing a
            // separate bot webhook/command handler.
            startParam: params.get('start_param') || null
        };
    } catch (err) {
        return { isValid: false, user: null, startParam: null };
    }
}


// Require a valid Telegram Mini App initData and resolve the linked DB user.
// Used for sensitive actions (password / username change) so callers cannot
// target arbitrary usernames without controlling that Telegram account.

async function getRoomCutPercent(stake, client) {
    const q = client && client.query ? client : pool;
    const r = await q.query('SELECT cut_percent FROM room_rake_settings WHERE stake = $1', [Number(stake)]);
    if (!r.rowCount) return 20;
    const pct = Number(r.rows[0].cut_percent);
    if (!Number.isFinite(pct) || pct < 0) return 20;
    return Math.min(100, pct);
}

function splitPot(prizePool, cutPercent) {
    const pot = Number(prizePool) || 0;
    const pct = Math.min(100, Math.max(0, Number(cutPercent) || 0));
    // House gets cut; winner gets the rest. Round to 2 decimals; leftover cent to winner.
    const houseCut = Number(((pot * pct) / 100).toFixed(2));
    let winnerPrize = Number((pot - houseCut).toFixed(2));
    if (winnerPrize < 0) winnerPrize = 0;
    // Fix floating residue so house + winner == pot
    const fixedHouse = Number((pot - winnerPrize).toFixed(2));
    return { houseCut: fixedHouse, winnerPrize, cutPercent: pct, prizePool: pot };
}

async function getWelcomeBonusSettings(client) {
    const q = client && client.query ? client : pool;
    const r = await q.query('SELECT enabled, amount FROM welcome_bonus_settings WHERE id = 1');
    if (!r.rowCount) return { enabled: true, amount: 10 };
    return { enabled: !!r.rows[0].enabled, amount: Number(r.rows[0].amount || 0) };
}

async function requireTelegramWebAppUser(initData) {
    const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!isValid || !user?.id) {
        return { ok: false, status: 401, message: 'Open this screen inside the Telegram Mini App and try again.' };
    }
    // Reject very old auth payloads (replay). 24h is generous for a settings form.
    try {
        const params = new URLSearchParams(initData);
        const authDate = Number(params.get('auth_date') || 0);
        if (authDate && (Math.floor(Date.now() / 1000) - authDate) > 86400) {
            return { ok: false, status: 401, message: 'Telegram session expired. Close and reopen the Mini App, then try again.' };
        }
    } catch (_) {}

    const result = await pool.query(
        'SELECT id, username, telegram_id FROM users WHERE telegram_id = $1',
        [user.id]
    );
    if (!result.rowCount) {
        return { ok: false, status: 404, message: 'No account linked to this Telegram user.' };
    }
    return { ok: true, dbUser: result.rows[0], tgUser: user };
}

// Records a referral relationship for a brand-new user, and credits the
// referrer's bonus balance the moment their referral count crosses a new
// multiple of the admin-configured milestone. Must run inside the same
// transaction as the INSERT that created the new user, and never throws —
// an unknown/invalid referral code should never block someone's signup.
async function applyReferralIfNew(client, referredByRaw, newUsername) {
    const referredBy = (referredByRaw || '').trim();
    if (!referredBy || referredBy.toLowerCase() === newUsername.toLowerCase()) return;

    const referrer = await client.query(
        'SELECT id, username FROM users WHERE LOWER(username) = LOWER($1)',
        [referredBy]
    );
    if (!referrer.rowCount) return;

    const referrerUsername = referrer.rows[0].username;
    await client.query(
        'UPDATE users SET referred_by = $1 WHERE LOWER(username) = LOWER($2)',
        [referrerUsername, newUsername]
    );

    const countRes = await client.query(
        'SELECT COUNT(*) FROM users WHERE LOWER(referred_by) = LOWER($1)',
        [referrerUsername]
    );
    const referralCount = Number(countRes.rows[0].count);

    const settingsRes = await client.query('SELECT referrals_required, reward_amount FROM referral_settings WHERE id = 1');
    const settings = settingsRes.rows[0] || { referrals_required: 100, reward_amount: 500 };
    const required = Number(settings.referrals_required);

    if (required > 0 && referralCount % required === 0) {
        const reward = Number(settings.reward_amount);
        await client.query(
            'UPDATE users SET bonus_balance = bonus_balance + $1 WHERE id = $2',
            [reward, referrer.rows[0].id]
        );
        await client.query(
            'INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',
            [referrer.rows[0].id, reward, 'REFERRAL_BONUS']
        );
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
async function sendTelegramWelcomeMessage(telegramId, username, phoneNumber, welcomeAmount) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken || !telegramId) return false;

    const baseUrl = (process.env.APP_URL ||
        (process.env.RENDER_EXTERNAL_HOSTNAME
            ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`
            : '')).replace(/\/$/, '');

    const imageUrl = baseUrl ? `${baseUrl}/images/welcome.jpg` : '';
    const amt = Number(welcomeAmount);
    const hasBonus = Number.isFinite(amt) && amt > 0;
    const amtStr = hasBonus ? amt.toFixed(2) : '0.00';
    const giftLine = hasBonus ? `${amtStr} ብር ስጦታ አለዎት።\n\n` : '';
    const captionText =
        `ለስለተመዘገብ እናመሰግናለን ${username}! 🎉\n\n` +
        giftLine +
        `የአካውንት ዝርዝሮች\n` +
        `ስም: ${username}\n` +
        `ስልክ: ${phoneNumber || '-'}\n` +
        `ቀሪ ሒሳብ: ${amtStr} ብር`;

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
app.post('/api/register', authLimiter, async (req, res) => {
    return res.status(403).json({
        success: false,
        message: 'Web registration is disabled. Open our Telegram bot to create an account, set a password there, then log in here.'
    });
    const { username, password, phoneNumber, referredBy } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Missing fields.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const hashedPassword = await bcrypt.hash(password, 12);
        const userRes = await client.query(
            `INSERT INTO users (username, password, telegram_id, phone_number, balance, last_active_at)
             VALUES ($1, $2, NULL, $3, 0.00, NOW())
             RETURNING id, username`,
            [username, hashedPassword, phoneNumber || null]
        );

        const userId = userRes.rows[0].id;

        await applyReferralIfNew(client, referredBy, userRes.rows[0].username);

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
app.post('/api/login', authLimiter, async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (result.rows.length === 0) return res.status(400).json({ success: false, message: "User not found." });

        const isMatch = await bcrypt.compare(password, result.rows[0].password);
        if (!isMatch) return res.status(401).json({ success: false, message: "Invalid password." });

        await pool.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [result.rows[0].id]);
        res.json({ success: true, username: result.rows[0].username });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error." });
    }
});

// 3. Telegram Auto-Authentication Endpoint
app.post('/api/telegram-auth', async (req, res) => {
    const { initData } = req.body;
    const { isValid, user, startParam } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);
    
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
            await client.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [dbUser.id]);
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

        const welcome = await getWelcomeBonusSettings(client);
        const welcomeAmount = welcome.enabled && welcome.amount > 0 ? welcome.amount : 0;

        const newUserRes = await client.query(
            'INSERT INTO users (username, password, telegram_id, phone_verified, balance, last_active_at) VALUES ($1, $2, $3, FALSE, $4, NOW()) RETURNING id',
            [finalUsername, hashedPassword, user.id, welcomeAmount]
        );

        // A direct link like t.me/<bot>/<app>?startapp=ref_<username> arrives
        // here as start_param = "ref_<username>".
        if (startParam && startParam.startsWith('ref_')) {
            await applyReferralIfNew(client, startParam.slice(4), finalUsername);
        }

        // Record welcome bonus transaction only when admin enabled it and amount > 0
        if (welcomeAmount > 0) {
            await client.query(
                'INSERT INTO transactions (user_id, amount, type) VALUES ($1, $2, $3)',
                [newUserRes.rows[0].id, welcomeAmount, 'WELCOME_BONUS']
            );
        }

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

        // If welcome bonus was never applied (legacy / race), credit once when enabled.
        if (!isAlreadyVerified) {
            const welcome = await getWelcomeBonusSettings(client);
            const welcomeAmount = welcome.enabled && welcome.amount > 0 ? welcome.amount : 0;
            if (welcomeAmount > 0) {
                const hasBonus = await client.query(
                    "SELECT id FROM transactions WHERE user_id = $1 AND type = 'WELCOME_BONUS'",
                    [userId]
                );
                if (hasBonus.rows.length === 0) {
                    await client.query(
                        'UPDATE users SET balance = balance + $1 WHERE id = $2',
                        [welcomeAmount, userId]
                    );
                    await client.query(
                        'INSERT INTO transactions (user_id, amount, type) VALUES ($1, $2, $3)',
                        [userId, welcomeAmount, 'WELCOME_BONUS']
                    );
                }
            }
        }

        await client.query('COMMIT');

        // Dispatch Telegram photo & message asynchronously
        (async () => {
            try {
                const w = await getWelcomeBonusSettings();
                const a = w.enabled && w.amount > 0 ? w.amount : 0;
                await sendTelegramWelcomeMessage(user.id, username, phoneNumber, a);
            } catch (e) { console.error(e); }
        })();

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
        // Touch activity so web users (who stay logged in via localStorage and
        // rarely hit /api/login) still count as active in the admin dashboard.
        const result = await pool.query(
            `UPDATE users SET last_active_at = NOW()
             WHERE LOWER(username) = LOWER($1)
             RETURNING username, display_name, phone_number, balance, bonus_balance,
                       preferred_language, preferred_theme, preferred_voice_pack, sound_enabled`,
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

app.post('/api/user/theme', async (req, res) => {
    const { username, theme } = req.body;
    if (!username || !['dark', 'light'].includes(theme)) {
        return res.status(400).json({ success: false, message: "Invalid theme." });
    }
    try {
        const result = await pool.query(
            'UPDATE users SET preferred_theme = $1 WHERE LOWER(username) = LOWER($2) RETURNING username',
            [theme, username]
        );
        if (!result.rowCount) return res.status(404).json({ success: false, message: "User not found." });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to save theme." });
    }
});

app.post('/api/user/display-name', async (req, res) => {
    const { username, displayName } = req.body;
    if (!username || !displayName || String(displayName).trim().length < 2 || String(displayName).trim().length > 50) {
        return res.status(400).json({ success: false, message: "Display name must be 2-50 characters." });
    }
    try {
        const result = await pool.query(
            'UPDATE users SET display_name = $1 WHERE LOWER(username) = LOWER($2) RETURNING username, display_name',
            [String(displayName).trim(), username]
        );
        if (!result.rowCount) return res.status(404).json({ success: false, message: "User not found." });
        res.json({ success: true, displayName: result.rows[0].display_name });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to save display name." });
    }
});

// Update Preferred Voice Pack for number calls
const VOICE_PACKS = ['john', 'amharic', 'oromifa', 'jerry', 'arada'];
app.post('/api/user/voice-pack', async (req, res) => {
    const { username, voicePack } = req.body;
    if (!username || !VOICE_PACKS.includes(voicePack)) {
        return res.status(400).json({ success: false, message: "Invalid voice pack." });
    }

    try {
        const result = await pool.query(
            'UPDATE users SET preferred_voice_pack = $1 WHERE LOWER(username) = LOWER($2) RETURNING username',
            [voicePack, username]
        );
        if (!result.rowCount) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Set voice pack error:', err);
        res.status(500).json({ success: false, message: "Failed to save voice pack." });
    }
});

// Update sound on/off — saved server-side so it's the same on the next
// game, the next login, and any device, instead of resetting each time.
app.post('/api/user/sound-setting', async (req, res) => {
    const { username, soundEnabled } = req.body;
    if (!username || typeof soundEnabled !== 'boolean') {
        return res.status(400).json({ success: false, message: "Invalid request." });
    }

    try {
        const result = await pool.query(
            'UPDATE users SET sound_enabled = $1 WHERE LOWER(username) = LOWER($2) RETURNING username',
            [soundEnabled, username]
        );
        if (!result.rowCount) {
            return res.status(404).json({ success: false, message: "User not found." });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Set sound setting error:', err);
        res.status(500).json({ success: false, message: "Failed to save sound setting." });
    }
});

// ---------------- REFERRALS ----------------
app.get('/api/referral-info', async (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ success: false, message: "Username required." });

    try {
        const userRes = await pool.query(
            'SELECT username, bonus_balance FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        if (!userRes.rowCount) return res.status(404).json({ success: false, message: "User not found." });

        const countRes = await pool.query(
            'SELECT COUNT(*) FROM users WHERE LOWER(referred_by) = LOWER($1)',
            [username]
        );
        const settingsRes = await pool.query('SELECT referrals_required, reward_amount FROM referral_settings WHERE id = 1');
        const settings = settingsRes.rows[0] || { referrals_required: 100, reward_amount: 500 };
        const referralCount = Number(countRes.rows[0].count);
        const required = Number(settings.referrals_required);

        const actualUsername = userRes.rows[0].username;
        // Telegram's Mini App "direct link" format — only buildable once the
        // bot's username and the Mini App's short name (set in BotFather) are
        // known, since neither can be derived automatically. Falls back to
        // just the web link when those aren't configured.
        const botUsername = process.env.TELEGRAM_BOT_USERNAME || 'kal_bingo_bot';
        const miniAppName = process.env.TELEGRAM_MINIAPP_NAME || 'kal_bingo_bot';
        const telegramLink = `https://t.me/${botUsername}/${miniAppName}?startapp=ref_${encodeURIComponent(actualUsername)}`;

        res.json({
            success: true,
            referralCode: actualUsername,
            webLink: `${req.protocol}://${req.get('host')}/index.html?ref=${encodeURIComponent(actualUsername)}`,
            telegramLink,
            referralCount,
            bonusBalance: Number(userRes.rows[0].bonus_balance || 0),
            referralsRequired: required,
            rewardAmount: Number(settings.reward_amount),
            progressInMilestone: required > 0 ? referralCount % required : 0
        });
    } catch (err) {
        console.error('Referral info error:', err);
        res.status(500).json({ success: false, message: "Server error fetching referral info." });
    }
});

app.get('/api/admin/referrals', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const offset = (page - 1) * limit;
        const params = [];
        const where = ['(EXISTS (SELECT 1 FROM users u2 WHERE LOWER(u2.referred_by) = LOWER(u.username)) OR u.referred_by IS NOT NULL)'];
        if (req.query.from && /^\d{4}-\d{2}-\d{2}/.test(String(req.query.from))) {
            params.push(String(req.query.from).trim());
            where.push(`u.created_at >= $${params.length}::timestamp`);
        }
        if (req.query.to && /^\d{4}-\d{2}-\d{2}/.test(String(req.query.to))) {
            const to = String(req.query.to).trim();
            params.push(to.length === 10 ? to + ' 23:59:59.999' : to);
            where.push(`u.created_at <= $${params.length}::timestamp`);
        }
        if (req.query.q) {
            params.push('%' + String(req.query.q).trim() + '%');
            where.push(`(LOWER(u.username) LIKE LOWER($${params.length}) OR LOWER(COALESCE(u.referred_by,'')) LIKE LOWER($${params.length}))`);
        }
        const wsql = 'WHERE ' + where.join(' AND ');
        const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM users u ${wsql}`, params);
        const total = countRes.rows[0].total;
        const result = await pool.query(`
            SELECT u.username, u.referred_by, u.bonus_balance, u.created_at,
                   (SELECT COUNT(*)::int FROM users u2 WHERE LOWER(u2.referred_by) = LOWER(u.username)) AS referral_count
            FROM users u
            ${wsql}
            ORDER BY referral_count DESC, u.username ASC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, [...params, limit, offset]);
        res.json({
            success: true,
            total,
            page,
            limit,
            totalPages: Math.max(1, Math.ceil(total / limit)),
            users: result.rows.map(r => ({
                username: r.username,
                referredBy: r.referred_by,
                bonusBalance: Number(r.bonus_balance || 0),
                referralCount: Number(r.referral_count),
                createdAt: r.created_at
            }))
        });
    } catch (err) {
        console.error('Admin referrals error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.get('/api/admin/referrals/:username', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const result = await pool.query(
            'SELECT username, created_at FROM users WHERE LOWER(referred_by) = LOWER($1) ORDER BY created_at DESC',
            [req.params.username]
        );
        res.json({ success: true, referred: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.get('/api/admin/referral-settings', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const r = await pool.query('SELECT referrals_required, reward_amount FROM referral_settings WHERE id = 1');
    const s = r.rows[0] || { referrals_required: 100, reward_amount: 500 };
    res.json({ success: true, referralsRequired: s.referrals_required, rewardAmount: Number(s.reward_amount) });
});

app.post('/api/admin/referral-settings', async (req, res) => {
    const { adminSecret, referralsRequired, rewardAmount } = req.body;
    if (!requireAdmin(req, res)) return;
    const required = Number(referralsRequired);
    const reward = Number(rewardAmount);
    if (!Number.isInteger(required) || required < 1 || !Number.isFinite(reward) || reward < 0) {
        return res.status(400).json({ success: false, message: 'Invalid settings.' });
    }
    await pool.query(
        `INSERT INTO referral_settings(id,referrals_required,reward_amount) VALUES(1,$1,$2)
         ON CONFLICT(id) DO UPDATE SET referrals_required=EXCLUDED.referrals_required, reward_amount=EXCLUDED.reward_amount`,
        [required, reward]
    );
    res.json({ success: true });
});

// ---------------- WALLET: PAYMENT METHODS (admin-managed) ----------------
app.get('/api/admin/welcome-bonus-settings', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const s = await getWelcomeBonusSettings();
        res.json({ success: true, enabled: s.enabled, amount: s.amount });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.post('/api/admin/welcome-bonus-settings', async (req, res) => {
    const { adminSecret, enabled, amount } = req.body;
    if (!requireAdmin(req, res)) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt < 0) {
        return res.status(400).json({ success: false, message: 'Invalid amount.' });
    }
    try {
        await pool.query(
            `INSERT INTO welcome_bonus_settings(id, enabled, amount, updated_at) VALUES(1, $1, $2, NOW())
             ON CONFLICT(id) DO UPDATE SET enabled = EXCLUDED.enabled, amount = EXCLUDED.amount, updated_at = NOW()`,
            [!!enabled, amt]
        );
        res.json({ success: true, enabled: !!enabled, amount: amt });
    } catch (err) {
        console.error('Welcome bonus settings error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});


app.get('/api/payment-methods', async (req, res) => {
    try {
        const methods = await cache.getOrSet('payment-methods:public', 60_000, async () => {
            const result = await pool.query(
                'SELECT method, account_number, account_name FROM payment_methods WHERE active = TRUE ORDER BY id ASC'
            );
            const grouped = { telebirr: [], cbe: [] };
            for (const row of result.rows) {
                if (!grouped[row.method]) grouped[row.method] = [];
                grouped[row.method].push({ number: row.account_number, name: row.account_name });
            }
            return grouped;
        });
        res.json({ success: true, methods });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.get('/api/admin/payment-methods', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const result = await pool.query('SELECT * FROM payment_methods ORDER BY method, id ASC');
    res.json({ success: true, methods: result.rows });
});

app.post('/api/admin/payment-methods', async (req, res) => {
    const { adminSecret, method, accountNumber, accountName } = req.body;
    if (!requireAdmin(req, res)) return;
    if (!['telebirr', 'cbe'].includes(method) || !accountNumber || !accountName) {
        return res.status(400).json({ success: false, message: 'Missing or invalid fields.' });
    }
    cache.invalidate('payment-methods');
    await pool.query(
        'INSERT INTO payment_methods(method,account_number,account_name) VALUES($1,$2,$3)',
        [method, String(accountNumber).trim(), String(accountName).trim()]
    );
    res.json({ success: true });
});

app.put('/api/admin/payment-methods/:id', async (req, res) => {
    const { adminSecret, accountNumber, accountName, active } = req.body;
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id.' });

    await pool.query(
        `UPDATE payment_methods SET
            account_number = COALESCE($1, account_number),
            account_name = COALESCE($2, account_name),
            active = COALESCE($3, active)
         WHERE id = $4`,
        [accountNumber ?? null, accountName ?? null, typeof active === 'boolean' ? active : null, id]
    );
    res.json({ success: true });
});

app.delete('/api/admin/payment-methods/:id', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ success: false, message: 'Invalid id.' });
    await pool.query('DELETE FROM payment_methods WHERE id = $1', [id]);
        res.json({ success: true });
});


app.get('/api/admin/debug-network', async (req, res) => {
    const secret = req.headers['x-admin-secret'] || req.query.secret;
    if (!config.adminSecret || secret !== config.adminSecret) {
        return res.status(403).json({ success: false, message: 'Unauthorized.' });
    }
    const targets = [
        { name: 'control (google, 443)', url: 'https://www.google.com' },
        { name: 'cbe (port 100)', url: 'https://apps.cbe.com.et:100/' },
        { name: 'telebirr (443)', url: 'https://transactioninfo.ethiotelecom.et/' }
    ];
    const results = {};
    for (const t of targets) {
        const start = Date.now();
        try {
            const r = await fetch(t.url, { signal: AbortSignal.timeout(8000) });
            results[t.name] = `OK (HTTP ${r.status}) in ${Date.now() - start}ms`;
        } catch (err) {
            const detail = err.cause ? (err.cause.code || err.cause.message || String(err.cause)) : err.message;
            results[t.name] = `FAILED: ${err.message} [${detail}]`;
        }
    }
    res.json({ success: true, results });
});

// ---------------- DEPOSIT AUTO-VERIFICATION CONTROLS ----------------
app.get('/api/admin/deposit-verification-settings', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    const r = await pool.query('SELECT auto_verify_enabled FROM deposit_verification_settings WHERE id = 1');
    res.json({ success: true, autoVerifyEnabled: r.rows[0] ? r.rows[0].auto_verify_enabled : true });
});

app.post('/api/admin/deposit-verification-settings', async (req, res) => {
    const { adminSecret, autoVerifyEnabled } = req.body;
    if (!requireAdmin(req, res)) return;
    await pool.query(
        `INSERT INTO deposit_verification_settings(id, auto_verify_enabled, updated_at) VALUES(1,$1,NOW())
         ON CONFLICT(id) DO UPDATE SET auto_verify_enabled=EXCLUDED.auto_verify_enabled, updated_at=NOW()`,
        [!!autoVerifyEnabled]
    );
    res.json({ success: true, autoVerifyEnabled: !!autoVerifyEnabled });
});

app.post('/api/admin/users/:username/auto-verify', async (req, res) => {
    const { adminSecret, enabled } = req.body;
    if (!requireAdmin(req, res)) return;
    const result = await pool.query(
        'UPDATE users SET auto_verify_enabled = $1 WHERE LOWER(username) = LOWER($2) RETURNING username, auto_verify_enabled',
        [!!enabled, req.params.username]
    );
    if (!result.rowCount) return res.status(404).json({ success: false, message: 'User not found.' });
    res.json({ success: true, username: result.rows[0].username, autoVerifyEnabled: result.rows[0].auto_verify_enabled });
});

// ---------------- ADMIN: STATS + USERS ----------------
app.get('/api/admin/stats', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const [users, deposits, withdraws, transfers, balance, games, newUsers, activeUsers, todayCounts, houseToday] = await Promise.all([
            pool.query('SELECT COUNT(*)::int AS total FROM users'),
            pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
                               COUNT(*) FILTER (WHERE status = 'APPROVED')::int AS approved
                        FROM deposit_requests`),
            pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
                               COUNT(*) FILTER (WHERE status = 'APPROVED')::int AS approved
                        FROM withdraw_requests`),
            pool.query(`SELECT COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending FROM transfer_requests`),
            pool.query('SELECT COALESCE(SUM(balance),0)::float AS total_balance, COALESCE(SUM(bonus_balance),0)::float AS total_bonus FROM users'),
            pool.query(`SELECT COUNT(*) FILTER (WHERE status IN ('active','waiting','playing','lobby'))::int AS active FROM game_sessions`),
            pool.query(`SELECT
                COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS today,
                COUNT(*) FILTER (WHERE created_at >= date_trunc('week', CURRENT_TIMESTAMP))::int AS week,
                COUNT(*) FILTER (WHERE created_at >= date_trunc('month', CURRENT_TIMESTAMP))::int AS month,
                COUNT(*) FILTER (WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '6 months')::int AS months6,
                COUNT(*) FILTER (WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '1 year')::int AS year
             FROM users`),
            pool.query(`SELECT
                COUNT(*) FILTER (WHERE last_active_at >= CURRENT_TIMESTAMP - INTERVAL '1 hour')::int AS h1,
                COUNT(*) FILTER (WHERE last_active_at >= CURRENT_TIMESTAMP - INTERVAL '2 hours')::int AS h2,
                COUNT(*) FILTER (WHERE last_active_at >= CURRENT_TIMESTAMP - INTERVAL '6 hours')::int AS h6,
                COUNT(*) FILTER (WHERE last_active_at >= CURRENT_TIMESTAMP - INTERVAL '12 hours')::int AS h12,
                COUNT(*) FILTER (WHERE last_active_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours')::int AS h24,
                COUNT(*) FILTER (WHERE last_active_at >= date_trunc('week', CURRENT_TIMESTAMP))::int AS week
             FROM users`),
            pool.query(`SELECT
                (SELECT COUNT(*)::int FROM deposit_requests WHERE created_at >= CURRENT_DATE) AS deposits_today,
                (SELECT COUNT(*)::int FROM withdraw_requests WHERE created_at >= CURRENT_DATE) AS withdraws_today,
                (SELECT COUNT(*)::int FROM transfer_requests WHERE created_at >= CURRENT_DATE) AS transfers_today,
                (SELECT COUNT(*)::int FROM transfer_requests WHERE status = 'APPROVED' AND created_at >= CURRENT_DATE) AS transfers_approved_today
            `),
            pool.query(`SELECT
                COALESCE(SUM(house_cut),0)::float AS house_today,
                COUNT(*)::int AS games_today
                 FROM game_sessions WHERE status IN ('COMPLETED', 'EXHAUSTED') AND created_at >= CURRENT_DATE`)
        ]);
        res.json({
            success: true,
            stats: {
                totalUsers: users.rows[0].total,
                pendingDeposits: deposits.rows[0].pending,
                approvedDeposits: deposits.rows[0].approved,
                pendingWithdraws: withdraws.rows[0].pending,
                approvedWithdraws: withdraws.rows[0].approved,
                pendingTransfers: transfers.rows[0].pending,
                totalBalance: Number(balance.rows[0].total_balance || 0),
                totalBonus: Number(balance.rows[0].total_bonus || 0),
                activeGames: games.rows[0].active,
                depositsToday: todayCounts.rows[0].deposits_today,
                withdrawsToday: todayCounts.rows[0].withdraws_today,
                transfersToday: todayCounts.rows[0].transfers_today,
                transfersApprovedToday: todayCounts.rows[0].transfers_approved_today,
                newUsers: {
                    today: newUsers.rows[0].today,
                    week: newUsers.rows[0].week,
                    month: newUsers.rows[0].month,
                    months6: newUsers.rows[0].months6,
                    year: newUsers.rows[0].year
                },
                activeUsers: {
                    h1: activeUsers.rows[0].h1,
                    h2: activeUsers.rows[0].h2,
                    h6: activeUsers.rows[0].h6,
                    h12: activeUsers.rows[0].h12,
                    h24: activeUsers.rows[0].h24,
                    week: activeUsers.rows[0].week
                },
                houseProfitToday: Number(houseToday.rows[0].house_today || 0),
                gamesCompletedToday: Number(houseToday.rows[0].games_today || 0)
            }
        });
    } catch (err) {
        console.error('Admin stats error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.get('/api/admin/users', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const q = (req.query.q || '').toString().trim();
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const offset = (page - 1) * limit;
        const activeWithin = (req.query.activeWithin || '').toString().trim();
        const params = [];
        const whereClean = [];

        if (q) {
            params.push('%' + q + '%');
            whereClean.push('(LOWER(username) LIKE LOWER($' + params.length + ') OR LOWER(COALESCE(display_name,\'\')) LIKE LOWER($' + params.length + ') OR COALESCE(phone_number,\'\') LIKE $' + params.length + ' OR CAST(telegram_id AS TEXT) LIKE $' + params.length + ')');
        }
        if (req.query.from && /^\d{4}-\d{2}-\d{2}/.test(String(req.query.from))) {
            params.push(String(req.query.from).trim());
            whereClean.push('users.created_at >= $' + params.length + '::timestamp');
        }
        if (req.query.to && /^\d{4}-\d{2}-\d{2}/.test(String(req.query.to))) {
            const to = String(req.query.to).trim();
            params.push(to.length === 10 ? to + ' 23:59:59.999' : to);
            whereClean.push('users.created_at <= $' + params.length + '::timestamp');
        }
        const activeMap = { '1h': "INTERVAL '1 hour'", '2h': "INTERVAL '2 hours'", '6h': "INTERVAL '6 hours'", '12h': "INTERVAL '12 hours'", '24h': "INTERVAL '24 hours'" };
        if (activeWithin === 'week') {
            whereClean.push('users.last_active_at >= date_trunc(\'week\', CURRENT_TIMESTAMP)');
        } else if (activeMap[activeWithin]) {
            whereClean.push('users.last_active_at >= CURRENT_TIMESTAMP - ' + activeMap[activeWithin]);
        }
        const where = whereClean.length ? 'WHERE ' + whereClean.join(' AND ') : '';
        const countRes = await pool.query('SELECT COUNT(*)::int AS total FROM users ' + where, params);
        const total = countRes.rows[0].total;
        const limitIdx = params.length + 1;
        const offsetIdx = params.length + 2;
        const result = await pool.query(
            `SELECT
                id, username, display_name, telegram_id, phone_number, phone_verified,
                balance, bonus_balance, wins, referred_by, auto_verify_enabled,
                preferred_language, preferred_theme, preferred_voice_pack, sound_enabled,
                created_at, last_active_at,
                (SELECT COUNT(*)::int FROM users u2 WHERE LOWER(u2.referred_by) = LOWER(users.username)) AS referral_count
             FROM users
             ${where}
             ORDER BY created_at DESC
             LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
            [...params, limit, offset]
        );
        res.json({
            success: true,
            total,
            page,
            limit,
            totalPages: Math.max(1, Math.ceil(total / limit)),
            users: result.rows.map(r => ({
                id: r.id,
                username: r.username,
                displayName: r.display_name,
                telegramId: r.telegram_id,
                phoneNumber: r.phone_number,
                phoneVerified: !!r.phone_verified,
                balance: Number(r.balance || 0),
                bonusBalance: Number(r.bonus_balance || 0),
                wins: Number(r.wins || 0),
                referredBy: r.referred_by,
                referralCount: Number(r.referral_count || 0),
                autoVerifyEnabled: !!r.auto_verify_enabled,
                preferredLanguage: r.preferred_language,
                preferredTheme: r.preferred_theme,
                preferredVoicePack: r.preferred_voice_pack,
                soundEnabled: !!r.sound_enabled,
                createdAt: r.created_at,
                lastActiveAt: r.last_active_at
            }))
        });
    } catch (err) {
        console.error('Admin users list error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.get('/api/admin/users/:username', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const result = await pool.query(
            `SELECT
                id, username, display_name, telegram_id, phone_number, phone_verified,
                balance, bonus_balance, wins, referred_by, auto_verify_enabled,
                preferred_language, preferred_theme, preferred_voice_pack, sound_enabled,
                created_at, last_active_at,
                (SELECT COUNT(*)::int FROM users u2 WHERE LOWER(u2.referred_by) = LOWER(users.username)) AS referral_count
             FROM users WHERE LOWER(username) = LOWER($1)`,
            [req.params.username]
        );
        if (!result.rowCount) return res.status(404).json({ success: false, message: 'User not found.' });
        const r = result.rows[0];
        const tx = await pool.query(
            'SELECT id, amount, type, created_at FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30',
            [r.id]
        );
        res.json({
            success: true,
            user: {
                id: r.id,
                username: r.username,
                displayName: r.display_name,
                telegramId: r.telegram_id,
                phoneNumber: r.phone_number,
                phoneVerified: !!r.phone_verified,
                balance: Number(r.balance || 0),
                bonusBalance: Number(r.bonus_balance || 0),
                wins: Number(r.wins || 0),
                referredBy: r.referred_by,
                referralCount: Number(r.referral_count || 0),
                autoVerifyEnabled: !!r.auto_verify_enabled,
                preferredLanguage: r.preferred_language,
                preferredTheme: r.preferred_theme,
                preferredVoicePack: r.preferred_voice_pack,
                soundEnabled: !!r.sound_enabled,
                createdAt: r.created_at,
                lastActiveAt: r.last_active_at
            },
            transactions: tx.rows.map(t => ({
                id: t.id,
                amount: Number(t.amount),
                type: t.type,
                createdAt: t.created_at
            }))
        });
    } catch (err) {
        console.error('Admin user detail error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.post('/api/admin/adjust-balance', async (req, res) => {
    const { adminSecret, username, amount } = req.body;
    if (!requireAdmin(req, res)) return;
    const delta = Number(amount);
    if (!username || !Number.isFinite(delta) || delta === 0) {
        return res.status(400).json({ success: false, message: 'Invalid request.' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await client.query(
            'UPDATE users SET balance = balance + $1 WHERE LOWER(username) = LOWER($2) RETURNING id, balance',
            [delta, username]
        );
        if (!result.rowCount) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        await client.query(
            'INSERT INTO transactions(user_id, amount, type) VALUES($1, $2, $3)',
            [result.rows[0].id, delta, delta > 0 ? 'admin_credit' : 'admin_debit']
        );
        await client.query('COMMIT');
        res.json({ success: true, balance: Number(result.rows[0].balance) });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Admin adjust-balance error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    } finally {
        client.release();
    }
});

// ---------------- WALLET: PAYMENT METHODS (admin-managed) ----------------
app.post('/api/deposit-request', moneyLimiter, async (req, res) => {
    const { username, method, amount, transactionId, submittedText } = req.body;
    const depositAmount = Number(amount);
    const txnId = transactionId ? String(transactionId).trim() : '';

    if (!username || !['telebirr', 'cbe'].includes(method)) {
        return res.status(400).json({ success: false, message: 'Missing or invalid fields.' });
    }
    if (!Number.isFinite(depositAmount) || depositAmount <= 0) {
        return res.status(400).json({ success: false, message: 'Enter a valid amount.' });
    }
    if (!txnId) {
        return res.status(400).json({ success: false, message: 'Enter the transaction ID from your confirmation SMS.' });
    }

    try {
                const userRes = await pool.query('SELECT id, auto_verify_enabled FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (!userRes.rowCount) return res.status(404).json({ success: false, message: 'User not found.' });
        const userId = userRes.rows[0].id;
        const userAutoVerifyEnabled = userRes.rows[0].auto_verify_enabled;

        // A transaction ID that's already been credited can never be reused
        // for a second deposit — block it here before it even gets a row.
               const already = await pool.query(
            "SELECT id FROM deposit_requests WHERE transaction_id = $1 AND status = 'APPROVED'",
            [txnId]
        );
        if (already.rowCount) {
            return res.status(400).json({ success: false, message: 'This transaction has already been credited.' });
        }

        // Insert as PENDING first. Auto-verification below may upgrade it to
        // APPROVED, but if anything goes wrong mid-verification the request
        // still exists in the admin queue instead of silently disappearing.
        const inserted = await pool.query(
            `INSERT INTO deposit_requests(user_id, username, method, submitted_text, amount, transaction_id)
             VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
            [userId, username, method, (submittedText || '').trim().slice(0, 1000) || null, depositAmount, txnId]
        );
        const requestId = inserted.rows[0].id;

        // ---- Attempt automatic verification against the bank/telco ----
        let verification = { verified: false, reason: 'Verification not attempted.' };
                        try {
            const settingsRes = await pool.query('SELECT auto_verify_enabled FROM deposit_verification_settings WHERE id = 1');
            const globalAutoVerifyEnabled = settingsRes.rows[0] ? settingsRes.rows[0].auto_verify_enabled : true;

            if (!globalAutoVerifyEnabled) {
                verification = { verified: false, reason: 'Auto-verification is currently turned off by admin — all deposits go to manual review.' };
            } else if (!userAutoVerifyEnabled) {
                verification = { verified: false, reason: 'Auto-verification is disabled for this account by admin — needs manual review.' };
            } else {
                const methodsRes = await pool.query(
                    'SELECT method, account_number, account_name FROM payment_methods WHERE active = TRUE'
                );
                const cbeAccounts = methodsRes.rows.filter(r => r.method === 'cbe').map(r => ({ number: r.account_number, name: r.account_name }));
                const telebirrAccounts = methodsRes.rows.filter(r => r.method === 'telebirr').map(r => ({ number: r.account_number, name: r.account_name }));
                verification = await verifyDeposit({
                    transactionId: txnId,
                    expectedAmount: depositAmount,
                    cbeAccounts,
                    telebirrAccounts
                });
            }
        } catch (verifyErr) {
            console.error('Payment verification threw:', verifyErr);
            verification = { verified: false, reason: 'Verification service error — needs manual review.' };
        }

        if (verification.verified) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const userUpd = await client.query(
                    'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
                    [depositAmount, userId]
                );
                await client.query(
                    'INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',
                    [userId, depositAmount, 'DEPOSIT_APPROVED']
                );
                await client.query(
                    "UPDATE deposit_requests SET status = 'APPROVED', credited_amount = $1, reviewed_at = NOW(), verification_note = $2 WHERE id = $3",
                    [depositAmount, 'Auto-verified', requestId]
                );
                await client.query('COMMIT');
                return res.json({
                    success: true,
                    autoVerified: true,
                    message: `Verified — ${depositAmount} Birr has been added to your balance.`,
                    balance: Number(userUpd.rows[0].balance)
                });
            } catch (err) {
                await client.query('ROLLBACK');
                // 23505 = unique_violation: another request with this exact
                // transaction ID got approved first (a race). Don't credit
                // twice — reject this one instead.
                if (err.code === '23505') {
                    await pool.query(
                        "UPDATE deposit_requests SET status = 'REJECTED', reviewed_at = NOW(), verification_note = $1 WHERE id = $2",
                        ['Duplicate transaction ID — already credited on another request.', requestId]
                    );
                    return res.status(400).json({ success: false, message: 'This transaction has already been credited.' });
                }
                console.error('Auto-credit error:', err);
                verification = { verified: false, reason: 'Crediting failed after verification — needs manual review.' };
            } finally {
                client.release();
            }
        }

        // Not auto-verified (mismatch, network/parsing failure, or the
        // crediting step above failed) — leave it PENDING for an admin to
        // approve or reject manually, same as before, but now with the
        // verification outcome attached so they have full context.
        await pool.query(
            'UPDATE deposit_requests SET verification_note = $1 WHERE id = $2',
            [verification.reason || 'Not auto-verified.', requestId]
        );
        return res.json({
            success: true,
            autoVerified: false,
            message: 'Submitted — your deposit is pending review.'
        });
    } catch (err) {
        console.error('Deposit request error:', err);
        res.status(500).json({ success: false, message: 'Server error submitting deposit.' });
    }
});

app.get('/api/admin/deposit-requests', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const offset = (page - 1) * limit;
        const status = (req.query.status || '').toString().trim().toUpperCase();
        const params = [];
        const where = [];
        if (status && ['PENDING','APPROVED','REJECTED'].includes(status)) {
            params.push(status);
            where.push(`dr.status = $${params.length}`);
        }
        if (req.query.from && /^\d{4}-\d{2}-\d{2}/.test(String(req.query.from))) {
            params.push(String(req.query.from).trim());
            where.push(`dr.created_at >= $${params.length}::timestamp`);
        }
        if (req.query.to && /^\d{4}-\d{2}-\d{2}/.test(String(req.query.to))) {
            const to = String(req.query.to).trim();
            params.push(to.length === 10 ? to + ' 23:59:59.999' : to);
            where.push(`dr.created_at <= $${params.length}::timestamp`);
        }
        if (req.query.q) {
            params.push('%' + String(req.query.q).trim() + '%');
            where.push(`LOWER(dr.username) LIKE LOWER($${params.length})`);
        }
        const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM deposit_requests dr ${wsql}`, params);
        const total = countRes.rows[0].total;
        const result = await pool.query(
            `SELECT dr.*, u.auto_verify_enabled
             FROM deposit_requests dr
             JOIN users u ON u.id = dr.user_id
             ${wsql}
             ORDER BY dr.created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
        );
        res.json({ success: true, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), requests: result.rows });
    } catch (err) {
        console.error('Admin deposits list error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.post('/api/admin/deposit-requests/:id/approve', async (req, res) => {
    const { adminSecret, amount } = req.body;
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    const creditAmount = Number(amount);
    if (!Number.isInteger(id) || !Number.isFinite(creditAmount) || creditAmount <= 0) {
        return res.status(400).json({ success: false, message: 'A valid credit amount is required.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqRow = await client.query(
            "SELECT * FROM deposit_requests WHERE id = $1 AND status = 'PENDING' FOR UPDATE",
            [id]
        );
        if (!reqRow.rowCount) throw new Error('Request not found or already reviewed.');
        const depositReq = reqRow.rows[0];

        const userRes = await client.query(
            'UPDATE users SET balance = balance + $1 WHERE id = $2 RETURNING balance',
            [creditAmount, depositReq.user_id]
        );
        await client.query(
            'INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',
            [depositReq.user_id, creditAmount, 'DEPOSIT_APPROVED']
        );
        await client.query(
            "UPDATE deposit_requests SET status = 'APPROVED', credited_amount = $1, reviewed_at = NOW() WHERE id = $2",
            [creditAmount, id]
        );
                await client.query('COMMIT');
        res.json({ success: true, balance: Number(userRes.rows[0].balance) });
    } catch (err) {
        await client.query('ROLLBACK');
        const message = err.code === '23505'
            ? 'This transaction ID has already been credited on another request.'
            : (err.message || 'Could not approve deposit.');
        res.status(400).json({ success: false, message });
    } finally {
        client.release();
    }
});


app.post('/api/admin/deposit-requests/:id/reject', async (req, res) => {
    const { adminSecret } = req.body;
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    const result = await pool.query(
        "UPDATE deposit_requests SET status = 'REJECTED', reviewed_at = NOW() WHERE id = $1 AND status = 'PENDING'",
        [id]
    );
    if (!result.rowCount) return res.status(400).json({ success: false, message: 'Request not found or already reviewed.' });
    res.json({ success: true });
});

// ---------------- WALLET: WITHDRAW REQUESTS ----------------
const MIN_WITHDRAW_AMOUNT = 21;

app.post('/api/withdraw-request', moneyLimiter, async (req, res) => {
    const { username, amount, method, destination, accountOwnerName } = req.body;
    const withdrawAmount = Number(amount);

    if (!username || !['telebirr', 'cbe'].includes(method) || !destination || !destination.trim()) {
        return res.status(400).json({ success: false, message: 'Missing or invalid fields.' });
    }
    if (method === 'cbe' && (!accountOwnerName || !String(accountOwnerName).trim())) {
        return res.status(400).json({ success: false, message: 'Account owner name is required for CBE.' });
    }
    if (!Number.isFinite(withdrawAmount) || withdrawAmount < MIN_WITHDRAW_AMOUNT) {
        return res.status(400).json({ success: false, message: `Minimum withdrawal is ${MIN_WITHDRAW_AMOUNT} Birr.` });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const charge = await client.query(
            'UPDATE users SET balance = balance - $1 WHERE LOWER(username) = LOWER($2) AND balance >= $1 RETURNING id, balance',
            [withdrawAmount, username]
        );
        if (!charge.rowCount) {
            const exists = await client.query('SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)', [username]);
            throw new Error(exists.rowCount ? "You don't have enough balance to withdraw that amount." : 'User not found.');
        }

        await client.query(
            'INSERT INTO withdraw_requests(user_id,username,amount,method,destination,account_owner_name) VALUES($1,$2,$3,$4,$5,$6)',
            [charge.rows[0].id, username, withdrawAmount, method, destination.trim(), method === 'cbe' ? String(accountOwnerName).trim() : null]
        );
        await client.query('COMMIT');
        res.json({ success: true, message: 'Submitted — your withdrawal is pending review.', balance: Number(charge.rows[0].balance) });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: err.message || 'Could not submit withdrawal.' });
    } finally {
        client.release();
    }
});

app.get('/api/admin/withdraw-requests', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const offset = (page - 1) * limit;
        const status = (req.query.status || '').toString().trim().toUpperCase();
        const params = [];
        const where = [];
        if (status && ['PENDING','APPROVED','REJECTED'].includes(status)) {
            params.push(status);
            where.push(`status = $${params.length}`);
        }
        if (req.query.from && /^\d{4}-\d{2}-\d{2}/.test(String(req.query.from))) {
            params.push(String(req.query.from).trim());
            where.push(`created_at >= $${params.length}::timestamp`);
        }
        if (req.query.to && /^\d{4}-\d{2}-\d{2}/.test(String(req.query.to))) {
            const to = String(req.query.to).trim();
            params.push(to.length === 10 ? to + ' 23:59:59.999' : to);
            where.push(`created_at <= $${params.length}::timestamp`);
        }
        if (req.query.q) {
            params.push('%' + String(req.query.q).trim() + '%');
            where.push(`LOWER(username) LIKE LOWER($${params.length})`);
        }
        const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM withdraw_requests ${wsql}`, params);
        const total = countRes.rows[0].total;
        const result = await pool.query(
            `SELECT * FROM withdraw_requests ${wsql} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
        );
        res.json({ success: true, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), requests: result.rows });
    } catch (err) {
        console.error('Admin withdraws list error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.post('/api/admin/withdraw-requests/:id/approve', async (req, res) => {
    const { adminSecret } = req.body;
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqRow = await client.query(
            "SELECT * FROM withdraw_requests WHERE id = $1 AND status = 'PENDING' FOR UPDATE",
            [id]
        );
        if (!reqRow.rowCount) throw new Error('Request not found or already reviewed.');
        const w = reqRow.rows[0];

        // The funds were already deducted at submission time — approving
        // just confirms the payout actually went out and logs it.
        await client.query(
            'INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',
            [w.user_id, -Number(w.amount), 'WITHDRAWAL_APPROVED']
        );
        await client.query(
            "UPDATE withdraw_requests SET status = 'APPROVED', reviewed_at = NOW() WHERE id = $1",
            [id]
        );
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: err.message || 'Could not approve withdrawal.' });
    } finally {
        client.release();
    }
});

app.post('/api/admin/withdraw-requests/:id/reject', async (req, res) => {
    const { adminSecret } = req.body;
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqRow = await client.query(
            "SELECT * FROM withdraw_requests WHERE id = $1 AND status = 'PENDING' FOR UPDATE",
            [id]
        );
        if (!reqRow.rowCount) throw new Error('Request not found or already reviewed.');
        const w = reqRow.rows[0];

        // Refund the reserved amount back since it never actually went out.
        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [w.amount, w.user_id]);
        await client.query(
            'INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',
            [w.user_id, Number(w.amount), 'WITHDRAWAL_REJECTED_REFUND']
        );
        await client.query(
            "UPDATE withdraw_requests SET status = 'REJECTED', reviewed_at = NOW() WHERE id = $1",
            [id]
        );
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: err.message || 'Could not reject withdrawal.' });
    } finally {
        client.release();
    }
});

function normalizePhone(raw) {
    let p = String(raw || '').replace(/[\s\-\(\)]/g, '');
    if (p.startsWith('+')) p = p.slice(1);
    if (p.startsWith('251') && p.length >= 12) p = '0' + p.slice(3);
    else if (p.startsWith('44') && p.length >= 11) p = '0' + p.slice(2);
    else if (/^[1-9]/.test(p) && p.length >= 10) p = '0' + p;
    return p;
}

// ---------------- WALLET: TRANSFER REQUESTS (user to user) ----------------
app.post('/api/transfer-request', moneyLimiter, async (req, res) => {
    const { username, amount, recipientPhone } = req.body;
    const transferAmount = Number(amount);
    const normPhone = normalizePhone(recipientPhone);

    if (!username || !normPhone) {
        return res.status(400).json({ success: false, message: 'Missing or invalid fields.' });
    }
    if (!Number.isFinite(transferAmount) || transferAmount <= 20) {
        return res.status(400).json({ success: false, message: 'Transfers must be more than 20 Birr.' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const recipient = await client.query(
            `SELECT username, phone_number FROM users WHERE
                phone_number = $1
                OR phone_number = $2
                OR REPLACE(REPLACE(phone_number,'+',''),' ','') = $3
                OR RIGHT(REGEXP_REPLACE(COALESCE(phone_number,''), '[^0-9]', '', 'g'), 9) = RIGHT(REGEXP_REPLACE($1, '[^0-9]', '', 'g'), 9)`,
            [normPhone, recipientPhone.trim(), normPhone.replace(/^0/, '')]
        );
        if (!recipient.rowCount) {
            throw new Error('No user found with that phone number.');
        }
        if (recipient.rows[0].username.toLowerCase() === username.toLowerCase()) {
            throw new Error('You cannot transfer to yourself.');
        }

        // Reserve the funds now, same reasoning as withdrawals.
        const charge = await client.query(
            'UPDATE users SET balance = balance - $1 WHERE LOWER(username) = LOWER($2) AND balance >= $1 RETURNING id, balance',
            [transferAmount, username]
        );
        if (!charge.rowCount) {
            const exists = await client.query('SELECT 1 FROM users WHERE LOWER(username)=LOWER($1)', [username]);
            throw new Error(exists.rowCount ? "You don't have enough balance to transfer that amount." : 'User not found.');
        }

        await client.query(
            'INSERT INTO transfer_requests(sender_id,sender_username,recipient_phone,recipient_username,amount) VALUES($1,$2,$3,$4,$5)',
            [charge.rows[0].id, username, normPhone, recipient.rows[0].username, transferAmount]
        );
        await client.query('COMMIT');
        res.json({ success: true, message: 'Submitted — your transfer is pending review.', balance: Number(charge.rows[0].balance) });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: err.message || 'Could not submit transfer.' });
    } finally {
        client.release();
    }
});

app.get('/api/admin/transfer-requests', async (req, res) => {
    if (!requireAdmin(req, res)) return;
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const offset = (page - 1) * limit;
        const status = (req.query.status || '').toString().trim().toUpperCase();
        const params = [];
        const where = [];
        if (status && ['PENDING','APPROVED','REJECTED'].includes(status)) {
            params.push(status);
            where.push(`status = $${params.length}`);
        }
        if (req.query.from && /^\d{4}-\d{2}-\d{2}/.test(String(req.query.from))) {
            params.push(String(req.query.from).trim());
            where.push(`created_at >= $${params.length}::timestamp`);
        }
        if (req.query.to && /^\d{4}-\d{2}-\d{2}/.test(String(req.query.to))) {
            const to = String(req.query.to).trim();
            params.push(to.length === 10 ? to + ' 23:59:59.999' : to);
            where.push(`created_at <= $${params.length}::timestamp`);
        }
        if (req.query.q) {
            params.push('%' + String(req.query.q).trim() + '%');
            where.push(`(LOWER(sender_username) LIKE LOWER($${params.length}) OR LOWER(COALESCE(recipient_username,'')) LIKE LOWER($${params.length}) OR recipient_phone LIKE $${params.length})`);
        }
        const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM transfer_requests ${wsql}`, params);
        const total = countRes.rows[0].total;
        const result = await pool.query(
            `SELECT * FROM transfer_requests ${wsql} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
        );
        res.json({ success: true, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), requests: result.rows });
    } catch (err) {
        console.error('Admin transfers list error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

app.post('/api/admin/transfer-requests/:id/approve', async (req, res) => {
    const { adminSecret } = req.body;
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqRow = await client.query(
            "SELECT * FROM transfer_requests WHERE id = $1 AND status = 'PENDING' FOR UPDATE",
            [id]
        );
        if (!reqRow.rowCount) throw new Error('Request not found or already reviewed.');
        const t = reqRow.rows[0];

        const recipient = await client.query(
            'UPDATE users SET balance = balance + $1 WHERE LOWER(username) = LOWER($2) RETURNING id',
            [t.amount, t.recipient_username]
        );
        if (!recipient.rowCount) throw new Error('Recipient no longer exists.');

        await client.query(
            'INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',
            [t.sender_id, -Number(t.amount), 'TRANSFER_SENT']
        );
        await client.query(
            'INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',
            [recipient.rows[0].id, Number(t.amount), 'TRANSFER_RECEIVED']
        );
        await client.query(
            "UPDATE transfer_requests SET status = 'APPROVED', reviewed_at = NOW() WHERE id = $1",
            [id]
        );
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: err.message || 'Could not approve transfer.' });
    } finally {
        client.release();
    }
});

app.post('/api/admin/transfer-requests/:id/reject', async (req, res) => {
    const { adminSecret } = req.body;
    if (!requireAdmin(req, res)) return;
    const id = Number(req.params.id);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const reqRow = await client.query(
            "SELECT * FROM transfer_requests WHERE id = $1 AND status = 'PENDING' FOR UPDATE",
            [id]
        );
        if (!reqRow.rowCount) throw new Error('Request not found or already reviewed.');
        const t = reqRow.rows[0];

        await client.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [t.amount, t.sender_id]);
        await client.query(
            'INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',
            [t.sender_id, Number(t.amount), 'TRANSFER_REJECTED_REFUND']
        );
        await client.query(
            "UPDATE transfer_requests SET status = 'REJECTED', reviewed_at = NOW() WHERE id = $1",
            [id]
        );
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, message: err.message || 'Could not reject transfer.' });
    } finally {
        client.release();
    }
});

// User-facing: their own pending requests across all three types, so
// submitting something doesn't just vanish with no feedback (they still
// won't show up in the confirmed transaction history until reviewed).
app.get('/api/my-pending-requests', async (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ success: false, message: 'Username required.' });

    const [deposits, withdrawals, transfers] = await Promise.all([
        pool.query("SELECT id, amount, method, status, created_at FROM deposit_requests WHERE LOWER(username)=LOWER($1) AND status='PENDING' ORDER BY created_at DESC", [username]),
        pool.query("SELECT id, amount, method, status, created_at FROM withdraw_requests WHERE LOWER(username)=LOWER($1) AND status='PENDING' ORDER BY created_at DESC", [username]),
        pool.query("SELECT id, amount, recipient_phone, status, created_at FROM transfer_requests WHERE LOWER(sender_username)=LOWER($1) AND status='PENDING' ORDER BY created_at DESC", [username])
    ]);

    res.json({
        success: true,
        pending: [
            ...deposits.rows.map(r => ({ type: 'deposit', ...r })),
            ...withdrawals.rows.map(r => ({ type: 'withdraw', ...r })),
            ...transfers.rows.map(r => ({ type: 'transfer', ...r }))
        ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    });
});


app.post('/api/admin/adjust-bonus', async (req, res) => {
    const { adminSecret, username, amount } = req.body;
    if (!requireAdmin(req, res)) return;
    const delta = Number(amount);
    if (!username || !Number.isFinite(delta) || delta === 0) {
        return res.status(400).json({ success: false, message: 'Invalid request.' });
    }
    try {
        const result = await pool.query(
            'UPDATE users SET bonus_balance = bonus_balance + $1 WHERE LOWER(username) = LOWER($2) RETURNING id, bonus_balance',
            [delta, username]
        );
        if (!result.rowCount) return res.status(404).json({ success: false, message: 'User not found.' });
        await pool.query(
            'INSERT INTO transactions(user_id,amount,type) VALUES($1,$2,$3)',
            [result.rows[0].id, delta, 'ADMIN_BONUS_ADJUSTMENT']
        );
        res.json({ success: true, bonusBalance: Number(result.rows[0].bonus_balance) });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error.' });
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
                gs.winner_prize,
                gs.winner_username,
                gs.winning_card_number,
                gs.status,
                gs.created_at,
                gs.ended_at,
                gp.card_count,
                gp.amount_paid,
                (SELECT COUNT(*) FROM game_participants gp2 WHERE gp2.game_id = gs.id) AS player_count,
                (SELECT COUNT(*) FROM game_winners gw WHERE gw.game_id = gs.id) AS winner_count,
                (SELECT STRING_AGG(gw.username, ', ' ORDER BY gw.id) FROM game_winners gw WHERE gw.game_id = gs.id) AS winner_names,
                (SELECT COALESCE(jsonb_agg(
                    jsonb_build_object(
                        'username', gw.username,
                        'displayName', COALESCE(gw.display_name, gw.username),
                        'cardNumber', gw.card_number,
                        'prize', gw.prize,
                        'winningCells', COALESCE(gw.winning_cells, '[]'::jsonb)
                    ) ORDER BY gw.id
                ), '[]'::jsonb) FROM game_winners gw WHERE gw.game_id = gs.id) AS winners,
                (SELECT SUM(gw.prize) FROM game_winners gw WHERE gw.game_id = gs.id) AS winners_net_prize
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

        const history = page.map(row => {
            const winnerCount = Number(row.winner_count) || 0;
            const winnerNames = row.winner_names || row.winner_username || null;
            const netPrize = row.winners_net_prize != null
                ? Number(row.winners_net_prize)
                : Number(row.winner_prize != null ? row.winner_prize : row.prize_pool);
            return {
                gameId: row.id,
                stake: Number(row.stake),
                prizePool: netPrize,
                winner: winnerNames,
                winnerCount,
                winners: Array.isArray(row.winners) ? row.winners : [],
                won: winnerCount > 1
                    ? (row.winner_names || '').toLowerCase().split(', ').some(name => name.trim() === username.toLowerCase())
                    : !!winnerNames && winnerNames.toLowerCase() === username.toLowerCase(),
                winningCardNumber: row.winning_card_number || null,
                players: Number(row.player_count),
                cardCount: Number(row.card_count),
                amountPaid: Number(row.amount_paid),
                date: row.ended_at || row.created_at
            };
        });

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
        const gsResult = await pool.query(
            `SELECT id, stake, prize_pool, winner_username, winner_prize, winning_pattern,
                    winning_card_number, winning_cells, drawn_numbers, ended_at
             FROM game_sessions WHERE id = $1`,
            [gameId]
        );
        if (!gsResult.rowCount) {
            return res.status(404).json({ success: false, message: 'Game not found.' });
        }
        const gs = gsResult.rows[0];

        const gwResult = await pool.query(
            `SELECT gw.username, gw.display_name, gw.card_number, gw.winning_cells, gw.prize, bc.grid
             FROM game_winners gw LEFT JOIN bingo_cards bc ON bc.card_number = gw.card_number
             WHERE gw.game_id = $1 ORDER BY gw.id`,
            [gameId]
        );

        let winners;
        if (gwResult.rowCount) {
            winners = gwResult.rows.map(r => ({
                winner: r.username,
                winnerDisplay: r.display_name || r.username,
                cardNumber: r.card_number,
                grid: r.grid,
                winningCells: r.winning_cells || [],
                prize: Number(r.prize)
            }));
        } else if (gs.winning_card_number) {
            const legacyCard = await pool.query('SELECT grid FROM bingo_cards WHERE card_number = $1', [gs.winning_card_number]);
            winners = [{
                winner: gs.winner_username,
                winnerDisplay: gs.winner_username,
                cardNumber: gs.winning_card_number,
                grid: legacyCard.rows[0]?.grid || null,
                winningCells: gs.winning_cells || [],
                prize: Number(gs.winner_prize != null ? gs.winner_prize : gs.prize_pool)
            }];
        } else {
            return res.status(404).json({ success: false, message: 'No winning card recorded for this game.' });
        }

        const netPrizeTotal = winners.reduce((sum, w) => sum + (Number(w.prize) || 0), 0);

        res.json({
            success: true,
            game: {
                gameId: gs.id,
                stake: Number(gs.stake),
                prizePool: netPrizeTotal,
                patternName: PATTERN_NAMES[gs.winning_pattern] || gs.winning_pattern,
                drawnNumbers: gs.drawn_numbers || [],
                date: gs.ended_at,
                winners
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
        const q = (req.query.q || '').trim();
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
        const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
        let result;
        if (q && /^\d+$/.test(q)) {
            result = await pool.query(
                'SELECT card_number FROM bingo_cards WHERE card_number::text LIKE $1 ORDER BY card_number ASC LIMIT $2 OFFSET $3',
                [q + '%', limit, offset]
            );
        } else {
            result = await pool.query(
                'SELECT card_number FROM bingo_cards ORDER BY card_number ASC LIMIT $1 OFFSET $2',
                [limit, offset]
            );
        }
        const countRes = await pool.query('SELECT COUNT(*) FROM bingo_cards');
        const total = Number(countRes.rows[0].count);
        res.json({ success: true, cardNumbers: result.rows.map(r => r.card_number), total, hasMore: offset + result.rows.length < total });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to load cards." });
    }
});

app.get('/api/cards/:num', async (req, res) => {
    const num = Number(req.params.num);
    if (!Number.isInteger(num)) return res.status(400).json({ success: false, message: 'Invalid card.' });
    try {
        const result = await pool.query('SELECT card_number, grid FROM bingo_cards WHERE card_number = $1', [num]);
        if (!result.rowCount) return res.status(404).json({ success: false, message: 'Card not found.' });
        res.json({ success: true, card: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Failed to load card.' });
    }
});

// 8. Set Password Endpoint
app.post('/api/set-password', async (req, res) => {
    const { newPassword, initData } = req.body;

    if (!newPassword) {
        return res.status(400).json({ success: false, message: "Missing password." });
    }
    if (String(newPassword).length < 6) {
        return res.status(400).json({ success: false, message: "Password must be at least 6 characters." });
    }

    try {
        const gate = await requireTelegramWebAppUser(initData);
        if (!gate.ok) return res.status(gate.status).json({ success: false, message: gate.message });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const result = await pool.query(
            'UPDATE users SET password = $1, last_active_at = NOW() WHERE id = $2 RETURNING id, username',
            [hashedPassword, gate.dbUser.id]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }

        res.json({
            success: true,
            username: result.rows[0].username,
            message: "Password updated successfully! You can now log in on the web."
        });
    } catch (err) {
        console.error("Set password error:", err);
        res.status(500).json({ success: false, message: `Database Error: ${err.message}` });
    }
});

// Change login username (Telegram account settings). Must stay unique.
app.post('/api/user/username', async (req, res) => {
    const { newUsername, initData } = req.body;
    if (!newUsername) {
        return res.status(400).json({ success: false, message: 'Missing username.' });
    }
    const next = String(newUsername).trim();
    if (next.length < 3 || next.length > 30) {
        return res.status(400).json({ success: false, message: 'Username must be 3–30 characters.' });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(next)) {
        return res.status(400).json({ success: false, message: 'Username may only contain letters, numbers, and underscores.' });
    }
    try {
        const gate = await requireTelegramWebAppUser(initData);
        if (!gate.ok) return res.status(gate.status).json({ success: false, message: gate.message });

        const taken = await pool.query(
            'SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND id <> $2',
            [next, gate.dbUser.id]
        );
        if (taken.rowCount) {
            return res.status(400).json({ success: false, message: 'That username is already taken.' });
        }
        const result = await pool.query(
            'UPDATE users SET username = $1, last_active_at = NOW() WHERE id = $2 RETURNING username',
            [next, gate.dbUser.id]
        );
        if (!result.rowCount) {
            return res.status(404).json({ success: false, message: 'User not found.' });
        }
        res.json({ success: true, username: result.rows[0].username });
    } catch (err) {
        console.error('Username change error:', err);
        res.status(500).json({ success: false, message: 'Server error.' });
    }
});

const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || config.cloudinary.cloudName,
    api_key: process.env.CLOUDINARY_API_KEY || config.cloudinary.apiKey,
    api_secret: process.env.CLOUDINARY_API_SECRET || config.cloudinary.apiSecret
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

    if (!config.adminSecret || adminSecret !== config.adminSecret) {
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
    if (!requireAdmin(req, res)) return;
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 10));
        const offset = (page - 1) * limit;
        const params = [];
        const where = [];
        if (req.query.from && /^\d{4}-\d{2}-\d{2}/.test(String(req.query.from))) {
            params.push(String(req.query.from).trim());
            where.push(`created_at >= $${params.length}::timestamp`);
        }
        if (req.query.to && /^\d{4}-\d{2}-\d{2}/.test(String(req.query.to))) {
            const to = String(req.query.to).trim();
            params.push(to.length === 10 ? to + ' 23:59:59.999' : to);
            where.push(`created_at <= $${params.length}::timestamp`);
        }
        const wsql = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const countRes = await pool.query(`SELECT COUNT(*)::int AS total FROM notifications ${wsql}`, params);
        const total = countRes.rows[0].total;
        const result = await pool.query(
            `SELECT * FROM notifications ${wsql} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
        );
        res.json({ success: true, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)), notifications: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to fetch posts." });
    }
});

// 3. Edit Notification Post
app.put('/api/admin/notifications/:id', async (req, res) => {
    const { id } = req.params;
    const { message, imageUrl, adminSecret } = req.body;

    if (!requireAdmin(req, res)) return;

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

    if (!requireAdmin(req, res)) return;

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


const { attachGameEngine } = require('./game/engine');
attachGameEngine({
  app,
  io,
  STAKES,
  ROUND_SECONDS,
  MIN_PLAYERS,
  splitPot,
  getRoomCutPercent,
});

// ---- Instant Bingo (isolated module; shares wallet only) ----
try {
  const { registerInstantRoutes } = require('./routes/instant');
  const instantEngine = require('./game/instant/engine');
  registerInstantRoutes(app);
  instantEngine.ensureSchema().catch((e) => console.error('instant schema', e));
  instantEngine.attachInstantGame(io);
} catch (err) {
  console.error('Instant Bingo failed to load (classic bingo still runs):', err.message);
}

server.listen(PORT, () => console.log(`Bingo server listening on ${PORT}`));

module.exports = { app, server, io, pool };
