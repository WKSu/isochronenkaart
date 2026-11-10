/* geocoder.js: adressen en plaatsen zoeken via de PDOK Locatieserver (gratis, geen sleutel). */
window.IsoGeocoder = (function () {
  'use strict';
  const cfg = window.ISO_CONFIG;

  async function suggest(q, signal) {
    const p = new URLSearchParams({ q, rows: '8' });
    p.append('fq', 'gemeentenaam:' + cfg.gemeente);
    p.append('fq', 'type:(adres OR weg OR postcode OR buurt OR wijk OR woonplaats)');
    const resp = await fetch(cfg.locatieserver + '/suggest?' + p.toString(), { signal });
    if (!resp.ok) throw new Error('Zoeken mislukt (HTTP ' + resp.status + ')');
    const data = await resp.json();
    return (data.response && data.response.docs ? data.response.docs : []).map((d) => ({
      id: d.id,
      naam: d.weergavenaam,
      type: d.type,
    }));
  }

  async function lookup(id) {
    const p = new URLSearchParams({ id, fl: 'id,weergavenaam,centroide_ll' });
    const resp = await fetch(cfg.locatieserver + '/lookup?' + p.toString());
    if (!resp.ok) throw new Error('Adres ophalen mislukt (HTTP ' + resp.status + ')');
    const data = await resp.json();
    const doc = data.response && data.response.docs && data.response.docs[0];
    if (!doc) throw new Error('Adres niet gevonden');
    const m = /POINT\(([-\d.]+) ([-\d.]+)\)/.exec(doc.centroide_ll || '');
    if (!m) throw new Error('Adres zonder coördinaat');
    return { naam: doc.weergavenaam, lng: Number(m[1]), lat: Number(m[2]) };
  }

  return { suggest, lookup };
})();
