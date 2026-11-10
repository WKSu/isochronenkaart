# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "geopandas",
#     "numpy",
#     "osmium",
#     "pyogrio",
#     "pyproj",
#     "requests",
#     "scipy",
#     "shapely",
# ]
# ///
"""Bouw de netwerk- en inwonerdata voor de isochronenkaart.

Leest OpenStreetMap (Geofabrik Zuid-Holland), de gemeentegrens van Rotterdam (PDOK)
en het CBS 100 m-vierkant, en schrijft compacte binaire bestanden naar docs/data/.

Gebruik:  uv run build/build_data.py
Downloads komen in build/cache/ en worden hergebruikt; verwijder ze voor verse data.
"""

from __future__ import annotations

import gzip
import itertools
import json
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import geopandas as gpd
import numpy as np
import osmium
import pyogrio
import requests
import shapely
from pyproj import Transformer
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from shapely.geometry import mapping, shape

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "build" / "cache"
OUT = ROOT / "docs" / "data"

PBF_URL = "https://download.geofabrik.de/europe/netherlands/zuid-holland-latest.osm.pbf"
PBF = CACHE / "zuid-holland-latest.osm.pbf"
CBS_YEAR = 2024
CBS_URL = (
    "https://service.pdok.nl/cbs/vierkantstatistieken100m/atom/downloads/"
    f"cbs_vk100_{CBS_YEAR}.gpkg"
)
CBS = CACHE / f"cbs_vk100_{CBS_YEAR}.gpkg"
GEMEENTE_URL = (
    "https://api.pdok.nl/kadaster/brk-bestuurlijke-gebieden/ogc/v1/"
    "collections/gemeentegebied/items"
)
GEMEENTE_NAAM = "Rotterdam"
RD_CRS_URI = "http://www.opengis.net/def/crs/EPSG/0/28992"

BUFFER_M = 3000.0
MIN_COMPONENT_M = 1000.0  # kleinere losse netwerkdelen worden verwijderd
SNAP_GRID_DM = 10  # coordinaten in decimeters

# Edge flags
WALK = 1
BIKE_FWD = 2
BIKE_BWD = 4
WALK_MAIN = 8
BIKE_MAIN = 16
# Node flags
NODE_RAND = 1

TO_RD = Transformer.from_crs("EPSG:4326", "EPSG:28992", always_xy=True)
TO_WGS = Transformer.from_crs("EPSG:28992", "EPSG:4326", always_xy=True)

# --------------------------------------------------------------------------- #
# Toegangsregels (Nederlandse standaarden voor OSM)
# --------------------------------------------------------------------------- #
ALWAYS_EXCLUDED = {
    "construction",
    "proposed",
    "planned",
    "abandoned",
    "disused",
    "razed",
    "raceway",
    "platform",
    "rest_area",
    "services",
    "bus_stop",
    "escape",
    "emergency_bay",
    "busway",
    "bus_guideway",
    "via_ferrata",
}
ROADS = {
    "primary",
    "primary_link",
    "secondary",
    "secondary_link",
    "tertiary",
    "tertiary_link",
    "unclassified",
    "residential",
    "living_street",
    "service",
    "track",
    "road",
}
WALK_BASE = ROADS | {
    "footway",
    "pedestrian",
    "path",
    "steps",
    "cycleway",
    "bridleway",
    "corridor",
    "elevator",
}
BIKE_BASE = ROADS | {"cycleway", "path"}
POSITIVE = {"yes", "designated", "permissive", "destination", "official", "customers"}
MODE_NEGATIVE = {"no", "private", "use_sidepath", "dismount"}
ACCESS_NEGATIVE = {"no", "private", "agricultural", "forestry", "military", "emergency"}
TRUE_VALUES = {"yes", "true", "1"}
FALSE_VALUES = {"no", "false", "0"}
OPPOSITE = {"opposite", "opposite_lane", "opposite_track", "opposite_share_busway"}

KEEP_TAGS = (
    "highway",
    "access",
    "foot",
    "bicycle",
    "vehicle",
    "motorroad",
    "oneway",
    "oneway:bicycle",
    "junction",
    "cycleway",
    "cycleway:left",
    "cycleway:right",
    "cycleway:both",
    "cycleway:left:oneway",
    "cycleway:right:oneway",
    "cycleway:both:oneway",
)


