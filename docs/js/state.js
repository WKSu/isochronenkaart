/* state.js: kaartinstellingen en locaties in de URL (#...), zodat een link deelbaar is. */
window.IsoState = (function () {
  'use strict';

  function encode(s) {
    const p = new URLSearchParams();
    p.set('m', s.modus);
    p.set('s', String(s.snelheid[s.modus]));
    p.set('b', s.banden.join(','));
    p.set('w', s.weergave);
    p.set('v', (s.toonVlakken ? '1' : '0') + (s.toonNetwerk ? '1' : '0'));
    if (s.basiskaart !== 'grijs') p.set('k', s.basiskaart);
    if (s.locaties.length) {
      p.set(
        'l',
        s.locaties
          .map((l) => [l.lat.toFixed(5), l.lng.toFixed(5), l.zichtbaar ? '' : '0', l.naam.replace(/[|]/g, '/')].join(','))
          .join('|'),
      );
    }
    return '#' + p.toString();
  }

  function num(v, lo, hi) {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
  }

  /** Lees de hash; onbekende of ongeldige waarden worden genegeerd. */
  function decode(hash, cfg) {
    const out = {};
    if (!hash || hash.length < 2) return out;
    const p = new URLSearchParams(hash.slice(1));
    const m = p.get('m');
    if (m && cfg.modi[m]) {
      out.modus = m;
      const s = num(p.get('s'), cfg.modi[m].min, cfg.modi[m].max);
      if (s !== null) out.snelheid = s;
    }
    const b = (p.get('b') || '')
      .split(',')
      .map((x) => num(x, 1, cfg.maxMinuten))
      .filter((x) => x !== null)
      .map(Math.round);
    if (b.length) out.banden = [...new Set(b)].sort((x, y) => x - y).slice(0, cfg.maxBanden);
    const w = p.get('w');
    if (w === 'per' || w === 'samen') out.weergave = w;
    const v = p.get('v');
    if (v && /^[01]{2}$/.test(v)) {
      out.toonVlakken = v[0] === '1';
      out.toonNetwerk = v[1] === '1';
    }
    const k = p.get('k');
    if (k && cfg.basiskaarten[k]) out.basiskaart = k;
    const l = p.get('l');
    if (l) {
      out.locaties = [];
      for (const part of l.split('|')) {
        const bits = part.split(',');
        const lat = num(bits[0], 50, 54);
        const lng = num(bits[1], 3, 8);
        if (lat === null || lng === null) continue;
        const naam = bits.slice(3).join(',').trim();
        out.locaties.push({ lat, lng, zichtbaar: bits[2] !== '0', naam });
        if (out.locaties.length >= cfg.maxLocaties) break;
      }
    }
    return out;
  }

  return { encode, decode };
})();
