'use strict';

const rateLimit = require('express-rate-limit');

const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
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

module.exports = { generalLimiter, authLimiter, moneyLimiter };
