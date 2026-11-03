"""Snap the OSM centreline of E Hayden Lake Rd onto the real pavement.

OSM geometry is off by several metres in places (and smoothing pulls hairpins inward), which
shows up as the paved ribbon not matching the aerial photo. For every station along the road we
score lateral offsets of the centre using two independent sources:

  imagery  NAIP 1 m RGB+NIR: asphalt is grey (low chroma), unvegetated (low NDVI), and not in
           deep shadow; pixels under tree canopy (CHM > 2.5 m) carry no information.
  lidar    USGS 1 m bare-earth DEM: a road is a flat bench, so a 6.6 m window centred on the
           road has low cross-slope and low roughness compared with the hillside around it
           (this still works under trees, where the photo can't see the road).

A Viterbi pass then picks the smoothest high-scoring offset sequence, which is smoothed again
and written as data/route_refined.json (UTM 11N x, y) for build.py.
"""
import json
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image, ImageDraw
from pyproj import Transformer
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
ROAD_W = 6.6
STEP = 2.0            # station spacing (m)
OFFS = np.arange(-12.0, 12.01, 0.5)
to_utm = Transformer.from_crs(4326, 32611, always_xy=True).transform


def osm_line():
    coords = json.load(open(DATA / "route_osrm.json"))["routes"][0]["geometry"]["coordinates"]
    pts = np.array([to_utm(*c) for c in coords])
    keep = np.r_[True, np.linalg.norm(np.diff(pts, axis=0), axis=1) > 0.01]
    pts = pts[keep]
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(pts, axis=0), axis=1))]
    ss = np.arange(0, s[-1], 1.0)
    p = np.c_[np.interp(ss, s, pts[:, 0]), np.interp(ss, s, pts[:, 1])]
    # light smoothing only: removes OSM vertex kinks without cutting the corners
    return ndimage.gaussian_filter1d(p, 1.5, axis=0, mode="nearest")


def resample(p, step):
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))]
    ss = np.arange(0, s[-1], step)
    return np.c_[np.interp(ss, s, p[:, 0]), np.interp(ss, s, p[:, 1])], ss


def normals(p):
    t = np.gradient(p, axis=0); t /= np.linalg.norm(t, axis=1)[:, None]
    return np.c_[-t[:, 1], t[:, 0]]   # left of travel in UTM (x east, y north)


