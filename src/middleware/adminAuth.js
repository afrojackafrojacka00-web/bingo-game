'use strict';

const config = require('../config');

function isAdminRequest(req) {
  const headerSecret = req.headers['x-admin-secret'];
  const bodySecret = req.body && req.body.adminSecret;
  const provided = headerSecret || bodySecret;
  return !!(config.adminSecret && provided === config.adminSecret);
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

module.exports = { adminAuth, requireAdmin, isAdminRequest };
