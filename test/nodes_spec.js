'use strict';
const should = require('should');
const helper = require('node-red-node-test-helper');
const config = require('../nodes/elpriser-config.js');
const price = require('../nodes/elpriser-price.js');
const cheapest = require('../nodes/elpriser-cheapest.js');
const forecast = require('../nodes/elpriser-forecast.js');
const mock = require('./mockserver');

helper.init(require.resolve('node-red'));

const ALL = [config, price, cheapest, forecast];
const NOW = '2026-11-03T10:15:00Z'; // 11:15 CET

describe('elpriser nodes', function () {
  this.timeout(10000);
  let srv;
  before(async () => {
    srv = await mock.start();
  });
  after(() => srv.close());
  beforeEach(() => helper.startServer());
  afterEach(async () => {
    srv.state.requests.length = 0;
    srv.state.mode = 'ok';
    await helper.unload();
    await helper.stopServer();
  });
  const restart = async () => {
    await helper.unload();
    await helper.stopServer();
    await helper.startServer();
  };

  /** Loads cfg + one node + a helper node; sends `input` and resolves with the first message (or error). */
  async function run(type, nodeProps, cfgProps, input) {
    const flow = [
      Object.assign({ id: 'c', type: 'elpriser-config', zone: 'dk1', mode: 'inkl_alt', baseUrl: srv.url }, cfgProps),
      Object.assign({ id: 'n', type, server: 'c', wires: [['h']] }, nodeProps),
      { id: 'h', type: 'helper' }
    ];
    await helper.load(ALL, flow);
    const n = helper.getNode('n');
    const h = helper.getNode('h');
    return new Promise((resolve, reject) => {
      h.on('input', (msg) => resolve({ msg, node: n }));
      n.on('call:error', (call) => reject(call.args[0]));
      n.receive(input);
      setTimeout(() => reject(new Error('timeout, no message')), 5000);
    });
  }

  describe('elpriser-price', () => {
    it('DK1: price now, next hour, level and today numbers', async () => {
      const { msg } = await run('elpriser-price', {}, {}, { payload: 1, now: NOW });
      msg.payload.should.equal(2.3166);
      msg.topic.should.equal('elpriser/dk1/price');
      const e = msg.elpriser;
      e.zone.should.equal('dk1');
      e.unit.should.equal('DKK/kWh');
      e.start.should.equal('2026-11-03T10:00:00.000Z');
      e.end.should.equal('2026-11-03T11:00:00.000Z');
      e.type.should.equal('actual');
      e.next.price.should.equal(2.2758);
      e.level.should.equal('cheap');
      e.today.should.containEql({ min: 2.209, max: 3.0903, average: 2.52244 });
      e.tomorrowPublished.should.be.false();
      e.stale.should.be.false();
      should(e.attribution).be.null();
    });
    it('keeps the incoming message properties', async () => {
      const { msg } = await run('elpriser-price', {}, {}, { payload: 1, now: NOW, _keep: 'me', topic: 'mine' });
      msg._keep.should.equal('me');
      msg.topic.should.equal('mine');
    });
    it('DE: EUR with the licence attribution', async () => {
      const { msg } = await run('elpriser-price', {}, { zone: 'de' }, { now: NOW });
      msg.elpriser.currency.should.equal('EUR');
      msg.payload.should.be.a.Number();
      msg.elpriser.attribution.should.match(/Energy-Charts/);
    });
    it('PL in PLN, and in EUR when asked', async () => {
      const pln = await run('elpriser-price', {}, { zone: 'pl' }, { now: NOW });
      pln.msg.elpriser.unit.should.equal('PLN/kWh');
      await restart();
      const eur = await run('elpriser-price', {}, { zone: 'pl', currency: 'eur' }, { now: NOW });
      eur.msg.elpriser.unit.should.equal('EUR/kWh');
      (pln.msg.payload / eur.msg.payload).should.be.approximately(4.4185, 0.01);
    });
    it('Danish zone with grid company: asks the net_* price from /api/forecast with the GLN', async () => {
      const { msg } = await run('elpriser-price', {}, { zone: 'dk2', mode: 'net_inkl_alt', gln: '5790000705689' }, { now: NOW });
      srv.state.requests[0].url.should.equal('/api/forecast?area=DK2&mode=net_inkl_alt&gln=5790000705689');
      msg.payload.should.be.a.Number();
      msg.elpriser.zone.should.equal('dk2');
    });
    it('GB: the hour has no price yet, the last complete hour is sent and marked stale', async () => {
      const { msg } = await run('elpriser-price', {}, { zone: 'gb' }, { now: '2026-11-03T08:10:00Z' });
      msg.elpriser.stale.should.be.true();
      msg.payload.should.be.a.Number();
      msg.elpriser.attribution.should.match(/Elexon/);
    });
    it('no price for the hour: payload null', async () => {
      const { msg } = await run('elpriser-price', {}, { zone: 'gb' }, { now: '2026-11-03T22:10:00Z' });
      should(msg.payload).be.null();
    });
    it('reports an error when the service is down and nothing is cached', async () => {
      srv.state.mode = 'fail';
      await run('elpriser-price', {}, {}, { now: NOW }).should.be.rejectedWith(/503/);
    });
    it('two nodes on one config share one request', async () => {
      const flow = [
        { id: 'c', type: 'elpriser-config', zone: 'dk1', baseUrl: srv.url },
        { id: 'a', type: 'elpriser-price', server: 'c', wires: [['h']] },
        { id: 'b', type: 'elpriser-cheapest', server: 'c', count: 3, wires: [['h']] },
        { id: 'h', type: 'helper' }
      ];
      await helper.load(ALL, flow);
      const h = helper.getNode('h');
      const got = new Promise((resolve) => {
        const seen = [];
        h.on('input', (m) => {
          seen.push(m);
          if (seen.length === 2) resolve(seen);
        });
      });
      helper.getNode('a').receive({ now: NOW });
      helper.getNode('b').receive({ now: NOW });
      await got;
      srv.state.requests.should.have.length(1);
    });
    it('without a config node it shows a status and does not crash', async () => {
      await helper.load(ALL, [{ id: 'n', type: 'elpriser-price', wires: [] }]);
      helper.getNode('n').should.be.ok();
    });
  });

  describe('elpriser-cheapest', () => {
    it('4 cheapest hours today: now (11:15) is not one of them; slots are the API schedule hours 0-3', async () => {
      const { msg } = await run('elpriser-cheapest', { strategy: 'hours', count: 4, scope: 'today' }, {}, { now: NOW });
      msg.payload.should.be.false();
      const e = msg.elpriser;
      e.slots.map((s) => s.price).should.eql([2.209, 2.2237, 2.22, 2.2411]);
      e.slots[0].start.should.equal('2026-11-02T23:00:00.000Z');
      e.basedOnForecast.should.be.false();
      e.strategy.should.equal('hours');
      should(e.nextStart).be.null(); // all four hours have passed
    });
    it('payload is true when now is one of the chosen hours', async () => {
      const { msg } = await run('elpriser-cheapest', { strategy: 'hours', count: 4, scope: 'today' }, {}, { now: '2026-11-03T01:30:00Z' });
      msg.payload.should.be.true();
    });
    it('next 12 hours from 11:15 CET, hours mode: only published prices unless forecast is ticked', async () => {
      const a = await run('elpriser-cheapest', { strategy: 'hours', count: 3, scope: 'next', lookahead: 24 }, {}, { now: NOW });
      // 24 hours from 10:00Z reach into the model forecast of tomorrow; without the tick only today's hours count
      a.msg.elpriser.hoursInHorizon.should.equal(24);
      a.msg.elpriser.hoursConsidered.should.equal(13);
      a.msg.elpriser.basedOnForecast.should.be.false();
      await restart();
      const b = await run('elpriser-cheapest', { strategy: 'hours', count: 3, scope: 'next', lookahead: 24, includeForecast: true }, {}, { now: NOW });
      b.msg.elpriser.hoursConsidered.should.equal(24);
      b.msg.elpriser.basedOnForecast.should.be.true();
      b.msg.elpriser.slots.should.have.length(3);
      b.msg.elpriser.nextStart.should.be.a.String();
    });
    it('cheapest window of 3 hours in a row', async () => {
      const { msg } = await run('elpriser-cheapest', { strategy: 'window', count: 3, scope: 'next', lookahead: 13 }, {}, { now: NOW });
      const e = msg.elpriser;
      e.slots.should.have.length(3);
      (Date.parse(e.end) - Date.parse(e.start)).should.equal(3 * 3600000);
      e.slots[1].start.should.equal(e.slots[0].end);
      // today 10:00Z..23:00Z: the cheapest three in a row are 12,13,14 (local 13-15?) - verify by brute force
      const prices = [2.3166, 2.2758, 2.3251, 2.3225, 2.5961, 2.931, 3.0305, 3.0903, 2.975, 2.7449, 2.3894, 2.2991, 2.283];
      let best = Infinity;
      for (let i = 0; i + 3 <= prices.length; i++) best = Math.min(best, prices[i] + prices[i + 1] + prices[i + 2]);
      (e.slots[0].price + e.slots[1].price + e.slots[2].price).should.be.approximately(best, 1e-9);
      e.average.should.be.approximately(best / 3, 1e-4);
    });
    it('max price: no hour qualifies, payload false with a reason', async () => {
      const { msg } = await run('elpriser-cheapest', { strategy: 'hours', count: 4, scope: 'today', maxPrice: '1' }, {}, { now: NOW });
      msg.payload.should.be.false();
      msg.elpriser.slots.should.have.length(0);
      msg.elpriser.reason.should.be.a.String();
    });
    it('msg.count / msg.lookahead override the node settings', async () => {
      const { msg } = await run('elpriser-cheapest', { strategy: 'hours', count: 4, scope: 'today' }, {}, { now: NOW, count: 2 });
      msg.elpriser.slots.should.have.length(2);
      msg.elpriser.count.should.equal(2);
    });
  });

  describe('elpriser-forecast', () => {
    it('DK1 from the current hour: published prices, then the model with min/max', async () => {
      const { msg } = await run('elpriser-forecast', { from: 'now', hours: 0, includeForecast: true }, {}, { now: NOW });
      const p = msg.payload;
      p[0].start.should.equal('2026-11-03T10:00:00.000Z');
      p[0].price.should.equal(2.3166);
      p[0].type.should.equal('actual');
      const f = p.find((x) => x.type === 'forecast');
      f.min.should.be.a.Number();
      f.max.should.be.a.Number();
      msg.elpriser.count.should.equal(p.length);
      msg.elpriser.actualHours.should.equal(13);
      msg.elpriser.forecastHours.should.equal(9 * 24);
      msg.elpriser.note.should.match(/not an official forecast/);
      msg.elpriser.model.should.have.property('name');
      p.length.should.equal(13 + 9 * 24);
    });
    it('limited to 48 hours and published prices only', async () => {
      const a = await run('elpriser-forecast', { from: 'now', hours: 48, includeForecast: true }, {}, { now: NOW });
      a.msg.payload.should.have.length(48);
      await restart();
      const b = await run('elpriser-forecast', { from: 'now', hours: 48, includeForecast: false }, {}, { now: NOW });
      b.msg.payload.should.have.length(13);
      b.msg.elpriser.forecastHours.should.equal(0);
      should(b.msg.elpriser.note).be.null();
    });
    it('from midnight today includes the hours that have passed', async () => {
      const { msg } = await run('elpriser-forecast', { from: 'today', hours: 24 }, {}, { now: NOW });
      msg.payload[0].start.should.equal('2026-11-02T23:00:00.000Z');
      msg.payload.should.have.length(24);
    });
  });

  describe('elpriser-config', () => {
    it('an invalid GLN makes the node error when used', async () => {
      await run('elpriser-price', {}, { zone: 'dk2', mode: 'net_inkl_alt', gln: '1' }, { now: NOW }).should.be.rejectedWith(/GLN/);
    });
  });
});