def walk_allowed(tags: dict[str, str]) -> bool:
    hw = tags["highway"]
    if hw in ALWAYS_EXCLUDED:
        return False
    foot = tags.get("foot")
    if foot in MODE_NEGATIVE:
        return False
    if foot in POSITIVE:
        return True
    if hw not in WALK_BASE:
        return False
    if tags.get("access") in ACCESS_NEGATIVE:
        return False
    return tags.get("motorroad") != "yes"


def bike_allowed(tags: dict[str, str]) -> bool:
    hw = tags["highway"]
    if hw in ALWAYS_EXCLUDED:
        return False
    bicycle = tags.get("bicycle")
    if bicycle in MODE_NEGATIVE:
        return False
    if bicycle in POSITIVE:
        return True
    if hw not in BIKE_BASE:
        return False
    if tags.get("access") in ACCESS_NEGATIVE:
        return False
    if tags.get("vehicle") in ACCESS_NEGATIVE:
        return False
    return tags.get("motorroad") != "yes"


def bike_directions(tags: dict[str, str]) -> tuple[bool, bool]:
    """(vooruit toegestaan, achteruit toegestaan) voor de fiets."""
    ob = tags.get("oneway:bicycle")
    if ob in FALSE_VALUES:
        return True, True
    if ob in TRUE_VALUES:
        return True, False
    if ob == "-1":
        return False, True
    ow = tags.get("oneway")
    if ow == "-1":
        return False, True
    roundabout = tags.get("junction") in {"roundabout", "circular"}
    if ow in TRUE_VALUES or (roundabout and ow not in FALSE_VALUES):
        for key in ("cycleway", "cycleway:left", "cycleway:right", "cycleway:both"):
            if tags.get(key) in OPPOSITE:
                return True, True
        for key in (
            "cycleway:left:oneway",
            "cycleway:right:oneway",
            "cycleway:both:oneway",
        ):
            if tags.get(key) in {"no", "-1"}:
                return True, True
        return True, False
    return True, True


def way_flags(tags: dict[str, str]) -> int:
    flags = 0
    if walk_allowed(tags):
        flags |= WALK
    if bike_allowed(tags):
        fwd, bwd = bike_directions(tags)
        flags |= (BIKE_FWD if fwd else 0) | (BIKE_BWD if bwd else 0)
    return flags


# --------------------------------------------------------------------------- #
# Downloads
# --------------------------------------------------------------------------- #
def download(url: str, target: Path) -> None:
    if target.exists() and target.stat().st_size > 0:
        print(f"cache: {target.name} ({target.stat().st_size / 1e6:.0f} MB)")
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".part")
    print(f"download: {url}")
    with requests.get(url, stream=True, timeout=120) as resp:
        resp.raise_for_status()
        with tmp.open("wb") as fh:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                fh.write(chunk)
    tmp.replace(target)


def fetch_gemeente() -> shapely.MultiPolygon | shapely.Polygon:
    """Gemeentegrens in RD New (EPSG:28992)."""
    cache = CACHE / "gemeente_rotterdam_rd.geojson"
    if not cache.exists():
        resp = requests.get(
            GEMEENTE_URL,
            params={"f": "json", "naam": GEMEENTE_NAAM, "crs": RD_CRS_URI},
            timeout=60,
        )
        resp.raise_for_status()
        content_crs = resp.headers.get("Content-Crs", "")
        if "28992" not in content_crs:
            raise RuntimeError(f"PDOK gaf geen RD-coordinaten terug: {content_crs!r}")
        cache.write_text(resp.text, encoding="utf-8")
    data = json.loads(cache.read_text(encoding="utf-8"))
    features = [f for f in data["features"] if f["properties"]["naam"] == GEMEENTE_NAAM]
    if len(features) != 1:
        raise RuntimeError(f"Verwacht 1 gemeente, gevonden: {len(features)}")
    geom = shape(features[0]["geometry"])
    print(f"gemeente: {features[0]['properties']} area={geom.area / 1e6:.1f} km2")
    return geom


# --------------------------------------------------------------------------- #
# OSM inlezen
# --------------------------------------------------------------------------- #
@dataclass
class Ways:
    flags: list[int] = field(default_factory=list)
    node_ids: list[np.ndarray] = field(default_factory=list)
    lon: list[np.ndarray] = field(default_factory=list)
    lat: list[np.ndarray] = field(default_factory=list)


