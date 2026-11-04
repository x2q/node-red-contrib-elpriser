# node-red-contrib-elpriser

[![Tests](https://github.com/x2q/node-red-contrib-elpriser/actions/workflows/tests.yml/badge.svg)](https://github.com/x2q/node-red-contrib-elpriser/actions/workflows/tests.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Node-RED](https://nodered.org) nodes for hourly electricity prices from [elpriser.org](https://elpriser.org):
the price right now, the cheapest hours (or the cheapest run of hours in a row) and the price forecast.

* **40 price zones**: Denmark (DK1/DK2), the other Nordic zones and the Netherlands, most of continental
  Europe, Great Britain and Ireland.
* **Free, no account, no API key, no telemetry.** The nodes only talk to `elpriser.org`.
* **Denmark: the price you pay** - spot + Energinet's tariffs + electricity duty + VAT, and with your grid
  company's GLN also the grid tariff.
* **No runtime dependencies**, Node.js 18 or newer, Node-RED 3 or newer.
* **Gentle on the service**: one request per zone per hour, shared by all nodes (details below).

## Install

From the Node-RED user directory (usually `~/.node-red`):

```bash
npm install node-red-contrib-elpriser
```

Or search for `node-red-contrib-elpriser` under **Manage palette > Install** in Node-RED. The package is on
[npm](https://www.npmjs.com/package/node-red-contrib-elpriser).

Restart Node-RED. The nodes appear in the palette under **elpriser**. Example flows: *Import > Examples >
node-red-contrib-elpriser* (or the files in [`examples/`](examples)).

## Nodes

All nodes use one **elpriser-config** node: the zone, for Denmark the price type and grid company GLN, and the
currency (the zone's own, or EUR).

### price now

Sends `msg.payload` = the price per kWh of the current hour in the zone's currency, and in `msg.elpriser`:

```js
{
  zone: "dk1", currency: "DKK", unit: "DKK/kWh",
  price: 2.3166, start: "2026-11-03T10:00:00.000Z", end: "2026-11-03T11:00:00.000Z", type: "actual",
  next: { start: "...", end: "...", price: 2.2758, type: "actual" },
  level: "cheap",                      // cheap | normal | expensive: where it lies in today's range
  today: { min: 2.209, max: 3.0903, average: 2.52244, cheapestStart: "...", mostExpensiveStart: "..." },
  tomorrowPublished: false, stale: false, attribution: null
}
```

Optionally it also sends by itself a few seconds after every full hour.

### cheapest hours

Finds **the N cheapest hours** (any hours) or **the cheapest run of N hours in a row**, in the **next H hours**
(from the current hour) or in **today** (the zone's calendar day, as in "is this one of today's 4 cheapest hours").
`msg.payload` is `true` while the current hour is one of them. `msg.elpriser`:

```js
{ active: false, strategy: "hours", count: 4, slots: [ { start, end, price, type }, ... ],
  start, end, average, nextStart, basedOnForecast: false, hoursConsidered: 13, hoursInHorizon: 24 }
```

An optional **max price** keeps expensive hours out (for a run: its average). With the hourly option the node
sends by itself after every full hour, optionally only when `payload` changes: wire it straight to a switch.
Per message you can override `msg.count`, `msg.lookahead`, `msg.maxPrice`, `msg.scope`, `msg.strategy`
and `msg.includeForecast`.

### price forecast

`msg.payload` is the hourly price list from the current hour (or midnight): `[{ start, end, price, type, min, max }]`
where `type` is `actual` (a published price) or `forecast`, and `min`/`max` are the model's P10/P90 band on forecast
hours. Ready for charts and dashboards.

> **The forecast hours are elpriser.org's own statistical model, not an official forecast.** It ranks the cheapest
> hours of a day better than it hits the price level, the error grows with the horizon, and an hour is replaced
> by the settled day-ahead price when it is published (about 13:00 CET for the next day). Because of that the
> *cheapest hours* node leaves forecast hours out unless you tick **Also use model-forecast hours**, and then it
> sets `msg.elpriser.basedOnForecast`. Model and accuracy: <https://elpriser.org/prognose>. There is no forecast
> for `gb` and `xk`.

### Testing and what-if: `msg.now`

Every node accepts `msg.now` (milliseconds or an ISO 8601 string) to pretend it is another moment.

## Prices, units, time

* **Outside Denmark** the number is the **wholesale (day-ahead) price without VAT, taxes and grid fees**, in the
  zone's currency converted with the ECB reference rate (or EUR). It is not what a household pays.
* **Denmark** (`dk1`, `dk2`): `inkl_alt` = spot + Energinet system and transmission tariff + electricity duty +
  25 % VAT, everything except your own grid company's tariff; `net_inkl_alt` = the full price, adds the tariff of
  the grid company with the given 13-digit GLN (list: <https://elpriser.org/tariffer>); `spot_inkl` / `spot_ex` =
  the raw spot price with / without VAT; the `*_elvarme` variants use the reduced duty for electrically heated
  homes. Danish zones are DKK; in EUR the node falls back to the wholesale price.
* **Great Britain** is the within-day Market Index Price in GBP, not a day-ahead price. An hour is only priced
  once it is over, so *price now* sends the last complete hour (up to three hours old) with `stale: true`, there is
  no tomorrow, and the *cheapest hours* node only sees the hours that are priced. Portugal and Ireland lack the
  price for the last hour of a published day; the nodes treat it as an hour without a price.
* **Time**: the service speaks in local hours (0-23) per calendar day of the zone. The nodes turn them into
  absolute one-hour slots with the IANA time zone of the zone (verified for all 40 zones through a whole year),
  so a 23- or 25-hour day at a clock change is handled: on a 25-hour day the doubled hour carries one price for
  both occurrences, as the service delivers it. Timestamps on messages are ISO 8601 UTC.
  The Nordic zones and the Netherlands run on the Copenhagen clock; **Finland runs on Helsinki time** (elpriser.org
  cuts `fi` into Helsinki days since 2026-11-03: hour 0 is 00:00 Helsinki, 22:00 UTC in winter).

## API etiquette

elpriser.org is a free service, edge-cached for 30-60 minutes. The nodes keep it light:

* **One request per zone per hour** for the whole day set (today, tomorrow once published, the forecast days),
  shared by every node that uses the same config node, with in-flight de-duplication. "Now" is picked locally.
* **If-None-Match / ETag**: an unchanged answer costs a `304`.
* Between 13:00 and 18:00 CET, while tomorrow is not published yet, a refresh every 20 minutes (still edge-cached).
* **Back-off on errors**: 5, 10, 20, 40 minutes, then hourly; `Retry-After` is honoured. While the data we hold
  still covers the current hour, the nodes keep using it and add `msg.elpriser.warning`.
* A `User-Agent` of `node-red-contrib-elpriser/<version>`, a 30 second timeout. Nothing but the zone (and for
  Denmark the price type and GLN) is sent.

## Data sources and licences

Prices come from Energi Data Service (Energinet), ENTSO-E, Energy-Charts, SEMOpx and Elexon via elpriser.org.
Zones from Bundesnetzagentur | SMARD.de via Energy-Charts.info are CC BY 4.0 (hourly means of the 15-minute
prices, changed); `gb` carries *Contains BMRS data © Elexon Limited copyright and database right <year>*.
`msg.elpriser.attribution` holds the text that applies to the zone; show it if you publish the numbers.

## Development

```bash
npm ci
npm test                 # unit tests, node tests with node-red-node-test-helper against a mock of recorded live answers, example flows
npm run test:live        # all 40 zones against the live service (needs network)
```

`lib/` is plain Node.js without Node-RED imports; `test/fixtures` are recorded live answers
(2026-11-03). MIT licensed. Issues: <https://github.com/x2q/node-red-contrib-elpriser/issues>.
Not affiliated with Node-RED / the OpenJS Foundation.

---

*Kort på dansk:* Node-RED-noder til elpriser fra elpriser.org: prisen lige nu, de billigste timer (eller det
billigste sammenhængende vindue) de næste N timer, og prognosen. 40 prisområder, gratis og uden nøgle. For
Danmark kan du få den fulde pris inkl. nettarif ved at vælge `net_inkl_alt` og dit netselskabs GLN-nummer.
Prognose-timerne er en statistisk model, ikke en officiel prognose, og bruges kun af "billigste timer" hvis du
sætter kryds i det. Installation: `npm install node-red-contrib-elpriser` i `~/.node-red`.
