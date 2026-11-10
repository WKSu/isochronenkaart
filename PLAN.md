# Plan: Isochronenkaart Rotterdam (walk + bike, static site)

## Context

Goal: a static website that gives quick insight into how reachable a place in Rotterdam is.
The user drops one or more locations on a map and sees network-based travel-time isochrones
for walking and cycling, then exports the result to GeoPackage for use in QGIS/ArcGIS.

The project folder `C:\Users\157414\claude\isochronen_kaart` is empty (greenfield, no git repo).
There is no server: everything is computed in the browser on a pre-built OpenStreetMap network.

### Decisions made with the user

| Topic | Decision |
|---|---|
| Hosting | GitHub Pages (static folder, data in separate files) |
| Routing | In the browser, on a pre-built OSM network snapshot. No API, no key |
| Display | Polygons per time band **and** reachable streets coloured by time, each switchable |
| Multiple locations | Two modes, switchable: per location / combined (time to nearest location) |
| Extent | Gemeente Rotterdam + 3 km buffer; locations may only be placed inside the gemeente |
| Extras in v1 | Address search (PDOK), inhabitants reached (CBS 100 m grid), shareable link (URL) |
| Language | Dutch UI, Dutch layer and field names in the export |
| Publishing | Data built locally with `uv run`, committed to the repo. No CI |
| Style | Inspired by skill `so-mob-014-htmlkaart-maker` (PDOK basemap, green `#00811F`, info block with disclaimer), but a side panel instead of a floating layer control because this is an app, not a data map |

### Assumptions (mine, cheap to change)

- Isochrones are **outbound** (from the location). Only matters for one-way streets when cycling.
- Constant speed per mode: walking 5 km/h, cycling 15 km/h, both adjustable with a slider.
- Ferries are excluded. No traffic-light delays, no bridge openings.
- Exported polygons are **cumulative** ("within 10 min" contains "within 5 min"), largest first.
- Export CRS is RD New (EPSG:28992).
- Default bands 5 / 10 / 15 min, editable, at most 5 bands, maximum 45 min.

---

## Architecture

```
isochronen_kaart/
  build/
    build_data.py        # PEP 723, uv run. OSM + boundary + CBS -> docs/data/
    check_gpkg.py        # PEP 723. Reads an exported .gpkg and validates it
    cache/               # downloads (gitignored)
  docs/                  # GitHub Pages root (Pages setting: main, /docs)
    index.html
    .nojekyll
    css/style.css
    js/config.js         # modes, default speeds, bands, colours, texts, contact line
    js/core.js           # pure logic: graph, snap, Dijkstra, raster, contours, stats
    js/worker.js         # thin Web Worker wrapper around core.js
    js/app.js            # Leaflet map, side panel, state, rendering
    js/geocoder.js       # PDOK Locatieserver
    js/state.js          # URL-hash encode/decode
    js/gpkg.js           # GeoPackage writer on sql.js
    vendor/              # leaflet 1.9.4, proj4, d3-array + d3-contour, sql.js (+ .wasm)
    data/                # network.bin.gz, network.json, inwoners.bin.gz, gemeente.geojson
  tests/core.test.mjs    # node --test, only if Node is installed
  README.md
  .gitignore
```

No bundler, no npm project. Libraries are **vendored** into `docs/vendor/` with pinned versions
(downloaded once with curl from cdnjs / jsdelivr), so the site has no CDN dependency and the
sql.js wasm file is same-origin. The only runtime internet calls are PDOK tiles and PDOK search.

All geometry work happens in RD New metres (EPSG:28992). Only the Leaflet display layer is
converted to WGS84 with proj4. This makes the raster, areas, the CBS grid and the export trivial.

---

## Step 0: Preflight (do first, report blockers)

