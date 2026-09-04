'use strict';

const pool = require('./pool');

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
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_theme VARCHAR(10) DEFAULT 'dark';");
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(50);");

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

        await pool.query(`CREATE TABLE IF NOT EXISTS game_winners (
            id SERIAL PRIMARY KEY,
            game_id INT REFERENCES game_sessions(id) ON DELETE CASCADE,
            username VARCHAR(50) NOT NULL,
            display_name VARCHAR(100),
            card_number INT,
            winning_cells JSONB,
            prize NUMERIC(10,2),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_game_winners_game_id ON game_winners(game_id);');
        await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS house_cut NUMERIC(10,2) DEFAULT 0;');
        await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS winner_prize NUMERIC(10,2) DEFAULT 0;');
        await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS cut_percent NUMERIC(5,2) DEFAULT 20;');
        await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS player_count INT DEFAULT 0;');
        await pool.query('ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS card_count INT DEFAULT 0;');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_game_sessions_created ON game_sessions(created_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_game_sessions_stake_created ON game_sessions(stake, created_at DESC);');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_game_sessions_status ON game_sessions(status);');
        // deposit/withdraw/transfer indexes are created AFTER those tables exist (below)
        await pool.query('CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at DESC);');


        // Per-stake house cut (rake). Default 20% for every stake room.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS room_rake_settings (
                stake NUMERIC(10,2) PRIMARY KEY,
                cut_percent NUMERIC(5,2) NOT NULL DEFAULT 20.00,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        for (const stake of [10, 20, 50, 100, 200, 500]) {
            await pool.query(
                `INSERT INTO room_rake_settings(stake, cut_percent) VALUES($1, 20.00) ON CONFLICT (stake) DO NOTHING`,
                [stake]
            );
        }

        // Voice pack for number calls, chosen per-player in Account Settings.
        await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_voice_pack VARCHAR(20) DEFAULT 'john';");
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS sound_enabled BOOLEAN DEFAULT TRUE;');

        // Referrals: the code is just the referrer's own username, kept
        // simple. referred_by records who invited this user (NULL if none).
        // bonus is a separate ledger from balance, credited automatically
        // at admin-configured milestones and otherwise only admin-adjusted.
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by VARCHAR(50);');
        await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bonus_balance NUMERIC(10,2) DEFAULT 0.00;');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(LOWER(referred_by));');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS referral_settings (
                id INT PRIMARY KEY CHECK (id=1),
                referrals_required INT NOT NULL DEFAULT 100,
                reward_amount NUMERIC(10,2) NOT NULL DEFAULT 500.00
            );
        `);
        await pool.query(`INSERT INTO referral_settings(id,referrals_required,reward_amount) VALUES(1,100,500.00) ON CONFLICT (id) DO NOTHING;`);

        // Welcome bonus for brand-new Telegram accounts (admin-controlled).
        await pool.query(`
            CREATE TABLE IF NOT EXISTS welcome_bonus_settings (
                id INT PRIMARY KEY CHECK (id=1),
                enabled BOOLEAN NOT NULL DEFAULT TRUE,
                amount NUMERIC(10,2) NOT NULL DEFAULT 10.00,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await pool.query(`INSERT INTO welcome_bonus_settings(id, enabled, amount) VALUES(1, TRUE, 10.00) ON CONFLICT (id) DO NOTHING;`);

        // Wallet: admin-managed deposit accounts, and pending user requests
        // that only take effect once an admin approves them.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS payment_methods (
                id SERIAL PRIMARY KEY,
                method VARCHAR(20) NOT NULL,
                account_number VARCHAR(50) NOT NULL,
                account_name VARCHAR(100) NOT NULL,
                active BOOLEAN NOT NULL DEFAULT TRUE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS deposit_requests (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                method VARCHAR(20) NOT NULL,
                submitted_text TEXT NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
                credited_amount NUMERIC(10,2),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                reviewed_at TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS withdraw_requests (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                username VARCHAR(50) NOT NULL,
                amount NUMERIC(10,2) NOT NULL,
                method VARCHAR(20) NOT NULL,
                destination VARCHAR(50) NOT NULL,
                account_owner_name VARCHAR(100),
                status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                reviewed_at TIMESTAMP
            );
             ALTER TABLE withdraw_requests ADD COLUMN IF NOT EXISTS account_owner_name VARCHAR(100);
            ALTER TABLE deposit_requests ALTER COLUMN submitted_text DROP NOT NULL;
            ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS amount NUMERIC(10,2);
            ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(50);
            ALTER TABLE deposit_requests ADD COLUMN IF NOT EXISTS verification_note TEXT;
            DROP INDEX IF EXISTS idx_deposit_requests_txn_approved_unique;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_deposit_requests_txn_unique
                ON deposit_requests (transaction_id)
                WHERE status = 'APPROVED' AND transaction_id IS NOT NULL;
            CREATE INDEX IF NOT EXISTS idx_users_username_lower ON users (LOWER(username));
            CREATE TABLE IF NOT EXISTS deposit_verification_settings (
                id INT PRIMARY KEY CHECK (id=1),
                auto_verify_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO deposit_verification_settings(id, auto_verify_enabled) VALUES (1, TRUE) ON CONFLICT (id) DO NOTHING;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_verify_enabled BOOLEAN NOT NULL DEFAULT TRUE;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;
            CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at DESC NULLS LAST);
            CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at DESC);
            CREATE TABLE IF NOT EXISTS transfer_requests (
                id SERIAL PRIMARY KEY,
                sender_id INT REFERENCES users(id) ON DELETE CASCADE,
                sender_username VARCHAR(50) NOT NULL,
                recipient_phone VARCHAR(30) NOT NULL,
                recipient_username VARCHAR(50),
                amount NUMERIC(10,2) NOT NULL,
                status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                reviewed_at TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_deposit_requests_status ON deposit_requests(status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_deposit_requests_status_created ON deposit_requests(status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_deposit_requests_created ON deposit_requests(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_withdraw_requests_status ON withdraw_requests(status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_withdraw_requests_status_created ON withdraw_requests(status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_withdraw_requests_created ON withdraw_requests(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_transfer_requests_status ON transfer_requests(status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_transfer_requests_status_created ON transfer_requests(status, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_deposit_requests_user ON deposit_requests(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_withdraw_requests_user ON withdraw_requests(user_id, created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_transfer_requests_user ON transfer_requests(sender_id, created_at DESC);
        `);

        // Seed the two starting numbers for each method if the table is empty,
        // so the deposit modal has something to show immediately — admin can
        // edit/add/remove these from the admin panel afterward.
        const paymentMethodCount = await pool.query('SELECT COUNT(*) FROM payment_methods');
        if (Number(paymentMethodCount.rows[0].count) === 0) {
            await pool.query(
                `INSERT INTO payment_methods (method, account_number, account_name) VALUES
                    ('telebirr', '0987655443', 'Jack'),
                    ('telebirr', '0934455678', 'Merry'),
                    ('cbe', '100001236765432', 'Rose'),
                    ('cbe', '105385464564559', 'Terry')`
            );
        }


        const countRes = await pool.query('SELECT COUNT(*) FROM bingo_cards');
        let existing = parseInt(countRes.rows[0].count, 10);
        if (existing < 5000) {
            console.log(`Seeding bingo cards from ${existing + 1} to 5000...`);
            for (let i = existing + 1; i <= 5000; i++) {
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

module.exports = { initDB };
