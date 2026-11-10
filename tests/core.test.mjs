// Tests voor docs/js/core.js. Draai met:  node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.join(here, '..', 'docs');
for (const f of ['vendor/d3-array.min.js', 'vendor/d3-contour.min.js', 'js/core.js']) {
  vm.runInThisContext(readFileSync(path.join(docs, f), 'utf8'), { filename: f });
}
const Core = globalThis.IsoCore;
const { WALK, BIKE_FWD, BIKE_BWD, WALK_MAIN, BIKE_MAIN } = Core._.flags;
const ALL = WALK | BIKE_FWD | BIKE_BWD | WALK_MAIN | BIKE_MAIN;

/** Codeer een klein netwerk in hetzelfde binaire formaat als build_data.py. */
function encode(nodes, edges, rand = []) {
  const x0 = 0;
  const y0 = 0;
  const q = nodes.map(([x, y]) => [Math.round((x - x0) * 10), Math.round((y - y0) * 10)]);
  const ndx = [];
  const ndy = [];
  let px = 0;
  let py = 0;
  for (const [x, y] of q) {
    ndx.push(x - px);
    ndy.push(y - py);
    px = x;
    py = y;
  }
  const gdx = [];
  const gdy = [];
  const nv = [];
  for (const e of edges) {
    const mid = e.geom || [];
    nv.push(mid.length);
    let [lx, ly] = q[e.u];
    for (const [x, y] of mid) {
      const qx = Math.round(x * 10);
      const qy = Math.round(y * 10);
      gdx.push(qx - lx);
      gdy.push(qy - ly);
      lx = qx;
      ly = qy;
    }
  }
  const sections = [
    ['node_dx', 'int32', Int32Array.from(ndx)],
    ['node_dy', 'int32', Int32Array.from(ndy)],
    ['edge_u', 'uint32', Uint32Array.from(edges.map((e) => e.u))],
    ['edge_v', 'uint32', Uint32Array.from(edges.map((e) => e.v))],
    ['geom_dx', 'int32', Int32Array.from(gdx)],
    ['geom_dy', 'int32', Int32Array.from(gdy)],
    ['edge_nv', 'uint16', Uint16Array.from(nv)],
    ['node_flags', 'uint8', Uint8Array.from(nodes.map((_, i) => (rand.includes(i) ? 1 : 0)))],
    ['edge_flags', 'uint8', Uint8Array.from(edges.map((e) => e.f ?? ALL))],
  ];
  const total = sections.reduce((s, [, , a]) => s + a.byteLength, 0);
  const buf = new ArrayBuffer(total);
  const secties = {};
  let off = 0;
  for (const [name, type, arr] of sections) {
    new Uint8Array(buf, off, arr.byteLength).set(new Uint8Array(arr.buffer));
    secties[name] = { offset: off, length: arr.length, type };
    off += arr.byteLength;
  }
  const meta = { versie: 1, knopen: nodes.length, randen: edges.length, oorsprong: [x0, y0], secties };
  return Core.parseNetwork(meta, buf);
}

// Rooster van 5 x 5 knopen op 100 m, randen horizontaal en verticaal.
function grid() {
  const nodes = [];
  for (let j = 0; j < 5; j++) for (let i = 0; i < 5; i++) nodes.push([1000 + i * 100, 2000 + j * 100]);
  const edges = [];
  const id = (i, j) => j * 5 + i;
  for (let j = 0; j < 5; j++) {
    for (let i = 0; i < 5; i++) {
      if (i < 4) edges.push({ u: id(i, j), v: id(i + 1, j) });
      if (j < 4) edges.push({ u: id(i, j), v: id(i, j + 1) });
    }
  }
  return { nodes, edges, id };
}

test('decoderen: coordinaten, tussenpunten en lengtes', () => {
  const net = encode(
    [[0, 0], [100, 0], [100, 100]],
    [{ u: 0, v: 1 }, { u: 1, v: 2, geom: [[150, 0], [150, 100]] }],
  );
  assert.equal(net.NX[2], 100);
  assert.equal(net.NY[2], 100);
  assert.equal(net.LEN[0], 100);
  assert.equal(Math.round(net.LEN[1]), 50 + 100 + 50);
});

