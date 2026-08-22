const express = require('express');
const multer = require('multer');
const upload = multer();
const { pool } = require('../config/db');
const { notifyBalanceChange } = require('../sockets/notificationSocket');

module.exports = (io) => {
    const router = express.Router();

    router.post('/broadcast', upload.single('imageFile'), async (req, res) => {
        const { message, imageUrl, adminSecret } = req.body;
        
        if (adminSecret !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, message: "Unauthorized: Incorrect secret key." });
        }

        try {
            let finalImageUrl = imageUrl || null;

            const dbRes = await pool.query(
                'INSERT INTO announcements (message, image_url) VALUES ($1, $2) RETURNING id, created_at',
                [message || '', finalImageUrl]
            );

            const announcementData = {
                id: dbRes.rows[0].id,
                message: message,
                imageUrl: finalImageUrl,
                createdAt: dbRes.rows[0].created_at
            };

            // Socket.io Real-time Pop-up Broadcast to Web
            io.emit('admin_announcement_popup', announcementData);

            // Send Telegram Message to All Users
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

            res.json({ success: true, message: "Broadcast deployed!" });
        } catch (err) {
            res.status(500).json({ success: false, message: "Server error during broadcast." });
        }
    });

    router.post('/update-balance', async (req, res) => {
        const { username, amount, reason, adminSecret } = req.body;

        if (adminSecret !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, message: "Unauthorized." });
        }

        try {
            const userRes = await pool.query(
                'UPDATE users SET balance = balance + $1 WHERE LOWER(username) = LOWER($2) RETURNING id, username, balance',
                [amount, username]
            );

            if (userRes.rows.length === 0) {
                return res.status(404).json({ success: false, message: "User not found." });
            }

            const user = userRes.rows[0];
            await notifyBalanceChange(pool, io, user.id, user.username, amount, user.balance, reason || 'ADMIN_ADJUSTMENT');

            res.json({ success: true, newBalance: user.balance });
        } catch (err) {
            res.status(500).json({ success: false, message: "Failed to update balance." });
        }
    });

    return router;
};