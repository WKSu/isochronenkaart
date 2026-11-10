// Rotterdamse scenario's op de echte data + GeoPackage-export in Node.
// Draai met:  node --test tests/scenario.test.mjs
// Zet ISO_OUT=<map> om de GeoPackage te bewaren (voor build/check_gpkg.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, '..', 'docs');
const dataDir = path.join(docs, 'data');
const haveData = existsSync(path.join(dataDir, 'network.bin.gz'));

const require = createRequire(import.meta.url);
globalThis.initSqlJs = require(path.join(docs, 'vendor', 'sql-wasm.js'));
for (const f of ['vendor/d3-array.min.js', 'vendor/d3-contour.min.js', 'vendor/proj4.js', 'js/core.js', 'js/gpkg.js']) {
  vm.runInThisContext(readFileSync(path.join(docs, f), 'utf8'), { filename: f });
}
const { IsoCore: Core, IsoGpkg: Gpkg, proj4 } = globalThis;
proj4.defs(
  'EPSG:28992',
  '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 ' +
    '+ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs',
);
const rd = proj4('EPSG:28992', 'EPSG:4326');
const loc = (id, lat, lng) => {
  const [x, y] = rd.inverse([lng, lat]);
  return { id, x, y };
};

// Coördinaten opgezocht via de PDOK Locatieserver
const P = {
  centraal: [51.92409, 4.47],
  charloisseHoofd: [51.89693, 4.46759], // zuidingang Maastunnel
  parkkade: [51.90317, 4.47041], // noordoever bij de Maastunnel
  boompjes: [51.91688, 4.49007], // noordoever bij de Erasmusbrug
  wilhelminakade: [51.90717, 4.48984], // zuidoever, Kop van Zuid
  spaansePolder: [51.92388, 4.42001], // tegen de grens met Schiedam
  hoekVanHolland: [51.98213, 4.11649],
};

function inRing(x, y, ring) {
  let binnen = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) binnen = !binnen;
  }
  return binnen;
}
const inMulti = (polys, x, y) => polys.some((p) => inRing(x, y, p[0]) && !p.slice(1).some((h) => inRing(x, y, h)));

let enginePromise = null;
function engine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const meta = JSON.parse(readFileSync(path.join(dataDir, 'network.json'), 'utf8'));
      const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      const net = Core.parseNetwork(meta, await Core.gunzip(ab(readFileSync(path.join(dataDir, 'network.bin.gz')))));
      const inw = Core.parseInwoners(await Core.gunzip(ab(readFileSync(path.join(dataDir, 'inwoners.bin.gz')))));
      const gebieden = JSON.parse(readFileSync(path.join(dataDir, 'gebieden.geojson'), 'utf8'));
      return { eng: Core.createEngine(net, inw), gebieden };
    })();
  }
  return enginePromise;
}

test('Maastunnel: fietsen van Charloisse Hoofd bereikt de noordoever binnen 10 min', { skip: !haveData }, async () => {
  const { eng } = await engine();
  const res = eng.compute({ modus: 'fietsen', snelheid: 15, banden: [5, 10], weergave: 'per', locaties: [loc('m', ...P.charloisseHoofd)], netwerk: false });
  const target = loc('t', ...P.parkkade);
  const polys = res.items[0].polygonen;
  console.log('  Parkkade binnen 5 min:', inMulti(polys[0], target.x, target.y), '| binnen 10 min:', inMulti(polys[1], target.x, target.y));
  assert.ok(inMulti(polys[1], target.x, target.y), 'Parkkade niet bereikt: fietstunnel ontbreekt?');
});

test('Erasmusbrug: lopen van de Boompjes steekt alleen via de brug over', { skip: !haveData }, async () => {
  const { eng } = await engine();
  const start = loc('b', ...P.boompjes);
  const res = eng.compute({ modus: 'lopen', snelheid: 5, banden: [10, 25], weergave: 'per', locaties: [start], netwerk: false });
  const zuid = loc('z', ...P.wilhelminakade);
  const polys = res.items[0].polygonen;
  // Nieuwe Maas tussen Boompjes en Wilhelminapier, ruim 250 m van beide bruggen (RD)
  const rivier = { x: 93300, y: 436650 };
  console.log('  Kop van Zuid binnen 10/25 min:', inMulti(polys[0], zuid.x, zuid.y), inMulti(polys[1], zuid.x, zuid.y));
  console.log('  rivier binnen 25 min:', inMulti(polys[1], rivier.x, rivier.y));
  assert.ok(!inMulti(polys[0], zuid.x, zuid.y), 'zuidoever binnen 10 min: te snel, oversteek zonder brug?');
  assert.ok(inMulti(polys[1], zuid.x, zuid.y), 'zuidoever niet bereikt binnen 25 min');
  assert.ok(!inMulti(polys[1], rivier.x, rivier.y), 'isochroon ligt midden in de Nieuwe Maas');
});