test('dijkstra: kortste afstanden op een rooster', () => {
  const g = grid();
  const net = encode(g.nodes, g.edges);
  const dist = Core._.dijkstra(net, 'lopen', [[g.id(0, 0), 0]], 1e9);
  assert.equal(dist[g.id(4, 4)], 800);
  assert.equal(dist[g.id(2, 1)], 300);
  const cut = Core._.dijkstra(net, 'lopen', [[g.id(0, 0), 0]], 250);
  assert.equal(cut[g.id(2, 0)], 200);
  assert.equal(cut[g.id(3, 0)], Infinity);
});

test('eenrichting voor de fiets, lopen in beide richtingen', () => {
  // 0 -> 1 -> 2 alleen vooruit voor de fiets; 2 -- 0 omweg van 1000 m
  const net = encode(
    [[0, 0], [100, 0], [200, 0]],
    [
      { u: 0, v: 1, f: WALK | BIKE_FWD | WALK_MAIN | BIKE_MAIN },
      { u: 1, v: 2, f: WALK | BIKE_FWD | WALK_MAIN | BIKE_MAIN },
      { u: 2, v: 0, f: ALL, geom: [[200, 500], [0, 500]] },
    ],
  );
  const bike = Core._.dijkstra(net, 'fietsen', [[2, 0]], 1e9);
  assert.equal(bike[1], 1300); // via de omweg en dan vooruit
  const walk = Core._.dijkstra(net, 'lopen', [[2, 0]], 1e9);
  assert.equal(walk[1], 100);
});

test('snap: dichtstbijzijnde rand, startknopen respecteren richting', () => {
  const net = encode(
    [[0, 0], [100, 0]],
    [{ u: 0, v: 1, f: WALK | BIKE_FWD | WALK_MAIN | BIKE_MAIN }],
  );
  const sn = Core._.snap(net, 'fietsen', 30, 20, 250);
  assert.equal(sn.edge, 0);
  assert.ok(Math.abs(sn.s - 30) < 1e-9);
  assert.ok(Math.abs(sn.access - 20) < 1e-9);
  const seeds = Core._.seedsFor(net, 'fietsen', sn);
  assert.deepEqual(seeds, [[1, 20 + 70]]); // alleen vooruit naar knoop 1
  const walkSeeds = Core._.seedsFor(net, 'lopen', Core._.snap(net, 'lopen', 30, 20, 250));
  assert.equal(walkSeeds.length, 2);
  assert.equal(Core._.snap(net, 'lopen', 30, 400, 250), null);
});

test('afstand langs de startrand gebruikt het startpunt zelf', () => {
  const net = encode([[0, 0], [1000, 0]], [{ u: 0, v: 1 }]);
  const sn = Core._.snap(net, 'lopen', 500, 0, 250);
  const dist = Core._.dijkstra(net, 'lopen', Core._.seedsFor(net, 'lopen', sn), 1e9);
  const field = Core._.makeField(dist, [sn]);
  assert.equal(Core._.edgeDist(net, 'lopen', field, 0, 500), 0);
  assert.equal(Core._.edgeDist(net, 'lopen', field, 0, 600), 100);
  assert.equal(Core._.edgeDist(net, 'lopen', field, 0, 0), 500);
});

test('engine: cumulatieve banden, oppervlak en inwoners', () => {
  const g = grid();
  const net = encode(g.nodes, g.edges);
  // Eén bewoonde cel van 100 m midden in het rooster: hm-coordinaten
  const inw = { n: 1, cx: Int32Array.of(12), cy: Int32Array.of(22), aantal: Int32Array.of(100) };
  const engine = Core.createEngine(net, inw);
  const res = engine.compute({
    modus: 'lopen',
    snelheid: 6, // 100 m per minuut
    banden: [2, 4],
    weergave: 'per',
    locaties: [{ id: 'a', x: 1200, y: 2200 }],
    netwerk: true,
  });
  assert.equal(res.fouten.length, 0);
  const it = res.items[0];
  assert.equal(it.polygonen.length, 2);
  assert.ok(it.polygonen[0].length >= 1);
  assert.ok(it.statistiek[1].km2 > it.statistiek[0].km2);
  assert.ok(it.statistiek[0].km2 > 0.05 && it.statistiek[1].km2 < 0.3, JSON.stringify(it.statistiek));
  assert.equal(it.statistiek[0].inwoners, 100);
  // netwerklijnen per band, totale lengte ~ alle 40 randen x 100 m (binnen 4 min)
  const len = it.netwerk.flat().reduce((s, l) => {
    for (let i = 1; i < l.length; i++) s += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
    return s;
  }, 0);
  assert.ok(Math.abs(len - 4000) < 1, 'lengte ' + len);
  assert.equal(it.raaktRand, false);
});

