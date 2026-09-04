'use strict';

const crypto = require('crypto');
const pool = require('../db/pool');
const config = require('../config');

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


module.exports = {
  createNotificationBaseline,
  createPersonalNotification,
  verifyTelegramAuth,
  getRoomCutPercent,
  splitPot,
  getWelcomeBonusSettings,
  requireTelegramWebAppUser,
  applyReferralIfNew,
  telegramApi,
  sendTelegramWelcomeMessage,
};