def read_ways(pbf: Path, bbox_ll: tuple[float, float, float, float]) -> Ways:
    minlon, minlat, maxlon, maxlat = bbox_ll
    margin = 0.05  # ~4 km: ruim genoeg voor het eerste knooppunt van een weg
    ways = Ways()
    n_seen = 0
    fp = (
        osmium.FileProcessor(str(pbf), osmium.osm.NODE | osmium.osm.WAY)
        .with_locations()
        .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
        .with_filter(osmium.filter.KeyFilter("highway"))
    )
    t0 = time.perf_counter()
    for w in fp:
        n_seen += 1
        nodes = w.nodes
        if len(nodes) < 2:
            continue
        first = nodes[0].location
        if not first.valid():
            continue
        if not (
            minlon - margin <= first.lon <= maxlon + margin
            and minlat - margin <= first.lat <= maxlat + margin
        ):
            continue
        tags = {k: w.tags[k] for k in KEEP_TAGS if k in w.tags}
        flags = way_flags(tags)
        if flags == 0:
            continue
        try:
            ids = np.fromiter((n.ref for n in nodes), dtype=np.int64, count=len(nodes))
            lon = np.fromiter(
                (n.lon for n in nodes), dtype=np.float64, count=len(nodes)
            )
            lat = np.fromiter(
                (n.lat for n in nodes), dtype=np.float64, count=len(nodes)
            )
        except osmium.InvalidLocationError:
            continue
        ways.flags.append(flags)
        ways.node_ids.append(ids)
        ways.lon.append(lon)
        ways.lat.append(lat)
    print(
        f"osm: {n_seen:,} highway-wegen gelezen, {len(ways.flags):,} kandidaten "
        f"in {time.perf_counter() - t0:.0f} s"
    )
    return ways


# --------------------------------------------------------------------------- #
# Graaf bouwen
# --------------------------------------------------------------------------- #
@dataclass
class Graph:
    node_x: np.ndarray  # RD m
    node_y: np.ndarray
    node_flags: np.ndarray
    edge_u: np.ndarray
    edge_v: np.ndarray
    edge_flags: np.ndarray
    edge_len: np.ndarray
    geom: list[np.ndarray]  # per edge: (k, 2) RD-coordinaten incl. eindpunten


def build_graph(ways: Ways, study: shapely.Geometry) -> Graph:
    lengths = np.array([len(a) for a in ways.node_ids])
    all_ids = np.concatenate(ways.node_ids)
    x, y = TO_RD.transform(np.concatenate(ways.lon), np.concatenate(ways.lat))
    shapely.prepare(study)
    inside = shapely.contains_xy(study, x, y)
    way_idx = np.repeat(np.arange(len(lengths)), lengths)
    keep_way = np.zeros(len(lengths), dtype=bool)
    keep_way[np.unique(way_idx[inside])] = True
    print(f"graaf: {keep_way.sum():,} wegen met minstens 1 punt in het studiegebied")

    starts = np.concatenate([[0], np.cumsum(lengths)])
    keep_pts = keep_way[way_idx]
    kept_ids = all_ids[keep_pts]
    uniq, counts = np.unique(kept_ids, return_counts=True)
    is_junction = set(uniq[counts >= 2].tolist())

    # Coordinaat per OSM-node
    coord_of: dict[int, tuple[float, float]] = {}
    pos_inside: dict[int, bool] = {}

    edge_u: list[int] = []
    edge_v: list[int] = []
    edge_flags: list[int] = []
    geoms: list[np.ndarray] = []
    for wi in np.flatnonzero(keep_way):
        s, e = starts[wi], starts[wi + 1]
        ids = all_ids[s:e]
        xs, ys, ins = x[s:e], y[s:e], inside[s:e]
        # dubbele opeenvolgende nodes verwijderen
        dup = np.concatenate([[False], ids[1:] == ids[:-1]])
        if dup.any():
            ids, xs, ys, ins = ids[~dup], xs[~dup], ys[~dup], ins[~dup]
        if len(ids) < 2:
            continue
        split = [0]
        for k in range(1, len(ids) - 1):
            if int(ids[k]) in is_junction:
                split.append(k)
        split.append(len(ids) - 1)
        for a, b in itertools.pairwise(split):
            u, v = int(ids[a]), int(ids[b])
            edge_u.append(u)
            edge_v.append(v)
            edge_flags.append(ways.flags[wi])
            geoms.append(np.column_stack([xs[a : b + 1], ys[a : b + 1]]))
        for k in (0, len(ids) - 1, *split):
            nid = int(ids[k])
            coord_of[nid] = (float(xs[k]), float(ys[k]))
            pos_inside[nid] = bool(ins[k])

    osm_ids = np.array(sorted(coord_of), dtype=np.int64)
    index = {nid: i for i, nid in enumerate(osm_ids.tolist())}
    node_x = np.array([coord_of[n][0] for n in osm_ids.tolist()])
    node_y = np.array([coord_of[n][1] for n in osm_ids.tolist()])
    node_flags = np.array(
        [0 if pos_inside[n] else NODE_RAND for n in osm_ids.tolist()], dtype=np.uint8
    )
    eu = np.array([index[u] for u in edge_u], dtype=np.int64)
    ev = np.array([index[v] for v in edge_v], dtype=np.int64)
    ef = np.array(edge_flags, dtype=np.uint8)
    elen = np.array([np.hypot(*np.diff(g, axis=0).T).sum() for g in geoms])
    print(f"graaf: {len(osm_ids):,} knopen, {len(eu):,} randen (ruw)")
    return Graph(node_x, node_y, node_flags, eu, ev, ef, elen, geoms)