1. `uv --version`; `node --version` (optional, only for tests).
2. Check reachability from this laptop (municipal network may block some hosts):
   - Geofabrik: `https://download.geofabrik.de/europe/netherlands/zuid-holland-latest.osm.pbf`
   - PDOK boundary: `https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1/collections/gemeentegebied/items?naam=Rotterdam&f=json` (verify the collection and property names; gemeente code 0599)
   - CBS 100 m grid: find the current "vierkantstatistieken 100 m" download on cbs.nl / PDOK (verify URL, year and the inhabitants column, expected `aantal_inwoners`)
   - PDOK search: `https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest`
3. Fallbacks if a host is blocked: OSM via Overpass (osmnx); boundary via OSM/Nominatim;
   CBS via the PDOK WFS/OGC API with a bbox filter. If nothing works, stop and tell the user.

---

## Step 1: Data build (`build/build_data.py`)

Follow the user's CLAUDE.md: PEP 723 header, `from __future__ import annotations`, type hints,
`pathlib`, no bare `except`, print shape/dtypes after loads, `uvx ruff format . && uvx ruff check . --fix`.
Dependencies: `osmium` (pyosmium), `numpy`, `shapely`, `pyproj`, `geopandas`, `pyogrio`, `requests`.
Run: `uv run build/build_data.py` (downloads are cached in `build/cache/`).

**1a. Study area.** Gemeente polygon -> RD -> buffer 3000 m. Write `docs/data/gemeente.geojson`
(WGS84, simplified to about 5 m) for display and for the "inside Rotterdam" check.

**1b. Network from OSM.** Read the PBF with pyosmium (`FileProcessor(...).with_locations()`,
key filter `highway`). Keep ways with at least one node inside the study area. Build the graph by hand:
a graph node is any OSM node that is a way endpoint or is used by more than one kept way; split
ways at graph nodes; each piece is one edge with its full polyline. Flag nodes where a way was
cut by the study-area boundary (`rand` flag, used for the "isochrone hits the edge" warning).

Per-edge flags (bit 0 walk, bit 1 bike u->v, bit 2 bike v->u), Dutch defaults:

| Rule | Walk | Bike |
|---|---|---|
| `highway` motorway, trunk (+links), `motorroad=yes`, construction, proposed, raceway, busway, bus_guideway, corridor, elevator | no | no |
| `access` = no / private | no, unless `foot` = yes/designated/permissive | no, unless `bicycle` = yes/designated/permissive |
| `foot` = no / private / use_sidepath | no | n/a |
| `bicycle` = no / private / use_sidepath / dismount | n/a | no |
| footway, pedestrian, bridleway | yes | only if `bicycle` = yes/designated/permissive |
| steps | yes | no |
| cycleway, path | yes (unless `foot=no`) | yes |
| residential, living_street, unclassified, service, track, tertiary, secondary, primary (+links), road | yes | yes |
| Bike one-way | n/a | forward only if `oneway` in yes/true/1 or `junction` in roundabout/circular, **unless** `oneway:bicycle=no` or any `cycleway*` = opposite / opposite_lane / opposite_track. `oneway=-1` or `oneway:bicycle=-1` -> backward only. `oneway:bicycle=yes` -> forward only |

`bicycle=use_sidepath` matters in the Netherlands: it keeps cyclists off roads with a parallel cycle path.
Pedestrian areas (`highway=pedestrian` + `area=yes`) are kept as their outline so squares stay connected.

Clean-up: per mode, keep only the largest connected component (clear the mode bit elsewhere),
then drop edges with no bits and orphan nodes. This prevents snapping to isolated fragments.

**1c. Binary format.** `docs/data/network.bin.gz` (gzip, little-endian, sections in this order) and
`docs/data/network.json` (counts, byte offsets, bbox, build date, OSM file timestamp, CRS).

| Section | Type | Length |
|---|---|---|
| node_x, node_y (RD m) | Float32 | N each |
| node_flags (bit 0 = rand) | Uint8 | N (pad to 4 bytes) |
| edge_u, edge_v | Uint32 | E each |
| edge_len (m, along the polyline) | Float32 | E |
| edge_flags | Uint8 | E (pad to 4 bytes) |
| edge_geom_start | Uint32 | E + 1 |
| geom_x, geom_y (RD m, full polylines incl. endpoints) | Float32 | G each |

