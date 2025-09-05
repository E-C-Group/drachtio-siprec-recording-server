const config = require('config');
const assert = require('assert');
const Client = require('rtpengine-client').Client ;
const http = require('http');
const https = require('https');
const { URL } = require('url');
const obj = module.exports = {} ;
//const debug = require('debug')('drachtio:siprec-recording-server');

obj.isFreeswitchSource = (req) => {
  console.log(`has token? ${req.has('X-Return-Token')}: ${req.get('X-Return-Token')}`);
  return req.has('X-Return-Token');
};

let idx = 0;
let servers;
obj.getAvailableFreeswitch = () => {
  servers = servers || config.get('freeswitch');
  if (idx == servers.length) idx = 0;
  return servers[idx++];
};


let idxRtpe = 0;
let rtpes;
obj.getAvailableRtpengine = () => {
  if (!rtpes) {
    let rtpEngines = config.get('rtpengine');
    rtpEngines = Array.isArray(rtpEngines) ? rtpEngines : [rtpEngines];
    rtpes = rtpEngines.map((r) => {
      const port = r.localPort || 0;
      const rtpe = new Client({port, timeout: 1500});
      rtpe.remote = r.remote;
      return rtpe;
    });
  }
  assert(rtpes.length > 0);
  if (idxRtpe == rtpes.length) idxRtpe = 0;
  return rtpes[idxRtpe++];
};

/**
 * Simple HTTP GET that returns parsed JSON body.
 * Rejects on non-2xx status, timeout, or parse error.
 * @param {string} urlStr
 * @param {number} timeoutMs
 * @returns {Promise<object>}
 */
function httpGetJson(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(urlStr);
      const isHttps = u.protocol === 'https:';
      const lib = isHttps ? https : http;
      const req = lib.request({
        method: 'GET',
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        headers: {
          'accept': 'application/json'
        }
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = data ? JSON.parse(data) : {};
              resolve(json);
            } catch (e) {
              reject(e);
            }
          }
          else {
            reject(new Error(`http status ${res.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      if (timeoutMs) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error('timeout'));
        });
      }
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}
obj.httpGetJson = httpGetJson;

/**
 * Verify whether to record this INVITE using optional external endpoint.
 * Falls back to recordByDefault when endpoint is not configured or not reachable.
 * If verification fails and recordByDefault is false, sends 403 and throws a handled error.
 * @param {object} opts - must contain req, res, logger, caller, callee after parsing
 * @returns {Promise<object>} resolves with opts to continue call setup
 */
obj.verifyInvite = async function verifyInvite(opts) {
  const logger = opts.logger;
  let endpoint;
  let recordByDefault = true;
  if (config.has('verification')) {
    const vcfg = config.get('verification');
    endpoint = vcfg.endpoint;
    if (typeof vcfg.recordByDefault === 'boolean') recordByDefault = vcfg.recordByDefault;
  }

  const caller = (opts.caller && (opts.caller.number || opts.caller.aor)) || 'unknown';
  const callee = (opts.callee && (opts.callee.number || opts.callee.aor)) || 'unknown';

  // No endpoint configured -> apply default policy
  if (!endpoint) {
    if (recordByDefault) {
      logger.debug('verification endpoint not configured; proceeding due to recordByDefault=true');
      return opts;
    }
    logger.info('verification endpoint not configured; rejecting due to recordByDefault=false');
    try { await opts.res.send(403); } catch (e) {}
    const err = new Error('verification: default deny (no endpoint)');
    err._handled = true;
    throw err;
  }

  try {
    const url = new URL(endpoint);
    url.searchParams.set('caller', caller);
    url.searchParams.set('callee', callee);
    const response = await httpGetJson(url.toString(), 1500);
    if (typeof response.record === 'boolean') {
      if (response.record) {
        logger.info({caller, callee}, 'verification allowed recording');
        return opts;
      }
      const reason = response.reason || 'denied by verification service';
      logger.info({caller, callee, reason}, 'verification denied recording');
      try { await opts.res.send(403); } catch (e) {}
      const err = new Error(`verification denied: ${reason}`);
      err._handled = true;
      throw err;
    }
    logger.warn({response}, 'verification returned invalid payload; applying recordByDefault');
    if (recordByDefault) return opts;
    try { await opts.res.send(403); } catch (e) {}
    const err = new Error('verification invalid payload: default deny');
    err._handled = true;
    throw err;
  } catch (e) {
    logger.warn({err: e}, 'verification request failed; applying recordByDefault');
    if (recordByDefault) return opts;
    try { await opts.res.send(403); } catch (e2) {}
    const err = new Error('verification failure: default deny');
    err._handled = true;
    throw err;
  }
};

