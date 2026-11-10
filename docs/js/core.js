/*
 * core.js: rekenkern van de isochronenkaart.
 * Puur: geen DOM, geen Leaflet. Draait in de Web Worker en onder `node --test`.
 * Alle geometrie in RD New (EPSG:28992), meters.
 * Contouren gebruiken d3-contour (globale `d3`).
 */
(function (root) {
  'use strict';

  const WALK = 1;
  const BIKE_FWD = 2;
  const BIKE_BWD = 4;
  const WALK_MAIN = 8;
  const BIKE_MAIN = 16;
  const NODE_RAND = 1;

  const TYPES = {
    int32: Int32Array,
    uint32: Uint32Array,
    uint16: Uint16Array,
    uint8: Uint8Array,
  };

  // ------------------------------------------------------------------ laden
  function isGzip(buf) {
    const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
    return b.length === 2 && b[0] === 0x1f && b[1] === 0x8b;
  }

  /** Pak gzip uit, tenzij de server dat al deed. */
  async function gunzip(buf) {
    if (!isGzip(buf)) return buf;
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  }

  function section(buf, meta, name) {
    const s = meta.secties[name];
    const T = TYPES[s.type];
    if (!T) throw new Error('Onbekend type in netwerkbestand: ' + s.type);
    return new T(buf, s.offset, s.length);
  }

  /** Bouw het netwerk uit network.json + uitgepakte network.bin. */
  function parseNetwork(meta, buf) {
    if (meta.versie !== 1) throw new Error('Onbekende versie netwerkbestand: ' + meta.versie);
    const N = meta.knopen;
    const E = meta.randen;
    const x0 = meta.oorsprong[0];
    const y0 = meta.oorsprong[1];
    const ndx = section(buf, meta, 'node_dx');
    const ndy = section(buf, meta, 'node_dy');
    const U = new Uint32Array(section(buf, meta, 'edge_u'));
    const V = new Uint32Array(section(buf, meta, 'edge_v'));
    const gdx = section(buf, meta, 'geom_dx');
    const gdy = section(buf, meta, 'geom_dy');
    const nv = section(buf, meta, 'edge_nv');
    const nodeFlags = new Uint8Array(section(buf, meta, 'node_flags'));
    const flags = new Uint8Array(section(buf, meta, 'edge_flags'));

    const qx = new Int32Array(N);
    const qy = new Int32Array(N);
    const NX = new Float64Array(N);
    const NY = new Float64Array(N);
    let ax = 0;
    let ay = 0;
    for (let i = 0; i < N; i++) {
      ax += ndx[i];
      ay += ndy[i];
      qx[i] = ax;
      qy[i] = ay;
      NX[i] = x0 + ax / 10;
      NY[i] = y0 + ay / 10;
    }

    const GS = new Uint32Array(E + 1);
    for (let e = 0; e < E; e++) GS[e + 1] = GS[e] + nv[e];
    const G = GS[E];
    if (G !== gdx.length) throw new Error('Netwerkbestand is beschadigd (tussenpunten)');
    const GX = new Float64Array(G);
    const GY = new Float64Array(G);
    const LEN = new Float64Array(E);
    for (let e = 0; e < E; e++) {
      let px = qx[U[e]];
      let py = qy[U[e]];
      let lx = NX[U[e]];
      let ly = NY[U[e]];
      let len = 0;
      for (let g = GS[e]; g < GS[e + 1]; g++) {
        px += gdx[g];
        py += gdy[g];
        GX[g] = x0 + px / 10;
        GY[g] = y0 + py / 10;
        len += Math.hypot(GX[g] - lx, GY[g] - ly);
        lx = GX[g];
        ly = GY[g];
      }
      len += Math.hypot(NX[V[e]] - lx, NY[V[e]] - ly);
      LEN[e] = Math.max(len, 0.01);
    }

    const net = { meta, N, E, NX, NY, U, V, GS, GX, GY, LEN, flags, nodeFlags };
    net.adj = { lopen: buildAdjacency(net, 'lopen'), fietsen: buildAdjacency(net, 'fietsen') };
    net.index = buildSpatialIndex(net, 100);
    return net;
  }

  /** Inwoners: Int32 x(hm), y(hm), aantal. */
  function parseInwoners(buf) {
    const all = new Int32Array(buf);
    const n = all.length / 3;
    return { n, cx: all.subarray(0, n), cy: all.subarray(n, 2 * n), aantal: all.subarray(2 * n) };
  }

  // ------------------------------------------------------------------ modus
  function canFwd(f, modus) {
    return modus === 'lopen' ? (f & WALK) !== 0 : (f & BIKE_FWD) !== 0;
  }
  function canBwd(f, modus) {
    return modus === 'lopen' ? (f & WALK) !== 0 : (f & BIKE_BWD) !== 0;
  }
  function allowed(f, modus) {
    return canFwd(f, modus) || canBwd(f, modus);
  }
  function isMain(f, modus) {
    return modus === 'lopen' ? (f & WALK_MAIN) !== 0 : (f & BIKE_MAIN) !== 0;
  }

  function buildAdjacency(net, modus) {
    const { N, E, U, V, LEN, flags } = net;
    const deg = new Uint32Array(N + 1);
    for (let e = 0; e < E; e++) {
      if (canFwd(flags[e], modus)) deg[U[e] + 1]++;
      if (canBwd(flags[e], modus)) deg[V[e] + 1]++;
    }
    for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
    const off = deg;
    const fill = off.slice(0, N);
    const M = off[N];
    const tgt = new Uint32Array(M);
    const w = new Float64Array(M);
    for (let e = 0; e < E; e++) {
      if (canFwd(flags[e], modus)) {
        const k = fill[U[e]]++;
        tgt[k] = V[e];
        w[k] = LEN[e];
      }
      if (canBwd(flags[e], modus)) {
        const k = fill[V[e]]++;
        tgt[k] = U[e];
        w[k] = LEN[e];
      }
    }
    return { off, tgt, w };
  }

  /** Callback per punt van rand e: fn(x, y, k), k = 0..nv+1. */
  function edgePoints(net, e) {
    const { GS, GX, GY, NX, NY, U, V } = net;
    const n = GS[e + 1] - GS[e] + 2;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    xs[0] = NX[U[e]];
    ys[0] = NY[U[e]];
    for (let g = GS[e], k = 1; g < GS[e + 1]; g++, k++) {
      xs[k] = GX[g];
      ys[k] = GY[g];
    }
    xs[n - 1] = NX[V[e]];
    ys[n - 1] = NY[V[e]];
    return { xs, ys, n };
  }

  // ------------------------------------------------------------- snappen
  function buildSpatialIndex(net, cell) {
    const { E, NX, NY } = net;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < net.N; i++) {
      if (NX[i] < minX) minX = NX[i];
      if (NX[i] > maxX) maxX = NX[i];
      if (NY[i] < minY) minY = NY[i];
      if (NY[i] > maxY) maxY = NY[i];
    }
    for (let g = 0; g < net.GX.length; g++) {
      if (net.GX[g] < minX) minX = net.GX[g];
      if (net.GX[g] > maxX) maxX = net.GX[g];
      if (net.GY[g] < minY) minY = net.GY[g];
      if (net.GY[g] > maxY) maxY = net.GY[g];
    }
    const ox = Math.floor(minX / cell) * cell;
    const oy = Math.floor(minY / cell) * cell;
    const w = Math.floor((maxX - ox) / cell) + 1;
    const h = Math.floor((maxY - oy) / cell) + 1;
    const counts = new Uint32Array(w * h + 1);

    function forEachCell(e, fn) {
      const p = edgePoints(net, e);
      let last = -1;
      for (let k = 0; k + 1 < p.n; k++) {
        const i0 = Math.floor((Math.min(p.xs[k], p.xs[k + 1]) - ox) / cell);
        const i1 = Math.floor((Math.max(p.xs[k], p.xs[k + 1]) - ox) / cell);
        const j0 = Math.floor((Math.min(p.ys[k], p.ys[k + 1]) - oy) / cell);
        const j1 = Math.floor((Math.max(p.ys[k], p.ys[k + 1]) - oy) / cell);
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const c = j * w + i;
            if (c !== last) fn(c);
            last = c;
          }
        }
      }
    }
    for (let e = 0; e < E; e++) forEachCell(e, (c) => counts[c + 1]++);
    for (let c = 0; c < w * h; c++) counts[c + 1] += counts[c];
    const fill = counts.slice(0, w * h);
    const items = new Uint32Array(counts[w * h]);
    for (let e = 0; e < E; e++) forEachCell(e, (c) => (items[fill[c]++] = e));
    return { cell, ox, oy, w, h, off: counts, items, stamp: new Uint32Array(E), q: 0 };
  }

  /**
   * Dichtstbijzijnde punt op het netwerk voor deze modus.
   * Losse netwerkdelen krijgen 50 m strafafstand zodat het hoofdnet de voorkeur heeft.
   */
  function snap(net, modus, x, y, maxDist) {
    const ix = net.index;
    const r = Math.ceil(maxDist / ix.cell);
    const ci = Math.floor((x - ix.ox) / ix.cell);
    const cj = Math.floor((y - ix.oy) / ix.cell);
    ix.q = (ix.q + 1) >>> 0;
    if (ix.q === 0) {
      ix.stamp.fill(0);
      ix.q = 1;
    }
    let best = null;
    let bestScore = Infinity;
    for (let j = Math.max(0, cj - r); j <= Math.min(ix.h - 1, cj + r); j++) {
      for (let i = Math.max(0, ci - r); i <= Math.min(ix.w - 1, ci + r); i++) {
        const c = j * ix.w + i;
        for (let k = ix.off[c]; k < ix.off[c + 1]; k++) {
          const e = ix.items[k];
          if (ix.stamp[e] === ix.q) continue;
          ix.stamp[e] = ix.q;
          const f = net.flags[e];
          if (!allowed(f, modus)) continue;
          const p = edgePoints(net, e);
          let cum = 0;
          for (let s = 0; s + 1 < p.n; s++) {
            const ax = p.xs[s];
            const ay = p.ys[s];
            const dx = p.xs[s + 1] - ax;
            const dy = p.ys[s + 1] - ay;
            const l2 = dx * dx + dy * dy;
            const segLen = Math.sqrt(l2);
            let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px = ax + t * dx;
            const py = ay + t * dy;
            const d = Math.hypot(x - px, y - py);
            const score = d + (isMain(f, modus) ? 0 : 50);
            if (score < bestScore) {
              bestScore = score;
              best = { edge: e, s: Math.min(cum + t * segLen, net.LEN[e]), access: d, x: px, y: py };
            }
            cum += segLen;
          }
        }
      }
    }
    if (!best || best.access > maxDist) return null;
    return best;
  }

  // ------------------------------------------------------------ Dijkstra
  class MinHeap {
    constructor(cap) {
      this.k = new Float64Array(cap);
      this.v = new Int32Array(cap);
      this.n = 0;
    }
    push(key, val) {
      if (this.n === this.k.length) {
        const k2 = new Float64Array(this.k.length * 2);
        const v2 = new Int32Array(this.v.length * 2);
        k2.set(this.k);
        v2.set(this.v);
        this.k = k2;
        this.v = v2;
      }
      let i = this.n++;
      const k = this.k;
      const v = this.v;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (k[p] <= key) break;
        k[i] = k[p];
        v[i] = v[p];
        i = p;
      }
      k[i] = key;
      v[i] = val;
    }
    pop() {
      const k = this.k;
      const v = this.v;
      const topV = v[0];
      this.topKey = k[0];
      const n = --this.n;
      if (n > 0) {
        const key = k[n];
        const val = v[n];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= key) break;
          k[i] = k[c];
          v[i] = v[c];
          i = c;
        }
        k[i] = key;
        v[i] = val;
      }
      return topV;
    }
  }

  /** Startknopen bij een gesnapt punt. */
  function seedsFor(net, modus, sn) {
    const e = sn.edge;
    const f = net.flags[e];
    const out = [];
    if (canBwd(f, modus)) out.push([net.U[e], sn.access + sn.s]);
    if (canFwd(f, modus)) out.push([net.V[e], sn.access + (net.LEN[e] - sn.s)]);
    return out;
  }

  /** Kortste afstand (m) vanaf de seeds, tot maxDist. */
  function dijkstra(net, modus, seeds, maxDist) {
    const { off, tgt, w } = net.adj[modus];
    const dist = new Float64Array(net.N).fill(Infinity);
    const heap = new MinHeap(4096);
    for (const [node, d] of seeds) {
      if (d <= maxDist && d < dist[node]) {
        dist[node] = d;
        heap.push(d, node);
      }
    }
    while (heap.n > 0) {
      const u = heap.pop();
      const du = heap.topKey;
      if (du > dist[u]) continue;
      for (let k = off[u]; k < off[u + 1]; k++) {
        const nd = du + w[k];
        const t = tgt[k];
        if (nd <= maxDist && nd < dist[t]) {
          dist[t] = nd;
          heap.push(nd, t);
        }
      }
    }
    return dist;
  }

  /** Afstandsveld: knoopafstanden + gesnapte startpunten (voor tijd langs de startrand). */
  function makeField(dist, snaps) {
    const byEdge = new Map();
    for (const s of snaps) {
      if (!byEdge.has(s.edge)) byEdge.set(s.edge, []);
      byEdge.get(s.edge).push(s);
    }
    return { dist, snaps, byEdge };
  }

  function mergeFields(fields) {
    const dist = new Float64Array(fields[0].dist);
    for (let i = 1; i < fields.length; i++) {
      const d = fields[i].dist;
      for (let n = 0; n < dist.length; n++) if (d[n] < dist[n]) dist[n] = d[n];
    }
    return makeField(dist, fields.flatMap((f) => f.snaps));
  }

  /** Afstand (m) tot het punt op afstand t van U[e] langs rand e. */
  function edgeDist(net, modus, field, e, t) {
    const f = net.flags[e];
    const L = net.LEN[e];
    let d = Infinity;
    if (canFwd(f, modus)) d = Math.min(d, field.dist[net.U[e]] + t);
    if (canBwd(f, modus)) d = Math.min(d, field.dist[net.V[e]] + (L - t));
    const ss = field.byEdge.get(e);
    if (ss) {
      for (const s of ss) {
        if (t >= s.s && canFwd(f, modus)) d = Math.min(d, s.access + (t - s.s));
        if (t <= s.s && canBwd(f, modus)) d = Math.min(d, s.access + (s.s - t));
      }
    }
    return d;
  }

  function reachedEdges(net, modus, field, maxDist) {
    const out = [];
    const { U, V, flags } = net;
    const dist = field.dist;
    for (let e = 0; e < net.E; e++) {
      if (!allowed(flags[e], modus)) continue;
      if (dist[U[e]] <= maxDist || dist[V[e]] <= maxDist || field.byEdge.has(e)) out.push(e);
    }
    return out;
  }

  // -------------------------------------------------------------- raster
  /**
   * Raster (cel 20 m, uitgelijnd op RD-veelvouden van 100 m) met per cel de kortste
   * afstand: netwerkafstand + rechte lijn tot het netwerk, max `radius` m van het netwerk.
   */
  function rasterize(net, modus, field, edges, maxDist, opts) {
    const cell = opts.cel;
    const radius = opts.straal;
    const step = opts.stap;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const e of edges) {
      const p = edgePoints(net, e);
      for (let k = 0; k < p.n; k++) {
        if (p.xs[k] < minX) minX = p.xs[k];
        if (p.xs[k] > maxX) maxX = p.xs[k];
        if (p.ys[k] < minY) minY = p.ys[k];
        if (p.ys[k] > maxY) maxY = p.ys[k];
      }
    }
    if (!isFinite(minX)) return null;
    const pad = radius + 2 * cell;
    const gx0 = Math.floor((minX - pad) / 100) * 100;
    const gy0 = Math.floor((minY - pad) / 100) * 100;
    const w = Math.ceil((maxX + pad - gx0) / 100) * (100 / cell);
    const h = Math.ceil((maxY + pad - gy0) / 100) * (100 / cell);
    const vals = new Float32Array(w * h).fill(Infinity);
    const R = Math.ceil(radius / cell);

    function stamp(x, y, d) {
      const ci = Math.floor((x - gx0) / cell);
      const cj = Math.floor((y - gy0) / cell);
      for (let dj = -R; dj <= R; dj++) {
        const j = cj + dj;
        if (j < 0 || j >= h) continue;
        const cy = gy0 + (j + 0.5) * cell;
        for (let di = -R; di <= R; di++) {
          const i = ci + di;
          if (i < 0 || i >= w) continue;
          const cx = gx0 + (i + 0.5) * cell;
          const off = Math.hypot(cx - x, cy - y);
          if (off > radius) continue;
          const v = d + off;
          if (v > maxDist) continue;
          const idx = j * w + i;
          if (v < vals[idx]) vals[idx] = v;
        }
      }
    }

    for (const e of edges) {
      const p = edgePoints(net, e);
      let cum = 0;
      for (let s = 0; s + 1 < p.n; s++) {
        const dx = p.xs[s + 1] - p.xs[s];
        const dy = p.ys[s + 1] - p.ys[s];
        const len = Math.hypot(dx, dy);
        const n = Math.max(1, Math.ceil(len / step));
        const last = s + 2 === p.n ? n : n - 1;
        for (let j = 0; j <= last; j++) {
          const f = j / n;
          const d = edgeDist(net, modus, field, e, cum + f * len);
          if (d <= maxDist) stamp(p.xs[s] + f * dx, p.ys[s] + f * dy, d);
        }
        cum += len;
      }
    }
    // Startpunten zelf (locatie naast het netwerk)
    for (const s of field.snaps) stamp(s.x, s.y, s.access);
    return { x0: gx0, y0: gy0, w, h, cel: cell, vals };
  }

  // ------------------------------------------------------------ contouren
  function ringArea(r) {
    let a = 0;
    for (let i = 0, n = r.length - 1; i < n; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
    return a / 2;
  }

  function simplifyRing(pts, tol) {
    if (pts.length <= 5) return pts;
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    const tol2 = tol * tol;
    while (stack.length) {
      const [a, b] = stack.pop();
      const ax = pts[a][0];
      const ay = pts[a][1];
      const dx = pts[b][0] - ax;
      const dy = pts[b][1] - ay;
      const l2 = dx * dx + dy * dy;
      let maxD = -1;
      let idx = -1;
      for (let i = a + 1; i < b; i++) {
        let d2;
        if (l2 === 0) {
          d2 = (pts[i][0] - ax) ** 2 + (pts[i][1] - ay) ** 2;
        } else {
          const cr = (pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx;
          d2 = (cr * cr) / l2;
        }
        if (d2 > maxD) {
          maxD = d2;
          idx = i;
        }
      }
      if (maxD > tol2) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    const out = [];
    for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  /**
   * Cumulatieve MultiPolygonen per band (RD-coordinaten).
   * Waarden worden genegeerd zodat d3 "binnen" = reistijd <= band levert.
   */
  function contourBands(raster, bandsM, opts) {
    const d3 = root.d3;
    if (!d3 || !d3.contours) throw new Error('d3-contour is niet geladen');
    const { w, h, vals, x0, y0, cel } = raster;
    const maxM = bandsM[bandsM.length - 1];
    const sentinel = -(maxM * 1.1 + 100);
    const neg = new Float64Array(w * h);
    for (let i = 0; i < neg.length; i++) neg[i] = isFinite(vals[i]) ? -vals[i] : sentinel;
    const gen = d3.contours().size([w, h]).smooth(true);
    const minArea = opts.minRingOpp;
    return bandsM.map((bm) => {
      const mp = gen.contour(neg, -bm);
      const polys = [];
      for (const poly of mp.coordinates) {
        const rings = [];
        for (let r = 0; r < poly.length; r++) {
          let ring = poly[r].map((p) => [x0 + p[0] * cel, y0 + p[1] * cel]);
          ring = simplifyRing(ring, opts.vereenvoudig);
          const f = ring[0];
          const l = ring[ring.length - 1];
          if (f[0] !== l[0] || f[1] !== l[1]) ring.push([f[0], f[1]]);
          if (ring.length < 4 || Math.abs(ringArea(ring)) < minArea) {
            if (r === 0) break;
            continue;
          }
          rings.push(ring);
        }
        if (rings.length) polys.push(rings);
      }
      return polys;
    });
  }

  // ------------------------------------------------------ bereikbaar netwerk
  function bandIndex(d, bandsM) {
    for (let b = 0; b < bandsM.length; b++) if (d <= bandsM[b]) return b;
    return -1;
  }

  /** Per band een lijst lijnen (RD), gesplitst op bandgrenzen. */
  function networkLines(net, modus, field, edges, bandsM, step) {
    const lines = bandsM.map(() => []);
    for (const e of edges) {
      const p = edgePoints(net, e);
      let cum = 0;
      let cur = null;
      let curBand = -2;
      for (let s = 0; s + 1 < p.n; s++) {
        const ax = p.xs[s];
        const ay = p.ys[s];
        const dx = p.xs[s + 1] - ax;
        const dy = p.ys[s + 1] - ay;
        const len = Math.hypot(dx, dy);
        const n = Math.max(1, Math.ceil(len / step));
        for (let j = 0; j < n; j++) {
          const tm = cum + ((j + 0.5) / n) * len;
          const b = bandIndex(edgeDist(net, modus, field, e, tm), bandsM);
          if (b !== curBand) {
            const pa = [ax + (j / n) * dx, ay + (j / n) * dy];
            if (cur) {
              cur.push(pa);
              if (cur.length >= 2) lines[curBand].push(cur);
            }
            cur = b >= 0 ? [pa] : null;
            curBand = b;
          }
        }
        if (cur) cur.push([p.xs[s + 1], p.ys[s + 1]]);
        cum += len;
      }
      if (cur && cur.length >= 2) lines[curBand].push(cur);
    }
    return lines;
  }

  // ------------------------------------------------------------ statistiek
  function statistics(raster, bandsM, inwoners) {
    const { w, h, vals, x0, y0, cel } = raster;
    const cellArea = cel * cel;
    const area = bandsM.map(() => 0);
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (!isFinite(v)) continue;
      for (let b = 0; b < bandsM.length; b++) if (v <= bandsM[b]) area[b]++;
    }
    const pop = bandsM.map(() => 0);
    if (inwoners) {
      const k = Math.round(100 / cel);
      const i0min = x0 / 100;
      const j0min = y0 / 100;
      const wHm = w / k;
      const hHm = h / k;
      const counts = new Int32Array(bandsM.length);
      for (let c = 0; c < inwoners.n; c++) {
        const hi = inwoners.cx[c] - i0min;
        const hj = inwoners.cy[c] - j0min;
        if (hi < 0 || hj < 0 || hi >= wHm || hj >= hHm) continue;
        counts.fill(0);
        for (let sj = 0; sj < k; sj++) {
          const row = (hj * k + sj) * w + hi * k;
          for (let si = 0; si < k; si++) {
            const v = vals[row + si];
            if (!isFinite(v)) continue;
            for (let b = 0; b < bandsM.length; b++) if (v <= bandsM[b]) counts[b]++;
          }
        }
        for (let b = 0; b < bandsM.length; b++) {
          if (counts[b]) pop[b] += (inwoners.aantal[c] * counts[b]) / (k * k);
        }
      }
    }
    return bandsM.map((_, b) => ({
      km2: Math.round((area[b] * cellArea) / 1e4) / 100,
      inwoners: Math.round(pop[b] / 10) * 10,
    }));
  }

  function touchesEdge(net, field, maxDist) {
    const { nodeFlags } = net;
    const dist = field.dist;
    for (let i = 0; i < net.N; i++) if (nodeFlags[i] & NODE_RAND && dist[i] <= maxDist) return true;
    return false;
  }

  // -------------------------------------------------------------- bereken
  const DEFAULTS = { cel: 20, straal: 50, stap: 10, vereenvoudig: 2, minRingOpp: 1000, snapAfstand: 250 };

  /** Engine met cache van afstandsvelden per locatie. */
  function createEngine(net, inwoners, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const cache = new Map();

    function fieldFor(modus, loc, maxDist) {
      const key = modus + '|' + loc.x.toFixed(1) + '|' + loc.y.toFixed(1);
      const hit = cache.get(key);
      if (hit && hit.maxDist >= maxDist) {
        cache.delete(key);
        cache.set(key, hit);
        return hit;
      }
      const sn = snap(net, modus, loc.x, loc.y, opts.snapAfstand);
      if (!sn) {
        const entry = { fout: 'Geen ' + (modus === 'lopen' ? 'looproute' : 'fietsroute') + ' binnen ' + opts.snapAfstand + ' m van deze locatie.' };
        return entry;
      }
      const dist = dijkstra(net, modus, seedsFor(net, modus, sn), maxDist);
      const entry = { field: makeField(dist, [sn]), snap: sn, maxDist };
      cache.set(key, entry);
      while (cache.size > 40) cache.delete(cache.keys().next().value);
      return entry;
    }

    function product(modus, field, bandsM, wantLines) {
      const maxDist = bandsM[bandsM.length - 1];
      const edges = reachedEdges(net, modus, field, maxDist);
      const raster = rasterize(net, modus, field, edges, maxDist, opts);
      if (!raster) return { polygonen: bandsM.map(() => []), netwerk: bandsM.map(() => []), statistiek: bandsM.map(() => ({ km2: 0, inwoners: 0 })), raaktRand: false };
      return {
        polygonen: contourBands(raster, bandsM, opts),
        netwerk: wantLines ? networkLines(net, modus, field, edges, bandsM, opts.stap) : null,
        statistiek: statistics(raster, bandsM, inwoners),
        raaktRand: touchesEdge(net, field, maxDist),
      };
    }

    /**
     * req: { modus, snelheid (km/u), banden (min, oplopend), weergave: 'per'|'samen',
     *        locaties: [{id, x, y}] (RD), netwerk: bool }
     */
    function compute(req) {
      const t0 = Date.now();
      const mpm = (req.snelheid * 1000) / 60;
      const bandsM = req.banden.map((b) => b * mpm);
      const maxDist = bandsM[bandsM.length - 1];
      const fouten = [];
      const aansluitingen = [];
      const ok = [];
      for (const loc of req.locaties) {
        const r = fieldFor(req.modus, loc, maxDist);
        if (r.fout) {
          fouten.push({ locatieId: loc.id, tekst: r.fout });
          continue;
        }
        aansluitingen.push({ locatieId: loc.id, x: r.snap.x, y: r.snap.y, afstand: r.snap.access });
        ok.push({ loc, field: r.field });
      }
      const items = [];
      if (ok.length) {
        if (req.weergave === 'samen') {
          const field = ok.length === 1 ? ok[0].field : mergeFields(ok.map((o) => o.field));
          items.push(Object.assign({ locatieId: null }, product(req.modus, field, bandsM, req.netwerk)));
        } else {
          for (const o of ok) items.push(Object.assign({ locatieId: o.loc.id }, product(req.modus, o.field, bandsM, req.netwerk)));
        }
      }
      return { items, fouten, aansluitingen, banden: req.banden, ms: Date.now() - t0 };
    }

    return { compute, snap: (modus, x, y) => snap(net, modus, x, y, opts.snapAfstand) };
  }

  const api = {
    gunzip,
    isGzip,
    parseNetwork,
    parseInwoners,
    createEngine,
    // voor tests
    _: { dijkstra, snap, seedsFor, makeField, mergeFields, edgeDist, rasterize, contourBands, networkLines, statistics, simplifyRing, ringArea, buildAdjacency, reachedEdges, MinHeap, flags: { WALK, BIKE_FWD, BIKE_BWD, WALK_MAIN, BIKE_MAIN, NODE_RAND } },
  };
  root.IsoCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
