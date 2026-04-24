const test = require('tape').test ;
const parsePayload = require('./../lib/payload-parser') ;
const combinePayloads = require('./../lib/payload-combiner') ;
const fs = require('fs-extra') ;

function combineAndVerifyPayloads(filename, delimiter, t) {
  fs.readFile(`${__dirname}/data/${filename}`, 'utf8')
    .then((data) => {
      const sdp = data.split('__split_here__');
      t.ok(sdp.length === 2, 'read two sdps');
      const full = combinePayloads(sdp[0], sdp[1], sdp[0], sdp[1]);
      t.ok(full, 'combined payloads');
      t.end();
      return;
    })
    .catch((err) => {
      console.error(err.stack);
      t.error(err);
    });
}

function parseAndVerifyPayload(filename, delimiter, t) {
  fs.readFile(`${__dirname}/data/${filename}`, 'utf8')
    .then((data) => {
      const segments = data.split(`\n${delimiter}`) ;
      const regex = /.*Content-Type:\s+(.*)\n.*\n([\s\S.]*)$/;
      const req = {payload: []} ;

      for (let i = 1; i < segments.length; i++) {
        const arr = regex.exec(segments[i]) ;
        if (!arr) {
          continue;
        }
        req.payload.push({type: arr[1], content: arr[2]}) ;
      }
      return parsePayload({req}) ;
    })
    .then((obj) => {
      t.ok(obj.sdp1, 'parsed first SDP');
      t.ok(obj.sdp2, 'parsed second SDP');
      t.ok(obj.caller.aor, 'parsed caller aor');
      t.ok(obj.sessionId, `parsed session id ${obj.sessionId}`);
      t.ok(obj.recordingSessionId, `parsed recording session id: ${obj.recordingSessionId}`);
      t.end();
      return;
    })
    .catch((err) => {
      console.error(err.stack);
      t.error(err);
    });
}

function parsePayloadFromFile(filename, delimiter) {
  return fs.readFile(`${__dirname}/data/${filename}`, 'utf8')
    .then((data) => {
      const segments = data.split(`\n${delimiter}`) ;
      const regex = /.*Content-Type:\s+(.*)\n.*\n([\s\S.]*)$/;
      const req = {payload: []} ;

      for (let i = 1; i < segments.length; i++) {
        const arr = regex.exec(segments[i]) ;
        if (!arr) {
          continue;
        }
        req.payload.push({type: arr[1], content: arr[2]}) ;
      }
      return parsePayload({req}) ;
    });
}

