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
  if (opts.recordingSessionId) kv.push(`session:${opts.recordingSessionId}`);
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

function allocateEndpoint(which, rtpEngine, totag, opts) {
  // If audio is inactive, rtpengine will stop recording and there is no blank audio in record file.
  const sdp = (which === 'caller' ? opts.sdp1 : opts.sdp2).replace(/a=inactive\r\n/g, 'a=sendonly\r\n');
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
  });
  if (which === 'callee') Object.assign(args, {'to-tag': totag});

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
