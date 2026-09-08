'use strict';

const crypto = require('crypto');
const config = require('../config');

// Constant-time comparison
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

const ROLES = {
  BOSS: 'boss',
  ADMIN: 'admin',
  SUPER_ADMIN: 'super_admin',
};

// What each role is allowed to access (panel names + API groups)
const ROLE_PERMISSIONS = {
  boss: ['*'],
  admin: [
    'dashboard',
    'deposits',
    'withdraws',
    'transfers',
    'announcements',
    'referrals',
    'leaderboard',
    'gamerooms',
    'gamehistory',
    'houseprofit',
    'instanthistory',
    'instantrounds',
    'specialevent',
    'specialhistory',
    'adminaccounts',
  ],
  super_admin: [
    'dashboard',
    'deposits',
    'withdraws',
    'transfers',
    'gamerooms',
    'gamehistory',
    'houseprofit',
    'instanthistory',
    'instantrounds',
    'specialhistory',
  ],
};

function hasPermission(role, permission) {
  if (!role) return false;
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  if (perms.includes('*')) return true;
  return perms.includes(permission);
}

// Token format: base64url(payload).signature
// payload = username|role|exp (unix seconds)
function createAdminToken(username, role, ttlSeconds = 60 * 60 * 12) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${username}|${role}|${exp}`;
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const secret = config.adminSecret || 'change-me-admin-secret';
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const secret = config.adminSecret || 'change-me-admin-secret';
  const expectedSig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  if (!timingSafeEqual(sig, expectedSig)) return null;

  let payload;
  try {
    payload = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const [username, role, expStr] = payload.split('|');
  if (!username || !role || !expStr) return null;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  if (!['boss', 'admin', 'super_admin'].includes(role)) return null;
  return { username, role };
}

/**
 * Extract admin identity from request.
 * Supports:
 *  1. New token: header x-admin-token  or  body.adminToken
 *  2. Legacy single secret (treated as boss) for backward compatibility during transition
 */
function getAdminFromRequest(req) {
  const headerToken = req.headers['x-admin-token'];
  const bodyToken = req.body && (req.body.adminToken || req.body.adminSecret);
  const headerSecret = req.headers['x-admin-secret'];
  // Prefer explicit token header, then body token/secret field, then legacy secret header
  const candidates = [headerToken, bodyToken, headerSecret].filter(Boolean);
  for (const t of candidates) {
    const admin = verifyAdminToken(t);
    if (admin) return admin;
  }

  // Legacy fallback: single ADMIN_SECRET → treat as boss
  const provided = headerSecret || (req.body && req.body.adminSecret);
  if (config.adminSecret && provided && timingSafeEqual(provided, config.adminSecret)) {
    return { username: 'legacy-boss', role: 'boss' };
  }
  return null;
}

function isAdminRequest(req) {
  return !!getAdminFromRequest(req);
}

/** Express middleware – any logged-in admin */
function adminAuth(req, res, next) {
  const admin = getAdminFromRequest(req);
  if (!admin) {
    return res.status(403).json({ success: false, message: 'Unauthorized.' });
  }
  req.admin = admin;
  return next();
}

/**
 * Inline guard for handlers.
 * Usage: if (!requireAdmin(req, res)) return;
 * Optional second arg: required permission string (or array)
 */
function requireAdmin(req, res, permission) {
  const admin = getAdminFromRequest(req);
  if (!admin) {
    res.status(403).json({ success: false, message: 'Unauthorized.' });
    return false;
  }
  req.admin = admin;

  if (permission) {
    const perms = Array.isArray(permission) ? permission : [permission];
    const allowed = perms.some((p) => hasPermission(admin.role, p));
    if (!allowed) {
      res.status(403).json({ success: false, message: 'Insufficient privileges.' });
      return false;
    }
  }
  return true;
}

/** Require specific role(s) */
function requireRole(...roles) {
  return (req, res, next) => {
    const admin = getAdminFromRequest(req);
    if (!admin) {
      return res.status(403).json({ success: false, message: 'Unauthorized.' });
    }
    if (!roles.includes(admin.role)) {
      return res.status(403).json({ success: false, message: 'Insufficient privileges.' });
    }
    req.admin = admin;
    return next();
  };
}

module.exports = {
  adminAuth,
  requireAdmin,
  requireRole,
  isAdminRequest,
  timingSafeEqual,
  createAdminToken,
  verifyAdminToken,
  getAdminFromRequest,
  hasPermission,
  ROLES,
  ROLE_PERMISSIONS,
};
