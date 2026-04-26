const parseSiprecPayload = require('./payload-parser');
const constructSiprecPayload = require('./payload-combiner');
const {getAvailableRtpengine, verifyInvite} = require('./utils');
const dedup = require('./dedup');
const debug = require('debug')('drachtio:siprec-recording-server');

// TTL on correlation-based dedup keys. Must comfortably exceed any expected
// call duration; on call end we compare-and-delete so the key is normally
// freed promptly. The TTL only matters as a safety net for crashes.
const DEDUP_LONG_TTL_MS = parseInt(process.env.SIPREC_DEDUP_LONG_TTL_MS || (6 * 60 * 60 * 1000), 10);
// TTL on the (caller,callee)-pair fallback key. Only used when no correlation
// header is available. Must be long enough to cover the gap between BroadWorks
// emitting the two SIPREC sessions (~hundreds of ms in practice) but short
// enough to not block legitimate consecutive calls between the same parties.
const DEDUP_PAIR_WINDOW_MS = parseInt(process.env.SIPREC_DEDUP_PAIR_WINDOW_MS || 5000, 10);

function getPartyNumber(aor) {
  if (!aor) return '';
  const m = /sip:\+?([^@;>]+)/i.exec(String(aor));
  if (m && m[1]) return m[1].replace(/\D/g, '');
  return '';
}

function buildDedupCandidates(req, opts) {
  const candidates = [];
  const seen = new Set();
  const push = (kind, value, ttlMs) => {
    if (!value) return;
    const key = dedup.makeKey(kind, value);
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({key, ttlMs, kind, raw: value});
  };

  // 1. SIP X-BroadWorks-Correlation-Info header. Best identifier when present.
  const correlation = req && typeof req.get === 'function' ? req.get('X-BroadWorks-Correlation-Info') : null;
  const sp = (opts.broadworks && opts.broadworks.serviceProviderId) || '';
  if (correlation) {
    const scoped = sp ? `${sp}|${correlation}` : correlation;
    push('bw-corr', scoped, DEDUP_LONG_TTL_MS);
  }

  // 2. extTrackingID from BroadWorks recording metadata (covers cases where
  //    the SIP header is stripped by an upstream SBC).
  const ext = opts.broadworks && opts.broadworks.extTrackingId;
  if (ext) {
    const scoped = sp ? `${sp}|${ext}` : ext;
    push('bw-ext', scoped, DEDUP_LONG_TTL_MS);
  }

  // 3. Fallback: (caller, callee) number pair within a short window. Only used
  //    when neither correlation header was present. The TTL is intentionally
  //    short so back-to-back legitimate calls between the same parties still
  //    record normally.
  if (candidates.length === 0) {
    const callerNum = getPartyNumber(opts.caller && opts.caller.aor);
    const calleeNum = getPartyNumber(opts.callee && opts.callee.aor);
    if (callerNum && calleeNum) {
      const pair = [callerNum, calleeNum].sort().join('|');
      push('pair', pair, DEDUP_PAIR_WINDOW_MS);
    }
  }

  return candidates;
}

async function dedupAcquire(opts) {
  const callId = opts.callDetails && opts.callDetails['call-id'];
  const candidates = buildDedupCandidates(opts.req, opts);
  if (candidates.length === 0) {
    opts.logger.debug('siprec dedup: no identity candidates derivable; skipping');
    return opts;
  }

  const result = await dedup.acquire(candidates, callId);
  if (!result.acquired) {
    opts.logger.warn({
      conflictKey: result.conflict && result.conflict.key,
      conflictOwner: result.conflict && result.conflict.owner,
      candidates: candidates.map((c) => ({kind: c.kind, key: c.key})),
      callId,
    }, 'rejecting duplicate SIPREC session (already in progress for same logical call)');
    try {
      await opts.res.send(488, {
        headers: {
          'Warning': '399 wingman "duplicate SIPREC session"',
        },
      });
    } catch (e) { /* best-effort */ }
    const err = new Error('duplicate SIPREC session');
    err._handled = true;
    throw err;
  }

  opts.dedupKeys = result.owned;
  opts.logger.debug({owned: result.owned}, 'siprec dedup keys acquired');
  return opts;
}

