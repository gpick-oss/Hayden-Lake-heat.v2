"""Roadside landmarks for E Hayden Lake Rd -> game/public/world/landmarks.json

Data-driven (from real data):
  gates, stop signs      OpenStreetMap nodes (data/osm_details.json)
  speed limit            OpenStreetMap maxspeed on E Hayden Lake Rd (35 mph)
  street name signs      Overture road names at every named junction
  driveways + mailboxes  every unnamed driveway/service road that meets the race road
  guard rails            lidar: wherever the ground drops >= 2 m within ~6 m of the edge, or water is right there
Rule-based (placed the way a county road crew would, not surveyed):
  curve / turn / hairpin / reverse-turn warning signs with advisory speed plaques (MUTCD ball-bank rule),
  "winding road NEXT X MILES" signs over runs of curves, chevrons on the outside of sharp curves,
  mile posts, and a utility pole line through the stretches with houses.

Positions are in the game's local frame (x east, z south); the game drops them onto its terrain.
"""
import json
import math
from pathlib import Path

import numpy as np
import rasterio
from pyproj import Transformer
from scipy import ndimage
from scipy.spatial import cKDTree
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parent.parent
DATA, WORLD = ROOT / "data", ROOT / "game" / "public" / "world"
MPH = 2.23694
to_utm = Transformer.from_crs(4326, 32611, always_xy=True).transform


