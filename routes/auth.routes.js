const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');

const router = express.Router();

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

async function sendTelegramWelcomeMessage(telegramId, username, phoneNumber) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken || !telegramId) return;

    const captionText = `ለስለተመዘገቡ እናመሰግናለን ${username}! 10 ብር ስጦታ አለዎት።\n\n` +
                        `የአካውንት ዝርዝሮች:\n` +
                        `ስም: ${username}\n` +
                        `ስልክ: ${phoneNumber}\n` +
                        `ቀሪ ሒሳብ: 10 ETB`;

    try {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: telegramId, text: captionText })
        });
    } catch (err) {
        console.error("Failed to send Telegram welcome message:", err);
    }
}

router.post('/register', async (req, res) => {
    const { username, password, phoneNumber, initData } = req.body;
    if (!username || !password) return res.status(400).json({ success: false, message: "Missing required fields." });

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
            'INSERT INTO users (username, password, telegram_id, phone_number, balance, phone_verified) VALUES ($1, $2, $3, $4, 10.00, $5) RETURNING id, username',
            [username, hashedPassword, telegramId, phoneNumber || null, !!phoneNumber]
        );

        await client.query(
            'INSERT INTO transactions (user_id, amount, type) VALUES ($1, $2, $3)',
            [userRes.rows[0].id, 10.00, 'WELCOME_BONUS']
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

router.post('/login', async (req, res) => {
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

router.post('/telegram-auth', async (req, res) => {
    const { initData } = req.body;
    const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);
    
    if (!isValid || !user?.id) return res.status(401).json({ success: false, message: "Invalid Telegram authentication." });

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
            return res.json({ success: true, status: 'LOGGED_IN', username: dbUser.username, phoneVerified: !!dbUser.phone_verified });
        }

        let baseUsername = (user.username || user.first_name || `tg_${user.id}`).replace(/[^a-zA-Z0-9_]/g, '') || `tg_${user.id}`;
        let finalUsername = baseUsername;
        let existingName = await client.query('SELECT id FROM users WHERE username = $1', [finalUsername]);
        if (existingName.rows.length > 0) finalUsername = `${baseUsername}_${Math.floor(1000 + Math.random() * 9000)}`;

        const randomPassword = crypto.randomBytes(16).toString('hex');
        const hashedPassword = await bcrypt.hash(randomPassword, 10);

        const newUserRes = await client.query(
            'INSERT INTO users (username, password, telegram_id, phone_verified, balance) VALUES ($1, $2, $3, FALSE, 10.00) RETURNING id',
            [finalUsername, hashedPassword, user.id]
        );

        await client.query(
            'INSERT INTO transactions (user_id, amount, type) VALUES ($1, $2, $3)',
            [newUserRes.rows[0].id, 10.00, 'WELCOME_BONUS']
        );

        await client.query('COMMIT');
        res.json({ success: true, status: 'LOGGED_IN', username: finalUsername, phoneVerified: false });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: "Server authentication error." });
    } finally {
        client.release();
    }
});

router.post('/save-telegram-phone', async (req, res) => {
    const { initData, phoneNumber } = req.body;
    const { isValid, user } = verifyTelegramAuth(initData, process.env.TELEGRAM_BOT_TOKEN);
    if (!isValid || !user?.id) return res.status(401).json({ success: false, message: "Unauthorized request." });
    if (!phoneNumber) return res.status(400).json({ success: false, message: "Phone number missing." });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const checkUser = await client.query('SELECT id, username, phone_verified FROM users WHERE telegram_id = $1', [user.id]);
        if (checkUser.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: "User not found." });
        }

        const username = checkUser.rows[0].username;
        await client.query('UPDATE users SET phone_number = $1, phone_verified = TRUE WHERE telegram_id = $2', [phoneNumber, user.id]);

        await client.query('COMMIT');
        sendTelegramWelcomeMessage(user.id, username, phoneNumber);
        res.json({ success: true, message: "Phone number verified and saved!" });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, message: "Failed to save phone." });
    } finally {
        client.release();
    }
});

module.exports = router;