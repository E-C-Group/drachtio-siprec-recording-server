"use strict";

const test = require('tape');
const http = require('http');
const clearRequire = require('clear-require');
const Module = require('module');

const utilsPath = require.resolve('../lib/utils');

function loadUtilsWithVerificationConfig(port, recordByDefault = false) {
  clearRequire(utilsPath);
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'config') {
      return {
        has(key) {
          return key === 'verification';
        },
        get(key) {
          if (key === 'verification') {
            return {
              endpoint: `http://127.0.0.1:${port}/verify`,
              recordByDefault
            };
          }
          throw new Error(`unexpected config key: ${key}`);
        }
      };
    }
    if (request === 'rtpengine-client') {
      return {Client: function Client() {}};
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    return require('../lib/utils');
  } finally {
    Module._load = originalLoad;
  }
}

function createVerifier(resolver) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const number = url.searchParams.get('number') || '';
    const payload = resolver(number, url.searchParams);
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify(payload));
  });
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });
}

function makeOpts() {
  return {
    caller: {
      number: '+19844808584',
      aor: 'sip:+19844808584@carrier.example'
    },
    callee: {
      number: '101',
      aor: 'sip:101@pbx.example'
    },
    logger: {
      info: () => {},
      warn: () => {},
      debug: () => {}
    },
    res: {
      status: null,
      send(code) {
        this.status = code;
        return Promise.resolve();
      }
    }
  };
}

test('verifyInvite allows recording when caller is enabled even if callee is not assigned', async(t) => {
  const server = createVerifier((number) => {
    if (number === '101') return {enabled: false, reason: 'number not assigned'};
    if (number === '+19844808584') return {enabled: true, reason: 'enabled'};
    return {enabled: false, reason: 'unexpected'};
  });
  const port = await listen(server);
  const utils = loadUtilsWithVerificationConfig(port, false);
  const opts = makeOpts();

  try {
    const result = await utils.verifyInvite(opts);
    t.equal(result, opts, 'invite proceeds when either side is enabled');
    t.equal(opts.res.status, null, 'no rejection response sent');
  } catch (err) {
    t.fail(`verifyInvite should not reject: ${err.message}`);
  } finally {
    await close(server);
  }

  t.end();
});

test('verifyInvite denies recording when neither caller nor callee is enabled', async(t) => {
  const server = createVerifier((number) => ({enabled: false, reason: `${number} not assigned`}));
  const port = await listen(server);
  const utils = loadUtilsWithVerificationConfig(port, false);
  const opts = makeOpts();

  try {
    await utils.verifyInvite(opts);
    t.fail('verifyInvite should reject when no side is enabled');
  } catch (err) {
    t.equal(opts.res.status, 403, 'rejection response sent');
    t.ok(err._handled, 'error marked as handled');
    t.ok(/verification denied/.test(err.message), 'error indicates explicit denial');
  } finally {
    await close(server);
  }

  t.end();
});
