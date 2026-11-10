# Isochronenkaart Rotterdam

Statische website die laat zien hoe ver je in Rotterdam komt **lopend of fietsend**.
Zet één of meer locaties op de kaart en zie per reistijd (bijvoorbeeld 5, 10 en 15 minuten)
het bereikbare gebied, de bereikbare straten en het aantal inwoners dat je bereikt.
Exporteer het resultaat als **GeoPackage** (RD New, EPSG:28992) voor QGIS of ArcGIS.

Alles wordt in de browser berekend op een vooraf gebouwd OpenStreetMap-netwerk.
Er is geen server, geen API-sleutel, en locaties verlaten de computer niet
(alleen de adreszoeker vraagt PDOK om een adres).

## Gebruik

| Wat | Hoe |
|---|---|
| Locatie toevoegen | Klik op de kaart (binnen de gemeente) of zoek een adres |
| Locatie verplaatsen | Sleep de marker |
| Vervoerwijze en snelheid | Lopen (standaard 5 km/u) of fietsen (standaard 15 km/u), schuif voor een andere snelheid |
| Reistijden | Maximaal 5 banden, 1 tot 45 minuten |
| Per locatie / Gecombineerd | Elke locatie apart (max. 8), of de reistijd naar de dichtstbijzijnde locatie (max. 25) |
| Vlakken / Bereikbaar netwerk | Gebied per reistijd en/of de straten zelf, gekleurd naar reistijd |
| Delen | "Kopieer link": alle instellingen en locaties zitten in de link |
| Exporteren | "Exporteer GeoPackage": lagen `locaties`, `isochronen`, `bereikbaar_netwerk` |

## Lokaal draaien

De pagina gebruikt een Web Worker en moet daarom via een webserver geopend worden,
niet als los bestand:

```bash
uv run --no-project python -m http.server 8000 --directory docs
```

Open daarna <http://localhost:8000>.

## Data opnieuw bouwen

```bash
uv run build/build_data.py
```

Downloadt (eenmalig, ~500 MB, in `build/cache/`) het OSM-extract van Zuid-Holland
(Geofabrik), de gemeentegrens (PDOK, Kadaster) en het CBS-vierkant 100 m, en schrijft
`docs/data/`. Duurt ongeveer een minuut. Verwijder `build/cache/` voor verse data
(de gemeentegrens wordt ook gecachet). Commit daarna `docs/data/`.

Het CBS-jaar staat bovenin `build/build_data.py` (`CBS_YEAR`).

## Publiceren op GitHub Pages

1. Push de repository naar GitHub.
2. Settings → Pages → *Deploy from a branch* → branch `main`, map `/docs`.

Alle paden zijn relatief, dus de site werkt ook onder `https://<account>.github.io/<repo>/`.
Let op: met een gratis account is de repository en de site openbaar.

## Testen

```bash
node --test tests/*.test.mjs                 # rekenkern + Rotterdamse scenario's + export
ISO_OUT=uit node --test tests/scenario.test.mjs
uv run build/check_gpkg.py uit/test_export.gpkg --png uit/controle.png
```

De scenario's controleren onder meer dat fietsers de Maastunnel gebruiken, dat lopers de
Nieuwe Maas alleen via een brug oversteken en dat isochronen doorlopen over de gemeentegrens.

## Hoe het rekent

1. **Netwerk.** Alle OSM-wegen en -paden in de gemeente + 3 km. Per rand: toegankelijk voor
   lopen, fietsen heen, fietsen terug (Nederlandse standaarden: `bicycle=use_sidepath` en
   `bicycle=no` respecteren, eenrichtingsverkeer met `oneway:bicycle=no` en tegenrichting-fietsstroken).
   Snelwegen, autowegen, private wegen en losse netwerkdelen < 1 km vallen af. Gangen
   (`highway=corridor`, bijvoorbeeld in stations) tellen mee voor lopen.
2. **Kortste route.** De locatie wordt gekoppeld aan het dichtstbijzijnde pad voor die
   vervoerwijze (max. 250 m), daarna Dijkstra over het netwerk.
3. **Vlakken.** Elk bereikt punt van het netwerk kleurt een raster van 20 m tot 50 m rondom in.
   Zo blijven rivieren, havens en spoorlijnen leeg. Contouren per reistijd met d3-contour.
4. **Inwoners.** CBS-vierkanten van 100 m, naar rato van het bereikte deel van elk vierkant.

### Beperkingen

- Vaste snelheid; geen wachttijd bij verkeerslichten, bruggen die open staan of drukte.
- Geen veerponten (Waterbus, fietsveren) en geen openbaar vervoer.
- Hoogteverschillen en trappen tellen niet zwaarder dan een gewoon pad.
- Het netwerk is een momentopname van OpenStreetMap (datum staat in de pagina).
- Buiten de gemeente + 3 km is niet gerekend; de pagina waarschuwt als een isochroon die rand raakt.

## Bronnen en licenties

- Netwerk: © OpenStreetMap-bijdragers, [ODbL](https://www.openstreetmap.org/copyright), via Geofabrik.
- Gemeentegrens en achtergrondkaart: Kadaster via PDOK, CC-BY 4.0.
- Inwoners: CBS Vierkantstatistieken 100 m (PDOK), CC-BY 4.0.
- Adressen zoeken: PDOK Locatieserver.
- Bibliotheken in `docs/vendor/`: Leaflet 1.9.4, proj4js 2.11.0, d3-array 3.2.4,
  d3-contour 4.0.2, sql.js 1.10.3.

## Bestanden

```
build/build_data.py     data bouwen (OSM, grens, CBS) -> docs/data/
build/check_gpkg.py     een geexporteerde GeoPackage controleren (+ optioneel kaartje)
docs/                   de website (GitHub Pages-root)
  js/core.js            rekenkern (netwerk, snappen, Dijkstra, raster, contouren, statistiek)
  js/worker.js          draait core.js buiten de hoofdthread
  js/app.js             kaart, paneel, tekenen
  js/gpkg.js            GeoPackage-schrijver (sql.js)
  js/config.js          instellingen, kleuren, teksten, contactpersoon
tests/                  node --test
```

Contactgegevens in het infoblok zet je in `docs/js/config.js` (`contact`).
