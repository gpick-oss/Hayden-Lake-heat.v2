"""Turn raw data/ into game assets in game/public/world/.

Local frame: x = east, z = -north (three.js), y = elevation - LAKE (lake surface ~ y 0).
Origin is the UTM point (OX, OY).
"""
import json, struct
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio import features
from scipy import ndimage
from shapely.geometry import shape, Polygon, MultiPolygon, LineString, mapping
from shapely.ops import transform as shp_transform

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
OUT = ROOT / "game" / "public" / "world"

OX, OY = 522950.0, 5291900.0
LAKE = 682.0          # Hayden Lake surface (m)
WATER_Y = 0.25        # water plane height in local frame
ROAD_W = 6.6          # E Hayden Lake Rd paved width
CHUNK = 256           # m per terrain chunk
FINE = 2              # m per cell in near-road chunks
COARSE = 8            # m per cell in the global far grid
NEAR = 450            # chunks within this distance of the route get fine data
TREE_RANGE = 350      # trees kept within this distance of the route

to_utm = Transformer.from_crs(4326, 32611, always_xy=True).transform


def local(x, y):
    return x - OX, -(y - OY)


def load():
    dem_ds = rasterio.open(DATA / "dem.tif")
    dem = dem_ds.read(1).astype(np.float32)
    chm = np.nan_to_num(rasterio.open(DATA / "chm.tif").read(1).astype(np.float32))
    naip = rasterio.open(DATA / "naip.tif").read()
    return dem_ds.transform, dem, chm, naip


def route_line(dem, tf):
    refined = DATA / "route_refined.json"
    if refined.exists():
        # centreline snapped to the real pavement by tools/refine_road.py (already smooth)
        pts = np.array(json.load(open(refined))["pts"])
        sigma = 1.0
    else:
        coords = json.load(open(DATA / "route_osrm.json"))["routes"][0]["geometry"]["coordinates"]
        pts = np.array([to_utm(*c) for c in coords])
        sigma = 4.0
    # drop consecutive duplicates, resample every 1 m, smooth out vertex kinks
    keep = np.r_[True, np.linalg.norm(np.diff(pts, axis=0), axis=1) > 0.01]
    pts = pts[keep]
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    s = np.r_[0, np.cumsum(seg)]
    ss = np.arange(0, s[-1], 1.0)
    p = np.c_[np.interp(ss, s, pts[:, 0]), np.interp(ss, s, pts[:, 1])]
    p = ndimage.gaussian_filter1d(p, sigma, axis=0, mode="nearest")
    # elevation from lidar bare earth, smoothed along the road
    inv = ~tf
    cols, rows = inv * (p[:, 0], p[:, 1])
    z = ndimage.map_coordinates(dem, [rows - 0.5, cols - 0.5], order=1)
    z = ndimage.median_filter(z, 9, mode="nearest")
    z = ndimage.gaussian_filter1d(z, 6, mode="nearest")
    return p, z