def main():
    naip = rasterio.open(DATA / "naip.tif"); dem_ds = rasterio.open(DATA / "dem.tif")
    chm_ds = rasterio.open(DATA / "chm.tif")
    dem = dem_ds.read(1).astype(np.float32)
    inv = ~naip.transform

    # ---- per-pixel pavement evidence from imagery, in [-1, 1]; 0 = no information (in row blocks)
    H, W = naip.height, naip.width
    img = np.zeros((H, W), np.float32)
    centre = np.zeros((H, W), np.float32)
    PAD = 12
    for r0 in range(0, H, 1024):
        win = rasterio.windows.Window(0, r0, W, min(1024, H - r0))
        R, G, B, N = [x.astype(np.float32) for x in naip.read((1, 2, 3, 4), window=win)]
        chm = np.nan_to_num(chm_ds.read(1, window=win))
        ndvi = (N - R) / np.maximum(N + R, 1)
        chroma = np.max([R, G, B], axis=0) - np.min([R, G, B], axis=0)
        bright = (R + G + B) / 3
        pave = (1 / (1 + np.exp((ndvi - 0.12) / 0.035))) * (1 / (1 + np.exp((chroma - 32) / 7))) * (1 / (1 + np.exp((40 - bright) / 6)))
        veg = 1 / (1 + np.exp((0.25 - ndvi) / 0.04))
        blk = pave - veg
        blk[chm > 2.5] = 0.0                  # canopy hides the road
        img[r0:r0 + blk.shape[0]] = blk
        # visible asphalt (not bright gravel/concrete, not deep shadow): its distance-to-edge ridge is
        # the pavement centre. Under trees there's no evidence either way (flat forest floor isn't road).
        a0, a1 = max(0, r0 - PAD), min(H, r0 + 1024 + PAD)
        wv = rasterio.windows.Window(0, a0, W, a1 - a0)
        R2, G2, B2, N2 = [x.astype(np.float32) for x in naip.read((1, 2, 3, 4), window=wv)]
        ch2 = np.nan_to_num(chm_ds.read(1, window=wv))
        nd2 = (N2 - R2) / np.maximum(N2 + R2, 1)
        cr2 = np.max([R2, G2, B2], axis=0) - np.min([R2, G2, B2], axis=0)
        br2 = (R2 + G2 + B2) / 3
        asphalt = (nd2 < 0.14) & (cr2 < 30) & (br2 > 38) & (br2 < 150)
        road = ndimage.binary_closing(ndimage.binary_opening(asphalt & (ch2 <= 2.5), iterations=1), iterations=2)
        dtb = np.minimum(ndimage.distance_transform_edt(road), 3.6).astype(np.float32)
        dtb[ch2 > 2.5] = np.nan                       # unknown under canopy
        centre[r0:r0 + blk.shape[0]] = dtb[r0 - a0:r0 - a0 + blk.shape[0]]
        del R2, G2, B2, N2, ch2, nd2, cr2, br2, asphalt, road, dtb
    img = ndimage.uniform_filter(img, 3)

    p0 = osm_line()
    p, ss = resample(p0, STEP)
    n = normals(p)
    M = len(p)

    def sample(arr, xs, ys):
        c, r = inv * (xs, ys)
        return ndimage.map_coordinates(arr, [r - 0.5, c - 0.5], order=1, mode="nearest")

    # profiles across the road at 0.5 m from -20 to +20 m
    prof_off = np.arange(-20.0, 20.01, 0.5)
    X = p[:, 0:1] + n[:, 0:1] * prof_off[None, :]
    Y = p[:, 1:2] + n[:, 1:2] * prof_off[None, :]
    P_img = sample(img, X.ravel(), Y.ravel()).reshape(X.shape)
    P_dem = sample(dem, X.ravel(), Y.ravel()).reshape(X.shape)
    P_ctr = sample(np.nan_to_num(centre, nan=-1.0), X.ravel(), Y.ravel()).reshape(X.shape)
    P_known = (P_ctr >= 0).astype(np.float32)
    P_ctr = ndimage.uniform_filter1d(np.maximum(P_ctr, 0), 3, axis=0)
    # average along the road (+-4 m) to beat noise
    P_img = ndimage.uniform_filter1d(P_img, 5, axis=0)

    half = ROAD_W / 2
    k_in = int(half / 0.5)
    IMG = np.zeros((M, len(OFFS))); FLAT = np.zeros((M, len(OFFS))); BENCH = np.zeros((M, len(OFFS)))
    for j, d in enumerate(OFFS):
        c = int(round((d + 20) / 0.5))
        inside = P_img[:, c - k_in:c + k_in + 1].mean(axis=1)
        sh_l = P_img[:, c - k_in - 6:c - k_in - 1].mean(axis=1)
        sh_r = P_img[:, c + k_in + 2:c + k_in + 7].mean(axis=1)
        IMG[:, j] = inside - 0.5 * (np.maximum(sh_l, 0) + np.maximum(sh_r, 0))
        # lidar: the road window is flat (low cross-slope, low residual)
        z = P_dem[:, c - k_in:c + k_in + 1]
        xo = np.linspace(-half, half, z.shape[1])
        zc = z - z.mean(axis=1, keepdims=True)
        slope = (zc * xo).sum(axis=1) / (xo ** 2).sum()
        resid = np.sqrt(((zc - slope[:, None] * xo) ** 2).mean(axis=1))
        FLAT[:, j] = np.exp(-np.abs(slope) / 0.05) * np.exp(-resid / 0.08)
        # bench: the ground just outside each edge leaves the road plane (ditch, cut or fill).
        # A flat field has no edges, so it scores low here even though it is flat.
        kl, kr = c - k_in - 5, c + k_in + 5
        ext = lambda u: z.mean(axis=1) + slope * u
        eL = np.abs(P_dem[:, kl - 2:kl + 1].mean(axis=1) - ext(-half - 1.5))
        eR = np.abs(P_dem[:, kr:kr + 3].mean(axis=1) - ext(half + 1.5))
        BENCH[:, j] = np.exp(-resid / 0.06) * np.tanh((eL + eR) / 0.25)
    FLAT = ndimage.uniform_filter1d(FLAT, 3, axis=0)
    # flatness only tells us something where the ground around the road isn't flat as well
    rough = P_dem.std(axis=1)
    dem_weight = np.clip((rough - 0.3) / 1.5, 0, 1)
    CTR = np.stack([P_ctr[:, int(round((d + 20) / 0.5))] for d in OFFS], axis=1) / 3.6
    KNOWN = np.stack([P_known[:, int(round((d + 20) / 0.5))] for d in OFFS], axis=1)
    # centre ridge only counts where the asphalt is visible; relative to the station's mean so it's a contrast
    CTRc = (CTR - (CTR * KNOWN).sum(axis=1, keepdims=True) / np.maximum(KNOWN.sum(axis=1, keepdims=True), 1)) * KNOWN
    BENCH = ndimage.uniform_filter1d(BENCH, 5, axis=0)
    score = (0.6 * IMG + 0.6 * dem_weight[:, None] * (FLAT - FLAT.mean(axis=1, keepdims=True)) + 0.9 * CTRc
             + 1.9 * (BENCH - BENCH.mean(axis=1, keepdims=True)))

    # ---- Viterbi: smooth offset path through the score field
    lam1 = 0.03       # cost per (m)^2 of offset change between 2 m stations
    prior = 0.004     # pull toward OSM when the evidence is weak
    K = len(OFFS)
    dd = (OFFS[:, None] - OFFS[None, :]) ** 2
    cost = -score[0] + prior * OFFS ** 2
    back = np.zeros((M, K), dtype=np.int16)
    for i in range(1, M):
        tot = cost[None, :] + lam1 * dd          # [to, from]
        back[i] = np.argmin(tot, axis=1)
        cost = tot[np.arange(K), back[i]] - score[i] + prior * OFFS ** 2
    path = np.zeros(M, dtype=int); path[-1] = int(np.argmin(cost))
    for i in range(M - 1, 0, -1): path[i - 1] = back[i, path[i]]
    off = OFFS[path]
    off_s = ndimage.gaussian_filter1d(off, 2.0, mode="nearest")
    q = p + n * off_s[:, None]
    q = ndimage.gaussian_filter1d(q, 1.0, axis=0, mode="nearest")
    print(f"stations {M}, mean |offset| {np.abs(off_s).mean():.2f} m, p95 {np.percentile(np.abs(off_s), 95):.2f} m, max {np.abs(off_s).max():.2f} m")
    conf = score[np.arange(M), path] - np.median(score, axis=1)
    print(f"confidence: median {np.median(conf):.2f}, share of stations with clear evidence {np.mean(conf > 0.15):.0%}")
    json.dump({"crs": "EPSG:32611", "pts": q.round(3).tolist(), "offset": off_s.round(3).tolist()}, open(DATA / "route_refined.json", "w"))
    debug(naip, p, q, ss, off_s)


