'use strict';
const should = require('should');
const fs = require('fs');
const path = require('path');
const lib = require('../lib/elpriser');
const { FIXTURES, NOW } = require('./mockserver');

const fixture = (n) => JSON.parse(fs.readFileSync(path.join(FIXTURES, n + '.json'), 'utf8'));
const iso = (ms) => new Date(ms).toISOString();

describe('lib/elpriser: requests', () => {
  it('Danish zones use /api/forecast with the price type', () => {
    lib.buildRequest({ zone: 'dk1' }).should.eql({ path: '/api/forecast', params: { area: 'DK1', mode: 'inkl_alt' }, danish: true });
    lib.buildRequest({ zone: 'dk2', mode: 'net_inkl_alt', gln: '5790000705689' }).params.should.eql({
      area: 'DK2',
      mode: 'net_inkl_alt',
      gln: '5790000705689'
    });
  });
  it('net_* price types need a 13-digit GLN', () => {
    (() => lib.buildRequest({ zone: 'dk2', mode: 'net_inkl_alt' })).should.throw(/GLN/);
    (() => lib.buildRequest({ zone: 'dk2', mode: 'net_inkl_alt', gln: '123' })).should.throw(/GLN/);
  });
  it('every other zone, and Denmark in EUR, use /api/nordic', () => {
    lib.buildRequest({ zone: 'de' }).should.eql({ path: '/api/nordic', params: { zone: 'de' }, danish: false });
    lib.buildRequest({ zone: 'dk1', currency: 'eur' }).path.should.equal('/api/nordic');
  });
  it('unknown zone or price type is an error', () => {
    (() => lib.buildRequest({ zone: 'xx' })).should.throw(/unknown zone/);
    (() => lib.buildRequest({ zone: 'dk1', mode: 'nope' })).should.throw(/price mode/);
  });
  it('the zone table has 40 zones', () => {
    lib.ZONES.should.have.length(40);
  });
});

describe('lib/elpriser: parsing recorded live answers', () => {
  it('DK1 inkl_alt: DKK/kWh, the 11:00 CET hour is the API price of hour 11', () => {
    const d = lib.parse(fixture('dk1_fc'), { zone: 'dk1' });
    d.currency.should.equal('DKK');
    d.unit.should.equal('DKK/kWh');
    const s = lib.slotAt(d, NOW);
    iso(s.start).should.equal('2026-11-03T10:00:00.000Z');
    s.value.should.equal(2.3166);
    s.type.should.equal('actual');
    d.slots.should.have.length(240);
    lib.slotAt(d, Date.parse('2026-11-04T10:15:00Z')).type.should.equal('forecast');
    should(lib.slotAt(d, Date.parse('2026-11-04T10:15:00Z')).min).be.a.Number();
  });
  it('DE: EUR/MWh -> EUR/kWh', () => {
    const r = fixture('de');
    const d = lib.parse(r, { zone: 'de' });
    d.currency.should.equal('EUR');
    const row = r.days.find((x) => x.date === '2026-11-03').prices[11];
    lib.slotAt(d, NOW).value.should.equal(Math.round(row.eur_mwh * 100) / 100000);
  });
  it('PL: converted with the ECB rate to PLN, or left in EUR', () => {
    const r = fixture('pl');
    const row = r.days.find((x) => x.date === '2026-11-03').prices[11];
    const pln = lib.parse(r, { zone: 'pl' });
    pln.currency.should.equal('PLN');
    lib.slotAt(pln, NOW).value.should.equal(Math.round(((row.eur_mwh * r.zoneInfo.rate) / 1000) * 1e5) / 1e5);
    const eur = lib.parse(r, { zone: 'pl', currency: 'eur' });
    eur.currency.should.equal('EUR');
    lib.slotAt(eur, NOW).value.should.equal(Math.round(row.eur_mwh * 100) / 100000);
  });
  it('SE3 is SEK, GB is GBP in both modes', () => {
    lib.parse(fixture('se3'), { zone: 'se3' }).currency.should.equal('SEK');
    lib.parse(fixture('gb'), { zone: 'gb' }).currency.should.equal('GBP');
    lib.parse(fixture('gb'), { zone: 'gb', currency: 'eur' }).currency.should.equal('GBP');
  });
  it('hours without a price stay in the data with value null (gb)', () => {
    const d = lib.parse(fixture('gb'), { zone: 'gb' });
    d.slots.filter((s) => s.value === null).length.should.be.above(0);
  });
  it('rejects answers that are not price data', () => {
    (() => lib.parse({}, { zone: 'de' })).should.throw(/no days/);
    (() => lib.parse({ days: [{ date: '2026-11-03', prices: [] }], zoneInfo: { rate: 1 } }, { zone: 'de' })).should.throw(/no usable hours/);
    (() => lib.parse({ days: [{ date: '2026-11-03', prices: [{ hour: 0, eur_mwh: 1 }] }] }, { zone: 'de' })).should.throw(/zoneInfo/);
  });
});

