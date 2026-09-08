'use strict';

const path = require('path');

const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',

  databaseUrl: process.env.DATABASE_URL,
  databaseSsl: process.env.DATABASE_SSL === 'true',
  pgPoolMax: Number(process.env.PG_POOL_MAX || 40),
  pgPoolIdleMs: Number(process.env.PG_POOL_IDLE_MS || 30000),
  pgPoolConnectionTimeoutMs: Number(process.env.PG_POOL_CONN_TIMEOUT_MS || 5000),
  pgStatementTimeoutMs: Number(process.env.PG_STATEMENT_TIMEOUT_MS || 15000),

  adminSecret: process.env.ADMIN_SECRET || '',
  // Signs regular-user session tokens (see src/middleware/userAuth.js).
  // Required in production — see the startup check in src/app.js. Keep this
  // separate from adminSecret so a leaked user-session secret can never be
  // used to forge an admin token, or vice versa.
  sessionSecret: process.env.SESSION_SECRET || '',
  // Comma-separated list of origins allowed to call the API / open a socket,
  // e.g. "https://yourapp.example.com,https://web.telegram.org". Required
  // in production — see the startup check in src/app.js. Left empty in dev
  // so localhost testing keeps working without extra setup.
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  botToken: process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '',

  stakes: [10, 20, 50, 100, 200, 500],
  roundSeconds: 40,
  minPlayers: 2,
  maxCardsPerPlayer: Number(process.env.MAX_CARDS_PER_PLAYER || 500),

  defaultGamePattern: 'any_one_line',
  defaultDrawIntervalSeconds: Number(process.env.DEFAULT_DRAW_INTERVAL_SECONDS || 4),
  drawIntervalMs: Number(process.env.DRAW_INTERVAL_MS || 2500),
  roomBroadcastMs: Number(process.env.ROOM_BROADCAST_MS || 300),

  minWithdrawAmount: 21,

  voicePacks: ['john', 'amharic', 'oromifa', 'jerry', 'arada'],

  publicDir: path.join(__dirname, '..', '..', 'public'),

  // Instant Bingo (Ohio-style multiple bingo) — isolated from classic rooms
  instantBingo: {
    enabled: process.env.INSTANT_BINGO_ENABLED !== 'false',
    maxCardsPerPlayer: Number(process.env.INSTANT_MAX_CARDS || 4),
    numbersDrawn: Number(process.env.INSTANT_NUMBERS_DRAWN || 20),
    catalogSize: Number(process.env.INSTANT_CATALOG_SIZE || 200),
    roundSeconds: Number(process.env.INSTANT_ROUND_SECONDS || 45),
    selectionSeconds: Number(process.env.INSTANT_SELECTION_SECONDS || 25),
    stakes: [10, 20, 50, 100, 200, 500],
    // multipliers on the stake paid for that card
    lineMultiplier: 2,
    cornersMultiplier: 2.5,
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },
};

module.exports = config;
