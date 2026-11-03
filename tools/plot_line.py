"""Draw racing-line candidates over the aerial photo at chosen distances: python tools/plot_line.py 5642 23254 ..."""
import json, sys
from pathlib import Path
import numpy as np, rasterio
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
WORLD, DATA = ROOT / "game/public/world", ROOT / "data"


def main(svals, out, cand_file=DATA / "racing_line_candidates.json", final=None):
    r = json.load(open(WORLD / "route.json")); P = np.array(r["pts"]); w = r["w"]
    xz = P[:, [0, 2]]; s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(xz, axis=0), axis=1))]
    t = np.gradient(xz, axis=0); t /= np.linalg.norm(t, axis=1)[:, None]; n = np.c_[t[:, 1], -t[:, 0]]
    meta = json.load(open(WORLD / "meta.json")); ox, oy = meta["origin_utm"]
    naip = rasterio.open(DATA / "naip.tif")
    lines = []
    speeds = None
    if final:
        f = json.load(open(final)); lines.append((np.c_[f["x"], f["z"]], None)); speeds = np.array(f["v"])
    else:
        cols = [(255, 60, 60), (255, 200, 40), (80, 220, 255), (190, 120, 255)]
        for ci, c in enumerate(json.load(open(cand_file))["candidates"]):
            a = np.array(c["alpha"]); lines.append((xz + n * a[:, None], cols[ci % 4]))
    tiles = []
    for sv in svals:
        i = int(np.searchsorted(s, sv)); cx, cz = xz[i]; half = 55
        win = rasterio.windows.from_bounds(cx + ox - half, oy - cz - half, cx + ox + half, oy - cz + half, naip.transform)
        img = np.moveaxis(naip.read([1, 2, 3], window=win, boundless=True), 0, -1)
        im = Image.fromarray(img).resize((440, 440)); d = ImageDraw.Draw(im); sc = 440 / (2 * half)
        Pt = lambda x, z: ((x - (cx - half)) * sc, (z - (cz - half)) * sc)
        sel = np.where(np.abs(s - sv) < 130)[0]
        for side in (-1, 1): d.line([Pt(*(xz[j] + n[j] * side * w / 2)) for j in sel], fill=(220, 220, 220), width=1)
        for pts, col in lines:
            if col is not None: d.line([Pt(*pts[j]) for j in sel], fill=col, width=2); continue
            for a, b in zip(sel[:-1], sel[1:]):   # colour by target speed: blue slow -> red fast
                u = min(1, speeds[a] / 40); d.line([Pt(*pts[a]), Pt(*pts[b])], fill=(int(255 * u), int(80 + 100 * (1 - abs(u - 0.5) * 2)), int(255 * (1 - u))), width=3)
            for j in sel[::12]: d.text(Pt(*pts[j]), f"{speeds[j] * 2.237:.0f}", fill=(255, 255, 255))
        d.text((5, 5), f"s={sv:.0f} m", fill=(255, 255, 255)); tiles.append(im)
    cols_n = min(4, len(tiles)); rows_n = (len(tiles) + cols_n - 1) // cols_n
    W = Image.new("RGB", (440 * cols_n, 440 * rows_n))
    for k, im in enumerate(tiles): W.paste(im, ((k % cols_n) * 440, (k // cols_n) * 440))
    W.save(out); print(out)


if __name__ == "__main__":
    args = sys.argv[1:]
    final = None
    if args and args[0] == "--final": final = args[1]; args = args[2:]
    main([float(a) for a in args], DATA / "line_spots.png", final=final)
