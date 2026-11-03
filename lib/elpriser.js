'use strict';
/**
 * Pure helpers for the elpriser.org API: request building, parsing into absolute one-hour slots,
 * and the queries the nodes need (current / next slot, day statistics, cheapest hours, cheapest window).
 * No Node-RED imports here, everything is unit-testable on recorded responses.
 *
 * The service speaks in local wall-clock hours (0-23) per calendar day. They are turned into absolute,
 * UTC-anchored one-hour slots, which is the only representation that survives daylight saving time:
 *  - a 25-hour day (clocks go back) carries ONE price for the doubled hour 2; both occurrences get it;
 *  - a 23-hour day (clocks go forward) has no hour 2.
 */

const ZONES = require('./zones.json');

const HOUR = 3600000;
const DECIMALS = 5;

/** Price modes of /api/forecast for the two Danish zones (DKK/kWh). */
const DK_MODES = [
  'inkl_alt',
  'spot_inkl',
  'spot_ex',
  'inkl_alt_minus',
  'inkl_alt_elvarme',
  'net_inkl_alt',
  'net_inkl_alt_elvarme',
  'net_inkl_tarif'
];
/** These need a grid company (GLN). */
const NET_MODES = ['net_inkl_alt', 'net_inkl_alt_elvarme', 'net_inkl_tarif'];

const ENERGY_CHARTS = ['de', 'fr', 'pl', 'it-n', 'at', 'be', 'ch', 'cz', 'hu', 'si'];

function zoneByKey(key) {
  return ZONES.find((z) => z.key === key) || null;
}

function isDanish(key) {
  return key === 'dk1' || key === 'dk2';
}

/** The licence / attribution text a zone's data requires, or null. */
function attribution(key, nowMs = Date.now()) {
  if (key === 'gb') {
    return `Contains BMRS data © Elexon Limited copyright and database right ${new Date(nowMs).getUTCFullYear()}`;
  }
  if (ENERGY_CHARTS.includes(key)) {
    return 'Price data: Bundesnetzagentur | SMARD.de via Energy-Charts.info, CC BY 4.0; hourly means of the 15-minute prices (changed)';
  }
  return null;
}

/**
 * Which URL to call.
 * @param {{zone:string, mode?:string, gln?:string, currency?:'local'|'eur'}} cfg
 * @returns {{path:string, params:Object<string,string>, danish:boolean}}
 */
function buildRequest(cfg) {
  const zone = zoneByKey(cfg.zone);
  if (!zone) throw new Error(`unknown zone "${cfg.zone}"`);
  if (isDanish(zone.key) && (cfg.currency || 'local') === 'local') {
    const mode = cfg.mode || 'inkl_alt';
    if (!DK_MODES.includes(mode)) throw new Error(`unknown price mode "${mode}"`);
    const params = { area: zone.key.toUpperCase(), mode };
    if (NET_MODES.includes(mode)) {
      if (!/^\d{13}$/.test(String(cfg.gln || ''))) throw new Error(`price mode ${mode} needs the 13-digit GLN of the grid company`);
      params.gln = String(cfg.gln);
    } else if (cfg.gln && /^\d{13}$/.test(String(cfg.gln))) {
      params.gln = String(cfg.gln);
    }
    return { path: '/api/forecast', params, danish: true };
  }
  return { path: '/api/nordic', params: { zone: zone.key }, danish: false };
}

// --- time zone helpers (no dependencies, Intl only) -----------------------------------------

const offsetFormats = new Map();

/** UTC offset of a zone at an instant, in ms (east of UTC positive). */
function tzOffsetMs(ms, tz) {
  let fmt = offsetFormats.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
    offsetFormats.set(tz, fmt);
  }
  const name = fmt.formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName').value;
  const m = /GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?/.exec(name);
  if (!m || !m[1]) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) * 60000;
}

/** Unix ms of 00:00 local time on a date "YYYY-MM-DD". */
function localMidnight(date, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

/** Local hour 0-23 of an instant. */
function localHour(ms, tz) {
  return new Date(ms + tzOffsetMs(ms, tz)).getUTCHours();
}

/** Local calendar date "YYYY-MM-DD" of an instant. */
function localDate(ms, tz) {
  return new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 10);
}

function nextDate(date) {
  return new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
}

/** Start of the hour (UTC-aligned, all zones have whole-hour offsets). */
function floorHour(ms) {
  return Math.floor(ms / HOUR) * HOUR;
}

// --- parsing ----------------------------------------------------------------------------------

class PriceDataError extends Error {}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function round(v) {
  return v === null ? null : Math.round(v * 10 ** DECIMALS) / 10 ** DECIMALS;
}

