/**
 * Cluster-wide SIPREC dedup.
 *
 * BroadWorks (and similar systems) emit two SIPREC sessions for the same
 * underlying call when both the calling and called parties are configured to
 * be recorded. The two SIPREC INVITEs have different SIP Call-IDs and
 * different SIPREC session UUIDs but share an X-BroadWorks-Correlation-Info
 * header, an extTrackingID in the rs-metadata XML, and the same calling/
 * called party numbers.
 *
 * This module exposes a small acquire/release API used by the rtpengine
 * call handler to claim a logical-call identity at SIPREC ingress. The
 * first SIPREC INVITE wins; subsequent INVITEs that map to the same
 * identity are rejected by the handler (488 Not Acceptable Here).
 *
 * Backed by Redis when REDIS_HOST is configured (so two telephony pods
 * dedup against each other). Falls back to an in-process map otherwise --
 * still useful in single-pod / local-dev setups and as a last-resort when
 * Redis is unreachable. By default we fail OPEN on Redis errors: rejecting
 * a real call is worse than admitting a rare duplicate, but every fail-open
 * path is logged loudly so it's visible.
 */

const redis = require('redis');

let backend = null;
let bound = false;
let baseLogger = null;
let failOpen = true;

const KEY_PREFIX = 'siprec-dedup:';

/* ------------------------------------------------------------------ */
/* in-memory backend (dev / fallback)                                 */
/* ------------------------------------------------------------------ */

function inMemoryBackend() {
  const store = new Map(); // key -> {value, expiresAt}

  function now() { return Date.now(); }

  function purge(key) {
    const entry = store.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= now()) {
      store.delete(key);
      return null;
    }
    return entry;
  }

  return {
    name: 'memory',
    async setNx(key, value, ttlMs) {
      const existing = purge(key);
      if (existing) return {ok: false, currentValue: existing.value};
      store.set(key, {value, expiresAt: ttlMs > 0 ? now() + ttlMs : 0});
      return {ok: true};
    },
    async delIfMatch(key, value) {
      const existing = purge(key);
      if (!existing) return false;
      if (existing.value !== value) return false;
      store.delete(key);
      return true;
    },
    async close() { store.clear(); },
  };
}

/* ------------------------------------------------------------------ */
/* redis backend                                                      */
/* ------------------------------------------------------------------ */

const COMPARE_AND_DELETE_LUA =
  'if redis.call("get", KEYS[1]) == ARGV[1] then ' +
  '  return redis.call("del", KEYS[1]) ' +
  'else ' +
  '  return 0 ' +
  'end';

function redisBackend(opts, logger) {
  const client = redis.createClient(opts);
  let connected = false;

  client.on('ready', () => {
    connected = true;
    logger.info({host: opts.host, port: opts.port, db: opts.db}, 'dedup redis connected');
  });
  client.on('end', () => {
    connected = false;
    logger.warn('dedup redis connection closed');
  });
  client.on('error', (err) => {
    logger.warn({err: err && err.message}, 'dedup redis error');
  });

  function setNx(key, value, ttlMs) {
    return new Promise((resolve, reject) => {
      // SET key value NX PX ttlMs  -> reply is "OK" on success or null on conflict
      const args = [key, value, 'NX'];
      if (ttlMs > 0) args.push('PX', ttlMs);
      client.send_command('SET', args, (err, reply) => {
        if (err) return reject(err);
        if (reply === 'OK') return resolve({ok: true});
        // Conflict: fetch current owner for diagnostics. Best-effort.
        client.get(key, (gerr, current) => {
          if (gerr) return resolve({ok: false, currentValue: null});
          resolve({ok: false, currentValue: current});
        });
      });
    });
  }

  function delIfMatch(key, value) {
    return new Promise((resolve) => {
      client.eval(COMPARE_AND_DELETE_LUA, 1, key, value, (err, reply) => {
        if (err) {
          logger.warn({err: err && err.message, key}, 'dedup redis delIfMatch failed');
          return resolve(false);
        }
        resolve(reply === 1);
      });
    });
  }

  function close() {
    return new Promise((resolve) => {
      try { client.quit(() => resolve()); }
      catch (e) { resolve(); }
    });
  }

  return {
    name: 'redis',
    isConnected: () => connected,
    setNx,
    delIfMatch,
    close,
  };
}

/* ------------------------------------------------------------------ */
/* public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Initialize the dedup backend. Safe to call multiple times; only the first
 * call has effect.
 *
 * @param {object} options
 * @param {object} options.logger    - pino-style logger
 * @param {string} [options.redisHost]
 * @param {number} [options.redisPort=6379]
 * @param {number} [options.redisDb=1]
 * @param {string} [options.redisPassword]
 * @param {boolean} [options.failOpen=true]
 */
