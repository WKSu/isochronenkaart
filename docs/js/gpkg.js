/*
 * gpkg.js: minimale GeoPackage 1.3-schrijver op sql.js (SQLite in WebAssembly).
 * Alleen wat nodig is: features in EPSG:28992, zonder ruimtelijke index.
 */
(function (root) {
  'use strict';

  const RD_WKT =
    'PROJCS["Amersfoort / RD New",GEOGCS["Amersfoort",DATUM["Amersfoort",' +
    'SPHEROID["Bessel 1841",6377397.155,299.1528128,AUTHORITY["EPSG","7004"]],' +
    'TOWGS84[565.2369,50.0087,465.658,-0.406857,0.350733,-1.87035,4.0812],' +
    'AUTHORITY["EPSG","6289"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],' +
    'UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4289"]],' +
    'PROJECTION["Oblique_Stereographic"],PARAMETER["latitude_of_origin",52.1561605555556],' +
    'PARAMETER["central_meridian",5.38763888888889],PARAMETER["scale_factor",0.9999079],' +
    'PARAMETER["false_easting",155000],PARAMETER["false_northing",463000],' +
    'UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],' +
    'AUTHORITY["EPSG","28992"]]';
  const WGS_WKT =
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,' +
    'AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,' +
    'AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],' +
    'AXIS["Latitude",NORTH],AXIS["Longitude",EAST],AUTHORITY["EPSG","4326"]]';

  const GEOM_TYPE = { POINT: 1, MULTILINESTRING: 5, MULTIPOLYGON: 6 };
  const SRS = 28992;

  // ----------------------------------------------------------- binair schrijven
  class Bytes {
    constructor() {
      this.buf = new ArrayBuffer(256);
      this.dv = new DataView(this.buf);
      this.n = 0;
    }
    grow(k) {
      if (this.n + k <= this.buf.byteLength) return;
      let size = this.buf.byteLength * 2;
      while (size < this.n + k) size *= 2;
      const nb = new ArrayBuffer(size);
      new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.n));
      this.buf = nb;
      this.dv = new DataView(nb);
    }
    u8(v) {
      this.grow(1);
      this.dv.setUint8(this.n, v);
      this.n += 1;
    }
    u32(v) {
      this.grow(4);
      this.dv.setUint32(this.n, v, true);
      this.n += 4;
    }
    i32(v) {
      this.grow(4);
      this.dv.setInt32(this.n, v, true);
      this.n += 4;
    }
    f64(v) {
      this.grow(8);
      this.dv.setFloat64(this.n, v, true);
      this.n += 8;
    }
    result() {
      return new Uint8Array(this.buf.slice(0, this.n));
    }
  }

  function envelope(type, coords) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const visit = (p) => {
      if (p[0] < minX) minX = p[0];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[1] > maxY) maxY = p[1];
    };
    if (type === 'POINT') visit(coords);
    else if (type === 'MULTILINESTRING') coords.forEach((l) => l.forEach(visit));
    else coords.forEach((poly) => poly.forEach((r) => r.forEach(visit)));
    return [minX, maxX, minY, maxY];
  }

  /** GeoPackage-geometrieblob: header (GP, versie, vlaggen, srs, envelop) + WKB. */
  function geometryBlob(type, coords) {
    const env = envelope(type, coords);
    const w = new Bytes();
    w.u8(0x47); // G
    w.u8(0x50); // P
    w.u8(0); // versie 1
    w.u8(0b00000011); // little endian + envelop [minx, maxx, miny, maxy]
    w.i32(SRS);
    env.forEach((v) => w.f64(v));
    // WKB
    w.u8(1);
    w.u32(GEOM_TYPE[type]);
    if (type === 'POINT') {
      w.f64(coords[0]);
      w.f64(coords[1]);
    } else if (type === 'MULTILINESTRING') {
      w.u32(coords.length);
      for (const line of coords) {
        w.u8(1);
        w.u32(2);
        w.u32(line.length);
        for (const p of line) {
          w.f64(p[0]);
          w.f64(p[1]);
        }
      }
    } else {
      w.u32(coords.length);
      for (const poly of coords) {
        w.u8(1);
        w.u32(3);
        w.u32(poly.length);
        for (const ring of poly) {
          w.u32(ring.length);
          for (const p of ring) {
            w.f64(p[0]);
            w.f64(p[1]);
          }
        }
      }
    }
    return { blob: w.result(), env };
  }

  // --------------------------------------------------------------- database
  let sqlPromise = null;
  function loadSql(vendorPath) {
    if (!sqlPromise) {
      if (typeof root.initSqlJs !== 'function') throw new Error('sql.js is niet geladen');
      sqlPromise = root.initSqlJs({ locateFile: (f) => vendorPath + f });
    }
    return sqlPromise;
  }

  const CORE_DDL = `
    CREATE TABLE gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY,
      organization TEXT NOT NULL, organization_coordsys_id INTEGER NOT NULL,
      definition TEXT NOT NULL, description TEXT);
    CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL,
      identifier TEXT UNIQUE, description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER,
      CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id));
    CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL,
      srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL,
      CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name),
      CONSTRAINT uk_gc_table_name UNIQUE (table_name),
      CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
      CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id));
  `;

  /**
   * layers: [{ naam, beschrijving, type: 'POINT'|'MULTILINESTRING'|'MULTIPOLYGON',
   *            velden: [{naam, type: 'TEXT'|'INTEGER'|'REAL'}],
   *            features: [{ coords, attrs: {veld: waarde} }] }]
   * Geeft een Uint8Array met het .gpkg-bestand.
   */
  async function write(layers, vendorPath) {
    const SQL = await loadSql(vendorPath);
    const db = new SQL.Database();
    try {
      db.run('PRAGMA application_id = 1196444487;');
      db.run('PRAGMA user_version = 10300;');
      db.run(CORE_DDL);
      const srs = db.prepare('INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)');
      srs.run(['Undefined cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined cartesian coordinate reference system']);
      srs.run(['Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system']);
      srs.run(['WGS 84 geodetic', 4326, 'EPSG', 4326, WGS_WKT, 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid']);
      srs.run(['Amersfoort / RD New', SRS, 'EPSG', SRS, RD_WKT, 'Rijksdriehoeksstelsel']);
      srs.free();

      for (const layer of layers) {
        if (!/^[a-z_][a-z0-9_]*$/.test(layer.naam)) throw new Error('Ongeldige laagnaam: ' + layer.naam);
        const cols = layer.velden.map((v) => {
          if (!/^[a-z_][a-z0-9_]*$/.test(v.naam)) throw new Error('Ongeldige veldnaam: ' + v.naam);
          return `"${v.naam}" ${v.type}`;
        });
        db.run(`CREATE TABLE "${layer.naam}" (fid INTEGER PRIMARY KEY AUTOINCREMENT, geom ${layer.type}, ${cols.join(', ')});`);
        const ph = layer.velden.map(() => '?').join(',');
        const ins = db.prepare(`INSERT INTO "${layer.naam}" (geom, ${layer.velden.map((v) => `"${v.naam}"`).join(',')}) VALUES (?, ${ph})`);
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const f of layer.features) {
          const g = geometryBlob(layer.type, f.coords);
          minX = Math.min(minX, g.env[0]);
          maxX = Math.max(maxX, g.env[1]);
          minY = Math.min(minY, g.env[2]);
          maxY = Math.max(maxY, g.env[3]);
          ins.run([g.blob, ...layer.velden.map((v) => (f.attrs[v.naam] === undefined ? null : f.attrs[v.naam]))]);
        }
        ins.free();
        const hasExtent = Number.isFinite(minX);
        db.run(
          'INSERT INTO gpkg_contents (table_name, data_type, identifier, description, min_x, min_y, max_x, max_y, srs_id) VALUES (?,?,?,?,?,?,?,?,?)',
          [layer.naam, 'features', layer.naam, layer.beschrijving || '', hasExtent ? minX : null, hasExtent ? minY : null, hasExtent ? maxX : null, hasExtent ? maxY : null, SRS],
        );
        db.run('INSERT INTO gpkg_geometry_columns VALUES (?,?,?,?,?,?)', [layer.naam, 'geom', layer.type, SRS, 0, 0]);
      }
      return db.export();
    } finally {
      db.close();
    }
  }

  root.IsoGpkg = { write, _geometryBlob: geometryBlob };
})(typeof self !== 'undefined' ? self : globalThis);