def mark_components(g: Graph) -> Graph:
    """Verwijder losse netwerkdelen < MIN_COMPONENT_M en markeer het hoofdnet."""
    n = len(g.node_x)
    flags = g.edge_flags.copy()
    for mode_mask, main_bit, label in (
        (WALK, WALK_MAIN, "lopen"),
        (BIKE_FWD | BIKE_BWD, BIKE_MAIN, "fietsen"),
    ):
        sel = np.flatnonzero(flags & mode_mask)
        mat = coo_matrix(
            (np.ones(len(sel)), (g.edge_u[sel], g.edge_v[sel])), shape=(n, n)
        )
        n_comp, labels = connected_components(mat, directed=True, connection="weak")
        comp_len = np.bincount(
            labels[g.edge_u[sel]], weights=g.edge_len[sel], minlength=n_comp
        )
        main = int(np.argmax(comp_len))
        edge_comp = labels[g.edge_u[sel]]
        small = comp_len[edge_comp] < MIN_COMPONENT_M
        flags[sel[small]] &= np.uint8(~mode_mask & 0xFF)
        flags[sel[edge_comp == main]] |= np.uint8(main_bit)
        kept = comp_len[comp_len >= MIN_COMPONENT_M]
        print(
            f"{label}: hoofdnet {comp_len[main] / 1000:,.0f} km; "
            f"{len(kept) - 1} extra delen >= {MIN_COMPONENT_M:.0f} m behouden "
            f"({(kept.sum() - comp_len[main]) / 1000:.1f} km); "
            f"{(comp_len < MIN_COMPONENT_M).sum():,} kleine delen verwijderd "
            f"({comp_len[comp_len < MIN_COMPONENT_M].sum() / 1000:.1f} km)"
        )

    keep = (flags & (WALK | BIKE_FWD | BIKE_BWD)) != 0
    used = np.zeros(n, dtype=bool)
    used[g.edge_u[keep]] = True
    used[g.edge_v[keep]] = True

    # Knopen ruimtelijk sorteren (blokken van 250 m) voor betere compressie
    old = np.flatnonzero(used)
    order = np.lexsort((g.node_x[old], np.floor(g.node_y[old] / 250.0)))
    old = old[order]
    remap = np.full(n, -1, dtype=np.int64)
    remap[old] = np.arange(len(old))

    eu = remap[g.edge_u[keep]]
    ev = remap[g.edge_v[keep]]
    eorder = np.lexsort((ev, eu))
    keep_idx = np.flatnonzero(keep)[eorder]
    return Graph(
        node_x=g.node_x[old],
        node_y=g.node_y[old],
        node_flags=g.node_flags[old],
        edge_u=eu[eorder],
        edge_v=ev[eorder],
        edge_flags=flags[keep_idx],
        edge_len=g.edge_len[keep_idx],
        geom=[g.geom[i] for i in keep_idx.tolist()],
    )