test('gecombineerd = minimum van de afzonderlijke locaties', () => {
  const g = grid();
  const net = encode(g.nodes, g.edges);
  const engine = Core.createEngine(net, null);
  const base = { modus: 'lopen', snelheid: 6, banden: [1, 2], netwerk: false };
  const locs = [{ id: 'a', x: 1000, y: 2000 }, { id: 'b', x: 1400, y: 2400 }];
  const per = engine.compute({ ...base, weergave: 'per', locaties: locs });
  const samen = engine.compute({ ...base, weergave: 'samen', locaties: locs });
  assert.equal(samen.items.length, 1);
  const sum = per.items[0].statistiek[1].km2 + per.items[1].statistiek[1].km2;
  assert.ok(Math.abs(samen.items[0].statistiek[1].km2 - sum) < 0.002); // geen overlap
});

test('vereenvoudigen houdt de ring gesloten en de vorm', () => {
  const ring = [];
  for (let i = 0; i <= 100; i++) ring.push([i, i % 2 ? 0.5 : 0]);
  ring.push([100, 50], [0, 50], [0, 0]);
  const s = Core._.simplifyRing(ring, 2);
  assert.ok(s.length < 10);
  assert.deepEqual(s[0], s[s.length - 1]);
});

// ------------------------------------------------------------ echte data
const dataDir = path.join(docs, 'data');
const haveData = existsSync(path.join(dataDir, 'network.bin.gz'));

async function loadReal() {
  const meta = JSON.parse(readFileSync(path.join(dataDir, 'network.json'), 'utf8'));
  const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const netBuf = await Core.gunzip(toAB(readFileSync(path.join(dataDir, 'network.bin.gz'))));
  const inwBuf = await Core.gunzip(toAB(readFileSync(path.join(dataDir, 'inwoners.bin.gz'))));
  const t0 = Date.now();
  const net = Core.parseNetwork(meta, netBuf);
  const ms = Date.now() - t0;
  return { net, inw: Core.parseInwoners(inwBuf), ms };
}

test('Rotterdam: Centraal Station, 10 min lopen en 15 min fietsen', { skip: !haveData }, async () => {
  const { net, inw, ms } = await loadReal();
  console.log(`  netwerk opbouwen: ${ms} ms`);
  const engine = Core.createEngine(net, inw);
  // Stationsplein, RD (ongeveer)
  const cs = { id: 'cs', x: 91840, y: 437724 };
  let t0 = Date.now();
  const walk = engine.compute({ modus: 'lopen', snelheid: 5, banden: [5, 10], weergave: 'per', locaties: [cs], netwerk: true });
  console.log(`  lopen 10 min: ${Date.now() - t0} ms`, JSON.stringify(walk.items[0].statistiek));
  assert.equal(walk.fouten.length, 0);
  const s = walk.items[0].statistiek;
  const circle = Math.PI * (10 * 83.33) ** 2 / 1e6;
  assert.ok(s[1].km2 < circle, `oppervlak ${s[1].km2} >= cirkel ${circle}`);
  assert.ok(s[1].km2 > 0.5 * circle * 0.5, 'onwaarschijnlijk klein');
  assert.ok(s[1].inwoners > 5000, 'inwoners ' + s[1].inwoners);

  t0 = Date.now();
  const bike = engine.compute({ modus: 'fietsen', snelheid: 15, banden: [5, 10, 15], weergave: 'per', locaties: [cs], netwerk: true });
  const ms15 = Date.now() - t0;
  console.log(`  fietsen 15 min: ${ms15} ms`, JSON.stringify(bike.items[0].statistiek));
  assert.ok(bike.items[0].statistiek[2].km2 > bike.items[0].statistiek[1].km2);
});