function expandDay(date, tz, rows, keys, scale, type) {
  const byHour = new Map();
  for (const row of rows) {
    if (row && Number.isInteger(row.hour) && row.hour >= 0 && row.hour <= 23) byHour.set(row.hour, row);
  }
  const start = localMidnight(date, tz);
  const end = localMidnight(nextDate(date), tz);
  const slots = [];
  // no clock change inside the day: the local hour is simply the distance from local midnight
  const fixed = tzOffsetMs(start, tz) === tzOffsetMs(end - 1, tz);
  for (let t = start; t < end; t += HOUR) {
    const row = byHour.get(fixed ? (t - start) / HOUR : localHour(t, tz));
    if (!row) continue; // the hour that does not exist (spring forward)
    const value = num(row[keys.price]);
    const lo = num(row[keys.min]);
    const hi = num(row[keys.max]);
    slots.push({
      start: t,
      end: t + HOUR,
      value: value === null ? null : round(value * scale),
      min: value === null || lo === null ? null : round(lo * scale),
      max: value === null || hi === null ? null : round(hi * scale),
      type
    });
  }
  return slots;
}

/**
 * Parse an /api/nordic or /api/forecast answer.
 * @param {object} payload parsed JSON
 * @param {{zone:string, currency?:'local'|'eur'}} cfg
 * @returns {{zone:string, tz:string, currency:string, unit:string, slots:Array, rate:(number|null), rateDate:(string|null), generated:(string|null), model:any}}
 */
function parse(payload, cfg) {
  const zone = zoneByKey(cfg.zone);
  if (!zone) throw new PriceDataError(`unknown zone "${cfg.zone}"`);
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.days) || payload.days.length === 0) {
    throw new PriceDataError('response has no days');
  }
  const danish = payload.area !== undefined && payload.zone === undefined;
  let keys;
  let scale;
  let currency;
  let rate = null;
  let rateDate = null;
  if (danish) {
    keys = { price: 'price', min: 'min', max: 'max' };
    scale = 1;
    currency = 'DKK';
  } else {
    const info = payload.zoneInfo;
    if (!info || typeof info !== 'object') throw new PriceDataError('response has no zoneInfo');
    const r = num(info.rate);
    if (r === null || r <= 0) throw new PriceDataError('zoneInfo has no usable rate');
    const sourceCurrency = String(payload.unit || 'EUR/MWh').split('/')[0].toUpperCase();
    const local = (cfg.currency || 'local') === 'local';
    // gb is delivered in GBP (rate 1); everything else in EUR with the ECB rate to the local currency
    currency = sourceCurrency === 'EUR' ? (local ? String(info.currency || 'EUR').toUpperCase() : 'EUR') : sourceCurrency;
    scale = (sourceCurrency === 'EUR' && local ? r : 1) / 1000;
    rate = r;
    rateDate = typeof info.rateDate === 'string' ? info.rateDate : null;
    keys = { price: 'eur_mwh', min: 'min_eur_mwh', max: 'max_eur_mwh' };
  }
  const byStart = new Map();
  for (const day of payload.days) {
    if (!day || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Array.isArray(day.prices)) continue;
    const type = day.type === 'forecast' ? 'forecast' : 'actual';
    for (const s of expandDay(day.date, zone.tz, day.prices, keys, scale, type)) byStart.set(s.start, s);
  }
  if (byStart.size === 0) throw new PriceDataError('response has no usable hours');
  const slots = [...byStart.keys()].sort((a, b) => a - b).map((k) => byStart.get(k));
  return {
    zone: zone.key,
    tz: zone.tz,
    currency,
    unit: `${currency}/kWh`,
    slots,
    rate,
    rateDate,
    generated: typeof payload.generated === 'string' ? payload.generated : null,
    model: payload.model !== undefined ? payload.model : null
  };
}

// --- queries ------------------------------------------------------------------------------------

function slotAt(data, ms) {
  return data.slots.find((s) => s.start <= ms && ms < s.end) || null;
}

/**
 * The slot whose price applies at `ms`. For gb, where an hour is only priced once it is over, a missing
 * price falls back to the last priced hour that ended at most `maxAgeHours` ago (`stale: true`).
 */
function currentSlot(data, ms, maxAgeHours = 3) {
  const slot = slotAt(data, ms);
  if (slot && slot.value !== null) return { slot, stale: false };
  if (data.zone !== 'gb') return { slot: slot && slot.value !== null ? slot : null, stale: false };
  const past = data.slots.filter((s) => s.value !== null && s.end <= ms && ms - s.end <= maxAgeHours * HOUR);
  return past.length ? { slot: past[past.length - 1], stale: true } : { slot: null, stale: false };
}