Size budget: `docs/data/` under 20 MB gzipped. If exceeded, simplify polylines (Douglas-Peucker 1 m).

**1d. Inhabitants.** CBS 100 m grid, read with a bbox filter for the study area, keep cells with
inhabitants > 0 (suppressed values such as -99997 count as 0). Write `docs/data/inwoners.bin.gz`:
Int32 x, Int32 y (south-west corner, RD), Int32 count; year and source go into `network.json`.

**1e. Build report** printed at the end: nodes, edges, km per mode, file sizes, population total
inside the gemeente (sanity: roughly 650-680 thousand).

---

## Step 2: Engine (`docs/js/core.js` + `worker.js`)

`core.js` is pure (no DOM, no Leaflet) so it runs in the worker and under `node --test`.

1. **Load.** Fetch `.bin.gz`; if the first bytes are `1f 8b`, decompress with
   `DecompressionStream('gzip')`, otherwise use as is (some servers decompress transparently).
   Create typed-array views from the offsets in `network.json`. Build one CSR adjacency per mode.
2. **Snap.** Spatial hash (100 m buckets) over polyline vertices -> candidate edges -> exact nearest
   point on a segment, restricted to edges allowed for the mode. Max snap distance 250 m, else
   return an error ("Geen netwerk in de buurt"). Seed both end nodes with the along-edge distance
   (respecting bike direction) plus the straight-line access distance.
3. **Dijkstra** in metres with a binary heap on typed arrays, cut-off = speed x largest band.
   Per-location mode: one run per location, cached until that location or a setting changes.
   Combined mode: one multi-source run with all seeds.
4. **Time along edges.** For a point at distance s from u on an edge of length L:
   `d = min(d_u + s if u->v allowed, d_v + (L - s) if v->u allowed)`; on the snapped edge also
   `access + |s - s_snap|`. This handles partially reachable edges without special cases.
5. **Raster.** Grid aligned to RD multiples of 20 m (so 5 x 5 cells fit one CBS cell), covering
   the reached bbox + 100 m. Stamp sample points every 10 m along reached edges (keep the minimum).
   Dilate with a circular kernel of radius 50 m, adding the offset distance to the value. The 50 m
   cap is what keeps the river, rail yards and docks empty. Convert metres to minutes.
6. **Polygons.** `d3.contours().size([w, h]).smooth(true)` on negated minutes (unreached = large
   negative sentinel), one threshold per band -> cumulative MultiPolygons. Convert grid coordinates
   to RD (mind the half-cell offset and the y flip). Keep RD for export, WGS84 for display.
7. **Reachable network.** Split reached edges at band thresholds, group into one multi-polyline
   per band (a handful of Leaflet layers instead of tens of thousands).
8. **Statistics per band (cumulative).** Area in km2 (raster cell count x 400 m2). Inhabitants: for
   each CBS cell, the minimum time over its 25 raster cells decides the band. Round inhabitants to 100.
9. **Edge warning.** If any node with the `rand` flag is reached, return `raaktRand: true`.

Worker messages: `init` -> `ready {meta}`; `bereken {modus, snelheid, banden, weergave, locaties}` ->
`resultaat {perLocatie | gecombineerd: {polygonen, netwerk, statistiek, raaktRand}}`; `fout {tekst}`.
Transfer typed arrays, do not clone them. Target: under 300 ms for a 15 min bike isochrone.

---

## Step 3: Interface (`index.html`, `app.js`, `style.css`)

For colours, load the `dataviz` skill before choosing a palette (sequential ramp for time bands,
categorical hues for locations, checked for colour-blind safety).

- **Map.** Leaflet 1.9.4, canvas renderer. Basemap PDOK BRT-Achtergrondkaart, default theme `grijs`
  (so the isochrone colours carry), switchable to `standaard`:
  `https://service.pdok.nl/brt/achtergrondkaart/wmts/v2_0/{thema}/EPSG:3857/{z}/{x}/{y}.png`,
  attribution "PDOK / (c) Kadaster (CC-BY 4.0)" plus "(c) OpenStreetMap-bijdragers" and "CBS".
  Gemeente outline as a thin line. Start view on the gemeente bounds.
