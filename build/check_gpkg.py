# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "geopandas",
#     "matplotlib",
#     "pyogrio",
# ]
# ///
"""Controleer een geexporteerde GeoPackage van de isochronenkaart.

Gebruik:
    uv run build/check_gpkg.py <bestand.gpkg>
    uv run build/check_gpkg.py <bestand.gpkg> --png kaart.png [--bbox xmin ymin xmax ymax]
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

import geopandas as gpd
import matplotlib.pyplot as plt
import pyogrio

EXPECTED = {
    "locaties": "Point",
    "isochronen": "MultiPolygon",
    "bereikbaar_netwerk": "MultiLineString",
}
# Ruime grenzen van het RD-stelsel (Europees Nederland)
RD_BOUNDS = (-7000.0, 289000.0, 300000.0, 629000.0)
GEBIEDEN = Path(__file__).resolve().parent.parent / "docs" / "data" / "gebieden.geojson"


def check_header(path: Path) -> list[str]:
    errors: list[str] = []
    with sqlite3.connect(path) as con:
        app_id = con.execute("PRAGMA application_id").fetchone()[0]
        version = con.execute("PRAGMA user_version").fetchone()[0]
        if app_id != 0x47504B47:
            errors.append(f"application_id {app_id:#x} is niet 'GPKG'")
        if version < 10200:
            errors.append(f"user_version {version} < 10200")
        integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            errors.append(f"integrity_check: {integrity}")
    return errors


def check_layers(path: Path) -> tuple[dict[str, gpd.GeoDataFrame], list[str]]:
    errors: list[str] = []
    layers = {name: gtype for name, gtype in pyogrio.list_layers(path)}
    print(f"lagen: {layers}")
    frames: dict[str, gpd.GeoDataFrame] = {}
    for name, gtype in EXPECTED.items():
        if name not in layers:
            errors.append(f"laag ontbreekt: {name}")
            continue
        if layers[name] != gtype:
            errors.append(f"{name}: type {layers[name]}, verwacht {gtype}")
        df = gpd.read_file(path, layer=name, engine="pyogrio")
        print(f"\n{name}: shape={df.shape}")
        print(df.dtypes)
        frames[name] = df
        if df.empty:
            errors.append(f"{name} is leeg")
            continue
        if df.crs is None or df.crs.to_epsg() != 28992:
            errors.append(f"{name}: CRS {df.crs}, verwacht EPSG:28992")
        invalid = int((~df.geometry.is_valid).sum())
        if invalid:
            errors.append(f"{name}: {invalid} ongeldige geometrieen")
        xmin, ymin, xmax, ymax = df.total_bounds
        bx0, by0, bx1, by1 = RD_BOUNDS
        if xmin < bx0 or ymin < by0 or xmax > bx1 or ymax > by1:
            errors.append(f"{name}: coordinaten buiten Nederland {df.total_bounds}")
        print(df.drop(columns="geometry").head(8).to_string())
    return frames, errors


def plot(
    frames: dict[str, gpd.GeoDataFrame], out: Path, bbox: list[float] | None
) -> None:
    fig, ax = plt.subplots(figsize=(10, 10))
    if GEBIEDEN.exists():
        geb = gpd.read_file(GEBIEDEN).to_crs(28992)
        geb.boundary.plot(ax=ax, color="#52514e", linewidth=0.8)
    iso = frames.get("isochronen")
    if iso is not None and not iso.empty:
        sel = iso[iso["locatie"] != "gecombineerd"] if "locatie" in iso else iso
        for _, row in sel.sort_values("minuten", ascending=False).iterrows():
            gpd.GeoSeries([row.geometry], crs=iso.crs).plot(
                ax=ax, color="#2a78d6", alpha=0.18, edgecolor="#184f95", linewidth=0.6
            )
    net = frames.get("bereikbaar_netwerk")
    if net is not None and not net.empty:
        net.plot(ax=ax, column="minuten", cmap="viridis_r", linewidth=0.5, legend=True)
    loc = frames.get("locaties")
    if loc is not None and not loc.empty:
        loc.plot(ax=ax, color="#e34948", markersize=40, zorder=5)
    if bbox:
        ax.set_xlim(bbox[0], bbox[2])
        ax.set_ylim(bbox[1], bbox[3])
    ax.set_title("Isochronen en bereikbaar netwerk (export-controle)")
    ax.set_xlabel("RD x (m)")
    ax.set_ylabel("RD y (m)")
    ax.set_aspect("equal")
    fig.tight_layout()
    fig.savefig(out, dpi=130)
    print(f"\nafbeelding: {out}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("gpkg", type=Path)
    parser.add_argument("--png", type=Path, default=None)
    parser.add_argument("--bbox", type=float, nargs=4, default=None)
    args = parser.parse_args()

    errors = check_header(args.gpkg)
    frames, layer_errors = check_layers(args.gpkg)
    errors += layer_errors
    if args.png:
        plot(frames, args.png, args.bbox)
    if errors:
        print("\nFOUTEN:")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    print("\nOK: geldige GeoPackage met de verwachte lagen in EPSG:28992")


if __name__ == "__main__":
    main()