function nextSlot(data, ms) {
  const cur = slotAt(data, ms);
  if (!cur) return null;
  const next = data.slots.find((s) => s.start === cur.end);
  return next && next.value !== null ? next : null;
}

/** The slots of the zone's local calendar day that contains `ms`. */
function slotsOnDay(data, ms) {
  const day = localDate(ms, data.tz);
  return data.slots.filter((s) => localDate(s.start, data.tz) === day);
}

function priced(slots) {
  return slots.filter((s) => s.value !== null);
}

function dayStats(slots) {
  const p = priced(slots);
  if (!p.length) return null;
  const min = p.reduce((a, s) => (s.value < a.value ? s : a));
  const max = p.reduce((a, s) => (s.value > a.value ? s : a));
  const avg = p.reduce((sum, s) => sum + s.value, 0) / p.length;
  return { min, max, average: round(avg), count: p.length };
}

/** cheap / normal / expensive: lowest third of today's range, middle, highest third; a flat day is normal. */
function priceLevel(value, stats) {
  if (value === null || value === undefined || !stats) return null;
  const low = stats.min.value;
  const high = stats.max.value;
  const span = high - low;
  if (span <= 0 || span < 0.005 * Math.max(Math.abs(low), Math.abs(high))) return 'normal';
  const pos = (value - low) / span;
  if (pos <= 1 / 3) return 'cheap';
  if (pos >= 2 / 3) return 'expensive';
  return 'normal';
}

/** The n cheapest priced slots (earliest wins a tie), in time order. */
function cheapestHours(slots, n, maxPrice = null) {
  const p = priced(slots).filter((s) => maxPrice === null || s.value <= maxPrice);
  return p
    .slice()
    .sort((a, b) => a.value - b.value || a.start - b.start)
    .slice(0, Math.max(0, n))
    .sort((a, b) => a.start - b.start);
}

/**
 * The cheapest run of `n` consecutive priced hours (lowest sum, earliest wins a tie).
 * With `maxAverage` a window whose average is higher is not eligible.
 */
function cheapestWindow(slots, n, maxAverage = null) {
  if (n < 1) return null;
  let best = null;
  for (let i = 0; i + n <= slots.length; i++) {
    const run = slots.slice(i, i + n);
    let ok = true;
    let sum = 0;
    for (let j = 0; j < run.length; j++) {
      if (run[j].value === null || (j > 0 && run[j].start !== run[j - 1].end)) {
        ok = false;
        break;
      }
      sum += run[j].value;
    }
    if (!ok) continue;
    if (maxAverage !== null && sum / n > maxAverage) continue;
    if (best === null || sum < best.sum) best = { slots: run, sum };
  }
  return best ? { slots: best.slots, average: round(best.sum / n) } : null;
}

/** Slots from the start of the current hour for `hours` hours (at most `hours` slots). */
function nextHours(data, ms, hours) {
  const from = floorHour(ms);
  const to = from + hours * HOUR;
  return data.slots.filter((s) => s.start >= from && s.start < to);
}

/** True if some `actual` slot with a price lies on the local calendar day after the one containing `ms`. */
function tomorrowPublished(data, ms) {
  const target = nextDate(localDate(ms, data.tz));
  return data.slots.some((s) => s.value !== null && s.type === 'actual' && localDate(s.start, data.tz) === target);
}

const iso = (ms) => new Date(ms).toISOString();

/** A slot in the shape the nodes put on messages. */
function view(slot) {
  if (!slot) return null;
  const out = { start: iso(slot.start), end: iso(slot.end), price: slot.value, type: slot.type };
  if (slot.min !== null) out.min = slot.min;
  if (slot.max !== null) out.max = slot.max;
  return out;
}

/** Accepts a number (ms), a Date or an ISO string; anything else is "now". */
function parseNow(v, fallback = Date.now()) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v instanceof Date && Number.isFinite(v.getTime())) return v.getTime();
  if (typeof v === 'string' && v !== '') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}

module.exports = {
  ZONES,
  DK_MODES,
  NET_MODES,
  HOUR,
  PriceDataError,
  zoneByKey,
  isDanish,
  attribution,
  buildRequest,
  tzOffsetMs,
  localMidnight,
  localHour,
  localDate,
  floorHour,
  parse,
  slotAt,
  currentSlot,
  nextSlot,
  slotsOnDay,
  dayStats,
  priceLevel,
  cheapestHours,
  cheapestWindow,
  nextHours,
  tomorrowPublished,
  view,
  parseNow
};