- **Side panel (left, collapsible on small screens)**, Arial, accent `#00811F`:
  1. Title "Isochronenkaart Rotterdam", data date from `network.json`.
  2. Vervoerwijze: Lopen / Fietsen (segmented control) + speed slider (3-7 and 10-25 km/h).
  3. Reistijd: band chips (add, remove, edit minutes).
  4. Locaties: address search box; "Klik op de kaart om een locatie toe te voegen"; list with
     colour dot, editable name, show/hide, delete; "Alles wissen". Markers are draggable; recompute on drag end.
  5. Weergave: Per locatie / Gecombineerd; checkboxes Vlakken, Bereikbaar netwerk; opacity slider.
  6. Resultaat: table per band with km2 and inwoners (per location in per-location mode, selected
     location highlighted on the map); warning line when `raaktRand` is true.
  7. Buttons: "Exporteer GeoPackage", "Kopieer link".
  8. Info block (green, like the skill): disclaimer, sources, limitations. Proposed disclaimer:
     "Deze kaart is gemaakt met behulp van AI en is indicatief. Reistijden zijn berekend met vaste
     snelheden op het OpenStreetMap-netwerk, zonder wachttijden bij kruispunten of veerverbindingen.
     Aan de weergave kunnen geen rechten worden ontleend." The contact line comes from `config.js`
     and stays empty until the user supplies a name and address (do not invent one).
- **Rendering.** Cumulative polygons drawn largest first in one pane with fill opacity 1 and the
  pane's CSS opacity set by the slider, so bands look like clean rings without polygon clipping.
  Combined mode: one sequential ramp. Per-location mode: one hue per location, lighter per band.
- **Rules.** A click outside the gemeente polygon is refused with a short message. Loading state
  while the network downloads. Errors are shown in the panel, never silently dropped.

---

## Step 4: GeoPackage export (`docs/js/gpkg.js`)

sql.js (SQLite wasm), hand-written minimal GeoPackage 1.3, no spatial index (not required):

- `PRAGMA application_id = 1196444487; PRAGMA user_version = 10300;`
- `gpkg_spatial_ref_sys` (rows -1, 0, 4326 and 28992 with WKT), `gpkg_contents`, `gpkg_geometry_columns`.
- Geometry blob: `GP`, version 0, flags 3 (little-endian, xy envelope), srs_id 28992, envelope, WKB.
- Layers:
  - `locaties` (Point): `naam`, `vervoerwijze`, `snelheid_kmh`
  - `isochronen` (MultiPolygon): `locatie` (name or "gecombineerd"), `vervoerwijze`, `snelheid_kmh`,
    `minuten`, `opp_km2`, `inwoners`
  - `bereikbaar_netwerk` (MultiLineString): `locatie`, `vervoerwijze`, `minuten`
- Exports what is currently computed (respects the per-location / combined mode).
- File name `JJMMDD_isochronen_rotterdam.gpkg` (date first, team naming convention), via a Blob download.

`build/check_gpkg.py <file>`: lists layers with geopandas, asserts CRS EPSG:28992, non-empty,
valid geometries, bounds inside the Netherlands RD range.

---

## Step 5: Extras

- **Address search** (`geocoder.js`): PDOK `suggest` (debounce 250 ms, `fq=gemeentenaam:Rotterdam`),
  then `lookup?id=` and read `centroide_rd` / `centroide_ll`. Selecting a result adds a location.
- **Shareable link** (`state.js`): mode, speed, bands, display mode and locations (lat, lon to 5
  decimals, name) in the URL hash, updated with `history.replaceState`; restored on load.
- **Inhabitants**: as in step 2.8; show the CBS year next to the numbers.

---

## Step 6: Repo and publishing

- `README.md` (Dutch): what it is, how to rebuild data (`uv run build/build_data.py`), how to run
  locally (`uv run python -m http.server 8000 --directory docs`), sources and licences
  (OSM ODbL, PDOK/Kadaster CC-BY, CBS CC-BY), known limitations.
