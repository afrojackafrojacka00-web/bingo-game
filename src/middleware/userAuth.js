'use strict';

const crypto = require('crypto');
const config = require('../config');

// Constant-time comparison (same helper as adminAuth.js — duplicated rather
// than imported to keep this module independently usable / testable).
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Dev-only fallback so `npm run dev` works with zero env-var setup. A fresh
// random secret is generated each time the process boots, so it is never a
// predictable, guessable value — and it naturally invalidates every session
// on restart, which is fine for local development. Production MUST set
// SESSION_SECRET — see the startup check in src/app.js, which refuses to
// boot without it. Nothing in this file should ever fall back to a fixed,
// hardcoded string.
const devFallbackSecret = crypto.randomBytes(32).toString('hex');
function secret() {
  return config.sessionSecret || devFallbackSecret;
}

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days — matches the "stay logged in" behavior the app already had via localStorage

// Token format: base64url(userId|username|exp).signature — same shape as
// the admin token in adminAuth.js, signed with a different secret.
function createUserToken(userId, username, ttlSeconds = TOKEN_TTL_SECONDS) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${userId}|${username}|${exp}`;
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyUserToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', secret()).update(payloadB64).digest('base64url');
  if (!timingSafeEqual(sig, expectedSig)) return null;

  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts2 = payload.split('|');
  if (parts2.length !== 3) return null;
  const [userIdStr, username, expStr] = parts2;
  if (!userIdStr || !username || !expStr) return null;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const userId = parseInt(userIdStr, 10);
  if (!Number.isFinite(userId)) return null;
  return { userId, username };
}

// A request can carry the token in a header (preferred, used by fetch calls)
// or in the JSON body / query string (used by the small number of callers —
// e.g. some GET requests and the socket.io handshake — where a header is
// awkward to attach). Header wins if more than one is present.
function getUserFromRequest(req) {
  const headerToken = req.headers && req.headers['x-session-token'];
  const bodyToken = req.body && req.body.sessionToken;
  const queryToken = req.query && req.query.sessionToken;
  const token = headerToken || bodyToken || queryToken;
  return verifyUserToken(token);
}

/**
 * Express middleware: requires a valid session token. Every route this app
 * already had was written to trust a `username` field in the body/query as
 * the caller's identity — rather than rewrite every handler's internals,
 * this middleware verifies the token, checks it against any `username` the
 * client also sent (clear error if they mismatch), and then overwrites
 * req.body.username / req.query.username with the *verified* value from the
 * token. Downstream handlers keep working unchanged, but now read a value
 * that's actually been proven instead of merely claimed.
 */
function requireUser(req, res, next) {
  const auth = getUserFromRequest(req);
  if (!auth) {
    return res.status(401).json({ success: false, message: 'Please log in again.', code: 'AUTH_REQUIRED' });
  }
  const claimedBody = req.body && req.body.username;
  const claimedQuery = req.query && req.query.username;
  if (claimedBody && String(claimedBody).toLowerCase() !== String(auth.username).toLowerCase()) {
    return res.status(403).json({ success: false, message: 'Session does not match the requested account.' });
  }
  if (claimedQuery && String(claimedQuery).toLowerCase() !== String(auth.username).toLowerCase()) {
    return res.status(403).json({ success: false, message: 'Session does not match the requested account.' });
  }
  if (req.body) req.body.username = auth.username;
  if (req.query) req.query.username = auth.username;
  req.user = auth;
  next();
}

/**
 * Socket.io equivalent, used once at connection time (see the io.use()
 * handshake middleware in app.js) rather than per-event — a socket
 * represents one logged-in session for its whole lifetime, so there is no
 * need to re-verify a token on every single event the way an HTTP request
 * does. Individual event handlers should read socket.data.user.username as
 * the caller's identity and ignore/validate-against any username in the
 * event payload — see attachGameEngine's socket handlers.
 */
function verifySocketToken(token) {
  return verifyUserToken(token);
}

module.exports = {
  createUserToken,
  verifyUserToken,
  getUserFromRequest,
  requireUser,
  verifySocketToken,
  TOKEN_TTL_SECONDS,
};
