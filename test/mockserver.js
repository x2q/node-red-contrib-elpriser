'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const FIXTURES = path.join(__dirname, 'fixtures');

/** Recorded live answers (2026-11-03 08:40 CET). Key: "<path>?<query>" without the host. */
const ROUTES = {
  '/api/forecast?area=DK1&mode=inkl_alt': 'dk1_fc.json',
  '/api/forecast?area=DK2&mode=net_inkl_alt&gln=5790000705689': 'dk2_net.json',
  '/api/nordic?zone=de': 'de.json',
  '/api/nordic?zone=pl': 'pl.json',
  '/api/nordic?zone=se3': 'se3.json',
  '/api/nordic?zone=gb': 'gb.json'
};

/** The instant the fixtures are about: 2026-11-03 11:15 CET. */
const NOW = Date.parse('2026-11-03T10:15:00Z');

function start() {
  const state = { requests: [], mode: 'ok', failStatus: 503, retryAfter: null };
  const server = http.createServer((req, res) => {
    state.requests.push({ url: req.url, headers: req.headers });
    if (state.mode === 'fail') {
      const h = state.retryAfter ? { 'Retry-After': String(state.retryAfter) } : {};
      res.writeHead(state.failStatus, h).end('nope');
      return;
    }
    const file = ROUTES[req.url];
    if (!file) {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad request"}');
      return;
    }
    const body = fs.readFileSync(path.join(FIXTURES, file));
    const etag = '"' + file + '"';
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag }).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', etag }).end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}`;
      resolve({ url, state, close: () =>
          new Promise((r) => {
            server.close(r);
            // fetch() keeps connections alive; do not wait for them (Node 18/20)
            if (server.closeAllConnections) server.closeAllConnections();
          }) });
    });
  });
}

module.exports = { start, NOW, FIXTURES };
