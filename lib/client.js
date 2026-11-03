'use strict';
/**
 * A small caching client for one zone. Etiquette (elpriser.org is a free service, edge-cached 30-60 min):
 *  - the whole day set of a zone comes in ONE request, shared by every node that uses the same config node;
 *  - the answer is kept for 60 minutes (20 minutes between 13:00 and 18:00 CET while tomorrow's prices are
 *    not published yet) and revalidated with If-None-Match, so an unchanged answer costs a 304;
 *  - errors back off 5, 10, 20, 40 minutes, then hourly (Retry-After is honoured); while the data we hold
 *    still covers the current hour it keeps being served;
 *  - a descriptive User-Agent, a 30 second timeout, nothing but the zone (and for Denmark price type and GLN)
 *    in the URL.
 */

const lib = require('./elpriser');

const MINUTE = 60000;
const REFRESH = 60 * MINUTE;
const CATCH_UP = 20 * MINUTE;
const TIMEOUT = 30000;
const BACKOFF = [5, 10, 20, 40].map((m) => m * MINUTE);

class ElpriserHttpError extends Error {
  constructor(status, retryAfterMs) {
    super(`elpriser.org answered HTTP ${status}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs || null;
  }
}

function retryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/**
 * @param {{zone:string, mode?:string, gln?:string, currency?:string, baseUrl?:string, userAgent?:string,
 *          fetch?:Function, now?:()=>number}} cfg
 */
function createClient(cfg) {
  const request = lib.buildRequest(cfg);
  const base = String(cfg.baseUrl || 'https://elpriser.org').replace(/\/+$/, '');
  const doFetch = cfg.fetch || (typeof fetch === 'function' ? fetch : null);
  const clock = cfg.now || Date.now;
  const userAgent = cfg.userAgent || 'node-red-contrib-elpriser';
  if (!doFetch) throw new Error('no global fetch (Node.js 18 or newer is needed)');

  const url = `${base}${request.path}?${new URLSearchParams(request.params).toString()}`;
  let data = null; // parsed
  let etag = null;
  let fetchedAt = 0;
  let nextTryAt = 0; // not before (after errors)
  let failures = 0;
  let inflight = null;
  let lastError = null;

  function ttl(now) {
    if (data && data.zone !== 'gb' && !lib.tomorrowPublished(data, now)) {
      const cphHour = lib.localHour(now, 'Europe/Copenhagen');
      if (cphHour >= 13 && cphHour < 18) return CATCH_UP;
    }
    return REFRESH;
  }

  async function fetchOnce() {
    const headers = { Accept: 'application/json', 'User-Agent': userAgent };
    if (etag && data) headers['If-None-Match'] = etag;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const res = await doFetch(url, { headers, signal: ctl.signal });
      if (res.status === 304 && data) return null;
      if (!res.ok) throw new ElpriserHttpError(res.status, retryAfter(res.headers.get('retry-after')));
      const payload = await res.json();
      return { data: lib.parse(payload, cfg), etag: res.headers.get('etag') };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {{now?:number, force?:boolean}} [opts]
   * @returns {Promise<{data:object, fetchedAt:number, stale:boolean, error:(Error|null)}>}
   */
  async function get(opts = {}) {
    const now = opts.now !== undefined ? opts.now : clock();
    const wallNow = clock();
    const fresh = data && wallNow - fetchedAt < ttl(wallNow);
    if (fresh && !opts.force) return { data, fetchedAt, stale: false, error: null };
    if (wallNow < nextTryAt) {
      if (data) return serveOld(now, lastError);
      throw lastError || new Error('backing off after an error');
    }
    if (!inflight) {
      inflight = (async () => {
        try {
          const got = await fetchOnce();
          if (got) {
            data = got.data;
            etag = got.etag;
          }
          fetchedAt = clock();
          failures = 0;
          nextTryAt = 0;
          lastError = null;
        } catch (err) {
          lastError = err;
          const wait = (err && err.retryAfterMs) || (failures < BACKOFF.length ? BACKOFF[failures] : REFRESH);
          failures++;
          nextTryAt = clock() + wait;
        } finally {
          inflight = null;
        }
      })();
    }
    await inflight;
    if (lastError) return serveOld(now, lastError);
    return { data, fetchedAt, stale: false, error: null };
  }

  /** On errors: keep serving what we hold while it still covers `now`. */
  function serveOld(now, err) {
    if (data && (lib.slotAt(data, now) || (data.zone === 'gb' && lib.currentSlot(data, now).slot))) {
      return { data, fetchedAt, stale: true, error: err };
    }
    throw err || new Error('no price data');
  }

  return {
    url,
    get,
    request,
    /** For tests and diagnostics. */
    state: () => ({ fetchedAt, failures, nextTryAt, etag, hasData: !!data })
  };
}

module.exports = { createClient, ElpriserHttpError, REFRESH, CATCH_UP };
