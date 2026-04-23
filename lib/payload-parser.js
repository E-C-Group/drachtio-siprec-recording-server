const xmlParser = require('xml2js').parseString;
const { v4 } = require('uuid');
const parseUri = require('drachtio-srf').parseUri;
const transform = require('sdp-transform');
const debug = require('debug')('drachtio:siprec-recording-server');

const normalizeName = (name) => {
  if (typeof name !== 'string') return name;
  let s = name.replace(/(&quot;|&#34;)/g, '"').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  return s;
};

const getNodeKey = (node, ...names) => {
  if (!node || typeof node !== 'object') return undefined;
  const lowerNames = names.map((name) => String(name).toLowerCase());
  const strippedNames = lowerNames.map((name) => (name.includes(':') ? name.split(':').pop() : name));
  return Object.keys(node).find((key) => {
    const lowerKey = String(key).toLowerCase();
    const strippedKey = lowerKey.includes(':') ? lowerKey.split(':').pop() : lowerKey;
    return lowerNames.includes(lowerKey) || strippedNames.includes(lowerKey) || strippedNames.includes(strippedKey);
  });
};

const getNode = (node, ...names) => {
  const key = getNodeKey(node, ...names);
  if (!key || !Array.isArray(node[key]) || node[key].length === 0) return undefined;
  return node[key][0];
};

const getValue = (node) => {
  if (Array.isArray(node)) return getValue(node[0]);
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node;
  if (typeof node === 'object') {
    if (node._ !== undefined) return getValue(node._);
    const id = getNode(node, 'id');
    if (id !== undefined) return getValue(id);
  }
  return undefined;
};

const getNodeValue = (node, ...names) => {
  const value = getNode(node, ...names);
  return getValue(value);
};

const getReference = (node, ...names) => {
  const ref = getNode(node, ...names);
  return getValue(ref);
};

const normalizeAor = (aor) => {
  if (typeof aor !== 'string') return aor;
  const uri = parseUri(aor);
  if (uri && uri.user && uri.host) return `sip:${uri.user}@${uri.host}`;
  return aor;
};

const normalizeLabel = (label) => {
  if (label === undefined || label === null) return undefined;
  const s = String(label).trim();
  return s || undefined;
};

const parsePartyHeader = (hdr) => {
  if (typeof hdr !== 'string') return {};
  const match = /^(.*)(<sip.*)$/.exec(hdr);
  if (!match) return {};
  const ret = {};
  const uriMatch = /<(.*)>/.exec(match[2]);
  if (uriMatch) {
    const uri = parseUri(uriMatch[1]);
    if (uri && uri.host) {
      const user = uri.user || 'anonymous';
      ret.aor = `sip:${user}@${uri.host}`;
    }
  }
  const displayName = match[1].trim();
  const quoted = /"(.*)"/.exec(displayName);
  if (quoted) ret.name = quoted[1];
  else if (displayName) ret.name = displayName;
  return ret;
};

const getPreferredSampleRate = (media) => {
  if (!media || !Array.isArray(media.rtp)) return undefined;
  const audioCodec = media.rtp.find(
    (entry) => entry && entry.codec && String(entry.codec).toLowerCase() !== 'telephone-event'
  );
  if (audioCodec && Number.isFinite(audioCodec.rate)) return Number(audioCodec.rate);
  const first = media.rtp.find((entry) => entry && Number.isFinite(entry.rate));
  return first ? Number(first.rate) : undefined;
};

const parseSdpMedia = (sdp) => {
  try {
    const parsed = transform.parse(sdp);
    return (parsed.media || [])
      .filter((media) => media && media.type === 'audio')
      .map((media, index) => ({
        index,
        label: normalizeLabel(media.label !== undefined ? media.label : index + 1),
        direction: media.direction,
        ptime: media.ptime,
        sampleRate: getPreferredSampleRate(media),
      }));
  } catch (err) {
    debug(`failed parsing SIPREC SDP: ${err && err.message ? err.message : err}`);
    return [];
  }
};

const parseCallData = (prefix, obj) => {
  const ret = {};
  const group = obj[`${prefix}group`];
  if (group) {
    const key = Object.keys(group[0]).find((k) => /:?callData$/.test(k));
    if (key) {
      const callData = group[0][key];
      for (const key of Object.keys(callData)) {
        if (['fromhdr', 'tohdr', 'callid'].includes(key)) ret[key] = callData[key][0];
      }
    }
  }
  debug('parseCallData', prefix, obj, ret);
  return ret;
};

const parseBroadWorksData = (obj) => {
  const ret = {};
  const key = getNodeKey(obj, 'extensiondata');
  const extensionData = key ? obj[key] : [];
  extensionData.forEach((entry) => {
    const metadata = getNode(entry, 'broadWorksRecordingMetadata');
    if (!metadata) return;
    const callType = getNode(metadata, 'callType');
    let callDetails;
    if (callType) {
      callDetails = getNode(callType, 'origCall') || getNode(callType, 'termCall');
      if (!callDetails) {
        for (const value of Object.values(callType)) {
          const candidate = Array.isArray(value) ? value[0] : value;
          if (!candidate || typeof candidate !== 'object') continue;
          if (getNodeValue(candidate, 'callingPartyNumber') || getNodeValue(candidate, 'calledPartyNumber')) {
            callDetails = candidate;
            break;
          }
        }
      }
    }
    const callid = getNodeValue(metadata, 'callID');
    const callerAor = getNodeValue(callDetails, 'callingPartyNumber');
    const calleeAor = getNodeValue(callDetails, 'calledPartyNumber');
    const userId = getNodeValue(metadata, 'userID');
    if (callid) ret.callid = callid;
    if (callerAor) ret.callerAor = callerAor;
    if (calleeAor) ret.calleeAor = calleeAor;
    if (userId) ret.userId = userId;
    if (callDetails === getNode(callType, 'origCall')) ret.callKind = 'origCall';
    else if (callDetails === getNode(callType, 'termCall')) ret.callKind = 'termCall';
  });
  return ret;
};

/**
 * parse a SIPREC multiparty body
 * @param  {object} opts - options
 * @return {Promise}
 */
module.exports = function parseSiprecPayload(opts) {
  const req = opts.req;
  const logger = opts.logger;
  return new Promise((resolve, reject) => {
    let sdp, meta;
    for (let i = 0; i < req.payload.length; i++) {
      switch (req.payload[i].type) {
        case 'application/sdp':
          sdp = req.payload[i].content;
          break;

        case 'application/rs-metadata+xml':
        case 'application/rs-metadata':
          meta = opts.xml = req.payload[i].content;
          break;

        default:
          break;
      }
    }

    const sdpMedia = parseSdpMedia(sdp || '');

    if (!meta && sdp) {
      const arr = /^([^]+)(m=[^]+?)(m=[^]+?)$/.exec(sdp);
      if (!arr) return reject(new Error('expected SIPREC SDP with two media sections'));
      opts.sdp1 = `${arr[1]}${arr[2]}`;
      opts.sdp2 = `${arr[1]}${arr[3]}\r\n`;
      opts.sessionId = v4();
      opts.mediaStreams = sdpMedia.map((media) => ({
        index: media.index,
        label: media.label,
        direction: media.direction,
        ptime: media.ptime,
        sampleRate: media.sampleRate,
      }));
      logger.info({ payload: req.payload }, 'SIPREC payload with no metadata (e.g. Cisco NBR)');
      return resolve(opts);
    } else if (!sdp || !meta) {
      logger.info({ payload: req.payload }, 'invalid SIPREC payload');
      return reject(new Error('expected multipart SIPREC body'));
    }

    xmlParser(meta, (err, result) => {
      if (err) return reject(err);

      opts.recordingData = result;
      opts.sessionId = v4();

      const arr = /^([^]+)(m=[^]+?)(m=[^]+?)$/.exec(sdp);
      if (!arr) return reject(new Error('expected SIPREC SDP with two media sections'));
      opts.sdp1 = `${arr[1]}${arr[2]}`;
      opts.sdp2 = `${arr[1]}${arr[3]}\r\n`;

      try {
        if (typeof result === 'object' && Object.keys(result).length === 1) {
          const key = Object.keys(result)[0];
          const arr = /^(.*:)?recording(_metadata)?$/.exec(key);
          const prefix = arr && arr[1] ? arr[1] : '';
          const obj = opts.recordingData[key];
          if (!obj) throw new Error(`unsupported SIPREC metadata root: ${key}`);

          const getAttr = (node, ...names) => {
            if (!node || !node.$) return undefined;
            for (const name of names) {
              if (node.$[name] !== undefined) return node.$[name];
            }
            return undefined;
          };

          // 1. collect participant data
          const participants = {};
          (obj[`${prefix}participant`] || []).forEach((p) => {
            const partDetails = {};
            const participantId = getAttr(p, 'participant_id', 'id');
            if (!participantId) return;
            participants[participantId] = partDetails;
            partDetails.sessionId = getAttr(p, 'session_id', 'session');
            const nameId = getNode(p, `${prefix}nameID`, 'nameID');
            if (nameId && nameId.$ && nameId.$.aor) partDetails.aor = nameId.$.aor;
            const participantAor = getNodeValue(p, `${prefix}aor`, 'aor');
            if (participantAor) partDetails.aor = participantAor;
            const participantName = getNodeValue(nameId, 'name');
            if (participantName) partDetails.name = normalizeName(participantName);
            partDetails.send = getReference(p, `${prefix}send`, 'send');
            partDetails.recv = getReference(p, `${prefix}recv`, 'recv');

            // Parse extensiondata for callingParty flag (optional, but in Acme SIPREC)
            if ((`${prefix}extensiondata` in p) && Array.isArray(p[`${prefix}extensiondata`])) {
              const extData = p[`${prefix}extensiondata`][0];
              // Look for callingParty in any namespace (e.g., apkt:callingParty)
              for (const key of Object.keys(extData)) {
                if (key.toLowerCase().includes('callingparty')) {
                  const val = extData[key][0];
                  // Convert to boolean
                  if (typeof val === 'string') {
                    partDetails.isCallingParty = (val.toLowerCase() === 'true');
                  } else if (typeof val === 'boolean') {
                    partDetails.isCallingParty = val;
                  }
                  break;
                }
              }
            }
          });

          // 2. find the associated streams for each participant
          if (`${prefix}participantstreamassoc` in obj) {
            obj[`${prefix}participantstreamassoc`].forEach((ps) => {
              const participantId = getAttr(ps, 'participant_id', 'id');
              const part = participants[participantId];
              if (part) {
                const send = getReference(ps, `${prefix}send`, 'send');
                const recv = getReference(ps, `${prefix}recv`, 'recv');
                if (send) part.send = send;
                if (recv) part.recv = recv;
              }
            });
          }

          // 3. Retrieve stream data
          const streamEntries = [];
          const streamsByLabel = new Map();
          opts.caller = {};
          opts.callee = {};
          (obj[`${prefix}stream`] || []).forEach((s) => {
            const streamId = getAttr(s, 'stream_id', 'id') || getNodeValue(s, `${prefix}id`, 'id');
            const label = normalizeLabel(getNodeValue(s, `${prefix}label`, 'label'));
            const mode = getNodeValue(s, `${prefix}mode`, 'mode');
            const sessionId = getAttr(s, 'session_id', 'session');
            let sender;
            let senderPart;
            for (const [k, v] of Object.entries(participants)) {
              if (v.send === streamId) {
                sender = k;
                senderPart = v;
                break;
              }
            }

            if (senderPart) {
              senderPart.streamId = streamId;
              senderPart.label = label;
              senderPart.mode = mode;
              if (sessionId) senderPart.sessionId = sessionId;
            }

            const entry = {
              id: streamId,
              label,
              mode,
              sessionId,
              participantId: sender,
            };
            streamEntries.push(entry);
            if (label) streamsByLabel.set(label, entry);
          });

          const callData = parseCallData(prefix, obj);
          if (callData.callid || callData.fromhdr || callData.tohdr) {
            debug(`callData: ${JSON.stringify(callData)}`);
            opts.originalCallId = callData.callid;
            Object.assign(opts.caller, parsePartyHeader(callData.fromhdr));
            Object.assign(opts.callee, parsePartyHeader(callData.tohdr));
            debug(`opts.caller from callData: ${JSON.stringify(opts.caller)}`);
            debug(`opts.callee from callData: ${JSON.stringify(opts.callee)}`);
          }

          const broadWorksData = parseBroadWorksData(obj);
          if (broadWorksData.callid) opts.originalCallId = broadWorksData.callid;
          if (broadWorksData.callerAor) opts.caller.aor = normalizeAor(broadWorksData.callerAor);
          if (broadWorksData.calleeAor) opts.callee.aor = normalizeAor(broadWorksData.calleeAor);

          const preferredCallerAor = normalizeAor(opts.caller.aor);
          const preferredCalleeAor = normalizeAor(opts.callee.aor);
          const broadWorksUserAor = broadWorksData.userId ? normalizeAor(`sip:${broadWorksData.userId}`) : undefined;
          const broadWorksUserRole = broadWorksData.callKind === 'termCall'
            ? 'callee'
            : broadWorksData.callKind === 'origCall'
              ? 'caller'
              : undefined;

          Object.values(participants).forEach((participant) => {
            const participantAor = normalizeAor(participant.aor);
            participant.normalizedAor = participantAor;
            if (typeof participant.isCallingParty === 'boolean') {
              participant.role = participant.isCallingParty ? 'caller' : 'callee';
              return;
            }
            if (preferredCallerAor && participantAor === preferredCallerAor) {
              participant.role = 'caller';
              return;
            }
            if (preferredCalleeAor && participantAor === preferredCalleeAor) {
              participant.role = 'callee';
              return;
            }
            if (broadWorksUserAor && broadWorksUserRole && participantAor === broadWorksUserAor) {
              participant.role = broadWorksUserRole;
              return;
            }
            if (-1 !== ['1', 'a_leg', 'inbound'].indexOf(participant.label)) {
              participant.role = 'caller';
              return;
            }
            if (-1 !== ['2', 'b_leg', 'outbound'].indexOf(participant.label)) {
              participant.role = 'callee';
            }
          });

          const participantsWithAor = Object.values(participants)
            .filter((participant) => participant && participant.aor);
          if (participantsWithAor.length === 2) {
            const callerPart = participantsWithAor.find((participant) => participant.role === 'caller');
            const calleePart = participantsWithAor.find((participant) => participant.role === 'callee');
            if (callerPart && !calleePart) {
              const other = participantsWithAor.find((participant) => participant !== callerPart);
              if (other) other.role = 'callee';
            } else if (calleePart && !callerPart) {
              const other = participantsWithAor.find((participant) => participant !== calleePart);
              if (other) other.role = 'caller';
            }
          }

          for (const participant of Object.values(participants)) {
            if (!participant || !participant.aor || !participant.role) continue;
            if (participant.role === 'caller' && !opts.caller.aor) {
              opts.caller.aor = normalizeAor(participant.aor);
              if (participant.name) opts.caller.name = participant.name;
            } else if (participant.role === 'callee' && !opts.callee.aor) {
              opts.callee.aor = normalizeAor(participant.aor);
              if (participant.name) opts.callee.name = participant.name;
            }
          }

          // unless we have extensiondata that tells us otherwise
          if (!opts.caller.aor && !opts.callee.aor) {
            let i = 0;
            for (const part in participants) {
              const p = participants[part];
              if (!p.aor) continue;

              // Use isCallingParty if available
              if (typeof p.isCallingParty === 'boolean') {
                if (p.isCallingParty) {
                  opts.caller.aor = normalizeAor(p.aor);
                  opts.caller.name = p.name;
                } else {
                  opts.callee.aor = normalizeAor(p.aor);
                  opts.callee.name = p.name;
                }
              } else {
                // Fallback to position-based assignment
                if (0 === i) {
                  opts.caller.aor = normalizeAor(p.aor);
                  opts.caller.name = p.name;
                } else if (1 === i) {
                  opts.callee.aor = normalizeAor(p.aor);
                  opts.callee.name = p.name;
                }
              }
              i++;
            }
          }

          if ((!opts.caller.aor && opts.callee.aor) || (opts.caller.aor && !opts.callee.aor)) {
            const partsWithAor = [];
            for (const p of Object.values(participants)) {
              if (p && p.aor) partsWithAor.push(p);
            }

            if (!opts.caller.aor && opts.callee.aor) {
              const other = partsWithAor.find((p) => p.aor !== opts.callee.aor);
              if (other) {
                opts.caller.aor = normalizeAor(other.aor);
                if (other.name) opts.caller.name = other.name;
              }
            }
            if (opts.caller.aor && !opts.callee.aor) {
              const other = partsWithAor.find((p) => p.aor !== opts.caller.aor);
              if (other) {
                opts.callee.aor = normalizeAor(other.aor);
                if (other.name) opts.callee.name = other.name;
              }
            }
          }

          if (opts.caller.aor && 0 !== opts.caller.aor.indexOf('sip:')) {
            opts.caller.aor = 'sip:' + opts.caller.aor;
          }
          if (opts.callee.aor && 0 !== opts.callee.aor.indexOf('sip:')) {
            opts.callee.aor = 'sip:' + opts.callee.aor;
          }

          if (opts.caller.aor) {
            const uri = parseUri(opts.caller.aor);
            if (uri) opts.caller.number = uri.user;
            else {
              const arr = /sip:(.*)@/.exec(opts.caller.aor);
              opts.caller.number = arr[1];
            }
          }
          if (opts.callee.aor) {
            const uri = parseUri(opts.callee.aor);
            if (uri) opts.callee.number = uri.user;
            else {
              const arr = /sip:(.*)@/.exec(opts.callee.aor);
              opts.callee.number = arr[1];
            }
          }

          opts.mediaStreams = sdpMedia.map((media, index) => {
            const stream = (media.label && streamsByLabel.get(media.label)) || streamEntries[index];
            const participant = stream && stream.participantId ? participants[stream.participantId] : undefined;
            return {
              index: media.index,
              label: media.label || (stream && stream.label) || normalizeLabel(index + 1),
              role: participant && participant.role ? participant.role : undefined,
              aor: participant && participant.aor ? normalizeAor(participant.aor) : undefined,
              name: participant && participant.name ? participant.name : undefined,
              mode: stream && stream.mode ? stream.mode : undefined,
              sessionId: (stream && stream.sessionId) || (participant && participant.sessionId),
              direction: media.direction,
              ptime: media.ptime,
              sampleRate: media.sampleRate,
            };
          });

          const sessionNode = getNode(obj, `${prefix}session`, 'session');
          opts.recordingSessionId = getAttr(sessionNode, 'session_id', 'id');
        }
      } catch (err) {
        reject(err);
      }
      debug(opts, 'payload parser results');
      resolve(opts) ;
    }) ;
  }) ;
};