test('parser: Broadworks SIPREC payload', (t) => {
  parseAndVerifyPayload('broadworks-offer-2.txt', '--foobar', t) ;
}) ;
test('parser: BroadWorks recording_metadata SIPREC payload', (t) => {
  parsePayloadFromFile('broadworks-recording-metadata-offer.txt', '--UniqueBroadWorksBoundary')
    .then((obj) => {
      t.ok(obj.sdp1, 'parsed first SDP');
      t.ok(obj.sdp2, 'parsed second SDP');
      t.equal(obj.originalCallId, 'callhalf-95876388553:0', 'parsed BroadWorks call id');
      t.equal(obj.caller.aor, 'sip:+15550001001@192.0.2.10', 'parsed BroadWorks caller aor');
      t.equal(obj.caller.number, '+15550001001', 'parsed BroadWorks caller number');
      t.equal(obj.callee.aor, 'sip:15550001002@192.0.2.10', 'parsed BroadWorks callee aor');
      t.equal(obj.callee.number, '15550001002', 'parsed BroadWorks callee number');
      t.equal(obj.recordingSessionId, 'urn:uuid:7ee4c89f-31d9-41e1-b6f1-8018b79b03d7', 'parsed recording session id');
      t.end();
      return;
    })
    .catch((err) => {
      console.error(err.stack);
      t.error(err);
    });
}) ;
test('parser: BroadWorks termCall recording_metadata SIPREC payload', (t) => {
  parsePayloadFromFile('broadworks-termcall-recording-metadata-offer.txt', '--UniqueBroadWorksBoundary')
    .then((obj) => {
      t.ok(obj.sdp1, 'parsed first SDP');
      t.ok(obj.sdp2, 'parsed second SDP');
      t.equal(obj.originalCallId, 'callhalf-5551587:0', 'parsed BroadWorks termCall call id');
      t.equal(obj.caller.aor, 'sip:+15550001002@192.0.2.10', 'parsed BroadWorks termCall caller aor');
      t.equal(obj.caller.number, '+15550001002', 'parsed BroadWorks termCall caller number');
      t.equal(obj.callee.aor, 'sip:+15550001001@192.0.2.10', 'parsed BroadWorks termCall callee aor');
      t.equal(obj.callee.number, '+15550001001', 'parsed BroadWorks termCall callee number');
      t.equal(
        obj.recordingSessionId,
        'urn:uuid:51da7beb-27f4-4296-b23f-c9bc02669127',
        'parsed termCall recording session id'
      );
      t.equal(obj.mediaStreams.length, 2, 'parsed ordered SIPREC media streams');
      t.equal(obj.mediaStreams[0].label, '1', 'preserved first SDP media label');
      t.equal(obj.mediaStreams[0].role, 'callee', 'mapped SDP label 1 to called party role');
      t.equal(obj.mediaStreams[1].label, '2', 'preserved second SDP media label');
      t.equal(obj.mediaStreams[1].role, 'caller', 'mapped SDP label 2 to calling party role');
      t.end();
      return;
    })
    .catch((err) => {
      console.error(err.stack);
      t.error(err);
    });
}) ;
test('parser: BroadWorks lineport peer inference', (t) => {
  parsePayloadFromFile('broadworks-lineport-recording-metadata-offer.txt', '--UniqueBroadWorksBoundary')
    .then((obj) => {
      // Participant 2 (+12295556666) matches BW calledPartyNumber via the
      // number path. Participant 1 (sip:fred@vwave.net) is a lineport AOR
      // that cannot be matched against either BW value or the BW userID.
      // The peer-inference pass should still assign role=caller to label 1
      // by elimination, which is what drives the per-leg rtpengine slot.
      t.equal(obj.mediaStreams.length, 2, 'parsed ordered SIPREC media streams');
      t.equal(obj.mediaStreams[0].label, '1', 'preserved first SDP media label');
      t.equal(obj.mediaStreams[0].role, 'caller', 'label 1 (fred lineport) inferred as caller');
      t.equal(obj.mediaStreams[1].label, '2', 'preserved second SDP media label');
      t.equal(obj.mediaStreams[1].role, 'callee', 'label 2 (+12295556666) resolved as callee by number match');
      t.end();
      return;
    })
    .catch((err) => {
      console.error(err.stack);
      t.error(err);
    });
}) ;
test('parser: Promcomm SIPREC payload', (t) => {
  parseAndVerifyPayload('procomm-siprec-offer.txt', '--2CD2A2E9', t) ;
}) ;
test('parser: Sonus SIPREC payload', (t) => {
  parseAndVerifyPayload('sonus-siprec-offer.txt', '--sonus-content-delim', t) ;
}) ;
test('parser: Cisco SIPREC payload', (t) => {
  parseAndVerifyPayload('cisco-siprec-offer.txt', '--uniqueBoundary', t) ;
}) ;
test('parser: AcmePacket SIPREC payload (quoted name)', (t) => {
  fs.readFile(`${__dirname}/data/acme-siprec-offer-quoted-name.txt`, 'utf8')
    .then((data) => {
      const segments = data.split('\n--unique-boundary-1') ;
      const regex = /.*Content-Type:\s+(.*)\n.*\n([\s\S.]*)$/;
      const req = {payload: []} ;

      for (let i = 1; i < segments.length; i++) {
        const arr = regex.exec(segments[i]) ;
        if (!arr) continue;
        req.payload.push({type: arr[1], content: arr[2]}) ;
      }
      return parsePayload({req}) ;
    })
    .then((obj) => {
      t.ok(obj.sdp1, 'parsed first SDP');
      t.ok(obj.sdp2, 'parsed second SDP');
      t.equal(obj.caller.aor, 'sip:22938884455@216.128.192.36', 'parsed caller aor');
      t.equal(obj.caller.name, 'ECG Tester', 'normalized quoted caller name');
      t.equal(obj.callee.aor, 'sip:+12298558585@216.128.192.137', 'parsed callee aor');
      t.equal(obj.recordingSessionId, 'To5Z71XZTYhiHWrFDgu7XQ==', 'parsed recording session id');
      t.end();
      return;
    })
    .catch((err) => {
      console.error(err.stack);
      t.error(err);
    });
}) ;
test('parser: Connectel SIPREC payload', (t) => {
  parseAndVerifyPayload('connectel-offer.txt', '--OSS-unique-boundary-42', t) ;
}) ;
test('parser: Connectel SIPREC payload (2)', (t) => {
  parseAndVerifyPayload('connectel-offer2.txt', '--OSS-unique-boundary-42', t) ;
}) ;
test('parser: Connectel SIPREC payload (3)', (t) => {
  parseAndVerifyPayload('connectel-offer3.txt', '--OSS-unique-boundary-42', t) ;
}) ;
test('parser: inactive sdp', (t) => {
  parseAndVerifyPayload('inactive-sdp-offer.txt', '--uniqueBoundary', t) ;
}) ;
test('combiner: sample1)', (t) => {
  combineAndVerifyPayloads('sample-sdps.txt', '__split_here__', t) ;
}) ;
test('combiner: sample2)', (t) => {
  combineAndVerifyPayloads('sample-sdp2.txt', '__split_here__', t) ;
}) ;
test('combiner: sample3)', (t) => {
  combineAndVerifyPayloads('sample-sdp3.txt', '__split_here__', t) ;
}) ;
