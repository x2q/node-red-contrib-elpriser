'use strict';
const lib = require('../lib/elpriser');
const { createClient } = require('../lib/client');

module.exports = function (RED) {
  function ElpriserConfigNode(n) {
    RED.nodes.createNode(this, n);
    this.zone = n.zone || 'dk1';
    this.mode = n.mode || 'inkl_alt';
    this.gln = (n.gln || '').trim();
    this.currency = n.currency === 'eur' ? 'eur' : 'local';
    try {
      this.client = createClient({
        zone: this.zone,
        mode: this.mode,
        gln: this.gln,
        currency: this.currency,
        baseUrl: n.baseUrl || undefined,
        userAgent: 'node-red-contrib-elpriser/' + require('../package.json').version
      });
    } catch (err) {
      this.client = null;
      this.configError = err.message;
      this.error(err.message);
    }

    /** Parsed price data of the zone (cached, shared by every node using this config). */
    this.getData = async (opts) => {
      if (!this.client) throw new Error(this.configError || 'elpriser config is invalid');
      return this.client.get(opts);
    };
    this.zoneInfo = lib.zoneByKey(this.zone);
  }

  RED.nodes.registerType('elpriser-config', ElpriserConfigNode);
};
