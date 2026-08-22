const express = require('express');
const { pool } = require('../config/db');
const router = express.Router();

router.get('/user-details', async (req, res) => {
    const username = req.query.username;
    if (!username) return res.status(400).json({ success: false, message: "Username required." });

    try {
        const result = await pool.query(
            'SELECT id, username, phone_number, balance, wins FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: "User not found." });

        res.json({ success: true, user: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error." });
    }
});

router.get('/cards/numbers', async (req, res) => {
    try {
        const result = await pool.query('SELECT card_number FROM bingo_cards ORDER BY card_number ASC');
        res.json({ success: true, cardNumbers: result.rows.map(r => r.card_number) });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to load cards." });
    }
});

router.get('/cards/grids', async (req, res) => {
    const cardNumbersStr = req.query.cardNumbers;
    if (!cardNumbersStr) return res.status(400).json({ success: false, message: "Card numbers required." });

    try {
        const cardNumbers = cardNumbersStr.split(',').map(n => parseInt(n, 10)).filter(n => !isNaN(n));
        const result = await pool.query('SELECT card_number, grid FROM bingo_cards WHERE card_number = ANY($1)', [cardNumbers]);
        
        const cardMap = {};
        result.rows.forEach(row => {
            cardMap[row.card_number] = row.grid;
        });

        res.json({ success: true, cards: cardMap });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to fetch grids." });
    }
});

router.get('/announcements', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 10');
        res.json({ success: true, announcements: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to load announcements." });
    }
});

module.exports = router;