def debug(naip, p, q, ss, off):
    def curv(a):
        d1 = np.gradient(a, axis=0); d2 = np.gradient(d1, axis=0)
        return (d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]) / np.maximum(np.linalg.norm(d1, axis=1) ** 3, 1e-9)
    k = np.abs(curv(p))
    order = np.argsort(-k); picks = []
    for i in order:
        if all(abs(ss[i] - ss[j]) > 400 for j in picks): picks.append(i)
        if len(picks) == 6: break
    rng = np.random.default_rng(1)
    picks += list(rng.choice(len(p), 6, replace=False))
    tiles = []
    nq = normals(q)
    for i in picks:
        cx, cy = q[i]
        half = 55
        win = rasterio.windows.from_bounds(cx - half, cy - half, cx + half, cy + half, naip.transform)
        img = np.moveaxis(naip.read([1, 2, 3], window=win, boundless=True), 0, -1)
        im = Image.fromarray(img).resize((440, 440)); d = ImageDraw.Draw(im)
        sc = 440 / (2 * half)
        P = lambda x, y: ((x - (cx - half)) * sc, ((cy + half) - y) * sc)
        sel = np.where(np.abs(ss - ss[i]) < 120)[0]
        d.line([P(*p[j]) for j in sel], fill=(255, 60, 60), width=2)
        for side in (-1, 1):
            d.line([P(*(q[j] + nq[j] * side * ROAD_W / 2)) for j in sel], fill=(80, 255, 120), width=1)
        d.line([P(*q[j]) for j in sel], fill=(255, 255, 0), width=2)
        d.text((5, 5), f"s={ss[i]:.0f}  shift={off[i]:+.1f} m", fill=(255, 255, 255))
        tiles.append(im)
    W = Image.new("RGB", (440 * 4, 440 * 3))
    for t, im in enumerate(tiles): W.paste(im, ((t % 4) * 440, (t // 4) * 440))
    W.save(DATA / "road_refine_debug.png")
    print("debug:", DATA / "road_refine_debug.png")


if __name__ == "__main__":
    main()
