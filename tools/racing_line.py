"""Racing-line geometry for E Hayden Lake Rd.

Solves the classic minimum-curvature problem: choose a lateral offset alpha_i (left of travel) at
every station so the path p_i = c_i + alpha_i * n_i bends as little as possible while staying
on the pavement:

    minimise  sum_i |p_{i-1} - 2 p_i + p_{i+1}|^2 / ds^4   (squared curvature)
            + w_len * sum_i |p_{i+1} - p_i|^2 / ds^2     (optional pull toward the shortest path)
    subject to  -b <= alpha_i <= b

p is linear in alpha, so this is a bounded linear least-squares problem (scipy lsq_linear).
Several w_len values are written out; game/tools/racingline.mjs lap-simulates each one with the
real car and keeps the fastest.

Output: data/racing_line_candidates.json (offsets resampled onto the 2 m route stations) and
data/racing_line_debug.png (a few corners drawn over the aerial photo).
"""
import json
from pathlib import Path

import numpy as np
from scipy import sparse
from scipy.optimize import lsq_linear

ROOT = Path(__file__).resolve().parent.parent
WORLD = ROOT / "game" / "public" / "world"
DATA = ROOT / "data"

DS = 3.0            # optimisation station spacing (m)
CAR_HALF = 0.90     # 1,795 mm wide
MARGIN = 0.40       # keep the tyres a little inside the edge line: a followable line, not a knife edge
GRID_OFF = -1.6     # start in the right-hand lane (negative = right of travel)
W_LENS = [0.0, 0.0005, 0.002, 0.008]


def load_route():
    r = json.load(open(WORLD / "route.json"))
    P = np.array(r["pts"], dtype=float)
    xz = P[:, [0, 2]]
    s = np.r_[0, np.cumsum(np.linalg.norm(np.diff(xz, axis=0), axis=1))]
    return r["w"], xz, P[:, 1], s


def frame(c):
    t = np.gradient(c, axis=0)
    t /= np.linalg.norm(t, axis=1)[:, None]
    n = np.c_[t[:, 1], -t[:, 0]]          # left of travel (x east, z south)
    return t, n


def solve(c, n, bound, w_len, fixed_start):
    N = len(c)
    rows, cols, vals, b = [], [], [], []
    r = 0
    inv2 = 1.0 / DS ** 2
    # curvature rows (x and z components of the second difference)
    for i in range(1, N - 1):
        d = c[i - 1] - 2 * c[i] + c[i + 1]
        for k in range(2):
            for j, coef in ((i - 1, 1.0), (i, -2.0), (i + 1, 1.0)):
                rows.append(r); cols.append(j); vals.append(coef * n[j, k] * inv2)
            b.append(-d[k] * inv2)
            r += 1
    if w_len > 0:
        sw = np.sqrt(w_len) / DS
        for i in range(N - 1):
            d = c[i + 1] - c[i]
            for k in range(2):
                rows += [r, r]; cols += [i, i + 1]; vals += [-n[i, k] * sw, n[i + 1, k] * sw]
                b.append(-d[k] * sw)
                r += 1
    # tiny pull to the centre so straights with no preference stay sane
    eps = 1e-4
    for i in range(N):
        rows.append(r); cols.append(i); vals.append(eps); b.append(0.0); r += 1
    A = sparse.csr_matrix((vals, (rows, cols)), shape=(r, N))
    lo = np.full(N, -bound); hi = np.full(N, bound)
    lo[:fixed_start] = hi[:fixed_start] = GRID_OFF
    return box_qp(A, np.array(b), lo, hi)


