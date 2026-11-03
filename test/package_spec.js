'use strict';
const should = require('should');
const fs = require('fs');
const path = require('path');
const helper = require('node-red-node-test-helper');
const lib = require('../lib/elpriser');
const mock = require('./mockserver');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

describe('package', () => {
  it('follows the Node-RED packaging rules', () => {
    pkg.keywords.should.containEql('node-red');
    pkg.license.should.equal('MIT');
    pkg['node-red'].version.should.be.a.String();
    pkg.repository.url.should.match(/github\.com\/x2q\/node-red-contrib-elpriser/);
    pkg.name.should.equal('node-red-contrib-elpriser');
    Object.keys(pkg['node-red'].nodes).should.eql(['elpriser-config', 'elpriser-price', 'elpriser-cheapest', 'elpriser-forecast']);
    for (const [type, file] of Object.entries(pkg['node-red'].nodes)) {
      fs.existsSync(path.join(root, file)).should.be.true(file);
      const html = read(file.replace(/\.js$/, '.html'));
      html.should.containEql(`RED.nodes.registerType("${type}"`);
      html.should.containEql(`data-template-name="${type}"`);
      html.should.containEql(`data-help-name="${type}"`);
      read(file).should.containEql(`registerType('${type}'`);
    }
    fs.existsSync(path.join(root, 'LICENSE')).should.be.true();
    pkg.files.should.containEql('examples');
  });

  it('the editor lists exactly the zones and price types of the library', () => {
    const html = read('nodes/elpriser-config.html');
    const zones = [...html.matchAll(/\["([a-z0-9-]+)", "[^"]+"\]/g)].map((m) => m[1]);
    zones.should.eql(lib.ZONES.map((z) => z.key));
    const modes = [...html.matchAll(/<option value="([a-z_]+)">(?:inkl|net|spot)_/g)].map((m) => m[1]);
    modes.slice().sort().should.eql(lib.DK_MODES.slice().sort());
  });

  it('has no runtime dependencies', () => {
    should(pkg.dependencies).be.undefined();
  });

  it('the zone table equals the zone list published by the live service spec (recorded 2026-11-03)', () => {
    const spec = [
      'dk1', 'dk2', 'no1', 'no2', 'no3', 'no4', 'no5', 'se1', 'se2', 'se3', 'se4', 'fi', 'nl', 'de', 'fr', 'pl', 'it-n', 'at', 'be',
      'ch', 'cz', 'hu', 'si', 'es', 'pt', 'sk', 'gr', 'ro', 'bg', 'hr', 'rs', 'ee', 'lv', 'lt', 'me', 'mk', 'al', 'xk', 'gb', 'ie'
    ];
    lib.ZONES.map((z) => z.key).should.eql(spec);
  });
});

describe('example flows', function () {
  this.timeout(15000);
  const core = (f) => require(path.join(root, 'node_modules/@node-red/nodes/core', f));
  const nodes = [
    core('common/20-inject.js'),
    core('function/10-switch.js'),
    core('function/10-function.js'),
    require('../nodes/elpriser-config.js'),
    require('../nodes/elpriser-price.js'),
    require('../nodes/elpriser-cheapest.js'),
    require('../nodes/elpriser-forecast.js')
  ];
  let srv;
  before(async () => {
    helper.init(require.resolve('node-red'));
    srv = await mock.start();
  });
  after(() => srv.close());
  beforeEach(() => helper.startServer());
  afterEach(async () => {
    await helper.unload();
    await helper.stopServer();
  });

  const files = fs.readdirSync(path.join(root, 'examples')).filter((f) => f.endsWith('.json'));
  it('there are examples', () => files.length.should.be.above(2));

  for (const file of files) {
    it(`${file} imports, runs against the mock service and produces a message`, async () => {
      const flow = JSON.parse(read('examples/' + file));
      const injects = [];
      for (const n of flow) {
        if (n.type === 'elpriser-config') n.baseUrl = srv.url;
        if (n.type === 'inject') {
          n.once = false;
          n.repeat = '';
          n.props = [{ p: 'now', v: '2026-11-03T10:15:00Z', vt: 'str' }];
          injects.push(n.id);
        }
        if (n.type === 'debug') {
          n.type = 'helper';
        }
      }
      await helper.load(nodes, flow);
      const outputs = flow.filter((n) => n.type === 'helper').map((n) => helper.getNode(n.id));
      const got = new Promise((resolve) => outputs.forEach((o) => o.on('input', resolve)));
      helper.getNode(injects[0]).receive({});
      const msg = await Promise.race([got, new Promise((_, rej) => setTimeout(() => rej(new Error('no message')), 8000))]);
      should.exist(msg.payload);
      if (msg.elpriser) msg.elpriser.zone.should.be.a.String();
    });
  }
});
