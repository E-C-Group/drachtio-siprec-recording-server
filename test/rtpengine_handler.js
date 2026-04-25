const test = require('tape').test;
const handler = require('../lib/rtpengine-call-handler');

// Unit tests for the rtpengine call-handler plumbing. These verify that the
// two SIPREC legs are allocated as INDEPENDENT rtpengine OP_OFFERs with
// distinct from-tags and per-leg slot assignment. The prior offer/answer
// pattern caused rtpengine to cross-update media remote endpoints between
// legs and port-latch caller audio onto the callee slot (and vice versa),
// swapping channel 0 / channel 1 in the mixed recording.

function makeRtpEngineMock() {
  const calls = [];
  return {
    calls,
    remote: {host: 'rtpengine.test', port: 22222},
    offer(remote, args) {
      calls.push({op: 'offer', args});
      return Promise.resolve({result: 'ok', sdp: `answered-${args['from-tag']}`});
    },
    answer(remote, args) {
      calls.push({op: 'answer', args});
      return Promise.resolve({result: 'ok', sdp: `answered-${args['from-tag']}`});
    },
    delete(remote, args) {
      calls.push({op: 'delete', args});
      return Promise.resolve({result: 'ok'});
    },
  };
}

function makeBaseOpts() {
  return {
    logger: {info: () => {}, error: () => {}, debug: () => {}},
    callDetails: {
      'call-id': 'BW2036201502404261443134105@216.128.192.36',
      'from-tag': '407462998-1777077380150-',
    },
    sdp1: 'v=0\r\nm=audio 13506 RTP/AVP 0\r\na=label:1\r\na=sendonly\r\n',
    sdp2: 'v=0\r\nm=audio 13508 RTP/AVP 0\r\na=label:2\r\na=sendonly\r\n',
    originalCallId: 'callhalf-6005903:0',
    recordingSessionId: 'urn:uuid:aa9eb433-1fb9-43d2-831e-63e8544bd589',
    caller: {aor: 'sip:+12292390959@216.128.192.36', name: 'Matthew Keathley'},
    callee: {aor: 'sip:19844807703@216.128.192.36'},
    mediaStreams: [
      {index: 0, label: '1', role: 'caller', aor: 'sip:+12292390959@216.128.192.36', mode: 'separate'},
      {index: 1, label: '2', role: 'callee', aor: 'sip:19844807703@216.128.192.36', mode: 'separate'},
    ],
  };
}

test('allocateEndpoint issues two OP_OFFERs with distinct from-tags and per-leg slots', (t) => {
  const rtp = makeRtpEngineMock();
  const opts = makeBaseOpts();

  handler.allocateEndpoint('caller', rtp, opts)
    .then((o) => handler.allocateEndpoint('callee', rtp, o))
    .then((o) => {
      t.equal(rtp.calls.length, 2, 'exactly two rtpengine NG commands issued');
      t.equal(rtp.calls[0].op, 'offer', 'caller leg is OP_OFFER');
      t.equal(rtp.calls[1].op, 'offer', 'callee leg is also OP_OFFER (NOT OP_ANSWER)');

      const callerArgs = rtp.calls[0].args;
      const calleeArgs = rtp.calls[1].args;

      t.equal(callerArgs['from-tag'], '407462998-1777077380150-',
        'caller leg keeps the SBC from-tag');
      t.equal(calleeArgs['from-tag'], handler.calleeFromTag('407462998-1777077380150-'),
        'callee leg uses the synthetic -callee from-tag');
      t.notEqual(callerArgs['from-tag'], calleeArgs['from-tag'],
        'the two legs MUST use different from-tags to prevent cross media updates');

      t.equal(callerArgs['recording-media-slot-offer'], 1,
        'caller leg gets slot 1 on the offer side');
      t.equal(calleeArgs['recording-media-slot-offer'], 2,
        'callee leg gets slot 2 on the offer side');
      t.equal(callerArgs['recording-media-slot-answer'], 1,
        'caller leg also sets slot-answer=1 so receiver_media never collapses to slot=0/SLOTS=1');
      t.equal(calleeArgs['recording-media-slot-answer'], 2,
        'callee leg also sets slot-answer=2 to keep MEDIA-REC-SLOTS=2 in the metafile');
      t.notOk('to-tag' in calleeArgs,
        'callee leg is a plain OP_OFFER, not an OP_ANSWER needing a to-tag');

      t.ok(/call_leg:caller/.test(callerArgs.metadata), 'caller metadata includes call_leg:caller');
      t.ok(/call_leg:callee/.test(calleeArgs.metadata), 'callee metadata includes call_leg:callee');
      t.ok(/channel_0_leg:caller/.test(callerArgs.metadata),
        'metadata maps channel 0 to caller');
      t.ok(/channel_1_leg:callee/.test(callerArgs.metadata),
        'metadata maps channel 1 to callee');

      t.end();
      return o;
    })
    .catch((err) => t.error(err));
});

test('calleeFromTag is deterministic', (t) => {
  t.equal(handler.calleeFromTag('abc'), 'abc-callee');
  t.equal(handler.calleeFromTag('abc'), handler.calleeFromTag('abc'),
    'deterministic so re-INVITE and DELETE use the same synthetic tag');
  t.end();
});
