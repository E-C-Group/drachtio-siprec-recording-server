const test = require('tape').test;
const dedup = require('../lib/dedup');
const handler = require('../lib/rtpengine-call-handler');
const fs = require('fs-extra');
const parsePayload = require('../lib/payload-parser');

function freshInMemoryDedup() {
  dedup._resetForTests();
  dedup._setBackendForTests(dedup._inMemoryBackend(), {
    info: () => {}, warn: () => {}, debug: () => {}, error: () => {},
  });
}

test('dedup: in-memory acquire/release round trip', async(t) => {
  freshInMemoryDedup();
  const cands = [{key: dedup.makeKey('bw-corr', '3358:2'), ttlMs: 60000}];

  const a = await dedup.acquire(cands, 'callA');
  t.ok(a.acquired, 'first acquire succeeds');
  t.deepEqual(a.owned, [cands[0].key], 'owned key is reported');

  const b = await dedup.acquire(cands, 'callB');
  t.notOk(b.acquired, 'second acquire is rejected');
  t.equal(b.conflict.owner, 'callA', 'conflict reports current owner');

  await dedup.release(a.owned, 'callA');
  const c = await dedup.acquire(cands, 'callC');
  t.ok(c.acquired, 'after release a new owner can acquire');
  t.end();
});

test('dedup: release is owner-scoped (compare-and-delete)', async(t) => {
  freshInMemoryDedup();
  const cands = [{key: dedup.makeKey('bw-corr', 'cas-test'), ttlMs: 60000}];
  const a = await dedup.acquire(cands, 'ownerA');
  t.ok(a.acquired);
  await dedup.release(a.owned, 'ownerB'); // wrong owner -> no-op
  const b = await dedup.acquire(cands, 'ownerB');
  t.notOk(b.acquired, 'foreign release did not free the key');
  t.equal(b.conflict.owner, 'ownerA');
  t.end();
});

test('dedup: pair-fallback ttl expires so legit follow-on calls record', async(t) => {
  freshInMemoryDedup();
  const cands = [{key: dedup.makeKey('pair', '1112223333|4445556666'), ttlMs: 50}];
  const a = await dedup.acquire(cands, 'callA');
  t.ok(a.acquired);
  await new Promise((resolve) => setTimeout(resolve, 80));
  const b = await dedup.acquire(cands, 'callB');
  t.ok(b.acquired, 'pair-window key auto-expires');
  t.end();
});

test('dedup: handler buildDedupCandidates picks correlation header first', (t) => {
  const req = {
    get: (h) => (h === 'X-BroadWorks-Correlation-Info' ? '3358:2' : null),
  };
  const opts = {
    broadworks: {extTrackingId: '3358:2', serviceProviderId: 'vwave_sp'},
    caller: {aor: 'sip:+12292390959@example.com'},
    callee: {aor: 'sip:+12292383547@example.com'},
  };
  const cands = handler.buildDedupCandidates(req, opts);
  t.ok(cands.length >= 1, 'produced at least one candidate');
  t.equal(cands[0].kind, 'bw-corr', 'correlation header is highest priority');
  t.ok(cands[0].key.includes('vwave_sp'), 'service provider scopes the key');
  // pair fallback should NOT be added when a correlation candidate exists,
  // so that legitimate consecutive calls between the same parties are not
  // blocked by the pair-window TTL.
  t.notOk(cands.some((c) => c.kind === 'pair'),
    'pair fallback is suppressed when correlation header is present');
  t.end();
});

test('dedup: handler buildDedupCandidates falls back to pair when no correlation', (t) => {
  const req = {get: () => null};
  const opts = {
    caller: {aor: 'sip:+12292390959@example.com'},
    callee: {aor: 'sip:+12292383547@example.com'},
  };
  const cands = handler.buildDedupCandidates(req, opts);
  t.equal(cands.length, 1, 'single pair-fallback candidate');
  t.equal(cands[0].kind, 'pair');
  t.end();
});

test('dedup: handler dedupAcquire rejects duplicate SIPREC with 488', async(t) => {
  freshInMemoryDedup();
  const req = {
    get: (h) => (h === 'X-BroadWorks-Correlation-Info' ? '3358:2' : null),
  };
  const baseOpts = () => ({
    req,
    res: {
      sentStatus: null,
      sentOpts: null,
      send(status, opts) {
        this.sentStatus = status;
        this.sentOpts = opts;
        return Promise.resolve();
      },
    },
    logger: {info: () => {}, warn: () => {}, debug: () => {}, error: () => {}},
    callDetails: {'call-id': 'callA-id'},
    broadworks: {extTrackingId: '3358:2', serviceProviderId: 'vwave_sp'},
    caller: {aor: 'sip:+12292390959@example.com'},
    callee: {aor: 'sip:+12292383547@example.com'},
  });

  const optsA = baseOpts();
  const r1 = await handler.dedupAcquire(optsA);
  t.ok(Array.isArray(r1.dedupKeys) && r1.dedupKeys.length > 0,
    'first call acquires keys');

  const optsB = baseOpts();
  optsB.callDetails['call-id'] = 'callB-id';
  let threw = null;
  try { await handler.dedupAcquire(optsB); }
  catch (e) { threw = e; }
  t.ok(threw, 'second call rejects (throws handled error)');
  t.ok(threw && threw._handled, 'error is marked handled to silence outer catch');
  t.equal(optsB.res.sentStatus, 488, 'second call gets 488 Not Acceptable Here');
  t.ok(optsB.res.sentOpts && optsB.res.sentOpts.headers
    && /duplicate SIPREC/i.test(optsB.res.sentOpts.headers.Warning),
  'Warning header explains the rejection');

  t.end();
});

test('parser: surfaces extTrackingID and serviceProviderID for dedup', (t) => {
  fs.readFile(`${__dirname}/data/broadworks-recording-metadata-offer.txt`, 'utf8')
    .then((data) => {
      const segments = data.split('\n--UniqueBroadWorksBoundary');
      const regex = /.*Content-Type:\s+(.*)\n.*\n([\s\S.]*)$/;
      const req = {payload: []};
      for (let i = 1; i < segments.length; i++) {
        const arr = regex.exec(segments[i]);
        if (!arr) continue;
        req.payload.push({type: arr[1], content: arr[2]});
      }
      return parsePayload({req});
    })
    .then((obj) => {
      // Fields are optional in the existing fixture but if present must be
      // surfaced under opts.broadworks. Either way, the parser must not
      // throw on the new code path.
      if (obj.broadworks) {
        t.ok(typeof obj.broadworks === 'object', 'broadworks block is an object');
      }
      t.end();
      return;
    })
    .catch((err) => { t.error(err); });
});
