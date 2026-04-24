const parseSiprecPayload = require('./payload-parser');
const constructSiprecPayload = require('./payload-combiner');
const {getAvailableRtpengine, verifyInvite} = require('./utils');
const { v4 } = require('uuid');
const debug = require('debug')('drachtio:siprec-recording-server');

module.exports = (req, res) => {
  const callid = req.get('Call-ID');
  const from = req.getParsedHeader('From');
  const totag = v4();
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
    .then(allocateEndpoint.bind(null, 'caller', rtpEngine, totag))
    .then(allocateEndpoint.bind(null, 'callee', rtpEngine, totag))
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

      dlg.on('modify', _onReinvite.bind(null, rtpEngine, logger, totag));
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

function _onReinvite(rtpEngine, logger, totag, req, res) {
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
    .then(allocateEndpoint.bind(null, 'caller', rtpEngine, totag))
    .then(allocateEndpoint.bind(null, 'callee', rtpEngine, totag))
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

function allocateEndpoint(which, rtpEngine, totag, opts) {
  // If audio is inactive, rtpengine will stop recording and there is no blank audio in record file.
  const sdp = (which === 'caller' ? opts.sdp1 : opts.sdp2).replace(/a=inactive\r\n/g, 'a=sendonly\r\n');

  const slots = resolveRecordingSlots(opts);
  // Tell rtpengine which mixer input each party should occupy.
  //
  // IMPORTANT: both slot flags must be sent on BOTH ng commands (not just the
  // one matching the current leg). rtpengine emits the metadata STREAM lines
  // during OP_OFFER via setup_stream_proc using whatever media->media_rec_slot
  // values exist at that moment. If the offer only carries the offer slot,
  // receiver_media->media_rec_slot stays at 0, the metadata gets written with
  // a defaulted slot, and the recording daemon collapses both legs onto
  // channel 0. Applying the answer slot later (during OP_ANSWER) is too late
  // because the metadata has already been flushed. Passing both slots on both
  // commands lets rtpengine set sender_media and receiver_media slots up
  // front, producing correct metadata on the first (and only) write.
  //
  // The total slot count is derived from the number of audio streams parsed
  // out of the SIPREC SDP rather than hardcoded.
  const slotFlags = {
    'recording-media-slots': slots.total,
    'recording-media-slot-offer': slots.caller,
    'recording-media-slot-answer': slots.callee,
  };

  const args = Object.assign({}, opts.callDetails, {
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
  if (which === 'callee') Object.assign(args, {'to-tag': totag});

  opts.logger.info({leg: which, slots, slotFlags},
    'assigned rtpengine recording-media slots from parsed SIPREC SDP');

  debug(`callDetails: ${JSON.stringify(opts.callDetails)}`);
  debug(`rtpengine args for ${which}: ${JSON.stringify(args)}, sending to ${JSON.stringify(rtpEngine.remote)}`);
  return rtpEngine[which === 'caller' ? 'offer' : 'answer'](rtpEngine.remote, args)
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
  opts.logger.info(`call ended - sending delete to rtpengine for call-id: ${opts.callDetails['call-id']}`);
  return rtpEngine.delete(rtpEngine.remote, opts.callDetails)
    .then((response) => {
      const elapsed = Date.now() - startTime;
      opts.logger.info(`rtpengine delete completed in ${elapsed}ms, response: ${JSON.stringify(response)}`);
      return debug(`response to rtpengine delete: ${JSON.stringify(response)}`);
    })
    .catch((err) => {
      opts.logger.error(`rtpengine delete failed: ${err}`);
    });
}