- `.gitignore`: `build/cache/`.
- `git init` and a local commit are fine. **Ask the user before** creating a GitHub repository,
  pushing, or enabling Pages: repo name, account/organisation, public or private. Pages on a free
  account means a public repo and a public site.

---

## Verification

1. **Build**: `uv run build/build_data.py` finishes; report shows plausible numbers; `docs/data` within budget.
2. **Core tests** (`node --test tests/`, skip if Node is missing): Dijkstra on a tiny hand-made graph;
   one-way handling; snap seeds; contour of a known raster; GeoPackage header bytes.
3. **Cross-check**: a small Python snippet (`uv run --with numpy --with scipy`) loads `network.bin.gz`,
   runs `scipy.sparse.csgraph.dijkstra` from one node and compares distances with `core.js` for the
   same node (max difference under 1 m).
4. **Browser** (`http://localhost:8000`), manual checklist:
   - Rotterdam Centraal, lopen 10 min: area clearly smaller than the 2.2 km2 straight-line circle,
     shape follows streets.
   - Location on the north bank near the Erasmusbrug: the isochrone crosses the river only via the bridge.
   - Location at the south entrance of the Maastunnel, fietsen 10 min: north bank is reached
     (bike/pedestrian tunnel works); the car tube is not used.
   - Fietsen on a one-way street with contraflow cycling allowed: reached in both directions.
   - Three locations: switch per locatie / gecombineerd; combined equals the union of the three.
   - Location near the gemeente border: isochrone continues into the neighbouring municipality;
     45 min bike shows the edge warning.
   - Click outside Rotterdam: refused with a message.
   - Copy link, open in a new tab: identical map.
5. **Export**: download the GeoPackage, run `uv run build/check_gpkg.py <file>`, and open it in QGIS
   on top of a PDOK layer: three layers, correct position, attributes filled.
6. **Pages dry run**: serve `docs/` from a sub-path (as GitHub Pages does) and confirm all paths are relative.

## Open items for the user at execution time

- Contact name/address for the info block (optional).
- GitHub repository name, owner and visibility.
- Whether exported polygons should be rings (5-10 min) instead of cumulative.

---

## Afwijkingen bij uitvoering (2026-11-10)

| Plan | Uitgevoerd | Waarom |
|---|---|---|
| Float32-coördinaten in `network.bin.gz` | Int32-decimeters, delta-gecodeerd; randlengtes berekend in de browser | 2,1 MB i.p.v. ~10 MB gzip |
| Alleen grootste component per modus houden | Componenten < 1 km weg; overige houden, snappen geeft hoofdnet voorrang (50 m straf) | Voorkomt dat afgelegen delen (Hoek van Holland) wegvallen |
| `corridor`/`elevator` uitsluiten | Meetellen voor lopen | Stationsgangen (Rotterdam Centraal) horen bij het loopnetwerk |
| `gemeente.geojson` | `gebieden.geojson` met gemeente + netwerkgebied | Netwerkgrens ook tonen |
| Inwoners: vierkant telt volledig mee | Naar rato van bereikte 20 m-cellen, afgerond op 10 | Nauwkeuriger aan de randen |
| Onbeperkt locaties per locatie-weergave | Max. 8 in 'Per locatie' (8 onderscheidbare kleuren), 25 in 'Gecombineerd' | Kleuren niet herhalen |
| Export-velden | Extra: `raakt_rand` (isochronen), `minuten_vanaf` (netwerk) | Waarschuwing en bandgrenzen ook in GIS |
| Browsertest met Playwright | Headless Edge is door beheer geblokkeerd; UI getest in jsdom met de echte engine | Beleid niet omzeilen |
| `node --test tests/` | `node --test tests/*.test.mjs` | Map-argument werkt niet op Node 24/Windows |
| Dijkstra-afstanden Float32 | Float64 | Float32-afronding liet knopen wegvallen (bug gevonden in test) |