# --------------------------------------------------------------------------- #
# Binaire uitvoer
# --------------------------------------------------------------------------- #
def write_network(g: Graph, meta_extra: dict[str, object]) -> dict[str, object]:
    x0 = float(
        np.floor(min(g.node_x.min(), min(a[:, 0].min() for a in g.geom)) / 1000) * 1000
    )
    y0 = float(
        np.floor(min(g.node_y.min(), min(a[:, 1].min() for a in g.geom)) / 1000) * 1000
    )

    def q(v: np.ndarray, origin: float) -> np.ndarray:
        return np.round((v - origin) * SNAP_GRID_DM).astype(np.int64)

    nqx, nqy = q(g.node_x, x0), q(g.node_y, y0)
    node_dx = np.diff(nqx, prepend=0).astype(np.int32)
    node_dy = np.diff(nqy, prepend=0).astype(np.int32)

    nv = np.array([len(a) - 2 for a in g.geom], dtype=np.int64)
    if nv.max() > 65535:
        raise RuntimeError("Te veel tussenpunten in een rand voor Uint16")
    geom_dx_parts: list[np.ndarray] = []
    geom_dy_parts: list[np.ndarray] = []
    for e, a in enumerate(g.geom):
        if len(a) <= 2:
            continue
        gx = q(a[1:-1, 0], x0)
        gy = q(a[1:-1, 1], y0)
        prev_x = np.concatenate([[nqx[g.edge_u[e]]], gx[:-1]])
        prev_y = np.concatenate([[nqy[g.edge_u[e]]], gy[:-1]])
        geom_dx_parts.append(gx - prev_x)
        geom_dy_parts.append(gy - prev_y)
    geom_dx = np.concatenate(geom_dx_parts).astype(np.int32)
    geom_dy = np.concatenate(geom_dy_parts).astype(np.int32)

    sections: list[tuple[str, np.ndarray]] = [
        ("node_dx", node_dx),
        ("node_dy", node_dy),
        ("edge_u", g.edge_u.astype(np.uint32)),
        ("edge_v", g.edge_v.astype(np.uint32)),
        ("geom_dx", geom_dx),
        ("geom_dy", geom_dy),
        ("edge_nv", nv.astype(np.uint16)),
        ("node_flags", g.node_flags.astype(np.uint8)),
        ("edge_flags", g.edge_flags.astype(np.uint8)),
    ]
    blob = bytearray()
    layout: dict[str, dict[str, object]] = {}
    for name, arr in sections:
        data = arr.astype(arr.dtype.newbyteorder("<")).tobytes()
        layout[name] = {
            "offset": len(blob),
            "length": int(arr.size),
            "type": str(arr.dtype),
        }
        blob.extend(data)

    path = OUT / "network.bin.gz"
    with gzip.GzipFile(path, "wb", compresslevel=9, mtime=0) as fh:
        fh.write(bytes(blob))

    walk = (g.edge_flags & WALK) != 0
    bike = (g.edge_flags & (BIKE_FWD | BIKE_BWD)) != 0
    meta: dict[str, object] = {
        "versie": 1,
        "crs": "EPSG:28992",
        "eenheid_coordinaten": "decimeter, delta-gecodeerd",
        "oorsprong": [x0, y0],
        "knopen": len(g.node_x),
        "randen": len(g.edge_u),
        "tussenpunten": len(geom_dx),
        "bytes": len(blob),
        "secties": layout,
        "vlaggen": {
            "lopen": WALK,
            "fiets_heen": BIKE_FWD,
            "fiets_terug": BIKE_BWD,
            "lopen_hoofdnet": WALK_MAIN,
            "fiets_hoofdnet": BIKE_MAIN,
            "knoop_rand": NODE_RAND,
        },
        "km_lopen": round(float(g.edge_len[walk].sum()) / 1000, 1),
        "km_fietsen": round(float(g.edge_len[bike].sum()) / 1000, 1),
        "bbox_rd": [
            float(g.node_x.min()),
            float(g.node_y.min()),
            float(g.node_x.max()),
            float(g.node_y.max()),
        ],
        **meta_extra,
    }
    return meta