test('Grens: isochroon loopt door in Schiedam; Hoek van Holland 45 min raakt de rand', { skip: !haveData }, async () => {
  const { eng, gebieden } = await engine();
  const res = eng.compute({ modus: 'fietsen', snelheid: 15, banden: [10], weergave: 'per', locaties: [loc('s', ...P.spaansePolder)], netwerk: false });
  const gem = gebieden.features.find((f) => f.properties.soort === 'gemeente').geometry;
  const gemPolys = gem.type === 'Polygon' ? [gem.coordinates] : gem.coordinates;
  let buiten = 0;
  let totaal = 0;
  for (const poly of res.items[0].polygonen[0]) {
    for (const p of poly[0]) {
      const [lng, lat] = rd.forward(p);
      totaal++;
      if (!inMulti(gemPolys, lng, lat)) buiten++;
    }
  }
  console.log(`  ${buiten} van ${totaal} randpunten buiten de gemeente`);
  assert.ok(buiten > 0, 'isochroon stopt bij de gemeentegrens');
  assert.equal(res.items[0].raaktRand, false);

  const hvh = eng.compute({ modus: 'fietsen', snelheid: 15, banden: [45], weergave: 'per', locaties: [loc('h', ...P.hoekVanHolland)], netwerk: false });
  assert.equal(hvh.items[0].raaktRand, true);
});

test('Export: GeoPackage met drie lagen in RD New', { skip: !haveData }, async () => {
  const { eng } = await engine();
  const locs = [loc(1, ...P.centraal), loc(2, ...P.charloisseHoofd), loc(3, ...P.boompjes)];
  const t0 = Date.now();
  const res = eng.compute({ modus: 'fietsen', snelheid: 15, banden: [5, 10, 15], weergave: 'per', locaties: locs, netwerk: true });
  console.log(`  3 locaties x 15 min fietsen: ${Date.now() - t0} ms`);
  const samen = eng.compute({ modus: 'fietsen', snelheid: 15, banden: [5, 10, 15], weergave: 'samen', locaties: locs, netwerk: true });
  const items = [...res.items, ...samen.items];
  const names = { 1: 'Centraal', 2: 'Charloisse Hoofd', 3: 'Boompjes' };
  const banden = [5, 10, 15];
  const layers = [
    {
      naam: 'locaties',
      type: 'POINT',
      velden: [{ naam: 'naam', type: 'TEXT' }],
      features: locs.map((l) => ({ coords: [l.x, l.y], attrs: { naam: names[l.id] } })),
    },
    {
      naam: 'isochronen',
      type: 'MULTIPOLYGON',
      velden: [
        { naam: 'locatie', type: 'TEXT' },
        { naam: 'minuten', type: 'INTEGER' },
        { naam: 'opp_km2', type: 'REAL' },
        { naam: 'inwoners', type: 'INTEGER' },
      ],
      features: items.flatMap((it) =>
        it.polygonen.map((p, b) => ({
          coords: p,
          attrs: { locatie: it.locatieId === null ? 'gecombineerd' : names[it.locatieId], minuten: banden[b], opp_km2: it.statistiek[b].km2, inwoners: it.statistiek[b].inwoners },
        })),
      ),
    },
    {
      naam: 'bereikbaar_netwerk',
      type: 'MULTILINESTRING',
      velden: [
        { naam: 'locatie', type: 'TEXT' },
        { naam: 'minuten', type: 'INTEGER' },
      ],
      features: items.flatMap((it) =>
        it.netwerk.map((l, b) => ({ coords: l, attrs: { locatie: it.locatieId === null ? 'gecombineerd' : names[it.locatieId], minuten: banden[b] } })),
      ),
    },
  ];
  const bytes = await Gpkg.write(layers, path.join(docs, 'vendor') + path.sep);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 15)), 'SQLite format 3');
  // application_id 'GPKG' op byte 68
  assert.equal(new TextDecoder().decode(bytes.slice(68, 72)), 'GPKG');
  console.log(`  gpkg: ${(bytes.length / 1024).toFixed(0)} kB`);
  if (process.env.ISO_OUT) {
    mkdirSync(process.env.ISO_OUT, { recursive: true });
    const f = path.join(process.env.ISO_OUT, 'test_export.gpkg');
    writeFileSync(f, bytes);
    console.log('  geschreven:', f);
  }
});