// Build a deterministic synthetic from-tag for the callee leg so the caller
// and callee are tracked as two independent rtpengine dialogs sharing one
// call-id (and therefore one recording metafile). Using two separate
// OP_OFFERs avoids the bug where issuing OP_ANSWER for the second SIPREC
// stream would update the first leg's media remote endpoint to the second
// leg's port (port-latching then crossed the recorded slots, swapping
// caller/callee audio channels).
function calleeFromTag(callerFromTag) {
  return `${callerFromTag}-callee`;
}

module.exports = (req, res) => {
  const callid = req.get('Call-ID');
  const from = req.getParsedHeader('From');
  const logger = req.srf.locals.logger.child({callid});
  const opts = {
    req,
    res,
    logger,
    callDetails: {
      'call-id': callid,
      'from-tag': from.params.tag
    }
  };

  logger.info(`received SIPREC invite: ${req.uri}`);
  const rtpEngine = getAvailableRtpengine();

  parseSiprecPayload(opts)
    .then(verifyInvite)
    .then(dedupAcquire)
    .then(allocateEndpoint.bind(null, 'caller', rtpEngine))
    .then(allocateEndpoint.bind(null, 'callee', rtpEngine))
    .then(respondToInvite)
    .then((dlg) => {
      logger.info(`call connected successfully, using rtpengine at ${JSON.stringify(rtpEngine.remote)}`);

      // Attempt to enable PCM forwarding at the NG layer
      try {
        if (typeof rtpEngine.startForwarding === 'function') {
          rtpEngine.startForwarding(rtpEngine.remote, {
            'call-id': opts.callDetails['call-id'],
            all: 'all'
          }).catch((e) => logger.warn({e}, 'startForwarding failed (non-fatal)'));
        }
      } catch (e) {
        logger.debug({e}, 'rtpengine client has no startForwarding method');
      }

      dlg.on('modify', _onReinvite.bind(null, rtpEngine, logger));
      return dlg.on('destroy', onCallEnd.bind(null, rtpEngine, opts));
    })
    .catch((err) => {
      if (err && err._handled) return;
      logger.error(`Error connecting call: ${err}`);
    });
};

function buildMetadata(opts, leg) {
  const kv = [];
  if (opts.originalCallId) kv.push(`orig_call_id:${opts.originalCallId}`);
  if (opts.originalCallId) kv.push(`call_id:${opts.originalCallId}`);
  if (opts.recordingSessionId) kv.push(`session:${opts.recordingSessionId}`);
  const mediaStreams = Array.isArray(opts.mediaStreams) ? opts.mediaStreams : [];
  const layout = mediaStreams
    .map((stream) => (stream && stream.role ? String(stream.role).trim() : ''))
    .filter((value) => value.length > 0);
  if (layout.length === mediaStreams.length && layout.length > 0) {
    kv.push(`channel_layout:${layout.join(',')}`);
  }
  mediaStreams.forEach((stream, index) => {
    if (!stream || typeof stream !== 'object') return;
    if (stream.role) kv.push(`channel_${index}_leg:${stream.role}`);
    if (stream.label) kv.push(`channel_${index}_label:${stream.label}`);
    if (stream.mode) kv.push(`channel_${index}_mode:${stream.mode}`);
  });
  if (opts.caller && opts.caller.aor) kv.push(`caller:${opts.caller.aor}`);
  if (opts.caller && opts.caller.name) kv.push(`caller_name:${opts.caller.name}`);
  if (opts.callee && opts.callee.aor) kv.push(`callee:${opts.callee.aor}`);
  if (opts.callee && opts.callee.name) kv.push(`callee_name:${opts.callee.name}`);
  // Add call_leg to identify which participant this stream belongs to
  if (leg) kv.push(`call_leg:${leg}`);
  return kv.join('|');
}