def write_inwoners(
    study: shapely.Geometry, gemeente: shapely.Geometry
) -> dict[str, object]:
    layers = pyogrio.list_layers(CBS)
    print(f"cbs lagen: {layers.tolist()}")
    layer = str(layers[0][0])
    minx, miny, maxx, maxy = study.bounds
    df = gpd.read_file(
        CBS,
        layer=layer,
        bbox=(minx, miny, maxx, maxy),
        columns=["aantal_inwoners"],
        engine="pyogrio",
    )
    print(f"cbs shape={df.shape}")
    print(df.dtypes)
    if df.crs is None or df.crs.to_epsg() != 28992:
        raise RuntimeError(f"Onverwacht CRS voor CBS-vierkanten: {df.crs}")
    inw = df["aantal_inwoners"].to_numpy(dtype=np.float64)
    inw = np.where(inw > 0, inw, 0)
    b = df.geometry.bounds
    cx = np.round(b["minx"].to_numpy() / 100).astype(np.int32)
    cy = np.round(b["miny"].to_numpy() / 100).astype(np.int32)
    keep = inw > 0
    cx, cy, inw = cx[keep], cy[keep], inw[keep].astype(np.int32)

    centers_x = cx * 100.0 + 50
    centers_y = cy * 100.0 + 50
    shapely.prepare(gemeente)
    in_gem = shapely.contains_xy(gemeente, centers_x, centers_y)
    total_gem = int(inw[in_gem].sum())

    blob = np.concatenate([cx, cy, inw]).astype("<i4").tobytes()
    with gzip.GzipFile(OUT / "inwoners.bin.gz", "wb", compresslevel=9, mtime=0) as fh:
        fh.write(blob)
    print(f"cbs: {len(inw):,} bewoonde vierkanten; inwoners gemeente: {total_gem:,}")
    return {
        "inwoners_jaar": CBS_YEAR,
        "inwoners_cellen": len(inw),
        "inwoners_totaal_studiegebied": int(inw.sum()),
        "inwoners_totaal_gemeente": total_gem,
    }


def write_gebieden(gemeente: shapely.Geometry, study: shapely.Geometry) -> None:
    def to_wgs(geom: shapely.Geometry) -> dict[str, object]:
        simple = geom.simplify(5.0, preserve_topology=True)
        wgs = shapely.transform(
            simple, lambda c: np.column_stack(TO_WGS.transform(c[:, 0], c[:, 1]))
        )
        wgs = shapely.set_precision(wgs, 1e-6)
        return mapping(wgs)

    fc = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"soort": "gemeente"},
                "geometry": to_wgs(gemeente),
            },
            {
                "type": "Feature",
                "properties": {"soort": "netwerkgebied"},
                "geometry": to_wgs(study),
            },
        ],
    }
    (OUT / "gebieden.geojson").write_text(
        json.dumps(fc, separators=(",", ":")), encoding="utf-8"
    )


def osm_timestamp(pbf: Path) -> str:
    reader = osmium.io.Reader(str(pbf), osmium.osm.NOTHING)
    try:
        header = reader.header()
        return header.get("osmosis_replication_timestamp") or ""
    finally:
        reader.close()


def main() -> None:
    t0 = time.perf_counter()
    OUT.mkdir(parents=True, exist_ok=True)
    download(PBF_URL, PBF)
    download(CBS_URL, CBS)

    gemeente = fetch_gemeente()
    study = gemeente.buffer(BUFFER_M)
    lon, lat = TO_WGS.transform(
        np.array(study.bounds)[[0, 2]], np.array(study.bounds)[[1, 3]]
    )
    bbox_ll = (float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max()))
    print(f"studiegebied: {study.area / 1e6:.0f} km2, bbox WGS84 {bbox_ll}")

    ways = read_ways(PBF, bbox_ll)
    graph = mark_components(build_graph(ways, study))
    del ways

    meta_extra: dict[str, object] = {
        "gebouwd": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "osm_datum": osm_timestamp(PBF),
        "bron_osm": "OpenStreetMap-bijdragers (ODbL), via Geofabrik",
        "bron_grens": "Kadaster BRK Bestuurlijke Gebieden (PDOK, CC-BY 4.0)",
        "bron_inwoners": f"CBS Vierkantstatistieken 100 m {CBS_YEAR} (PDOK, CC-BY 4.0)",
        "buffer_m": BUFFER_M,
    }
    meta_extra.update(write_inwoners(study, gemeente))
    meta = write_network(graph, meta_extra)
    (OUT / "network.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    write_gebieden(gemeente, study)

    print("\n=== Rapport ===")
    print(
        f"knopen {meta['knopen']:,} | randen {meta['randen']:,} | tussenpunten {meta['tussenpunten']:,}"
    )
    print(f"km lopen {meta['km_lopen']:,} | km fietsen {meta['km_fietsen']:,}")
    print(f"inwoners gemeente (CBS {CBS_YEAR}): {meta['inwoners_totaal_gemeente']:,}")
    for f in sorted(OUT.iterdir()):
        print(f"  {f.name:24s} {f.stat().st_size / 1e6:6.2f} MB")
    print(f"klaar in {time.perf_counter() - t0:.0f} s")


if __name__ == "__main__":
    main()
