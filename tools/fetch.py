"""Download raw source data for the Hayden Lake Rd corridor.

Outputs (data/):
  dem.tif      USGS 3DEP bare-earth elevation, 1 m, UTM 11N
  naip.tif     USGS NAIP aerial imagery (R,G,B,NIR), 1 m, UTM 11N
  chm.tif      Meta/WRI 1 m canopy height model, reprojected to the DEM grid
  osm.json     OpenStreetMap roads, buildings, water, landuse (Overpass)
  buildings.geojson  Overture Maps building footprints (incl. Microsoft ML footprints)
"""
import io, json, math, sys, time
from pathlib import Path

import numpy as np
import rasterio
import requests
from rasterio.transform import from_origin
from rasterio.warp import reproject, Resampling

DATA = Path(__file__).resolve().parent.parent / "data"
CRS = "EPSG:32611"
# UTM bounds covering the route plus ~500 m margin, snapped to 1 m
X0, Y0, X1, Y1 = 519800, 5287200, 526100, 5296600
LON0, LAT0, LON1, LAT1 = -116.736, 47.737, -116.651, 47.823
RES = 1.0
TILE = 2000
W, H = int((X1 - X0) / RES), int((Y1 - Y0) / RES)
TRANSFORM = from_origin(X0, Y1, RES, RES)

DEM_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
NAIP_URL = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer/exportImage"


def export_tile(url, x0, y0, x1, y1, w, h, pixel_type, extra=None):
    params = {
        "bbox": f"{x0},{y0},{x1},{y1}", "bboxSR": 32611, "imageSR": 32611,
        "size": f"{w},{h}", "format": "tiff", "pixelType": pixel_type,
        "interpolation": "RSP_BilinearInterpolation", "f": "image",
    }
    params.update(extra or {})
    for attempt in range(5):
        try:
            r = requests.get(url, params=params, timeout=180)
            r.raise_for_status()
            with rasterio.MemoryFile(r.content) as mf, mf.open() as ds:
                return ds.read()
        except Exception as e:
            print(f"  retry {attempt + 1}: {e}", file=sys.stderr)
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"failed tile {x0},{y0}")


def fetch_mosaic(name, url, bands, dtype, pixel_type, extra=None):
    out = DATA / name
    if out.exists():
        print(f"{name}: exists")
        return
    arr = np.zeros((bands, H, W), dtype=dtype)
    for ty in range(0, H, TILE):
        for tx in range(0, W, TILE):
            w, h = min(TILE, W - tx), min(TILE, H - ty)
            x0 = X0 + tx * RES
            y1 = Y1 - ty * RES
            tile = export_tile(url, x0, y1 - h * RES, x0 + w * RES, y1, w, h, pixel_type, extra)
            arr[:, ty:ty + h, tx:tx + w] = tile[:bands, :h, :w]
            print(f"  {name} tile {tx},{ty}")
    with rasterio.open(out, "w", driver="GTiff", width=W, height=H, count=bands, dtype=dtype,
                       crs=CRS, transform=TRANSFORM, compress="deflate", tiled=True) as ds:
        ds.write(arr)
    print(f"{name}: done")


