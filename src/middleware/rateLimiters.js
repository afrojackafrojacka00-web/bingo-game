'use strict';

const rateLimit = require('express-rate-limit');

// Higher ceiling: Telegram clients poll status while users play Instant/Special
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_GENERAL_MAX || 240),
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many attempts. Try again later.' },
});

const moneyLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.body && req.body.username
      ? String(req.body.username).toLowerCase()
      : req.ip,
  message: {
    success: false,
    message: 'Too many requests. Please wait a few minutes and try again.',
  },
});

// Join / READY / claim — per username, allows play without opening wallet floodgates
const gameActionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number(process.env.RATE_GAME_ACTION_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    (req.body && req.body.username) || (req.query && req.query.username)
      ? String((req.body && req.body.username) || req.query.username).toLowerCase()
      : req.ip,
  message: {
    success: false,
    message: 'Too many game actions. Please wait a moment.',
  },
});

module.exports = { generalLimiter, authLimiter, moneyLimiter, gameActionLimiter };
