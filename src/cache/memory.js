'use strict';

/**
 * Simple in-process TTL cache for non-sensitive, read-heavy data
 * (card grids, public settings, payment method lists, etc.).
 *
 * Do NOT store balances, auth tokens, or live room claim state here.
 */

const store = new Map();

/**
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => Promise<any>} loader
 */
async function getOrSet(key, ttlMs, loader) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }
  const value = await loader();
  store.set(key, { value, expiresAt: now + ttlMs });
  return value;
}

function get(key) {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= Date.now()) {
    store.delete(key);
    return undefined;
  }
  return hit.value;
}

function set(key, value, ttlMs) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function invalidate(keyOrPrefix) {
  if (store.has(keyOrPrefix)) {
    store.delete(keyOrPrefix);
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(keyOrPrefix)) store.delete(key);
  }
}

function clear() {
  store.clear();
}

module.exports = { getOrSet, get, set, invalidate, clear };
