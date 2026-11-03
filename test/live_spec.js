'use strict';
// Against the live service. Skipped unless ELPRISER_LIVE=1 (needs network): npm run test:live
const should = require('should');
const lib = require('../lib/elpriser');
const { createClient } = require('../lib/client');

const live = process.env.ELPRISER_LIVE === '1';
(live ? describe : describe.skip)('live elpriser.org', function () {
  this.timeout(30000);

  it('DK1: the current slot equals /api/now, the 4 cheapest hours equal /api/schedule', async () => {
    const hdr = { headers: { 'User-Agent': 'node-red-contrib-elpriser-tests' } };
    const [nowRes, schedRes] = await Promise.all([
      fetch('https://elpriser.org/api/now?area=DK1&mode=inkl_alt', hdr).then((r) => r.json()),
      fetch('https://elpriser.org/api/schedule?area=DK1&mode=inkl_alt&strategy=cheapest_n&hours=4', hdr).then((r) => r.json())
    ]);
    const { data } = await createClient({ zone: 'dk1' }).get();
    const t = Date.now();
    lib.currentSlot(data, t).slot.value.should.be.approximately(nowRes.price, 1e-4);
    const mine = lib
      .cheapestHours(lib.slotsOnDay(data, t), 4)
      .map((s) => lib.localHour(s.start, data.tz))
      .sort((a, b) => a - b);
    const theirs = schedRes.schedule.filter((s) => s.on).map((s) => s.hour);
    mine.should.eql(theirs);
  });

  for (const zone of lib.ZONES.map((z) => z.key)) {
    it(`${zone}: parses, covers now (gb: or the last complete hour), has a price`, async () => {
      const { data } = await createClient({ zone }).get();
      const cur = lib.currentSlot(data, Date.now());
      should.exist(cur.slot, `${zone} has no price for the current hour`);
      cur.slot.value.should.be.a.Number();
      data.unit.should.match(/^[A-Z]{3}\/kWh$/);
    });
  }
});
