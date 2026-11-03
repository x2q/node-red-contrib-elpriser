'use strict';
const lib = require('../lib/elpriser');
const { hourly } = require('../lib/hourly');
const fmt = require('../lib/format');

module.exports = function (RED) {
  function ElpriserPriceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    node.autoEmit = !!config.autoEmit;

    if (!server) {
      node.status({ fill: 'red', shape: 'ring', text: 'no elpriser config' });
      return;
    }

    async function compute(base) {
      const now = lib.parseNow(base && base.now);
      const { data, stale, error, fetchedAt } = await server.getData({ now });
      const { slot, stale: gbStale } = lib.currentSlot(data, now);
      const next = lib.nextSlot(data, now);
      const stats = lib.dayStats(lib.slotsOnDay(data, now));
      const out = base || {};
      out.topic = out.topic || `elpriser/${data.zone}/price`;
      out.payload = slot ? slot.value : null;
      out.elpriser = {
        zone: data.zone,
        label: server.zoneInfo ? server.zoneInfo.label : data.zone,
        currency: data.currency,
        unit: data.unit,
        price: slot ? slot.value : null,
        start: slot ? new Date(slot.start).toISOString() : null,
        end: slot ? new Date(slot.end).toISOString() : null,
        type: slot ? slot.type : null,
        stale: gbStale || stale,
        next: lib.view(next),
        level: slot ? lib.priceLevel(slot.value, stats) : null,
        today: stats
          ? {
              min: stats.min.value,
              max: stats.max.value,
              average: stats.average,
              cheapestStart: new Date(stats.min.start).toISOString(),
              mostExpensiveStart: new Date(stats.max.start).toISOString()
            }
          : null,
        tomorrowPublished: lib.tomorrowPublished(data, now),
        generated: data.generated,
        fetchedAt: new Date(fetchedAt).toISOString(),
        attribution: lib.attribution(data.zone, now)
      };
      if (error) out.elpriser.warning = `using older data: ${error.message}`;
      const label = slot ? `${fmt.price(slot.value)} ${data.unit}` : 'no price for this hour';
      node.status({
        fill: slot ? (out.elpriser.stale ? 'yellow' : 'green') : 'yellow',
        shape: out.elpriser.stale ? 'ring' : 'dot',
        text: label + (out.elpriser.stale ? ' (older)' : '')
      });
      return out;
    }

    node.on('input', async (msg, send, done) => {
      try {
        send(await compute(msg));
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
          node.send(await compute({}));
        } catch (err) {
          node.status({ fill: 'red', shape: 'ring', text: String(err.message).slice(0, 60) });
          node.error(err);
        }
      });
      node.on('close', cancel);
    }
  }

  RED.nodes.registerType('elpriser-price', ElpriserPriceNode);
};
