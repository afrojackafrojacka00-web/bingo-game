const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

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

            CREATE TABLE IF NOT EXISTS announcements (
                id SERIAL PRIMARY KEY,
                message TEXT NOT NULL,
                image_url TEXT,
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
                called_numbers INT[],
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

        // Ensure columns exist on legacy databases
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS balance NUMERIC(10,2) DEFAULT 10.00;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;');

        // Seed standard B-I-N-G-O 5x5 grids
        const countRes = await pool.query('SELECT COUNT(*) FROM bingo_cards');
        if (parseInt(countRes.rows[0].count, 10) < 500) {
            console.log("Seeding 500 standard Bingo cards into database...");
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
        console.log("Database initialized successfully.");
    } catch (err) {
        console.error("Database initialization error:", err);
    }
};

module.exports = { pool, initDB };