def quadkey(lon, lat, z):
    n = 2 ** z
    x = int((lon + 180) / 360 * n)
    s = math.sin(math.radians(lat))
    y = int((0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n)
    qk = ""
    for i in range(z, 0, -1):
        d, m = 0, 1 << (i - 1)
        if x & m: d += 1
        if y & m: d += 2
        qk += str(d)
    return qk


def fetch_chm():
    out = DATA / "chm.tif"
    if out.exists():
        print("chm.tif: exists")
        return
    keys = {quadkey(lon, lat, 9) for lon in (LON0, LON1) for lat in (LAT0, LAT1)}
    dst = np.full((H, W), np.nan, dtype=np.float32)
    for qk in keys:
        src_url = f"/vsicurl/https://dataforgood-fb-data.s3.amazonaws.com/forests/v1/alsgedi_global_v6_float/chm/{qk}.tif"
        print(f"  chm tile {qk}")
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"), rasterio.open(src_url) as src:
            # read only the window covering our area, then reproject onto the DEM grid
            from rasterio.warp import transform_bounds
            from rasterio.windows import from_bounds
            b = transform_bounds("EPSG:4326", src.crs, LON0, LAT0, LON1, LAT1)
            win = from_bounds(*b, transform=src.transform).round_offsets().round_lengths()
            win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
            data = src.read(1, window=win).astype(np.float32)
            tmp = np.full((H, W), np.nan, dtype=np.float32)
            reproject(data, tmp, src_transform=src.window_transform(win), src_crs=src.crs,
                      dst_transform=TRANSFORM, dst_crs=CRS, resampling=Resampling.bilinear,
                      src_nodata=src.nodata, dst_nodata=np.nan)
            dst = np.where(np.isnan(dst), tmp, dst)
    with rasterio.open(out, "w", driver="GTiff", width=W, height=H, count=1, dtype="float32",
                       crs=CRS, transform=TRANSFORM, compress="deflate", tiled=True, nodata=np.nan) as ds:
        ds.write(dst, 1)
    print("chm.tif: done")


def fetch_osm():
    out = DATA / "osm.json"
    if out.exists():
        print("osm.json: exists")
        return
    bbox = f"{LAT0},{LON0},{LAT1},{LON1}"
    q = f"""[out:json][timeout:120];
(
  way["highway"]({bbox});
  way["building"]({bbox});
  relation["building"]({bbox});
  way["natural"]({bbox});
  relation["natural"="water"]({bbox});
  way["landuse"]({bbox});
  way["barrier"]({bbox});
  way["waterway"]({bbox});
  node["natural"="tree"]({bbox});
  way["leisure"]({bbox});
  way["man_made"]({bbox});
);
out geom;"""
    r = requests.post("https://overpass.kumi.systems/api/interpreter", data={"data": q}, timeout=300,
                      headers={"User-Agent": "hayden-racer/0.1 (personal game project)"})
    r.raise_for_status()
    out.write_bytes(r.content)
    print("osm.json: done", len(r.json()["elements"]), "elements")


def fetch_overture_buildings():
    out = DATA / "buildings.geojson"
    if out.exists():
        print("buildings.geojson: exists")
        return
    import duckdb
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; INSTALL spatial; LOAD spatial; SET s3_region='us-west-2'; SET geometry_always_xy = true;")
    rel = requests.get("https://stac.overturemaps.org/catalog.json", timeout=30).json()
    release = rel.get("latest") or sorted(l["href"].split("/")[1] for l in rel["links"] if l["rel"] == "child")[-1]
    print("  overture release", release)
    sql = f"""
    COPY (
      SELECT id, height, num_floors, class, subtype, geometry
      FROM read_parquet('s3://overturemaps-us-west-2/release/{release}/theme=buildings/type=building/*', hive_partitioning=1)
      WHERE bbox.xmin < {LON1} AND bbox.xmax > {LON0} AND bbox.ymin < {LAT1} AND bbox.ymax > {LAT0}
    ) TO '{out}' WITH (FORMAT GDAL, DRIVER 'GeoJSON');"""
    con.execute(sql)
    n = len(json.load(open(out))["features"])
    print("buildings.geojson: done", n, "buildings")


if __name__ == "__main__":
    DATA.mkdir(exist_ok=True)
    which = sys.argv[1:] or ["osm", "buildings", "dem", "chm", "naip"]
    for step in which:
        {"dem": lambda: fetch_mosaic("dem.tif", DEM_URL, 1, "float32", "F32"),
         "naip": lambda: fetch_mosaic("naip.tif", NAIP_URL, 4, "uint8", "U8"),
         "chm": fetch_chm, "osm": fetch_osm, "buildings": fetch_overture_buildings}[step]()
