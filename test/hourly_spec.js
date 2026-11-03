'use strict';
const should = require('should');
const { hourly } = require('../lib/hourly');

describe('lib/hourly', () => {
  it('fires just after every full hour and can be cancelled', async () => {
    let t = Date.parse('2026-11-03T10:15:00Z');
    const timers = [];
    const calls = [];
    const stop = hourly(() => calls.push(t), {
      now: () => t,
      jitterMs: 5000,
      setTimeout: (fn, ms) => {
        const h = { fn, ms };
        timers.push(h);
        return h;
      },
      clearTimeout: (h) => {
        h.cleared = true;
      }
    });
    timers.should.have.length(1);
    timers[0].ms.should.equal(45 * 60000 + 5000);
    t += timers[0].ms;
    await timers[0].fn();
    calls.should.have.length(1);
    timers.should.have.length(2);
    timers[1].ms.should.equal(3600000);
    stop();
    timers[1].cleared.should.be.true();
  });

  it('keeps going when the callback throws', async () => {
    let t = 0;
    const timers = [];
    hourly(
      () => {
        throw new Error('x');
      },
      { now: () => t, jitterMs: 0, setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers[timers.length - 1]) }
    );
    await timers[0].fn();
    timers.should.have.length(2);
  });
});
