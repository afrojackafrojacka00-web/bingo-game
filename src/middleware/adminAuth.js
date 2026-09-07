'use strict';

const crypto = require('crypto');
const config = require('../config');

// Constant-time comparison — a plain `===` short-circuits on the first
// mismatched byte, so how long the check takes leaks how many leading
// characters of a guess were correct. Not the biggest risk on its own, but
// this secret gates every admin/money endpoint, so it costs nothing to close.
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers so mismatched-length
    // guesses don't return measurably faster than correct-length ones.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAdminRequest(req) {
  const headerSecret = req.headers['x-admin-secret'];
  const bodySecret = req.body && req.body.adminSecret;
  const provided = headerSecret || bodySecret;
  if (!config.adminSecret || !provided) return false;
  return timingSafeEqual(provided, config.adminSecret);
}

/** Express middleware */
function adminAuth(req, res, next) {
  if (!isAdminRequest(req)) {
    return res.status(403).json({ success: false, message: 'Unauthorized.' });
  }
  return next();
}

/**
 * Inline guard for handlers not yet wired with middleware.
 * Usage: if (!requireAdmin(req, res)) return;
 */
function requireAdmin(req, res) {
  if (!isAdminRequest(req)) {
    res.status(403).json({ success: false, message: 'Unauthorized.' });
    return false;
  }
  return true;
}

module.exports = { adminAuth, requireAdmin, isAdminRequest, timingSafeEqual };