def lake_mask(shape_hw, tf):
    feats = json.load(open(DATA / "ov_water.geojson"))["features"]
    geoms = []
    for f in feats:
        if f["properties"]["subtype"] in ("lake", "water", "pond", "reservoir") and f["geometry"]["type"] in ("Polygon", "MultiPolygon"):
            geoms.append(shp_transform(lambda x, y, z=None: to_utm(x, y), shape(f["geometry"])))
    m = features.rasterize([(g, 1) for g in geoms], out_shape=shape_hw, transform=tf, dtype=np.uint8)
    return m.astype(bool), geoms


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    tf, dem, chm, naip = load()
    H, W = dem.shape
    X0, Y1 = tf.c, tf.f
    route, rz = route_line(dem, tf)
    print("route", len(route), "m")

    # --- terrain (1 m working grid) -------------------------------------------------
    lake, lake_geoms = lake_mask(dem.shape, tf)
    terr = dem.copy()
    # lake bed: drop below the water plane, sloping down away from the shore
    shore_d = ndimage.distance_transform_edt(lake)
    terr[lake] = LAKE + WATER_Y - 0.6 - np.minimum(shore_d[lake] * 0.15, 8)

    # rasterise road centreline with its height, then flatten terrain under the road
    road_h = np.full(dem.shape, np.nan, np.float32)
    inv = ~tf
    cc, rr = inv * (route[:, 0], route[:, 1])
    ci, ri = np.floor(cc).astype(int), np.floor(rr).astype(int)
    ok = (ci >= 0) & (ci < W) & (ri >= 0) & (ri < H)
    road_h[ri[ok], ci[ok]] = rz[ok]
    dist, (ir, ic) = ndimage.distance_transform_edt(np.isnan(road_h), return_indices=True)
    nearest_h = road_h[ir, ic]
    half = ROAD_W / 2
    # road bed just under the asphalt ribbon (drawn 4 cm higher). Cut slopes (ground above the road)
    # stay at road level until 4.5 m past the edge so the 2 m terrain triangles can't bridge up through
    # the asphalt or gravel shoulder; fill slopes (ground below the road) fall away from 1.5 m out.
    near = dist < half + 12.0
    o, tg, d = terr[near], nearest_h[near] - 0.12, dist[near]
    sstep = lambda t: t * t * (3 - 2 * t)
    t_fill = sstep(np.clip((d - (half + 1.5)) / 8.0, 0, 1))
    t_cut = sstep(np.clip((d - (half + 4.5)) / 6.0, 0, 1))
    terr[near] = tg + np.where(o > tg, t_cut, t_fill) * (o - tg)
    del o, tg, d
    # conform: the asphalt is drawn from 2 m stations, flat across its width, at station height - 0.08.
    # Clamp every ground sample under it (and out past the gravel shoulder far enough that no 2 m
    # terrain triangle can reach up through either ribbon) to 6 cm below that exact surface.
    from scipy.spatial import cKDTree
    st, sty = route[::2], rz[::2]
    s_st = np.r_[0, np.cumsum(np.linalg.norm(np.diff(st, axis=0), axis=1))]
    s_d = np.arange(0, s_st[-1], 0.25)
    dense = np.c_[np.interp(s_d, s_st, st[:, 0]), np.interp(s_d, s_st, st[:, 1])]
    dense_y = np.interp(s_d, s_st, sty)
    rr, cc = np.nonzero(dist < half + 4.7)
    px, py = tf * (cc + 0.5, rr + 0.5)
    _, kk = cKDTree(dense).query(np.c_[px, py])
    cap = dense_y[kk] - 0.08 - 0.06
    terr[rr, cc] = np.minimum(terr[rr, cc], cap)
    print(f"conformed {len(rr)} ground samples under the road ribbons")
    del rr, cc, px, py, kk, cap
    road_dist = dist  # metres to centreline

    # --- chunk grid -----------------------------------------------------------------
    nx, ny = W // CHUNK, H // CHUNK
    near = np.zeros((ny, nx), bool)
    for j in range(ny):
        for i in range(nx):
            sub = road_dist[j * CHUNK:(j + 1) * CHUNK, i * CHUNK:(i + 1) * CHUNK]
            near[j, i] = sub.min() < NEAR
    print("chunks", nx, ny, "near", near.sum())

    def enc(h):
        return np.clip((h - 600.0) * 50.0, 0, 65535).astype(np.uint16)

    # coarse global grid (8 m), sampled at cell corners
    gx = np.arange(0, nx * CHUNK + 1, COARSE)
    gy = np.arange(0, ny * CHUNK + 1, COARSE)
    coarse = terr[np.clip(gy, 0, H - 1)][:, np.clip(gx, 0, W - 1)]
    # fine chunks (2 m), 129x129 verts each
    n = CHUNK // FINE + 1
    fine_list = []
    for j in range(ny):
        for i in range(nx):
            if not near[j, i]:
                continue
            ys = np.clip(j * CHUNK + np.arange(n) * FINE, 0, H - 1)
            xs = np.clip(i * CHUNK + np.arange(n) * FINE, 0, W - 1)
            fine_list.append((i, j, terr[ys][:, xs]))
    with open(OUT / "terrain.bin", "wb") as f:
        f.write(struct.pack("<6i", nx, ny, CHUNK, FINE, COARSE, len(fine_list)))
        # vertices sit on pixel centres (+0.5 m), so the mesh lines up with the road and trees
        f.write(struct.pack("<3f", X0 - OX + 0.5, -(Y1 - OY) + 0.5, LAKE))
        f.write(struct.pack("<2i", len(gx), len(gy)))
        f.write(enc(coarse).tobytes())
        for i, j, a in fine_list:
            f.write(struct.pack("<2i", i, j))
            f.write(enc(a).tobytes())
    print("terrain.bin", (OUT / "terrain.bin").stat().st_size // 1024, "KB")

    # --- imagery --------------------------------------------------------------------
    rgb = np.moveaxis(naip[:3], 0, -1)
    tex_dir = OUT / "tex"
    tex_dir.mkdir(exist_ok=True)
    for i, j, _ in fine_list:
        tile = rgb[j * CHUNK:(j + 1) * CHUNK, i * CHUNK:(i + 1) * CHUNK]
        Image.fromarray(tile).resize((512, 512), Image.BICUBIC).save(tex_dir / f"{i}_{j}.jpg", quality=82)
    far = Image.fromarray(rgb[:ny * CHUNK, :nx * CHUNK]).resize((nx * CHUNK // 4, ny * CHUNK // 4), Image.LANCZOS)
    far.save(OUT / "far.jpg", quality=85)
    Image.fromarray(rgb[:ny * CHUNK, :nx * CHUNK]).resize((nx * CHUNK // 8, ny * CHUNK // 8), Image.LANCZOS).save(OUT / "minimap.jpg", quality=80)

    # --- buildings ------------------------------------------------------------------
    bfeats = json.load(open(DATA / "buildings.geojson"))["features"]
    blds = []
    bmask_geoms = []
    for f in bfeats:
        g = shp_transform(lambda x, y, z=None: to_utm(x, y), shape(f["geometry"]))
        polys = list(g.geoms) if isinstance(g, MultiPolygon) else [g]
        for poly in polys:
            if poly.area < 6:
                continue
            poly = poly.simplify(0.4)
            ext = np.array(poly.exterior.coords)[:-1]
            c, r = inv * (ext[:, 0], ext[:, 1])
            c = np.clip(c.astype(int), 0, W - 1); r = np.clip(r.astype(int), 0, H - 1)
            base = float(terr[r, c].min())
            h = f["properties"].get("height")
            if not h or h < 2.2:
                h = 3.0 if poly.area < 40 else 5.5
            cx, cy = poly.centroid.x, poly.centroid.y
            cc_, rr_ = inv * (cx, cy)
            win = rgb[max(int(rr_) - 2, 0):int(rr_) + 3, max(int(cc_) - 2, 0):int(cc_) + 3].reshape(-1, 3)
            roof = win.mean(0).astype(int).tolist() if len(win) else [90, 90, 90]
            # pitched roof for house-sized, roughly rectangular footprints
            mrr = poly.minimum_rotated_rectangle
            rect = poly.area / max(mrr.area, 1e-6) > 0.85
            blds.append({
                "p": [[round(v, 2) for v in local(x, y)] for x, y in ext],
                "b": round(base - LAKE, 2), "h": round(float(h), 2), "roof": roof,
                "gable": bool(rect and poly.area < 600 and h < 12),
            })
            bmask_geoms.append(poly)
    json.dump(blds, open(OUT / "buildings.json", "w"), separators=(",", ":"))
    print("buildings", len(blds))
    bmask = features.rasterize([(g.buffer(1.5), 1) for g in bmask_geoms], out_shape=dem.shape, transform=tf, dtype=np.uint8).astype(bool)

    # --- trees from the 1 m canopy height model ---------------------------------------
    c_s = ndimage.gaussian_filter(chm, 1.0)
    peaks = (c_s == ndimage.maximum_filter(c_s, size=5)) & (c_s > 3.0)
    tall = (c_s == ndimage.maximum_filter(c_s, size=7)) | (c_s < 15)
    peaks &= tall
    peaks &= (road_dist < TREE_RANGE) & (road_dist > half + 3.5) & ~lake & ~bmask
    r, c = np.nonzero(peaks)
    # the CHM is smooth, so peaks undercount dense stands: fill remaining canopy with a
    # jittered grid, keeping crowns from overlapping much
    from scipy.spatial import cKDTree
    rng0 = np.random.default_rng(3)
    gr, gc = np.mgrid[0:H:3, 0:W:3]
    gr = np.clip(gr + rng0.integers(0, 3, gr.shape), 0, H - 1).ravel()
    gc = np.clip(gc + rng0.integers(0, 3, gc.shape), 0, W - 1).ravel()
    m = (c_s[gr, gc] > 4) & (road_dist[gr, gc] < TREE_RANGE) & (road_dist[gr, gc] > half + 3.5) & ~lake[gr, gc] & ~bmask[gr, gc]
    gr, gc = gr[m], gc[m]
    tree = cKDTree(np.c_[r, c])
    d, _ = tree.query(np.c_[gr, gc])
    spacing = np.clip(c_s[gr, gc] * 0.16, 1.8, 4.0)
    keep = d > spacing
    gr, gc = gr[keep], gc[keep]
    # thin the fill itself (greedy, random order)
    order = rng0.permutation(len(gr))
    gr, gc, spacing = gr[order], gc[order], spacing[keep][order]
    t2 = cKDTree(np.c_[gr, gc])
    taken = np.zeros(len(gr), bool); blocked = np.zeros(len(gr), bool)
    for k in range(len(gr)):
        if blocked[k]:
            continue
        taken[k] = True
        blocked[t2.query_ball_point((gr[k], gc[k]), spacing[k])] = True
    r = np.r_[r, gr[taken]]; c = np.r_[c, gc[taken]]
    h = c_s[r, c] * rng0.uniform(0.85, 1.05, len(r))
    nir = naip[3, r, c].astype(np.float32); red = naip[0, r, c].astype(np.float32); grn = naip[1, r, c].astype(np.float32)
    ndvi = (nir - red) / np.maximum(nir + red, 1)
    # broadleaf canopies are brighter in green/NIR than conifers in summer NAIP
    kind = ((nir > np.percentile(nir, 88)) & (ndvi > 0.35) & (h < 24)).astype(np.uint8)
    x, y = tf * (c + 0.5, r + 0.5)
    lx, lz = local(np.asarray(x), np.asarray(y))
    ground = terr[r, c] - LAKE
    col = naip[:3, r, c].T.astype(np.uint8)
    rng = np.random.default_rng(7)
    jit = rng.uniform(-0.4, 0.4, (len(r), 2))
    with open(OUT / "trees.bin", "wb") as f:
        f.write(struct.pack("<i", len(r)))
        f.write(np.c_[lx + jit[:, 0], ground, lz + jit[:, 1], h].astype(np.float32).tobytes())
        f.write(np.c_[col, kind].astype(np.uint8).tobytes())
    print("trees", len(r), "broadleaf", int(kind.sum()))

    # --- route + side roads -----------------------------------------------------------
    step = 2
    rp = route[::step]; rzz = rz[::step]
    lx, lz = local(rp[:, 0], rp[:, 1])
    json.dump({"w": ROAD_W, "pts": np.c_[lx, rzz - LAKE, lz].round(2).tolist()}, open(OUT / "route.json", "w"), separators=(",", ":"))

    side = []
    route_ls = LineString(route)
    from scipy.spatial import cKDTree
    route_tree = cKDTree(route)
    for f in json.load(open(DATA / "ov_segment.geojson"))["features"]:
        pr = f["properties"]
        if pr["subtype"] != "road" or f["geometry"]["type"] != "LineString":
            continue
        g = shp_transform(lambda x, y, z=None: to_utm(x, y), shape(f["geometry"]))
        if g.distance(route_ls) > 900:
            continue
        # skip the bits that ARE the race road
        if pr.get("name") == "East Hayden Lake Road" and g.buffer(6).intersection(route_ls).length > 0.6 * g.length:
            continue
        L = g.length
        ds = np.arange(0, L, 3.0).tolist() + [L]
        pts = np.array([g.interpolate(d).coords[0] for d in ds])
        c, r = inv * (pts[:, 0], pts[:, 1])
        hz = ndimage.map_coordinates(terr, [r - 0.5, c - 0.5], order=1)
        sx, sz = local(pts[:, 0], pts[:, 1])
        w = {"secondary": 7, "tertiary": 6.5, "residential": 5.5, "unclassified": 5, "service": 3.5, "track": 3}.get(pr["class"], 2)
        if pr["class"] in ("footway", "path", "cycleway"):
            continue
        surf = str(pr.get("road_surface") or "")
        dirt = pr["class"] in ("track", "service") or any(k in surf for k in ("gravel", "dirt", "unpaved"))
        # stop side roads at the race road's edge so they don't paint over its asphalt and lines
        dmain, _ = route_tree.query(pts)
        keep = dmain > half + 0.4
        xyz = np.c_[sx, hz - LAKE + 0.08, sz]
        runs, cur = [], []
        for k_, ok in enumerate(keep):
            if ok: cur.append(xyz[k_])
            elif cur: runs.append(cur); cur = []
        if cur: runs.append(cur)
        for run in runs:
            if len(run) >= 2:
                side.append({"w": w, "dirt": dirt, "pts": np.array(run).round(2).tolist()})
    json.dump(side, open(OUT / "roads.json", "w"), separators=(",", ":"))
    print("side roads", len(side))

    meta = {"origin_utm": [OX, OY], "lake": LAKE, "water_y": WATER_Y,
            "extent": [X0 - OX + 0.5, -(Y1 - OY) + 0.5, nx * CHUNK, ny * CHUNK]}
    json.dump(meta, open(OUT / "meta.json", "w"))


if __name__ == "__main__":
    main()