def box_qp(A, b, lo, hi, max_iter=300):
    """min |A x - b|^2 s.t. lo <= x <= hi, for banded A^T A (bandwidth 2).

    Primal active-set: solve the free variables exactly with a banded Cholesky, pin violators to
    their bound, release pinned variables whose gradient says they want back inside. Converges
    in a few dozen banded solves (milliseconds each) where generic solvers take minutes.
    """
    from scipy.linalg import solveh_banded
    H = (A.T @ A).tocsr(); g = A.T @ b
    N = len(g)
    x = np.zeros(N)
    pinned = np.zeros(N, dtype=np.int8)        # 0 free, -1 at lo, +1 at hi
    pinned[lo == hi] = 2                        # equality-fixed
    x[lo == hi] = lo[lo == hi]
    for it in range(max_iter):
        free = np.where(pinned == 0)[0]
        fixedv = np.where(pinned != 0)[0]
        x[pinned == -1] = lo[pinned == -1]; x[pinned == 1] = hi[pinned == 1]
        rhs = g[free] - H[free][:, fixedv] @ x[fixedv]
        Hf = H[free][:, free]
        ab = np.zeros((3, len(free)))
        for k in range(3):
            dk = Hf.diagonal(k)
            ab[2 - k, k:] = dk
        x[free] = solveh_banded(ab, rhs)
        changed = 0
        over, under = (x > hi + 1e-9) & (pinned == 0), (x < lo - 1e-9) & (pinned == 0)
        pinned[over] = 1; pinned[under] = -1; changed += over.sum() + under.sum()
        if changed == 0:
            grad = H @ x - g
            rel = ((pinned == 1) & (grad > 1e-12)) | ((pinned == -1) & (grad < -1e-12))
            if not rel.any():
                break
            # release the worst offenders only, to avoid cycling
            idx = np.where(rel)[0]
            worst = idx[np.argsort(-np.abs(grad[idx]))[: max(1, len(idx) // 3)]]
            pinned[worst] = 0
    x = np.clip(x, lo, hi)
    cost = float(np.sum((A @ x - b) ** 2))
    return x, {"status": it, "cost": cost}


def curvature(p):
    d1 = np.gradient(p, axis=0); d2 = np.gradient(d1, axis=0)
    return (d1[:, 0] * d2[:, 1] - d1[:, 1] * d2[:, 0]) / np.maximum(np.linalg.norm(d1, axis=1) ** 3, 1e-9)


def main():
    w, xz, y, s = load_route()
    L = s[-1]
    sg = np.arange(0, L, DS); sg = np.r_[sg, L] if L - sg[-1] > 0.5 else sg
    c = np.c_[np.interp(sg, s, xz[:, 0]), np.interp(sg, s, xz[:, 1])]
    t, n = frame(c)
    bound = w / 2 - CAR_HALF - MARGIN
    fixed = int(30 / DS)
    print(f"{len(c)} stations, usable half-width {bound:.2f} m")

    out = {"route_s": s.round(3).tolist(), "bound": bound, "candidates": []}
    kc = curvature(c)
    print(f"centreline: sum k^2 = {np.sum(kc ** 2) * DS:.4f}, max |k| = {np.abs(kc).max():.4f} (R {1 / np.abs(kc).max():.1f} m)")
    for wl in W_LENS:
        a, res = solve(c, n, bound, wl, fixed)
        p = c + n * a[:, None]
        k = curvature(p)
        at_edge = np.mean(np.abs(a) > bound - 0.02)
        print(f"w_len {wl:<7} iters {res['status']} cost {res['cost']:.4e}  sum k^2 {np.sum(k ** 2) * DS:.4f}  max |k| {np.abs(k).max():.4f} (R {1 / np.abs(k).max():.1f} m)  "
              f"length {np.sum(np.linalg.norm(np.diff(p, axis=0), axis=1)):.1f} m  at edge {at_edge:.0%}")
        alpha_route = np.interp(s, sg, a)
        out["candidates"].append({"w_len": wl, "alpha": alpha_route.round(4).tolist()})
    json.dump(out, open(DATA / "racing_line_candidates.json", "w"))
    debug_plot(w, xz, s, out)


def debug_plot(w, xz, s, out):
    """Draw the tightest corners: centreline (white), road edges (grey), candidate lines (coloured)."""
    from PIL import Image, ImageDraw
    import rasterio
    meta = json.load(open(WORLD / "meta.json"))
    ox, oy = meta["origin_utm"]
    naip = rasterio.open(DATA / "naip.tif")
    t, n = frame(xz)
    k = curvature(xz)
    # pick 6 well-separated tight corners
    order = np.argsort(-np.abs(k)); picks = []
    for i in order:
        if all(abs(s[i] - s[j]) > 400 for j in picks): picks.append(i)
        if len(picks) == 6: break
    tiles = []
    cols = [(255, 80, 80), (255, 200, 40), (80, 220, 255), (190, 120, 255)]
    for i in picks:
        cx, cz = xz[i]
        half = 60  # metres
        # NAIP window around the corner (local x,z -> UTM)
        ux, uy = cx + ox, oy - cz
        win = rasterio.windows.from_bounds(ux - half, uy - half, ux + half, uy + half, naip.transform)
        img = np.moveaxis(naip.read([1, 2, 3], window=win, boundless=True), 0, -1)
        im = Image.fromarray(img).resize((480, 480)); d = ImageDraw.Draw(im)
        sc = 480 / (2 * half)
        P = lambda x, z: ((x - (cx - half)) * sc, (z - (cz - half)) * sc)
        sel = np.where(np.abs(s - s[i]) < 140)[0]
        for side in (-1, 1):
            d.line([P(*(xz[j] + n[j] * side * w / 2)) for j in sel], fill=(200, 200, 200), width=2)
        d.line([P(*xz[j]) for j in sel], fill=(255, 255, 255), width=1)
        for ci, cand in enumerate(out["candidates"]):
            a = np.array(cand["alpha"])
            d.line([P(*(xz[j] + n[j] * a[j])) for j in sel], fill=cols[ci % len(cols)], width=2)
        d.text((6, 6), f"s={s[i]:.0f} m  R={1 / abs(k[i]):.0f} m", fill=(255, 255, 255))
        tiles.append(im)
    W = Image.new("RGB", (480 * 3, 480 * 2))
    for q, im in enumerate(tiles): W.paste(im, ((q % 3) * 480, (q // 3) * 480))
    W.save(DATA / "racing_line_debug.png")
    print("debug image:", DATA / "racing_line_debug.png")


if __name__ == "__main__":
    main()
