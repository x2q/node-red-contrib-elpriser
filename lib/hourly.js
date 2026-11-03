'use strict';
/**
 * Calls `fn` a few seconds after every full hour (the price changes on the hour; a little spread keeps
 * every installation from asking in the same second). Returns a function that cancels the timer.
 */
const { HOUR, floorHour } = require('./elpriser');

function hourly(fn, opts = {}) {
  const now = opts.now || Date.now;
  const set = opts.setTimeout || setTimeout;
  const clear = opts.clearTimeout || clearTimeout;
  const jitter = opts.jitterMs !== undefined ? opts.jitterMs : 2000 + Math.floor(Math.random() * 28000);
  let timer = null;
  let stopped = false;

  function schedule() {
    if (stopped) return;
    const t = now();
    const at = floorHour(t) + HOUR + jitter;
    timer = set(async () => {
      timer = null;
      try {
        await fn();
      } catch (e) {
        /* the node reports its own errors */
      }
      schedule();
    }, Math.max(1000, at - t));
    if (timer && typeof timer.unref === 'function' && opts.unref) timer.unref();
  }

  schedule();
  return () => {
    stopped = true;
    if (timer) clear(timer);
    timer = null;
  };
}

module.exports = { hourly };
