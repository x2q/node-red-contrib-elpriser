'use strict';
const lib = require('./elpriser');

/** "HH:MM" of an instant on the zone's own wall clock. */
function clock(ms, tz) {
  return new Date(ms + lib.tzOffsetMs(ms, tz)).toISOString().slice(11, 16);
}

function price(v, digits = 3) {
  return v === null || v === undefined ? '-' : String(Number(v.toFixed(digits)));
}

module.exports = { clock, price };