function _onReinvite(rtpEngine, logger, req, res) {
  const callid = req.get('Call-ID');
  const from = req.getParsedHeader('From');
  const opts = {
    req,
    res,
    logger,
    callDetails: {
      'call-id': callid,
      'from-tag': from.params.tag,
    }
  };

  parseSiprecPayload(opts)
    .then(allocateEndpoint.bind(null, 'caller', rtpEngine))
    .then(allocateEndpoint.bind(null, 'callee', rtpEngine))
    .then((opts) => {
      const body = constructSiprecPayload(opts.rtpengineCallerSdp, opts.rtpengineCalleeSdp, opts.sdp1, opts.sdp2);
      return opts.res.send(200, {body});
    })
    .catch((err) => {
      logger.error(`Error connecting call: ${err}`);
    });

  logger.info(`received SIPREC Re-invite: ${req.uri}`);
}

function resolveRecordingSlots(opts) {
  const streams = Array.isArray(opts.mediaStreams) ? opts.mediaStreams.filter((s) => s) : [];
  const total = streams.length > 0 ? streams.length : 1;

  const slotForLeg = (leg) => {
    const byRole = streams.findIndex((s) => s && s.role === leg);
    if (byRole >= 0) return byRole + 1;
    // Fall back to conventional ordering when participant roles weren't resolved
    // from the SIPREC metadata: caller is the first stream, callee is the second.
    if (leg === 'caller') return 1;
    if (leg === 'callee') return streams.length >= 2 ? 2 : 1;
    return 1;
  };

  return {
    total,
    caller: slotForLeg('caller'),
    callee: slotForLeg('callee'),
  };
}

function allocateEndpoint(which, rtpEngine, opts) {
  // If audio is inactive, rtpengine will stop recording and there is no blank audio in record file.
  const sdp = (which === 'caller' ? opts.sdp1 : opts.sdp2).replace(/a=inactive\r\n/g, 'a=sendonly\r\n');

  const slots = resolveRecordingSlots(opts);
  const slotForLeg = which === 'caller' ? slots.caller : slots.callee;

  // Each SIPREC leg is sent as its own OP_OFFER under a distinct from-tag
  // (the callee leg uses a synthetic `${from-tag}-callee` value) so the two
  // legs become independent rtpengine dialogs that share the call-id (and
  // therefore the recording metafile) but cannot influence each other's
  // media endpoints. Previously the callee leg was issued as OP_ANSWER on
  // the same dialog, which caused rtpengine to update the caller leg's
  // media remote endpoint to the callee leg's advertised port. After port
  // latching, the SBC's caller-stream packets were associated with the
  // callee slot and vice versa, swapping channel 0 / channel 1 in the
  // mixed recording. Two OP_OFFERs sidestep that cross-update entirely.
  //
  // ``recording-media-slot-offer`` carries the slot for THIS leg (1-indexed).
  // We also set ``recording-media-slot-answer`` to the SAME value so that
  // both ``sender_media`` and ``receiver_media`` on this leg get
  // ``media_rec_slot`` set on rtpengine's side.
  //
  // This matters because rtpengine's ``setup_stream_proc`` emits a
  // ``MEDIA-REC-SLOT N MEDIA-REC-SLOTS M`` line for every packet_stream,
  // including the ``receiver_media`` side that never carries audio in pure
  // SIPREC. If receiver_media's slot is 0, ``recording.c`` falls back to
  // ``MEDIA-REC-SLOTS 1`` for that line. The ``recording-daemon`` then
  // calls ``mix_set_channel_slots(mix, 1)`` which collapses the mixer back
  // to a single input channel - and the next sender stream that registers
  // for slot 0 evicts the first one's ``input_ref``, producing repeated
  // ``received samples for old re-used input channel`` errors and dropping
  // the caller's audio entirely. Setting both flags keeps every
  // ``MEDIA-REC-SLOTS`` line at the correct total.
  //
  // The total slot count is derived from the number of audio streams
  // parsed out of the SIPREC SDP rather than hardcoded.
  const slotFlags = {
    'recording-media-slots': slots.total,
    'recording-media-slot-offer': slotForLeg,
    'recording-media-slot-answer': slotForLeg,
  };

  const fromTag = which === 'caller'
    ? opts.callDetails['from-tag']
    : calleeFromTag(opts.callDetails['from-tag']);

  const args = Object.assign({}, opts.callDetails, {
    'from-tag': fromTag,
    sdp,
    'replace': ['origin', 'session-connection'],
    'transport protocol': 'RTP/AVP',
    'record call': 'yes',
    'DTLS': 'off',
    'ICE': 'remove',
    'SDES': 'off',
    'flags': ['media handover', 'port latching'],
    'rtcp-mux': ['accept'],
    'direction':  ['public', 'public'],
    // Metadata is required for rtpengine-recording to write DB record
    // Pass call_leg to identify caller vs callee streams
    'metadata': buildMetadata(opts, which),
  }, slotFlags);

  opts.logger.info({leg: which, fromTag, slots, slotFlags},
    'assigned rtpengine recording-media slots from parsed SIPREC SDP');

  debug(`callDetails: ${JSON.stringify(opts.callDetails)}`);
  debug(`rtpengine args for ${which}: ${JSON.stringify(args)}, sending to ${JSON.stringify(rtpEngine.remote)}`);
  return rtpEngine.offer(rtpEngine.remote, args)
    .then((response) => {
      if (response.result !== 'ok') {
        throw new Error('error connecting to rtpengine');
      }
      opts[which === 'caller' ? 'rtpengineCallerSdp' : 'rtpengineCalleeSdp'] = response.sdp;
      return opts;
    });
}