def main():
    meta = json.load(open(WORLD / "meta.json")); ox, oy = meta["origin_utm"]; lake = meta["lake"]
    route = json.load(open(WORLD / "route.json")); P = np.array(route["pts"]); W = route["w"]; half = W / 2
    xz = P[:, [0, 2]]; n = len(xz)
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(xz, axis=0), axis=1))]; L = s[-1]
    t = np.gradient(xz, axis=0); t /= np.linalg.norm(t, axis=1)[:, None]
    left = np.c_[t[:, 1], -t[:, 0]]                        # left of forward travel (x east, z south)
    heading = np.arctan2(t[:, 0], t[:, 1])                  # game yaw of forward travel
    tree = cKDTree(xz)
    local = lambda x, y: np.array([x - ox, -(y - oy)])
    at = lambda sv: int(np.clip(np.searchsorted(s, sv), 0, n - 1))
    out = {"signs": [], "rails": [], "posts": [], "gates": [], "mailboxes": [], "poles": [], "wires": []}

    def sign(sv, dirn, kind, text="", extra=0.0, lat=None, height=1.6, plaque=None, plaque2=None, face=None):
        """a post-mounted sign on the right side of travel for direction dirn (+1 forward, -1 reverse)"""
        i = at(sv)
        side = -1 if dirn > 0 else 1                       # right of travel
        off = half + 2.0 + extra if lat is None else lat
        p = xz[i] + left[i] * side * off
        yaw = heading[i] + (math.pi if dirn > 0 else 0)       # face the approaching driver
        if face is not None: yaw = face
        out["signs"].append({"x": round(float(p[0]), 2), "z": round(float(p[1]), 2), "yaw": round(float(yaw), 4), "kind": kind,
                             "text": text, "h": height, "plaque": plaque, "plaque2": plaque2, "s": round(float(sv), 1), "dir": dirn})

    # ------------------------------------------------------------ curves -> warning signs
    h = np.unwrap(np.arctan2(t[:, 0], t[:, 1]))
    k = np.zeros(n)
    for i in range(n):
        a, b = max(i - 5, 0), min(i + 5, n - 1)
        k[i] = (h[b] - h[a]) / max(s[b] - s[a], 1e-3)
    k = ndimage.gaussian_filter1d(k, 3)
    curves = []
    i = 0
    while i < n:
        if abs(k[i]) < 1 / 300: i += 1; continue
        sg = np.sign(k[i]); j = i
        while j < n - 1 and np.sign(k[j + 1]) == sg and abs(k[j + 1]) > 1 / 450: j += 1
        if curves and curves[-1]["sign"] == sg and s[i] - curves[-1]["s1"] < 20:
            curves[-1].update(s1=s[j], b=j)
        else:
            curves.append({"a": i, "b": j, "s0": s[i], "s1": s[j], "sign": sg})
        i = j + 1
    for c in curves:
        seg = slice(c["a"], c["b"] + 1)
        c["R"] = 1 / max(np.abs(k[seg]).max(), 1e-6)
        c["angle"] = abs(h[c["b"]] - h[c["a"]]) * 180 / math.pi
        c["adv"] = 5 * math.floor(math.sqrt(0.29 * 9.81 * c["R"]) * MPH / 5)       # 16-degree ball-bank rule
    LIMIT = 35
    curves = [c for c in curves if c["angle"] >= 20 and c["adv"] <= LIMIT - 10]
    print(f"curves needing an advisory speed: {len(curves)}; advisory mph counts:", {a: sum(1 for c in curves if c['adv'] == a) for a in sorted({c['adv'] for c in curves})})

    def warn(dirn):
        cs = curves if dirn > 0 else [dict(c, s0=L - c["s1"], s1=L - c["s0"], sign=-c["sign"]) for c in curves[::-1]]
        # runs of curves closer than 180 m (600 ft) -> winding road
        runs, cur = [], [cs[0]] if cs else []
        for c in cs[1:]:
            if c["s0"] - cur[-1]["s1"] < 180: cur.append(c)
            else: runs.append(cur); cur = [c]
        if cur: runs.append(cur)
        for run in runs:
            if len(run) >= 3:
                miles = (run[-1]["s1"] - run[0]["s0"]) / 1609.34
                adv = min(c["adv"] for c in run)
                plaque2 = f"NEXT {miles:.1f} MILES" if miles >= 0.3 else None
                sign(max(15, run[0]["s0"] - 60), dirn, "winding", "L" if run[0]["sign"] > 0 else "R", plaque=f"{adv} MPH", plaque2=plaque2)
                for c in run:                                  # only the hairpins get their own sign inside a run
                    if c["angle"] >= 135 and c["R"] < 25: sign(max(0, c["s0"] - 45), dirn, "hairpin", "L" if c["sign"] > 0 else "R", plaque=f"{c['adv']} MPH")
            else:
                for q, c in enumerate(run):
                    nxt = run[q + 1] if q + 1 < len(run) else None
                    d = "L" if c["sign"] > 0 else "R"
                    if c["angle"] >= 135 and c["R"] < 25: kind = "hairpin"
                    elif nxt is not None and nxt["sign"] != c["sign"]: kind = "reverse_turn" if c["adv"] <= 30 else "reverse_curve"
                    else: kind = "turn" if c["adv"] <= 30 else "curve"
                    sign(max(15, c["s0"] - 55), dirn, kind, d, plaque=f"{c['adv']} MPH")
        # chevrons on the outside of the sharp ones (advisory 20+ mph below the limit)
        for c in cs:
            if not (c["adv"] <= 10 or (c["angle"] >= 120 and c["R"] < 25)): continue
            space = float(np.clip(c["R"] * 0.6, 12, 30))
            outside = -c["sign"]                                # outside of a left turn is the right side
            for sv in np.arange(c["s0"], c["s1"] + 0.1, space):
                i = at(sv if dirn > 0 else L - sv)
                side = outside * (1 if dirn > 0 else -1)
                p = xz[i] + left[i] * side * (half + 2.2)
                yaw = heading[i] + (math.pi if dirn > 0 else 0)
                out["signs"].append({"x": round(float(p[0]), 2), "z": round(float(p[1]), 2), "yaw": round(float(yaw), 4), "kind": "chevron",
                                     "text": "L" if c["sign"] > 0 else "R", "h": 1.5, "s": round(float(sv), 1), "dir": dirn})
    warn(1); warn(-1)

    # ------------------------------------------------------------ speed limits (OSM: 35 mph on E Hayden Lake Rd)
    for dirn in (1, -1):
        for sv in np.arange(120, L - 200, 3200):
            sign(sv, dirn, "speed", str(LIMIT))

    # ------------------------------------------------------------ mile posts (forward side, from the north end)
    for m in range(1, int(L / 1609.34) + 1):
        sign(m * 1609.34, 1, "milepost", str(m), extra=0.6, height=1.2)

    # ------------------------------------------------------------ OSM gates and stop signs
    osm = json.load(open(DATA / "osm_details.json"))
    for e in osm["elements"]:
        if e["type"] != "node": continue
        tg = e.get("tags", {})
        p = local(*to_utm(e["lon"], e["lat"]))
        dist, i = tree.query(p)
        if tg.get("barrier") == "gate" and dist < 60:
            v = p - xz[i]; yaw = math.atan2(v[0], v[1])        # driveway runs toward the road; gate spans it
            out["gates"].append({"x": round(float(p[0]), 2), "z": round(float(p[1]), 2), "yaw": round(yaw + math.pi / 2, 4), "w": 4.2})
        if tg.get("highway") == "stop" and dist < 40:
            v = p - xz[i]; yaw = math.atan2(v[0], v[1])        # faces traffic coming toward the junction
            out["signs"].append({"x": round(float(p[0]), 2), "z": round(float(p[1]), 2), "yaw": round(yaw, 4), "kind": "stop", "text": "", "h": 1.6, "s": round(float(s[i]), 1), "dir": 0})

    # ------------------------------------------------------------ junctions: street names, driveways, mailboxes
    junctions = []
    seen = []
    for f in json.load(open(DATA / "ov_segment.geojson"))["features"]:
        pr = f["properties"]
        if pr["subtype"] != "road" or f["geometry"]["type"] != "LineString": continue
        if pr.get("class") in ("footway", "path", "cycleway"): continue
        name = pr.get("name") or ""
        if name == "East Hayden Lake Road": continue
        g = np.array([local(*to_utm(*c)) for c in f["geometry"]["coordinates"]])
        dd, ii = tree.query(g)
        q = int(np.argmin(dd))
        if dd[q] > 9: continue
        # the road leaves from this end; its direction away from the race road
        far = g[-1] if q == 0 else g[0] if q == len(g) - 1 else (g[q + 1] if dd[min(q + 1, len(g) - 1)] > dd[max(q - 1, 0)] else g[q - 1])
        i = int(ii[q]); away = far - xz[i]; away /= max(np.linalg.norm(away), 1e-6)
        side = 1 if np.dot(away, left[i]) > 0 else -1
        if any(abs(s[i] - s2) < 12 and side == sd2 for s2, sd2 in seen): continue
        seen.append((s[i], side))
        junctions.append({"s": float(s[i]), "i": i, "side": side, "name": name, "cls": pr.get("class"), "away": away})
    abbrev = lambda nm: (nm.replace("North ", "N ").replace("South ", "S ").replace("East ", "E ").replace("West ", "W ")
                         .replace(" Road", " Rd").replace(" Drive", " Dr").replace(" Lane", " Ln").replace(" Court", " Ct")
                         .replace(" Street", " St").replace(" Avenue", " Ave").replace(" Loop", " Lp").replace(" Parkway", " Pkwy").replace(" Trail", " Trl"))
    rng = np.random.default_rng(11)
    for j in junctions:
        i, side = j["i"], j["side"]
        if j["name"]:
            p = xz[i] + left[i] * side * (half + 3.2) + t[i] * 5.0
            out["signs"].append({"x": round(float(p[0]), 2), "z": round(float(p[1]), 2), "yaw": round(float(heading[i] + math.pi / 2 * side), 4),
                                 "kind": "street", "text": abbrev(j["name"]), "h": 2.4, "s": round(j["s"], 1), "dir": 0})
        elif j["cls"] in ("service", "residential", "unknown", "track", "unclassified") and rng.random() < 0.85:
            p = xz[i] + left[i] * side * (half + 1.6) + t[i] * (3.2 * (1 if rng.random() < 0.5 else -1))
            out["mailboxes"].append({"x": round(float(p[0]), 2), "z": round(float(p[1]), 2), "yaw": round(float(heading[i] + (math.pi / 2) * -side), 4),
                                     "c": int(rng.integers(0, 4))})
    print(f"junctions {len(junctions)}: named {sum(1 for j in junctions if j['name'])}, mailboxes {len(out['mailboxes'])}")

    # ------------------------------------------------------------ guard rails from lidar drop-offs
    dem_ds = rasterio.open(DATA / "dem.tif"); dem = dem_ds.read(1).astype(np.float32); inv = ~dem_ds.transform
    def ground(pts):
        ux, uy = pts[:, 0] + ox, oy - pts[:, 1]
        c, r = inv * (ux, uy)
        return ndimage.map_coordinates(dem, [r - 0.5, c - 0.5], order=1, mode="nearest")
    road_y = P[:, 1] + lake
    junc_s = np.array([j["s"] for j in junctions]) if junctions else np.zeros(0)
    for side in (1, -1):
        # a rail is warranted on a high, steep fill (>= 4 m high and steeper than 1:2 within 7 m of
        # the edge, the usual barrier-warrant chart), or where the lake is right below the road
        d1 = road_y - ground(xz + left * side * (half + 1.5))
        d3 = road_y - ground(xz + left * side * (half + 7.0))
        steep = (d3 - np.maximum(d1, 0)) / 5.5
        water = ground(xz + left * side * (half + 4.0)) < lake + 0.4
        cand = ((d3 >= 4.0) & (steep >= 0.5)) | water
        cand = ndimage.binary_opening(cand, iterations=3)
        jclear = np.array([np.any(np.abs(junc_s - sv) < 9) if len(junc_s) else False for sv in s])
        cand &= ~jclear
        cand = ndimage.binary_closing(cand, iterations=6)
        lab, nl = ndimage.label(cand)
        for r in range(1, nl + 1):
            idx = np.where(lab == r)[0]
            if s[idx[-1]] - s[idx[0]] < 30: continue
            a, b = max(idx[0] - 3, 0), min(idx[-1] + 3, n - 1)
            line = xz[a:b + 1] + left[a:b + 1] * side * (half + 1.0)
            out["rails"].append({"pts": np.round(line[::1], 2).tolist(), "side": side, "s0": round(float(s[a]), 1), "s1": round(float(s[b]), 1)})
    print(f"guard rail runs: {len(out['rails'])}, total {sum(r['s1'] - r['s0'] for r in out['rails']):.0f} m")

    # ------------------------------------------------------------ utility poles through the stretches with houses
    blds = json.load(open(WORLD / "buildings.json"))
    cent = np.array([np.mean(b["p"], axis=0) for b in blds])
    bt = cKDTree(cent)
    dens = np.array([len(bt.query_ball_point(xz[i], 140)) for i in range(0, n, 10)])
    dens = np.repeat(dens, 10)[:n]
    dens = ndimage.uniform_filter1d(dens.astype(float), 100)
    live = dens >= 1.5
    lab, nl = ndimage.label(live)
    for r in range(1, nl + 1):
        idx = np.where(lab == r)[0]
        if s[idx[-1]] - s[idx[0]] < 250: continue
        # side with more houses
        mid = idx[len(idx) // 2]
        near = bt.query_ball_point(xz[mid], 250)
        sd = 1 if sum(np.dot(cent[q] - xz[mid], left[mid]) > 0 for q in near) >= len(near) / 2 else -1
        prev = None
        for sv in np.arange(s[idx[0]], s[idx[-1]], 42.0):
            i = at(sv)
            p = xz[i] + left[i] * sd * (half + 3.6)
            if ground(p[None])[0] < lake + 0.6: prev = None; continue
            if np.any(np.abs(junc_s - sv) < 6): continue
            out["poles"].append({"x": round(float(p[0]), 2), "z": round(float(p[1]), 2), "yaw": round(float(heading[i]), 4)})
            if prev is not None: out["wires"].append([len(out["poles"]) - 2, len(out["poles"]) - 1])
            prev = i
    print(f"utility poles {len(out['poles'])}, spans {len(out['wires'])}")
    kinds = {}
    for sg in out["signs"]: kinds[sg["kind"]] = kinds.get(sg["kind"], 0) + 1
    print("signs:", kinds, " gates:", len(out["gates"]))
    json.dump(out, open(WORLD / "landmarks.json", "w"), separators=(",", ":"))


if __name__ == "__main__":
    main()
