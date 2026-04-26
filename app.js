const assert = require('assert');
const config = require('config');
const pino = require('pino');
const Srf = require('drachtio-srf');
const srf = new Srf() ;
const logger = srf.locals.logger = pino();
const dedup = require('./lib/dedup');
let callHandler;

// Initialize SIPREC ingress dedup.
dedup.init({
  logger,
  redisHost: process.env.REDIS_HOST || (config.has('redis.host') ? config.get('redis.host') : undefined),
  redisPort: process.env.REDIS_PORT || (config.has('redis.port') ? config.get('redis.port') : undefined),
  redisDb: process.env.REDIS_DB || (config.has('redis.db') ? config.get('redis.db') : 1),
  redisPassword: process.env.REDIS_PASSWORD
    || (config.has('redis.password') ? config.get('redis.password') : undefined),
  failOpen: process.env.SIPREC_DEDUP_FAIL_CLOSED === '1' ? false : true,
});

if (config.has('drachtio.host')) {
  logger.info(config.get('drachtio'), 'attempting inbound connection');
  srf.connect(config.get('drachtio'));
  srf
    .on('connect', (err, hp) => { logger.info(`inbound connection to drachtio listening on ${hp}`);})
    .on('error', (err) => { logger.error(err, `Error connecting to drachtio server: ${err}`); });
}
else {
  logger.info(config.get('drachtio'), 'listening for outbound connections');
  srf.listen(config.get('drachtio'));
}

if (config.has('rtpengine')) {
  logger.info(config.get('rtpengine'), 'using rtpengine as the recorder');
  callHandler = require('./lib/rtpengine-call-handler');
  // start DTMF listener
  require('./lib/dtmf-event-handler')(logger);

  // we only want to deal with siprec invites (having multipart content) in this application
  srf.use('invite', (req, res, next) => {
    const ctype = req.get('Content-Type') || '';
    if (!ctype.includes('multipart/mixed')) {
      logger.info(`rejecting non-SIPREC INVITE with call-id ${req.get('Call-ID')}`);
      return res.send(488);
    }
    next();
  });

}
else if (config.has('freeswitch')) {
  logger.info(config.get('freeswitch'), 'using freeswitch as the recorder');
  callHandler = require('./lib/freeswitch-call-handler')(logger);
}
else {
  assert('recorder type not specified in configuration: must be either rtpengine or freeswitch');
}

// Add 200OK support for Options
srf.options((req, res) => {
  logger.info(`OPTIONS request with call-id ${req.get('Call-ID')}`);
  return res.send(200);
});

srf.invite(callHandler);

module.exports = srf;
