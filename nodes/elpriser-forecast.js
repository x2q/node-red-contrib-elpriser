'use strict';
const lib = require('../lib/elpriser');
const { hourly } = require('../lib/hourly');

module.exports = function (RED) {
  function ElpriserForecastNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const server = RED.nodes.getNode(config.server);
    node.from = config.from === 'today' ? 'today' : 'now';
    const h = Number(config.hours);
    node.hours = Number.isFinite(h) && h >= 0 ? Math.floor(h) : 48; // 0 = everything the service has
    node.includeForecast = config.includeForecast !== false;
    node.autoEmit = !!config.autoEmit;

    if (!server) {
      node.status({ fill: 'red', shape: 'ring', text: 'no elpriser config' });
      return;
    }

    async function compute(base) {
      const now = lib.parseNow(base && base.now);
      const { data, stale, error } = await server.getData({ now });
      const from = node.from === 'today' ? lib.localMidnight(lib.localDate(now, data.tz), data.tz) : lib.floorHour(now);
      const to = node.hours > 0 ? from + node.hours * lib.HOUR : Infinity;
      const slots = data.slots.filter(
        (s) => s.start >= from && s.start < to && s.value !== null && (node.includeForecast || s.type === 'actual')
      );
      const out = base || {};
      out.topic = out.topic || `elpriser/${data.zone}/forecast`;
      out.payload = slots.map(lib.view);
      const model = slots.filter((s) => s.type === 'forecast');
      out.elpriser = {
        zone: data.zone,
        currency: data.currency,
        unit: data.unit,
        count: slots.length,
        actualHours: slots.length - model.length,
        forecastHours: model.length,
        firstForecastStart: model.length ? new Date(model[0].start).toISOString() : null,
        tomorrowPublished: lib.tomorrowPublished(data, now),
        generated: data.generated,
        model: data.model,
        stale,
        note: model.length
          ? "type:'forecast' hours come from elpriser.org's own statistical model, not an official forecast; they are replaced by the settled price when published"
          : null,
        attribution: lib.attribution(data.zone, now)
      };
      if (error) out.elpriser.warning = `using older data: ${error.message}`;
      node.status({
        fill: stale ? 'yellow' : 'green',
        shape: 'dot',
        text: `${slots.length} h (${model.length} forecast)`
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

  RED.nodes.registerType('elpriser-forecast', ElpriserForecastNode);
};