describe('lib/elpriser: daylight saving', () => {
  const day = (date, zone, tz) => {
    const payload = {
      zone,
      unit: 'EUR/MWh',
      zoneInfo: { currency: 'EUR', rate: 1 },
      days: [{ date, type: 'actual', prices: Array.from({ length: 24 }, (_, hour) => ({ hour, eur_mwh: hour * 1000 })) }]
    };
    return lib.parse(payload, { zone }).slots;
  };
  it('Berlin 2026-03-29 has 23 hours and no hour 2', () => {
    const s = day('2026-03-29', 'de');
    s.should.have.length(23);
    s.map((x) => x.value).should.not.containEql(2);
    iso(s[0].start).should.equal('2026-03-28T23:00:00.000Z');
  });
  it('Berlin 2026-10-25 has 25 hours; the doubled hour carries one price twice', () => {
    const s = day('2026-10-25', 'de');
    s.should.have.length(25);
    s.filter((x) => x.value === 2).should.have.length(2);
    iso(s[0].start).should.equal('2026-10-24T22:00:00.000Z');
  });
  it('London and Lisbon (UTC+0 in winter), Athens (UTC+2) change on the same days', () => {
    day('2026-03-29', 'gb').should.have.length(23);
    day('2026-10-25', 'pt').should.have.length(25);
    iso(day('2026-01-15', 'gr')[0].start).should.equal('2026-01-14T22:00:00.000Z');
    iso(day('2026-07-15', 'gr')[0].start).should.equal('2026-07-14T21:00:00.000Z');
    iso(day('2026-07-15', 'gb')[0].start).should.equal('2026-07-14T23:00:00.000Z');
  });
  it('every zone: 23 hours on 2026-03-29, 25 on 2026-10-25, 24 on the days around them; slots are contiguous', function () {
    this.timeout(60000);
    const dates = ['2026-01-15', '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-07-15', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27'];
    const expected = { '2026-03-29': 23, '2026-10-25': 25 };
    for (const z of lib.ZONES) {
      const days = dates.map((date) => ({ date, type: 'actual', prices: Array.from({ length: 24 }, (_, hour) => ({ hour, eur_mwh: 1 })) }));
      const d = lib.parse({ zone: z.key, unit: 'EUR/MWh', zoneInfo: { rate: 1, currency: 'EUR' }, days }, { zone: z.key });
      const perDay = new Map();
      for (const s of d.slots) perDay.set(lib.localDate(s.start, z.tz), (perDay.get(lib.localDate(s.start, z.tz)) || 0) + 1);
      for (const date of dates) perDay.get(date).should.equal(expected[date] || 24, `${z.key} ${date}`);
      // consecutive days join up
      const mar = d.slots.filter((s) => ['2026-03-28', '2026-03-29', '2026-03-30'].includes(lib.localDate(s.start, z.tz)));
      for (let i = 1; i < mar.length; i++) mar[i].start.should.equal(mar[i - 1].end, `${z.key} ${i}`);
    }
  });
});

describe('lib/elpriser: Finland is on Helsinki time', () => {
  const fiDay = (date) =>
    lib.parse(
      {
        zone: 'fi',
        unit: 'EUR/MWh',
        zoneInfo: { currency: 'EUR', rate: 1 },
        days: [{ date, type: 'actual', prices: Array.from({ length: 24 }, (_, hour) => ({ hour, eur_mwh: hour === 1 ? 5.77 : hour * 1000 })) }]
      },
      { zone: 'fi' }
    );
  it('the zone table: fi is Europe/Helsinki, the other Nordic zones and NL stay on Copenhagen', () => {
    lib.ZONES.find((z) => z.key === 'fi').tz.should.equal('Europe/Helsinki');
    for (const key of ['dk1', 'dk2', 'no1', 'no5', 'se1', 'se4', 'nl']) lib.ZONES.find((z) => z.key === key).tz.should.equal('Europe/Copenhagen', key);
  });
  it('ENTSO-E ground truth: the 2026-11-03 market day starts 2026-11-02T23:00Z = Helsinki hour 1; hour 0 is 22:00Z', () => {
    const d = fiDay('2026-11-03');
    d.tz.should.equal('Europe/Helsinki');
    d.slots.should.have.length(24);
    iso(d.slots[0].start).should.equal('2026-11-02T22:00:00.000Z');
    iso(d.slots[1].start).should.equal('2026-11-02T23:00:00.000Z');
    d.slots[1].value.should.equal(0.00577);
    iso(d.slots[23].end).should.equal('2026-11-03T22:00:00.000Z');
  });
  it('summer: hour 0 is 21:00Z; the spring and autumn clock changes give 23 and 25 hours', () => {
    iso(fiDay('2026-07-15').slots[0].start).should.equal('2026-07-14T21:00:00.000Z');
    fiDay('2026-03-29').slots.should.have.length(23);
    fiDay('2026-10-25').slots.should.have.length(25);
  });
});

describe('lib/elpriser: every slot lands on the hour it was published for (2026-2027, Intl as the reference)', function () {
  this.timeout(60000);
  for (const [zone, tz] of [['de', 'Europe/Berlin'], ['gr', 'Europe/Athens'], ['gb', 'Europe/London'], ['pt', 'Europe/Lisbon']]) {
    it(zone, () => {
      const days = [];
      for (let t = Date.parse('2026-01-01T00:00:00Z'), n = 0; t < Date.parse('2028-01-01T00:00:00Z'); t += 86400000, n++) {
        days.push({ date: new Date(t).toISOString().slice(0, 10), type: 'actual', prices: Array.from({ length: 24 }, (_, hour) => ({ hour, eur_mwh: n * 100 + hour })) });
      }
      const d = lib.parse({ zone, unit: 'EUR/MWh', zoneInfo: { rate: 1, currency: 'EUR' }, days }, { zone });
      const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' });
      for (const s of d.slots) {
        const p = Object.fromEntries(fmt.formatToParts(new Date(s.start)).map((x) => [x.type, x.value]));
        const idx = days.findIndex((x) => x.date === `${p.year}-${p.month}-${p.day}`);
        Math.round(s.value * 1000).should.equal(idx * 100 + Number(p.hour), new Date(s.start).toISOString());
      }
    });
  }
});

describe('lib/elpriser: queries', () => {
  const d = lib.parse(fixture('dk1_fc'), { zone: 'dk1' });
  it('currentSlot / nextSlot / day statistics match the API (DK1 today: min 2.209, max 3.0903, avg 2.5224)', () => {
    lib.currentSlot(d, NOW).slot.value.should.equal(2.3166);
    lib.nextSlot(d, NOW).value.should.equal(2.2758);
    const st = lib.dayStats(lib.slotsOnDay(d, NOW));
    st.min.value.should.equal(2.209);
    st.max.value.should.equal(3.0903);
    st.average.should.equal(2.52244);
    iso(st.min.start).should.equal('2026-11-02T23:00:00.000Z');
  });
  it('price level: lowest third cheap, highest expensive', () => {
    const st = lib.dayStats(lib.slotsOnDay(d, NOW));
    lib.priceLevel(2.209, st).should.equal('cheap');
    lib.priceLevel(3.0903, st).should.equal('expensive');
    lib.priceLevel(2.65, st).should.equal('normal');
    should(lib.priceLevel(null, st)).be.null();
  });
  it('4 cheapest hours of today are the ones the API schedule marks on (hours 0-3)', () => {
    const chosen = lib.cheapestHours(lib.slotsOnDay(d, NOW), 4);
    chosen.map((s) => s.value).should.eql([2.209, 2.2237, 2.22, 2.2411]);
    chosen.map((s) => s.start).should.eql(chosen.map((s) => s.start).slice().sort((a, b) => a - b));
  });
  it('cheapest window of 3 hours in a row (lowest sum, in order)', () => {
    const slots = lib.slotsOnDay(d, NOW);
    const w = lib.cheapestWindow(slots, 3);
    w.slots.should.have.length(3);
    // brute force
    let best = Infinity;
    for (let i = 0; i + 3 <= slots.length; i++) best = Math.min(best, slots[i].value + slots[i + 1].value + slots[i + 2].value);
    (w.slots[0].value + w.slots[1].value + w.slots[2].value).should.be.approximately(best, 1e-9);
    w.average.should.be.approximately(best / 3, 1e-4);
  });
  it('a gap (unpriced hour) breaks a window', () => {
    const s = [1, 2, null, 0.1, 0.1].map((v, i) => ({ start: i * 3600000, end: (i + 1) * 3600000, value: v, type: 'actual' }));
    lib.cheapestWindow(s, 2).slots.map((x) => x.value).should.eql([0.1, 0.1]);
    should(lib.cheapestWindow(s, 3)).be.null();
    should(lib.cheapestWindow(s.slice(0, 3), 3)).be.null();
  });
  it('max price filters hours; max average filters windows', () => {
    const slots = lib.slotsOnDay(d, NOW);
    lib.cheapestHours(slots, 4, 2.215).map((s) => s.value).should.eql([2.209]);
    should(lib.cheapestWindow(slots, 3, 1)).be.null();
  });
  it('nextHours: current hour and H-1 following hours', () => {
    const s = lib.nextHours(d, NOW, 5);
    s.should.have.length(5);
    iso(s[0].start).should.equal('2026-11-03T10:00:00.000Z');
  });
  it('tomorrowPublished: false while tomorrow is only the model, true with actual prices', () => {
    lib.tomorrowPublished(d, NOW).should.be.false();
    const r = fixture('de');
    r.days.find((x) => x.date === '2026-11-04').type = 'actual';
    lib.tomorrowPublished(lib.parse(r, { zone: 'de' }), NOW).should.be.true();
  });
  it('gb: an hour without a price falls back to the last complete hour (stale), max 3 hours old', () => {
    const g = lib.parse(fixture('gb'), { zone: 'gb' });
    const t = Date.parse('2026-11-03T08:10:00Z'); // hour 08:00Z has no price yet
    const c = lib.currentSlot(g, t);
    c.stale.should.be.true();
    c.slot.value.should.be.a.Number();
    should(lib.currentSlot(g, Date.parse('2026-11-03T22:10:00Z')).slot).be.null();
  });
  it('parseNow takes numbers, Dates and ISO strings', () => {
    lib.parseNow(5).should.equal(5);
    lib.parseNow('2026-11-03T10:15:00Z').should.equal(NOW);
    lib.parseNow(new Date(NOW)).should.equal(NOW);
    lib.parseNow(undefined, 7).should.equal(7);
    lib.parseNow('garbage', 7).should.equal(7);
  });
  it('attribution notes for the licensed zones', () => {
    lib.attribution('gb', NOW).should.match(/Elexon.*2026/);
    lib.attribution('de').should.match(/CC BY 4.0/);
    should(lib.attribution('se3')).be.null();
  });
});