function init(options) {
  if (bound) return backend;
  baseLogger = (options && options.logger) || console;
  failOpen = options && options.failOpen === false ? false : true;

  const host = options && options.redisHost;
  if (!host) {
    baseLogger.info('dedup using in-memory backend (REDIS_HOST not set)');
    backend = inMemoryBackend();
  }
  else {
    const port = parseInt(options.redisPort || 6379, 10);
    const db = options.redisDb !== undefined ? parseInt(options.redisDb, 10) : 1;
    const conn = {host, port, db};
    if (options.redisPassword) conn.password = options.redisPassword;
    // redis@2 retry strategy - keep a bounded backoff so we don't spin on
    // connect failures forever while still recovering automatically.
    conn.retry_strategy = (info) => {
      if (info.attempt > 60) return undefined; // stop trying after ~60 attempts
      return Math.min(30000, 500 * info.attempt);
    };
    backend = redisBackend(conn, baseLogger);
  }

  bound = true;
  return backend;
}

/**
 * Build a normalized dedup candidate key.
 * @param {string} kind
 * @param {string} value
 * @returns {string}
 */
function makeKey(kind, value) {
  const v = String(value || '').trim().toLowerCase().replace(/\s+/g, '');
  return `${KEY_PREFIX}${kind}:${v}`;
}

/**
 * Try to acquire ALL candidate keys for `ownerId`. If any candidate is
 * already held by a different owner, the function backs out (releases any
 * keys it had set) and returns {acquired: false, conflict: {key, owner}}.
 *
 * Order of evaluation matches the candidates array, so callers should pass
 * the highest-confidence identity first (e.g. X-BroadWorks-Correlation-Info,
 * then extTrackingID, then a short-window caller/callee pair).
 *
 * @param {Array<{key:string, ttlMs:number}>} candidates
 * @param {string} ownerId  - typically the SIP Call-ID of this INVITE
 * @returns {Promise<{acquired:boolean, conflict?:{key:string, owner:string}, owned: Array<string>}>}
 */
async function acquire(candidates, ownerId) {
  if (!bound) init({});
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return {acquired: true, owned: []};
  }

  const owned = [];
  for (const cand of candidates) {
    if (!cand || !cand.key) continue;
    try {
      const res = await backend.setNx(cand.key, ownerId, cand.ttlMs || 0);
      if (res.ok) {
        owned.push(cand.key);
        continue;
      }
      if (res.currentValue === ownerId) {
        // Same INVITE somehow re-entered (e.g. retransmit). Treat as ok.
        continue;
      }
      // Conflict: back out any keys we already claimed.
      for (const k of owned) {
        try { await backend.delIfMatch(k, ownerId); } catch (e) { /* ignore */ }
      }
      return {acquired: false, conflict: {key: cand.key, owner: res.currentValue || 'unknown'}, owned: []};
    }
    catch (err) {
      baseLogger.warn({err: err && err.message, key: cand.key}, 'dedup backend error during acquire');
      if (!failOpen) {
        for (const k of owned) {
          try { await backend.delIfMatch(k, ownerId); } catch (e) { /* ignore */ }
        }
        const e = new Error('dedup backend error (failClosed)');
        e._dedupBackend = true;
        throw e;
      }
      // fail-open: skip this candidate, continue
    }
  }
  return {acquired: true, owned};
}

/**
 * Release previously-acquired candidate keys, but only if still owned by
 * `ownerId` (compare-and-delete). Errors are swallowed and logged: TTL
 * will eventually clean up.
 *
 * @param {Array<string>} keys
 * @param {string} ownerId
 */
async function release(keys, ownerId) {
  if (!bound || !Array.isArray(keys)) return;
  for (const key of keys) {
    if (!key) continue;
    try { await backend.delIfMatch(key, ownerId); }
    catch (err) {
      baseLogger.warn({err: err && err.message, key}, 'dedup backend error during release');
    }
  }
}

function _resetForTests() {
  if (backend && backend.close) {
    try { backend.close(); } catch (e) { /* ignore */ }
  }
  backend = null;
  bound = false;
  baseLogger = null;
  failOpen = true;
}

function _setBackendForTests(b, logger) {
  backend = b;
  bound = true;
  baseLogger = logger || console;
}

module.exports = {
  init,
  makeKey,
  acquire,
  release,
  KEY_PREFIX,
  _resetForTests,
  _setBackendForTests,
  _inMemoryBackend: inMemoryBackend,
};
