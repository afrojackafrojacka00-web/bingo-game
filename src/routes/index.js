'use strict';

/**
 * Route map (domain → location)
 *
 * HTTP routes currently register from:
 *   - src/app.js          (auth, account, wallet, admin-*, history, cards, notifications, referrals)
 *   - src/game/engine.js  (admin games, rake, house-profit, game-settings, game-state, sockets)
 *
 * Shared guards:
 *   - requireAdmin / adminAuth  → src/middleware/adminAuth.js
 *   - authLimiter / moneyLimiter → src/middleware/rateLimiters.js
 *
 * Future: move each domain into its own file exporting
 *   module.exports = function registerXxxRoutes(app, ctx) { ... }
 * and call them from src/app.js. Behavior stays the same; only file layout changes.
 */

module.exports = {
  domains: [
    'auth',
    'account',
    'referrals',
    'wallet',
    'admin-wallet',
    'admin-users',
    'history',
    'cards',
    'notifications',
    'admin-games',
    'game-live',
  ],
};