function respondToInvite(opts) {
  const srf = opts.req.srf;
  const payload = constructSiprecPayload(opts.rtpengineCallerSdp, opts.rtpengineCalleeSdp, opts.sdp1, opts.sdp2);
  return srf.createUAS(opts.req, opts.res, {localSdp: payload});
}

function onCallEnd(rtpEngine, opts) {
  const startTime = Date.now();
  const callId = opts.callDetails['call-id'];
  const callerFromTag = opts.callDetails['from-tag'];
  opts.logger.info(`call ended - sending delete to rtpengine for call-id: ${callId}`);

  // Release SIPREC dedup keys so a subsequent call with the same correlation
  // identity (e.g. a callback between the same two BroadWorks users) is not
  // blocked. Compare-and-delete inside the backend ensures we only release
  // keys we still own; any stale TTL handles the crash case.
  if (Array.isArray(opts.dedupKeys) && opts.dedupKeys.length > 0) {
    Promise.resolve(dedup.release(opts.dedupKeys, callId))
      .catch((err) => opts.logger.warn({err: err && err.message}, 'siprec dedup release failed'));
  }

  // Delete each leg explicitly. Each was opened as its own OP_OFFER with a
  // distinct from-tag, so a delete keyed only by call-id may leave the
  // synthetic callee-leg dialog around in some rtpengine versions.
  const deleteLeg = (fromTag) => rtpEngine
    .delete(rtpEngine.remote, {'call-id': callId, 'from-tag': fromTag})
    .then((response) => {
      const elapsed = Date.now() - startTime;
      opts.logger.info(
        `rtpengine delete completed in ${elapsed}ms for from-tag=${fromTag}, ` +
        `response: ${JSON.stringify(response)}`);
      debug(`response to rtpengine delete (${fromTag}): ${JSON.stringify(response)}`);
      return response;
    })
    .catch((err) => {
      opts.logger.error(`rtpengine delete failed for from-tag=${fromTag}: ${err}`);
    });

  return Promise.all([
    deleteLeg(callerFromTag),
    deleteLeg(calleeFromTag(callerFromTag)),
  ]);
}

module.exports.calleeFromTag = calleeFromTag;
module.exports.allocateEndpoint = allocateEndpoint;
module.exports.buildDedupCandidates = buildDedupCandidates;
module.exports.dedupAcquire = dedupAcquire;
