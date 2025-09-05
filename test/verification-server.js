"use strict";

const http = require('http');
const url = require('url');

function parseTokens(v) {
  if (!v) return [];
  const s = String(v).toLowerCase();
  const tokens = new Set();
  // split common separators
  s.split(/[\s<>]/).forEach((p) => {
    if (!p) return;
    // strip sip: prefix
    let q = p.replace(/^sips?:/i, '');
    // remove brackets
    q = q.replace(/[<>]/g, '');
    // take user@host -> user and host
    const at = q.indexOf('@');
    if (at > -1) {
      tokens.add(q.slice(0, at));
      tokens.add(q.slice(at + 1));
    }
    tokens.add(q);
  });
  return Array.from(tokens);
}

function shouldAllow(query) {
  const caller = query.caller || '';
  const callee = query.callee || '';
  const tokens = new Set([...parseTokens(caller), ...parseTokens(callee)]);

  // Deny if any obvious deny token present
  const denyTokens = ['blocked', 'deny', 'forbidden', '403', '9999'];
  for (const d of denyTokens) {
    if (tokens.has(d)) return false;
  }
  return true;
}

const server = http.createServer((req, res) => {
  const u = url.parse(req.url, true);
  if (u.pathname !== '/verify') {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false }));
  }
  const allow = shouldAllow(u.query);
  const body = { record: allow, reason: allow ? 'allowed by test verifier' : 'denied by test verifier' };
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`test verification server listening on :${PORT}`);
});
