'use strict';
const lib = require('../lib/elpriser');
const { hourly } = require('../lib/hourly');
const fmt = require('../lib/format');

module.exports = function (RED) {
  function toNumber(v, dflt) {
    const n = Number(v);
    return v !== '' && v !== null && v !== undefined && Number.isFinite(n) ? n : dflt;
  }

  function ElpriserCheapestNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    node.strategy = config.strategy === 'window' ? 'window' : 'hours';
    node.count = Math.max(1, Math.floor(toNumber(config.count, 4)));
    node.scope = config.scope === 'today' ? 'today' : 'next';
    node.lookahead = Math.max(1, Math.floor(toNumber(config.lookahead, 24)));
    node.includeForecast = !!config.includeForecast;
    node.maxPrice = config.maxPrice === '' || config.maxPrice === undefined ? null : toNumber(config.maxPrice, null);
    node.autoEmit = !!config.autoEmit;
    node.onlyChange = !!config.onlyChange;
    let lastActive = null;

    if (!server) {
      node.status({ fill: 'red', shape: 'ring', text: 'no elpriser config' });
      return;
    }

    /** Settings can be overridden per message: msg.count, msg.lookahead, msg.maxPrice, msg.scope, msg.strategy. */
    function settings(msg) {
      const s = {
        strategy: msg && (msg.strategy === 'window' || msg.strategy === 'hours') ? msg.strategy : node.strategy,
        count: msg && msg.count !== undefined ? Math.max(1, Math.floor(toNumber(msg.count, node.count))) : node.count,
        scope: msg && (msg.scope === 'today' || msg.scope === 'next') ? msg.scope : node.scope,
        lookahead:
          msg && msg.lookahead !== undefined ? Math.max(1, Math.floor(toNumber(msg.lookahead, node.lookahead))) : node.lookahead,
        maxPrice: msg && msg.maxPrice !== undefined ? toNumber(msg.maxPrice, null) : node.maxPrice,
        includeForecast: msg && typeof msg.includeForecast === 'boolean' ? msg.includeForecast : node.includeForecast
      };
      return s;
    }

    async function compute(base) {
      const now = lib.parseNow(base && base.now);
      const s = settings(base);
      const { data, stale, error } = await server.getData({ now });

      let candidates = s.scope === 'today' ? lib.slotsOnDay(data, now) : lib.nextHours(data, now, s.lookahead);
      const considered = candidates.length;
      if (!s.includeForecast) candidates = candidates.filter((x) => x.type === 'actual');
      candidates = candidates.filter((x) => x.value !== null);

      let chosen = [];
      let average = null;
      if (s.strategy === 'window') {
        const w = lib.cheapestWindow(candidates, s.count, s.maxPrice);
        if (w) {
          chosen = w.slots;
          average = w.average;
        }
      } else {
        chosen = lib.cheapestHours(candidates, s.count, s.maxPrice);
        if (chosen.length) average = Math.round((chosen.reduce((a, x) => a + x.value, 0) / chosen.length) * 1e5) / 1e5;
      }

      const active = chosen.some((x) => x.start <= now && now < x.end);
      const nextChosen = chosen.find((x) => x.start > now) || null;
      const out = base || {};
      out.topic = out.topic || `elpriser/${data.zone}/cheapest`;
      out.payload = active;
      out.elpriser = {
        zone: data.zone,
        currency: data.currency,
        unit: data.unit,
        strategy: s.strategy,
        scope: s.scope,
        count: s.count,
        lookahead: s.scope === 'next' ? s.lookahead : null,
        active,
        start: chosen.length ? new Date(chosen[0].start).toISOString() : null,
        end: chosen.length ? new Date(chosen[chosen.length - 1].end).toISOString() : null,
        average,
        slots: chosen.map(lib.view),
        nextStart: nextChosen ? new Date(nextChosen.start).toISOString() : null,
        basedOnForecast: chosen.some((x) => x.type === 'forecast'),
        // how many hours of the horizon had a price we were allowed to use
        hoursConsidered: candidates.length,
        hoursInHorizon: considered,
        stale,
        attribution: lib.attribution(data.zone, now)
      };
      if (chosen.length < (s.strategy === 'window' ? s.count : 1)) {
        out.elpriser.reason = candidates.length === 0 ? 'no prices in the horizon' : 'no hour or window matches the settings';
      } else if (s.strategy === 'hours' && chosen.length < s.count) {
        out.elpriser.reason = `only ${chosen.length} of ${s.count} hours have a price`;
      }
      if (error) out.elpriser.warning = `using older data: ${error.message}`;

      if (chosen.length) {
        const first = fmt.clock(chosen[0].start, data.tz);
        const last = fmt.clock(chosen[chosen.length - 1].end, data.tz);
        node.status({
          fill: active ? 'green' : 'grey',
          shape: active ? 'dot' : 'ring',
          text: `${active ? 'cheap now' : 'not now'}: ${s.strategy === 'window' ? first + '-' + last : chosen.length + ' h'}, avg ${fmt.price(average)}`
        });
      } else {
        node.status({ fill: 'yellow', shape: 'ring', text: out.elpriser.reason || 'nothing chosen' });
      }
      return out;
    }

    node.on('input', async (msg, send, done) => {
      try {
        const out = await compute(msg);
        lastActive = out.payload;
        send(out);
        if (done) done();
      } catch (err) {
        node.status({ fill: 'red', shape: 'ring', text: String(err.message).slice(0, 60) });
        if (done) done(err);
        else node.error(err, msg);
      }
    });

    if (node.autoEmit) {
      const cancel = hourly(async () => {
        try {
          const out = await compute({});
          const changed = lastActive !== out.payload;
          lastActive = out.payload;
          if (!node.onlyChange || changed) node.send(out);
        } catch (err) {
          node.status({ fill: 'red', shape: 'ring', text: String(err.message).slice(0, 60) });
          node.error(err);
        }
      });
      node.on('close', cancel);
    }
  }

  RED.nodes.registerType('elpriser-cheapest', ElpriserCheapestNode);
};
