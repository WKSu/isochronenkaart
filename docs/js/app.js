/* app.js: kaart, zijpaneel, toestand en tekenen. Rekenen gebeurt in js/worker.js. */
/* global L, proj4, IsoState, IsoGeocoder, IsoGpkg */
(function () {
  'use strict';

  const cfg = window.ISO_CONFIG;
  const $ = (id) => document.getElementById(id);
  const nf = (d) => new Intl.NumberFormat('nl-NL', { maximumFractionDigits: d, minimumFractionDigits: d });
  const fmtKm2 = nf(2);
  const fmtInt = nf(0);
  const fmtSpeed = (v) => new Intl.NumberFormat('nl-NL', { maximumFractionDigits: 1 }).format(v);

  proj4.defs(
    'EPSG:28992',
    '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 ' +
      '+y_0=463000 +ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 ' +
      '+units=m +no_defs',
  );
  const rd = proj4('EPSG:28992', 'EPSG:4326');
  const toLatLng = (p) => {
    const ll = rd.forward([p[0], p[1]]);
    return [ll[1], ll[0]];
  };
  const toRD = (lat, lng) => rd.inverse([lng, lat]);

  // ------------------------------------------------------------- toestand
  const state = {
    modus: 'lopen',
    snelheid: { lopen: cfg.modi.lopen.snelheid, fietsen: cfg.modi.fietsen.snelheid },
    banden: cfg.standaardBanden.slice(),
    weergave: 'per',
    toonVlakken: true,
    toonNetwerk: false,
    dekking: 0.55,
    basiskaart: 'grijs',
    locaties: [], // {id, naam, lat, lng, zichtbaar, kleur}
  };
  let volgendeId = 1;
  let meta = null;
  let gemeenteGeom = null;
  let workerKlaar = false;
  let rekenId = 0;
  let laatste = null; // {res, ctx}
  let rekenTimer = null;
  let pendingCtx = null; // instellingen van het lopende rekenverzoek

  // --------------------------------------------------------------- kaart
  const map = L.map('kaart', { zoomControl: false, preferCanvas: true }).setView([51.92, 4.45], 11);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ position: 'bottomright', imperial: false }).addTo(map);
  let tegels = null;
  function zetBasiskaart() {
    if (tegels) map.removeLayer(tegels);
    tegels = L.tileLayer(cfg.basiskaartUrl.replace('{thema}', state.basiskaart), {
      attribution:
        'Kaart: <a href="https://www.pdok.nl/">PDOK</a> / &copy; Kadaster (CC-BY 4.0) | ' +
        'Netwerk: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap-bijdragers</a> | Inwoners: CBS',
      minZoom: 6,
      maxNativeZoom: 19,
      maxZoom: 20,
    }).addTo(map);
  }
  zetBasiskaart();

  map.createPane('gebied').style.zIndex = 350;
  map.createPane('netwerk').style.zIndex = 450;
  const gebiedLaag = L.layerGroup().addTo(map);
  const isoLaag = L.layerGroup().addTo(map);
  const markerLaag = L.layerGroup().addTo(map);
  const renderers = new Map();
  function rendererVoor(pane) {
    if (!renderers.has(pane)) renderers.set(pane, L.canvas({ pane, padding: 0.3 }));
    return renderers.get(pane);
  }
  function paneVoor(sleutel) {
    const naam = 'iso-' + sleutel;
    if (!map.getPane(naam)) {
      const p = map.createPane(naam);
      p.style.zIndex = 400;
    }
    map.getPane(naam).style.opacity = String(state.dekking);
    return naam;
  }

  // ------------------------------------------------------------ status
  function status(soort, tekst) {
    const el = $('status');
    el.className = 'status' + (tekst ? ' zichtbaar ' + soort : '');
    const prefix = { waarschuwing: 'Let op: ', fout: 'Fout: ' }[soort] || '';
    el.textContent = tekst ? prefix + tekst : '';
  }

  // ----------------------------------------------------------- kleuren
  function hexToRgb(h) {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(hex, naar, f) {
    const a = hexToRgb(hex);
    const b = hexToRgb(naar);
    const c = a.map((v, i) => Math.round(v + (b[i] - v) * f));
    return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  /** Bandkleuren: gecombineerd = blauwe tinten; per locatie = tinten van de locatiekleur. */
  function bandKleuren(n, basis) {
    if (!basis) {
      const ramp = cfg.bandKleuren;
      if (n === 1) return [ramp[2]];
      return Array.from({ length: n }, (_, i) => ramp[Math.round((i * (ramp.length - 1)) / (n - 1))]);
    }
    if (n === 1) return [basis];
    return Array.from({ length: n }, (_, i) => {
      const f = -0.3 + (0.85 * i) / (n - 1);
      return f < 0 ? mix(basis, '#000000', -f) : mix(basis, '#ffffff', f);
    });
  }
  function locKleur(loc) {
    return loc.kleur === null ? '#52514e' : cfg.locatieKleuren[loc.kleur];
  }
  const donkereTekst = (kleur) => kleur === '#eda100';
  function vrijeKleur() {
    const bezet = new Set(state.locaties.map((l) => l.kleur));
    for (let i = 0; i < cfg.locatieKleuren.length; i++) if (!bezet.has(i)) return i;
    return null;
  }

  // ---------------------------------------------------------- geometrie
  function inRing(x, y, ring) {
    let binnen = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) binnen = !binnen;
    }
    return binnen;
  }
  function inGemeente(lat, lng) {
    if (!gemeenteGeom) return true;
    const polys = gemeenteGeom.type === 'Polygon' ? [gemeenteGeom.coordinates] : gemeenteGeom.coordinates;
    return polys.some((poly) => inRing(lng, lat, poly[0]) && !poly.slice(1).some((h) => inRing(lng, lat, h)));
  }

  // ------------------------------------------------------------ worker
  if (location.protocol === 'file:') {
    status('fout', 'Open deze pagina via een webserver (zie README), niet als los bestand.');
  }
  const worker = new Worker('js/worker.js');
  worker.onerror = (e) => status('fout', 'De rekenmodule kon niet starten (' + (e.message || 'onbekend') + ').');
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === 'voortgang') {
      status('bezig', m.tekst);
    } else if (m.type === 'klaar') {
      workerKlaar = true;
      meta = m.meta;
      tekenInfo();
      status('', '');
      plan(0);
    } else if (m.type === 'resultaat') {
      if (m.id !== rekenId) return;
      verwerkResultaat(m.resultaat);
    } else if (m.type === 'fout') {
      if (m.id !== undefined && m.id !== rekenId) return;
      status('fout', m.tekst);
      $('export').disabled = !laatste;
    }
  };
  status('bezig', 'Netwerk laden…');
  worker.postMessage({ type: 'init', basis: new URL('data/', location.href).href });

  function zichtbareLocaties() {
    return state.locaties.filter((l) => l.zichtbaar);
  }

  function plan(ms) {
    clearTimeout(rekenTimer);
    rekenTimer = setTimeout(bereken, ms === undefined ? 120 : ms);
  }

  function bereken() {
    if (!workerKlaar) return;
    const locs = zichtbareLocaties();
    if (!locs.length) {
      laatste = null;
      rekenId++;
      teken();
      tekenResultaat();
      status('', '');
      $('export').disabled = true;
      return;
    }
    const ctx = {
      modus: state.modus,
      snelheid: state.snelheid[state.modus],
      banden: state.banden.slice(),
      weergave: state.weergave,
      locaties: locs.map((l) => ({ id: l.id, naam: l.naam, lat: l.lat, lng: l.lng })),
    };
    const id = ++rekenId;
    status('bezig', 'Berekenen…');
    $('export').disabled = true;
    worker.postMessage({
      type: 'bereken',
      id,
      verzoek: {
        modus: ctx.modus,
        snelheid: ctx.snelheid,
        banden: ctx.banden,
        weergave: ctx.weergave,
        netwerk: true,
        locaties: locs.map((l) => {
          const p = toRD(l.lat, l.lng);
          return { id: l.id, x: p[0], y: p[1] };
        }),
      },
    });
    pendingCtx = ctx;
  }

  function verwerkResultaat(res) {
    laatste = { res, ctx: pendingCtx };
    teken();
    tekenResultaat();
    $('export').disabled = res.items.length === 0;
    if (res.fouten.length) {
      status('waarschuwing', res.fouten.length === 1 ? res.fouten[0].tekst : res.fouten.length + ' locaties liggen te ver van het netwerk.');
    } else {
      status('ok', 'Berekend in ' + fmtInt.format(res.ms) + ' ms.');
    }
  }

  // ------------------------------------------------------------- tekenen
  function locatieNaam(id) {
    const l = state.locaties.find((x) => x.id === id);
    return l ? l.naam : '';
  }

  function teken() {
    isoLaag.clearLayers();
    if (!laatste) return;
    const { res, ctx } = laatste;
    const modusLabel = cfg.modi[ctx.modus].label.toLowerCase();
    const netRenderer = rendererVoor('netwerk');
    for (const item of res.items) {
      const loc = item.locatieId === null ? null : state.locaties.find((l) => l.id === item.locatieId);
      if (item.locatieId !== null && !loc) continue;
      const kleuren = bandKleuren(ctx.banden.length, loc ? locKleur(loc) : null);
      const wie = loc ? loc.naam : 'alle locaties';
      if (state.toonVlakken) {
        const pane = paneVoor(loc ? loc.id : 'samen');
        const renderer = rendererVoor(pane);
        for (let b = ctx.banden.length - 1; b >= 0; b--) {
          const polys = item.polygonen[b];
          if (!polys.length) continue;
          const latlngs = polys.map((rings) => rings.map((r) => r.map(toLatLng)));
          L.polygon(latlngs, {
            pane,
            renderer,
            color: '#ffffff',
            weight: 1,
            opacity: 1,
            fillColor: kleuren[b],
            fillOpacity: 1,
          })
            .bindTooltip(`≤ ${ctx.banden[b]} min ${modusLabel} vanaf ${escapeHtml(wie)}`, { sticky: true })
            .addTo(isoLaag);
        }
      }
      if (state.toonNetwerk && item.netwerk) {
        for (let b = ctx.banden.length - 1; b >= 0; b--) {
          const lines = item.netwerk[b];
          if (!lines.length) continue;
          L.polyline(
            lines.map((l) => l.map(toLatLng)),
            { pane: 'netwerk', renderer: netRenderer, color: kleuren[b], weight: 2, opacity: 0.95, interactive: false },
          ).addTo(isoLaag);
        }
      }
    }
    // aansluiting op het netwerk
    for (const a of res.aansluitingen) {
      const loc = state.locaties.find((l) => l.id === a.locatieId);
      if (!loc || a.afstand < 15) continue;
      L.polyline([[loc.lat, loc.lng], toLatLng([a.x, a.y])], {
        pane: 'netwerk',
        renderer: netRenderer,
        color: '#52514e',
        weight: 1.5,
        dashArray: '4 4',
        interactive: false,
      }).addTo(isoLaag);
    }
  }

  function zetDekking() {
    Object.keys(map._panes)
      .filter((n) => n.startsWith('iso-'))
      .forEach((n) => (map.getPane(n).style.opacity = String(state.dekking)));
  }

  // ------------------------------------------------------------ markers
  const markers = new Map();
  function tekenMarkers() {
    markerLaag.clearLayers();
    markers.clear();
    state.locaties.forEach((loc, i) => {
      const kleur = locKleur(loc);
      const icon = L.divIcon({
        className: 'loc-marker' + (donkereTekst(kleur) ? ' donker-tekst' : '') + (loc.zichtbaar ? '' : ' verborgen'),
        html: `<span style="background:${kleur}">${i + 1}</span>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      const m = L.marker([loc.lat, loc.lng], { icon, draggable: true, title: loc.naam, keyboard: true, riseOnHover: true });
      m.on('dragend', () => {
        const p = m.getLatLng();
        if (!inGemeente(p.lat, p.lng)) {
          m.setLatLng([loc.lat, loc.lng]);
          buitenGemeente(p);
          return;
        }
        loc.lat = p.lat;
        loc.lng = p.lng;
        bewaar();
        plan(0);
      });
      m.addTo(markerLaag);
      markers.set(loc.id, m);
    });
  }

  function buitenGemeente(latlng) {
    L.popup({ closeButton: false, autoClose: true })
      .setLatLng(latlng)
      .setContent('Buiten de gemeente Rotterdam. Kies een locatie binnen de grens.')
      .openOn(map);
  }

  // ----------------------------------------------------------- locaties
  function voegToe(lat, lng, naam) {
    if (state.locaties.length >= cfg.maxLocaties) {
      status('waarschuwing', 'Maximaal ' + cfg.maxLocaties + ' locaties.');
      return;
    }
    if (!inGemeente(lat, lng)) {
      buitenGemeente([lat, lng]);
      return;
    }
    const id = volgendeId++;
    state.locaties.push({ id, naam: naam || 'Locatie ' + id, lat, lng, zichtbaar: true, kleur: vrijeKleur() });
    controleerWeergave();
    alles();
  }

  function controleerWeergave() {
    const teVeel = state.locaties.length > cfg.maxPerLocatie;
    if (teVeel && state.weergave === 'per') {
      state.weergave = 'samen';
      status('info', `Bij meer dan ${cfg.maxPerLocatie} locaties is alleen 'Gecombineerd' beschikbaar.`);
    }
  }

  map.on('click', (e) => voegToe(e.latlng.lat, e.latlng.lng));

  // -------------------------------------------------------- paneel: UI
  function tekenModus() {
    const box = $('modus');
    box.innerHTML = '';
    for (const [k, m] of Object.entries(cfg.modi)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = m.label;
      b.setAttribute('aria-pressed', String(state.modus === k));
      b.onclick = () => {
        state.modus = k;
        alles();
      };
      box.appendChild(b);
    }
    const m = cfg.modi[state.modus];
    const s = $('snelheid');
    s.min = m.min;
    s.max = m.max;
    s.step = m.stap;
    s.value = state.snelheid[state.modus];
    $('snelheid-waarde').textContent = fmtSpeed(state.snelheid[state.modus]) + ' km/u';
  }
  $('snelheid').addEventListener('input', (e) => {
    state.snelheid[state.modus] = Number(e.target.value);
    $('snelheid-waarde').textContent = fmtSpeed(state.snelheid[state.modus]) + ' km/u';
    bewaar();
    tekenLegenda();
    plan(200);
  });

  function tekenBanden() {
    const box = $('banden');
    box.innerHTML = '';
    const kleuren = bandKleuren(state.banden.length, null);
    state.banden.forEach((b, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `<span class="stip" style="background:${kleuren[i]}"></span>${b} min`;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = `${b} minuten verwijderen`;
      x.setAttribute('aria-label', `${b} minuten verwijderen`);
      x.disabled = state.banden.length === 1;
      x.onclick = () => {
        state.banden = state.banden.filter((v) => v !== b);
        alles();
      };
      chip.appendChild(x);
      box.appendChild(chip);
    });
    $('band-nieuw').disabled = state.banden.length >= cfg.maxBanden;
    $('band-form').querySelector('button').disabled = state.banden.length >= cfg.maxBanden;
  }
  $('band-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Math.round(Number($('band-nieuw').value));
    if (!Number.isFinite(v) || v < 1 || v > cfg.maxMinuten) {
      status('waarschuwing', `Kies een reistijd tussen 1 en ${cfg.maxMinuten} minuten.`);
      return;
    }
    if (state.banden.includes(v)) return;
    if (state.banden.length >= cfg.maxBanden) return;
    state.banden = [...state.banden, v].sort((a, b) => a - b);
    $('band-nieuw').value = '';
    alles();
  });

  function tekenLocaties() {
    const ol = $('locaties');
    ol.innerHTML = '';
    state.locaties.forEach((loc, i) => {
      const li = document.createElement('li');
      if (!loc.zichtbaar) li.className = 'verborgen';
      const kleur = locKleur(loc);
      const nr = document.createElement('button');
      nr.type = 'button';
      nr.className = 'nummer' + (donkereTekst(kleur) ? ' donker-tekst' : '');
      nr.style.background = kleur;
      nr.textContent = String(i + 1);
      nr.title = 'Ga naar locatie';
      nr.onclick = () => map.panTo([loc.lat, loc.lng]);
      const naam = document.createElement('input');
      naam.type = 'text';
      naam.value = loc.naam;
      naam.setAttribute('aria-label', 'Naam locatie ' + (i + 1));
      naam.addEventListener('change', () => {
        loc.naam = naam.value.trim() || 'Locatie ' + loc.id;
        naam.value = loc.naam;
        bewaar();
        tekenMarkers();
        tekenResultaat();
        teken();
      });
      const zicht = document.createElement('input');
      zicht.type = 'checkbox';
      zicht.className = 'zicht';
      zicht.checked = loc.zichtbaar;
      zicht.title = 'Meenemen in de berekening';
      zicht.setAttribute('aria-label', 'Locatie ' + (i + 1) + ' meenemen');
      zicht.onchange = () => {
        loc.zichtbaar = zicht.checked;
        alles();
      };
      const weg = document.createElement('button');
      weg.type = 'button';
      weg.className = 'weg';
      weg.textContent = '×';
      weg.title = 'Verwijderen';
      weg.setAttribute('aria-label', 'Locatie ' + (i + 1) + ' verwijderen');
      weg.onclick = () => {
        state.locaties = state.locaties.filter((l) => l.id !== loc.id);
        alles();
      };
      li.append(nr, naam, zicht, weg);
      ol.appendChild(li);
    });
    $('wis-alles').hidden = state.locaties.length < 2;
  }
  $('wis-alles').onclick = () => {
    state.locaties = [];
    alles();
  };

  function tekenWeergave() {
    const teVeel = state.locaties.length > cfg.maxPerLocatie;
    $('weergave')
      .querySelectorAll('button')
      .forEach((b) => {
        b.setAttribute('aria-pressed', String(state.weergave === b.dataset.waarde));
        if (b.dataset.waarde === 'per') b.disabled = teVeel;
        b.onclick = () => {
          state.weergave = b.dataset.waarde;
          alles();
        };
      });
    $('weergave-uitleg').textContent =
      state.weergave === 'per'
        ? 'Elke locatie een eigen isochroon en kleur.'
        : 'Reistijd naar de dichtstbijzijnde locatie.';
    $('toon-vlakken').checked = state.toonVlakken;
    $('toon-netwerk').checked = state.toonNetwerk;
    $('dekking').value = state.dekking;
    $('dekking-waarde').textContent = Math.round(state.dekking * 100) + '%';
    const sel = $('basiskaart');
    if (!sel.options.length) {
      for (const [k, v] of Object.entries(cfg.basiskaarten)) sel.add(new Option(v, k));
    }
    sel.value = state.basiskaart;
  }
  $('toon-vlakken').onchange = (e) => {
    state.toonVlakken = e.target.checked;
    bewaar();
    teken();
  };
  $('toon-netwerk').onchange = (e) => {
    state.toonNetwerk = e.target.checked;
    bewaar();
    teken();
  };
  $('dekking').addEventListener('input', (e) => {
    state.dekking = Number(e.target.value);
    $('dekking-waarde').textContent = Math.round(state.dekking * 100) + '%';
    zetDekking();
  });
  $('basiskaart').onchange = (e) => {
    state.basiskaart = e.target.value;
    zetBasiskaart();
    bewaar();
  };

  function tekenLegenda() {
    const box = $('legenda');
    const n = state.banden.length;
    const label = cfg.modi[state.modus].label.toLowerCase();
    const speed = fmtSpeed(state.snelheid[state.modus]);
    let html = '';
    if (state.weergave === 'samen' || !state.locaties.length) {
      const k = bandKleuren(n, null);
      html = state.banden
        .map((b, i) => `<div class="rij"><span class="vak" style="background:${k[i]}"></span>≤ ${b} min ${label}</div>`)
        .join('');
    } else {
      const k = bandKleuren(n, locKleur(state.locaties[0]));
      html =
        `<div class="rij"><span class="strook">${k.map((c) => `<span class="vak" style="background:${c}"></span>`).join('')}</span>` +
        `<span>${state.banden.map((b) => b).join(' / ')} min</span></div>` +
        '<p class="hint">Donker = dichtbij, licht = verder weg. Kleur = locatie.</p>';
    }
    box.innerHTML = html + `<p class="hint">Snelheid ${speed} km/u, gemeten over het netwerk.</p>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function tekenResultaat() {
    const box = $('resultaat');
    if (!laatste) {
      box.innerHTML = state.locaties.length
        ? '<p class="leeg">Geen locaties geselecteerd.</p>'
        : '<p class="leeg">Voeg een locatie toe om te beginnen.</p>';
      return;
    }
    const { res, ctx } = laatste;
    const label = cfg.modi[ctx.modus].label.toLowerCase();
    let html = '';
    for (const item of res.items) {
      const loc = item.locatieId === null ? null : state.locaties.find((l) => l.id === item.locatieId);
      if (item.locatieId !== null && !loc) continue;
      const kleur = loc ? locKleur(loc) : cfg.bandKleuren[1];
      const titel = loc ? escapeHtml(loc.naam) : `Alle locaties samen (${ctx.locaties.length})`;
      html += `<div class="blok"><h3><span class="stip" style="background:${kleur}"></span>${titel}</h3>`;
      html += `<table><thead><tr><th scope="col">Reistijd ${label}</th><th scope="col">Oppervlak</th><th scope="col">Inwoners</th></tr></thead><tbody>`;
      item.statistiek.forEach((s, b) => {
        html += `<tr><td>≤ ${ctx.banden[b]} min</td><td>${fmtKm2.format(s.km2)} km²</td><td>${fmtInt.format(s.inwoners)}</td></tr>`;
      });
      html += '</tbody></table>';
      if (item.raaktRand) {
        html +=
          '<p class="melding waarschuwing">Let op: deze isochroon raakt de rand van het netwerkgebied (gemeente + 3 km). Daarbuiten is niet gerekend; het werkelijke bereik is groter.</p>';
      }
      const a = res.aansluitingen.find((x) => x.locatieId === item.locatieId);
      if (a && a.afstand > 50) {
        html += `<p class="voetnoot">Locatie ligt ${fmtInt.format(a.afstand)} m van het dichtstbijzijnde ${ctx.modus === 'lopen' ? 'looppad' : 'fietspad of -straat'}.</p>`;
      }
      html += '</div>';
    }
    for (const f of res.fouten) {
      html += `<p class="melding fout">${escapeHtml(locatieNaam(f.locatieId))}: ${escapeHtml(f.tekst)}</p>`;
    }
    if (meta) {
      html += `<p class="voetnoot">Inwoners: CBS ${meta.inwoners_jaar}, naar rato van het bereikte deel per 100 m-vierkant, afgerond op tientallen. Oppervlak inclusief 50 m rond het bereikte netwerk.</p>`;
    }
    box.innerHTML = html;
  }

  function tekenInfo() {
    const osmDatum = meta && meta.osm_datum ? new Date(meta.osm_datum).toLocaleDateString('nl-NL') : 'onbekend';
    const c = cfg.contact;
    $('titel').textContent = cfg.titel;
    $('ondertitel').textContent = cfg.ondertitel;
    $('info').innerHTML =
      `<p><strong>Over deze kaart</strong></p>` +
      `<p>${escapeHtml(cfg.disclaimer)}</p>` +
      `<p>Bronnen: netwerk &copy; OpenStreetMap-bijdragers (ODbL), stand ${osmDatum}; inwoners CBS Vierkantstatistieken 100 m ${meta ? meta.inwoners_jaar : ''}; gemeentegrens en achtergrondkaart Kadaster via PDOK (CC-BY 4.0).</p>` +
      (c && c.naam
        ? `<p>Contact: ${c.email ? `<a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.naam)}</a>` : escapeHtml(c.naam)}</p>`
        : '');
  }

  // ------------------------------------------------------------ zoeken
  (function zoeken() {
    const input = $('zoek');
    const lijst = $('zoek-lijst');
    let ctrl = null;
    let items = [];
    let actief = -1;
    let t = null;
    function sluit() {
      lijst.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      actief = -1;
    }
    function render() {
      lijst.innerHTML = '';
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.id = 'zoek-optie-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === actief));
        li.innerHTML = `${escapeHtml(it.naam)}<small>${escapeHtml(it.type)}</small>`;
        li.addEventListener('mousedown', (e) => {
          e.preventDefault();
          kies(i);
        });
        lijst.appendChild(li);
      });
      lijst.hidden = items.length === 0;
      input.setAttribute('aria-expanded', String(items.length > 0));
      input.setAttribute('aria-activedescendant', actief >= 0 ? 'zoek-optie-' + actief : '');
    }
    async function kies(i) {
      const it = items[i];
      if (!it) return;
      sluit();
      input.value = '';
      try {
        const r = await IsoGeocoder.lookup(it.id);
        voegToe(r.lat, r.lng, r.naam);
        map.setView([r.lat, r.lng], Math.max(map.getZoom(), 14));
      } catch (err) {
        status('fout', err.message);
      }
    }
    input.addEventListener('input', () => {
      clearTimeout(t);
      const q = input.value.trim();
      if (q.length < 2) {
        items = [];
        render();
        return;
      }
      t = setTimeout(async () => {
        if (ctrl) ctrl.abort();
        ctrl = new AbortController();
        try {
          items = await IsoGeocoder.suggest(q, ctrl.signal);
          actief = items.length ? 0 : -1;
          render();
        } catch (err) {
          if (err.name !== 'AbortError') status('fout', 'Zoeken mislukt: ' + err.message);
        }
      }, 250);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' && items.length) {
        actief = (actief + 1) % items.length;
        render();
        e.preventDefault();
      } else if (e.key === 'ArrowUp' && items.length) {
        actief = (actief - 1 + items.length) % items.length;
        render();
        e.preventDefault();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (actief >= 0) kies(actief);
      } else if (e.key === 'Escape') {
        sluit();
      }
    });
    input.addEventListener('blur', () => setTimeout(sluit, 150));
  })();

  // ------------------------------------------------------------ export
  function datumcode() {
    const d = new Date();
    return String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }

  async function exporteer() {
    if (!laatste || !laatste.res.items.length) return;
    const { res, ctx } = laatste;
    const knop = $('export');
    knop.disabled = true;
    status('bezig', 'GeoPackage maken…');
    try {
      const naam = (id) => (id === null ? 'gecombineerd' : locatieNaam(id) || ctx.locaties.find((l) => l.id === id)?.naam || '');
      const vw = ctx.modus;
      const locFeatures = ctx.locaties.map((l) => ({
        coords: toRD(l.lat, l.lng),
        attrs: { naam: locatieNaam(l.id) || l.naam, vervoerwijze: vw, snelheid_kmh: ctx.snelheid },
      }));
      const isoFeatures = [];
      const netFeatures = [];
      for (const item of res.items) {
        item.polygonen.forEach((polys, b) => {
          if (!polys.length) return;
          isoFeatures.push({
            coords: polys,
            attrs: {
              locatie: naam(item.locatieId),
              vervoerwijze: vw,
              snelheid_kmh: ctx.snelheid,
              minuten: ctx.banden[b],
              opp_km2: item.statistiek[b].km2,
              inwoners: item.statistiek[b].inwoners,
              raakt_rand: item.raaktRand ? 1 : 0,
            },
          });
        });
        (item.netwerk || []).forEach((lines, b) => {
          if (!lines.length) return;
          netFeatures.push({
            coords: lines,
            attrs: { locatie: naam(item.locatieId), vervoerwijze: vw, minuten: ctx.banden[b], minuten_vanaf: b ? ctx.banden[b - 1] : 0 },
          });
        });
      }
      const bytes = await IsoGpkg.write(
        [
          {
            naam: 'locaties',
            beschrijving: 'Startlocaties',
            type: 'POINT',
            velden: [
              { naam: 'naam', type: 'TEXT' },
              { naam: 'vervoerwijze', type: 'TEXT' },
              { naam: 'snelheid_kmh', type: 'REAL' },
            ],
            features: locFeatures,
          },
          {
            naam: 'isochronen',
            beschrijving: 'Bereik binnen de reistijd (cumulatief: 10 min bevat 5 min)',
            type: 'MULTIPOLYGON',
            velden: [
              { naam: 'locatie', type: 'TEXT' },
              { naam: 'vervoerwijze', type: 'TEXT' },
              { naam: 'snelheid_kmh', type: 'REAL' },
              { naam: 'minuten', type: 'INTEGER' },
              { naam: 'opp_km2', type: 'REAL' },
              { naam: 'inwoners', type: 'INTEGER' },
              { naam: 'raakt_rand', type: 'INTEGER' },
            ],
            features: isoFeatures,
          },
          {
            naam: 'bereikbaar_netwerk',
            beschrijving: 'Bereikbaar netwerk per reistijdband (minuten_vanaf < reistijd <= minuten)',
            type: 'MULTILINESTRING',
            velden: [
              { naam: 'locatie', type: 'TEXT' },
              { naam: 'vervoerwijze', type: 'TEXT' },
              { naam: 'minuten', type: 'INTEGER' },
              { naam: 'minuten_vanaf', type: 'INTEGER' },
            ],
            features: netFeatures,
          },
        ],
        'vendor/',
      );
      const blob = new Blob([bytes], { type: 'application/geopackage+sqlite3' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${datumcode()}_isochronen_rotterdam.gpkg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      status('ok', `GeoPackage opgeslagen (${fmtInt.format(bytes.length / 1024)} kB, RD New).`);
    } catch (err) {
      status('fout', 'Export mislukt: ' + err.message);
    } finally {
      knop.disabled = !laatste;
    }
  }
  $('export').onclick = exporteer;

  // -------------------------------------------------------------- link
  function bewaar() {
    history.replaceState(null, '', IsoState.encode(state));
  }
  $('deel').onclick = async () => {
    bewaar();
    try {
      await navigator.clipboard.writeText(location.href);
      status('ok', 'Link gekopieerd. Wie hem opent, ziet dezelfde kaart.');
    } catch (err) {
      window.prompt('Kopieer deze link:', location.href);
    }
  };
  window.addEventListener('hashchange', () => location.reload());

  // ------------------------------------------------------------ mobiel
  $('paneel-open').onclick = () => $('paneel').classList.add('open');
  $('paneel-sluit').onclick = () => $('paneel').classList.remove('open');

  // ------------------------------------------------------------ alles
  function alles() {
    tekenModus();
    tekenBanden();
    tekenLocaties();
    tekenWeergave();
    tekenLegenda();
    tekenMarkers();
    tekenResultaat();
    bewaar();
    plan();
  }

  // ------------------------------------------------------------ start
  const uitLink = IsoState.decode(location.hash, cfg);
  if (uitLink.modus) state.modus = uitLink.modus;
  if (uitLink.snelheid) state.snelheid[state.modus] = uitLink.snelheid;
  for (const k of ['banden', 'weergave', 'toonVlakken', 'toonNetwerk', 'basiskaart']) {
    if (uitLink[k] !== undefined) state[k] = uitLink[k];
  }
  if (state.basiskaart !== 'grijs') zetBasiskaart();
  tekenInfo();
  alles();

  fetch('data/gebieden.geojson')
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then((fc) => {
      for (const f of fc.features) {
        const isGemeente = f.properties.soort === 'gemeente';
        if (isGemeente) gemeenteGeom = f.geometry;
        L.geoJSON(f, {
          pane: 'gebied',
          interactive: false,
          style: isGemeente
            ? { color: '#0b0b0b', weight: 1.5, opacity: 0.7, fill: false }
            : { color: '#52514e', weight: 1, opacity: 0.6, dashArray: '4 6', fill: false },
        }).addTo(gebiedLaag);
      }
      if (gemeenteGeom && !(uitLink.locaties && uitLink.locaties.length)) {
        map.fitBounds(L.geoJSON(gemeenteGeom).getBounds(), { padding: [10, 10] });
      }
      if (uitLink.locaties) {
        let overgeslagen = 0;
        for (const l of uitLink.locaties) {
          if (!inGemeente(l.lat, l.lng)) {
            overgeslagen++;
            continue;
          }
          const id = volgendeId++;
          state.locaties.push({ id, naam: l.naam || 'Locatie ' + id, lat: l.lat, lng: l.lng, zichtbaar: l.zichtbaar, kleur: vrijeKleur() });
        }
        controleerWeergave();
        alles();
        if (state.locaties.length) {
          map.fitBounds(L.latLngBounds(state.locaties.map((l) => [l.lat, l.lng])).pad(0.5), { maxZoom: 14 });
        }
        if (overgeslagen) status('waarschuwing', overgeslagen + ' locatie(s) uit de link liggen buiten Rotterdam en zijn overgeslagen.');
      }
    })
    .catch((err) => status('fout', 'Gemeentegrens laden mislukt: ' + err.message));
})();
