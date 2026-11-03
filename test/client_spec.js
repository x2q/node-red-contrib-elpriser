'use strict';
const should = require('should');
const { createClient, CATCH_UP, REFRESH } = require('../lib/client');
const mock = require('./mockserver');

describe('lib/client', () => {
  let srv;
  let clock;
  const MIN = 60000;
  beforeEach(async () => {
    srv = await mock.start();
    clock = mock.NOW;
  });
  afterEach(() => srv.close());
  const make = (extra) => createClient(Object.assign({ zone: 'dk1', baseUrl: srv.url, now: () => clock }, extra));

  it('asks for the whole day set of the zone once and sends a descriptive User-Agent', async () => {
    const c = make({ userAgent: 'test-agent/1' });
    const r = await c.get();
    r.data.zone.should.equal('dk1');
    srv.state.requests.should.have.length(1);
    srv.state.requests[0].url.should.equal('/api/forecast?area=DK1&mode=inkl_alt');
    srv.state.requests[0].headers['user-agent'].should.equal('test-agent/1');
  });

  it('serves from the cache within the hour, shares one in-flight request', async () => {
    const c = make();
    await Promise.all([c.get(), c.get(), c.get()]);
    srv.state.requests.should.have.length(1);
    clock += 30 * MIN;
    await c.get();
    srv.state.requests.should.have.length(1);
  });

  it('revalidates after an hour with If-None-Match and keeps the data on 304', async () => {
    const c = make();
    const first = await c.get();
    clock += REFRESH + MIN;
    const second = await c.get();
    srv.state.requests.should.have.length(2);
    srv.state.requests[1].headers['if-none-match'].should.equal('"dk1_fc.json"');
    second.data.should.equal(first.data);
    second.stale.should.be.false();
  });

  it('refreshes every 20 minutes between 13:00 and 18:00 CET while tomorrow is not published', async () => {
    const c = make();
    clock = Date.parse('2026-11-03T12:30:00Z'); // 13:30 CET, fixtures have only a model for tomorrow
    await c.get();
    clock += CATCH_UP + MIN;
    await c.get();
    srv.state.requests.should.have.length(2);
  });

  it('on errors keeps serving old data that still covers now, then backs off 5 minutes', async () => {
    const c = make();
    await c.get();
    clock += REFRESH + MIN;
    srv.state.mode = 'fail';
    const r = await c.get();
    r.stale.should.be.true();
    r.error.message.should.match(/503/);
    srv.state.requests.should.have.length(2);
    clock += 2 * MIN;
    await c.get(); // inside the back-off: no new request
    srv.state.requests.should.have.length(2);
    clock += 4 * MIN;
    await c.get();
    srv.state.requests.should.have.length(3);
    srv.state.mode = 'ok';
    clock += 11 * MIN; // second failure waited 10 minutes
    const ok = await c.get();
    ok.stale.should.be.false();
  });

  it('honours Retry-After', async () => {
    const c = make();
    await c.get();
    clock += REFRESH + MIN;
    srv.state.mode = 'fail';
    srv.state.failStatus = 429;
    srv.state.retryAfter = 900;
    await c.get();
    clock += 10 * MIN;
    await c.get();
    srv.state.requests.should.have.length(2);
    clock += 6 * MIN;
    await c.get();
    srv.state.requests.should.have.length(3);
  });

  it('with no data yet an error is thrown, and the back-off still applies', async () => {
    srv.state.mode = 'fail';
    const c = make();
    await c.get().should.be.rejectedWith(/503/);
    await c.get().should.be.rejectedWith(/503/);
    srv.state.requests.should.have.length(1);
  });

  it('does not serve old data that no longer covers now', async () => {
    const c = make();
    await c.get();
    srv.state.mode = 'fail';
    clock = Date.parse('2026-11-20T10:00:00Z');
    await c.get().should.be.rejectedWith(/503/);
  });

  it('a bad zone fails when the client is built', () => {
    (() => createClient({ zone: 'zz' })).should.throw(/unknown zone/);
  });
});
