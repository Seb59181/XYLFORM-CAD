"""
Les matériaux de la bibliothèque : une fonction par matériau, qui renvoie la couleur (RGB 0–1),
le relief (hauteurs en mm) et la rugosité (0 = poli, 1 = mat) d'un motif raccordable.

`size` = largeur réelle de l'image en mm ; `aspect` = hauteur / largeur.
Les identifiants doivent correspondre à src/core/textureLibrary.ts.
"""
from __future__ import annotations

import numpy as np
from PIL import Image, ImageDraw

from lib import (F, Rects, blur, grid, hexc, herringbone, mix, noise, norm01, per_id, planks, ramp,
                 rng, running_bond, sstep, tint, voronoi, draw_wrapped)

W = 1024
REGISTRY: dict[str, dict] = {}


def material(mid: str, size: float, aspect: float = 1.0):
    def deco(fn):
        REGISTRY[mid] = {'fn': fn, 'size': size, 'aspect': aspect}
        return fn
    return deco


def dims(aspect: float) -> tuple[int, int]:
    return int(round(W * aspect)), W


# ---------------------------------------------------------------- outils communs

def joints(R: Rects, joint_px: float, bevel_px: float, depth: float, wobble: np.ndarray | None = None):
    """Relief d'un pavage : joint creux de `depth` mm, arête arrondie sur `bevel_px`."""
    e = R.edge - joint_px / 2
    if wobble is not None:
        e = e + wobble
    top = sstep(0, max(bevel_px, 0.5), e)
    return top, (top - 1) * depth


def grains(h, w, seed, scale=1.0):
    """Grain fin d'une matière minérale (mm)."""
    return (noise(h, w, seed, 1.2, fmin=80 * scale) * 0.6 + noise(h, w, seed + 1, 2.2, fmin=10 * scale) * 0.4)


def pores(h, w, seed, density, rmin, rmax, depth):
    """Petits trous (bulles d'un béton, piqûres) : hauteurs négatives en mm."""
    f1, _, ids, _, _ = voronoi(h, w, int(w / density), int(h / density), seed, 0.9)
    r = rmin + (rmax - rmin) * per_id(ids, seed + 7) ** 3
    keep = per_id(ids, seed + 9) < 0.45
    hole = np.where(keep, sstep(0, 1, 1 - f1 / np.maximum(r, 0.5)), 0)
    return -hole * depth


def wood(lx, ly, seed, ring_mm, px_mm, col_early, col_late, figure=1.0, knots=0, plank_ids=None):
    """Veinage du bois débité sur dosse : bandes de cernes ondulées le long des fibres, pores.

    lx le long des fibres, ly en travers (px) ; ring_mm = largeur moyenne d'une bande de cerne
    vue sur la face de la planche.
    """
    h, w = lx.shape
    if plank_ids is not None:
        off = per_id(plank_ids, seed + 3) * 1000
        bend = per_id(plank_ids, seed + 4) - 0.5
        cath = per_id(plank_ids, seed + 8)
    else:
        off = np.zeros_like(lx)
        bend = np.zeros_like(lx)
        cath = np.full_like(lx, 0.5)
    X = lx * px_mm
    Y = ly * px_mm
    n1 = noise(h, w, seed + 1, 3.0, aniso=(0.15, 1.0))
    n2 = noise(h, w, seed + 2, 2.0, fmin=30, aniso=(0.06, 1.0))
    # « cathédrales » : les cernes dessinent des arcs allongés le long de la planche
    arc = np.sin(X / (ring_mm * 18) + off) * ring_mm * (1.5 + 3 * cath)
    d = Y + off + n1 * ring_mm * 1.2 * figure + arc + bend * X * 0.02
    rings = (d / ring_mm) % 1.0
    late = sstep(0.45, 0.8, rings) * (1 - sstep(0.88, 1.0, rings))
    late = np.clip(late + n2 * 0.12, 0, 1)
    ones = np.ones((h, w, 1), F)
    col = mix(col_early[None, None, :] * ones, col_late[None, None, :] * ones, late)
    fib = noise(h, w, seed + 5, 0.8, fmin=150, aniso=(0.04, 1.0))
    pores_ = sstep(1.2, 2.5, fib)
    col = tint(col, (1 + 0.07 * fib) * (1 - 0.25 * pores_ * (0.4 + late)))
    broad = noise(h, w, seed + 6, 2.6, aniso=(0.2, 1.0))
    col = tint(col, 1 + 0.06 * broad)
    if plank_ids is not None:
        col = tint(col, 0.86 + 0.26 * per_id(plank_ids, seed + 6))
    hmm = -late * 0.05 - pores_ * 0.04 + fib * 0.01
    return col.astype(F), hmm.astype(F), late


def strokes(h, w, seed, n, length, width, pal, hmin=0.0, hmax=1.0, angle=None, spread=np.pi, base=None):
    """Brins dessinés (herbe) : couleur et hauteur, raccordables."""
    r = rng(seed)
    img = Image.new('RGB', (w, h), tuple(int(c * 255) for c in (base if base is not None else pal[0])))
    hh = Image.new('L', (w, h), 0)
    dc = ImageDraw.Draw(img)
    dh = ImageDraw.Draw(hh)
    heights = np.sort(r.uniform(hmin, hmax, n))
    for k in range(n):
        x, y = r.uniform(0, w), r.uniform(0, h)
        a = (angle if angle is not None else 0) + r.uniform(-spread, spread)
        L = length * r.uniform(0.5, 1.3)
        x2, y2 = x + np.cos(a) * L, y + np.sin(a) * L
        ht = heights[k]
        c = pal[r.integers(len(pal))] * (0.55 + 0.6 * ht) * r.uniform(0.85, 1.15)
        col = tuple(int(np.clip(v, 0, 1) * 255) for v in c)
        g = int(ht * 255)
        wd = max(1, int(round(width * r.uniform(0.7, 1.3))))
        bb = (min(x, x2) - 3, min(y, y2) - 3, max(x, x2) + 3, max(y, y2) + 3)

        def dr(dx, dy, x=x, y=y, x2=x2, y2=y2, col=col, g=g, wd=wd):
            dc.line([(x + dx, y + dy), (x2 + dx, y2 + dy)], fill=col, width=wd)
            dh.line([(x + dx, y + dy), (x2 + dx, y2 + dy)], fill=g, width=wd)
        draw_wrapped(dr, w, h, bb)
    return np.asarray(img, F) / 255, np.asarray(hh, F) / 255


def stones(f1, f2, ids, seed, mortar_px, round_px):
    """Pierres d'un Voronoï : dôme dans chaque cellule, joint entre deux."""
    e = (f2 - f1) / 2 - mortar_px / 2
    top = sstep(0, round_px, e)
    dome = np.sqrt(np.clip(e / (round_px * 3), 0, 1))
    return top, dome, e


def plain(h, w, c):
    return np.ones((h, w, 1), F) * hexc(c)[None, None, :]


# ================================================================ 1. Sols extérieurs

@material('pelouse', 1000)
def pelouse(seed):
    h, w = dims(1)
    pal = [hexc(c) for c in ('#3f6b22', '#4f7f2a', '#5d8f33', '#6a9a3a', '#3a5f1e', '#7aa548', '#8a9f3e')]
    soil = mix(plain(h, w, '#3b3220'), plain(h, w, '#2d3b18'), norm01(noise(h, w, seed, 2.5)))
    col, ht = strokes(h, w, seed, 70000, 9, 2, pal, angle=None, spread=np.pi)
    lowc = mix(soil, col, sstep(0.0, 0.08, ht))
    patch = norm01(noise(h, w, seed + 3, 3.0))
    col = tint(lowc, 0.85 + 0.3 * patch)
    yellow = sstep(0.7, 0.95, norm01(noise(h, w, seed + 4, 3.2)))
    col = mix(col, tint(col, 1.0) * hexc('#d8d070'), yellow * 0.25)
    return col, ht * 6, 0.85 - 0.1 * ht


@material('herbe_haute', 1000)
def herbe_haute(seed):
    h, w = dims(1)
    pal = [hexc(c) for c in ('#4c6e25', '#5f8530', '#7a9440', '#8d9a4a', '#a39c55', '#6b8a35', '#3d5a1d')]
    col, ht = strokes(h, w, seed, 55000, 22, 2, pal, angle=-np.pi / 2, spread=1.2, base=hexc('#2c3517'))
    patch = norm01(noise(h, w, seed + 3, 3.0))
    col = tint(col, 0.8 + 0.35 * patch)
    return col, ht * 12, 0.9 - 0.1 * ht


@material('terre', 1000)
def terre(seed):
    h, w = dims(1)
    f1, f2, ids, _, _ = voronoi(h, w, 26, 26, seed, 1.0)
    clod = sstep(0, 6, (f2 - f1) / 2) * (0.6 + 0.4 * per_id(ids, seed))
    n = noise(h, w, seed + 1, 2.4)
    fine = noise(h, w, seed + 2, 1.0, fmin=150)
    ht = clod * 3 + n * 1.5 + fine * 0.3
    pf1, pf2, pid, _, _ = voronoi(h, w, 90, 90, seed + 5, 1.0)
    peb = (per_id(pid, seed + 6) < 0.08) & (pf1 < 3 + 3 * per_id(pid, seed + 8))
    ht = ht + peb * 1.5
    t = norm01(n * 0.6 + clod * 0.8 + fine * 0.2)
    col = ramp(t, [(0, '#2f2216'), (0.5, '#4d3826'), (1, '#6e553b')])
    col = np.where(peb[..., None], ramp(per_id(pid, seed + 9), [(0, '#8a8277'), (1, '#b7ab97')]), col)
    return col, ht, 0.95 - 0.15 * peb


@material('gravier', 500)
def gravier(seed):
    h, w = dims(1)
    f1, f2, ids, _, _ = voronoi(h, w, 40, 40, seed, 1.0)
    top, dome, e = stones(f1, f2, ids, seed, 1.5, 6)
    ht = dome * (4 + 3 * per_id(ids, seed + 1)) + noise(h, w, seed + 2, 1.0, fmin=200) * 0.15
    t = per_id(ids, seed + 3)
    col = ramp(t, [(0, '#6e6a64'), (0.35, '#9a9286'), (0.7, '#b9ae9c'), (0.9, '#d4cbbb'), (1, '#837a70')])
    col = tint(col, 0.75 + 0.35 * norm01(noise(h, w, seed + 4, 1.5, fmin=60)))
    col = tint(col, 0.25 + 0.75 * top)
    return col, ht, 0.75 + 0.1 * (1 - top)


@material('sable', 500)
def sable(seed):
    h, w = dims(1)
    xs, ys = grid(h, w)
    warp = noise(h, w, seed, 3.0) * 25
    rip = np.sin((ys + warp) * 2 * np.pi / (w / 9)) * 0.5 + 0.5
    fine = noise(h, w, seed + 1, 0.5, fmin=300)
    ht = rip * 1.2 + noise(h, w, seed + 2, 2.6) * 0.8 + fine * 0.08
    t = norm01(noise(h, w, seed + 3, 2.2) + fine * 0.6)
    col = ramp(t, [(0, '#b89b72'), (0.5, '#d0b68b'), (1, '#e2cfa8')])
    sp = per_id(voronoi(h, w, 200, 200, seed + 4, 1.0)[2], seed + 5)
    col = tint(col, 0.9 + 0.2 * sp)
    return col, ht, 0.92


@material('macadam', 500)
def macadam(seed):
    h, w = dims(1)
    f1, f2, ids, _, _ = voronoi(h, w, 70, 70, seed, 1.0)
    agg = (f2 - f1) / 2
    stone = sstep(0.5, 2.5, agg)
    exposed = per_id(ids, seed + 1)
    fine = noise(h, w, seed + 2, 0.8, fmin=250)
    ht = stone * (0.4 + 0.8 * exposed) + fine * 0.1 + noise(h, w, seed + 3, 2.5) * 0.3
    tar = ramp(norm01(fine), [(0, '#1e1f21'), (1, '#36373a')])
    rock = ramp(per_id(ids, seed + 4), [(0, '#3e3e40'), (0.7, '#575654'), (1, '#7a766f')])
    col = mix(tar, rock, stone * sstep(0.55, 1.0, exposed))
    col = tint(col, 0.85 + 0.25 * norm01(noise(h, w, seed + 5, 3.0)))
    return col, ht, 0.88 - 0.1 * stone * exposed


@material('paves_beton', 800)
def paves_beton(seed):
    h, w = dims(1)
    R = herringbone(h, w, w / 8, 2)
    top, ht = joints(R, 5, 6, 4)
    ht = ht + grains(h, w, seed) * 0.12
    t = per_id(R.id, seed)
    col = ramp(t, [(0, '#77736d'), (0.4, '#8e8981'), (0.75, '#a39b8e'), (1, '#b3a58f')])
    col = tint(col, 0.9 + 0.15 * norm01(grains(h, w, seed + 2)))
    sand = ramp(norm01(noise(h, w, seed + 3, 0.5, fmin=200)), [(0, '#6c6250'), (1, '#a8977a')])
    col = mix(sand, col, top)
    return col, ht, 0.85


@material('paves_pierre', 800)
def paves_pierre(seed):
    h, w = dims(1)
    xs, ys = grid(h, w)
    f1, f2, ids, _, _ = voronoi(h, w, 8, 8, seed, 0.35)
    top, dome, e = stones(f1, f2, ids, seed, 8, 10)
    ht = dome * 6 + grains(h, w, seed + 1) * 0.2 - (1 - top) * 3
    t = per_id(ids, seed + 2)
    col = ramp(t, [(0, '#5d5b58'), (0.5, '#7b7873'), (0.8, '#938c82'), (1, '#6c665e')])
    col = tint(col, 0.8 + 0.3 * norm01(grains(h, w, seed + 3)))
    worn = sstep(0.6, 1, dome)
    col = tint(col, 1 + 0.12 * worn)
    joint = ramp(norm01(noise(h, w, seed + 4, 1.5)), [(0, '#2e2a24'), (1, '#4c4436')])
    col = mix(joint, col, top)
    return col, ht, 0.8 - 0.25 * worn


@material('dalles_jardin', 1000)
def dalles_jardin(seed):
    h, w = dims(1)
    R = running_bond(h, w, 2, 2, 0)
    top, ht = joints(R, 10, 3, 4)
    f1, f2, ids, _, _ = voronoi(h, w, 110, 110, seed, 1.0)
    peb = sstep(0.3, 1.6, (f2 - f1) / 2)
    ht = ht + peb * 0.6 * top
    pc = ramp(per_id(ids, seed + 1), [(0, '#7a6f62'), (0.4, '#a89a86'), (0.7, '#c9bba3'), (1, '#5e5852')])
    cem = plain(h, w, '#8a857c')
    col = mix(cem, pc, peb)
    col = tint(col, 0.9 + 0.2 * per_id(R.id, seed + 2))
    grass = ramp(norm01(noise(h, w, seed + 3, 0.6, fmin=200)), [(0, '#304b1b'), (1, '#5b7d2f')])
    col = mix(grass, col, top)
    return col, ht, 0.85


# ================================================================ 2. Béton et ciment

@material('ciment_lisse', 1000)
def ciment_lisse(seed):
    h, w = dims(1)
    xs, ys = grid(h, w)
    swirl = np.sin((xs + noise(h, w, seed, 3.0) * 120) * 2 * np.pi / 128) * np.sin((ys + noise(h, w, seed + 1, 3.0) * 120) * 2 * np.pi / 128)
    mott = norm01(noise(h, w, seed + 2, 2.8))
    col = ramp(mott, [(0, '#88867f'), (0.5, '#94928d'), (1, '#a09d97')])
    col = tint(col, 1 + 0.04 * swirl + 0.03 * noise(h, w, seed + 3, 1.0, fmin=200))
    ht = swirl * 0.03 + pores(h, w, seed + 4, 40, 0.5, 2, 0.15)
    return col, ht, 0.55 + 0.1 * mott


@material('beton_brut', 1000)
def beton_brut(seed):
    h, w = dims(1)
    mott = norm01(noise(h, w, seed, 2.6))
    col = ramp(mott, [(0, '#7c7a75'), (0.5, '#8b8984'), (1, '#98958f')])
    g = grains(h, w, seed + 1)
    col = tint(col, 1 + 0.05 * g)
    p = pores(h, w, seed + 2, 22, 0.6, 4, 1.2)
    col = tint(col, 1 + 0.35 * np.clip(p, -1, 0))
    ht = g * 0.08 + p + noise(h, w, seed + 3, 2.5) * 0.3
    return col, ht, 0.9


@material('beton_banche', 1200)
def beton_banche(seed):
    h, w = dims(1)
    xs, ys = grid(h, w)
    R = planks(h, w, 8, seed, w * 0.45, w * 1.0)
    px = 1200 / w
    col_e, col_l = hexc('#8d8a84'), hexc('#7a7771')
    c, hw, late = wood(R.lx, R.ly, seed + 1, 7, px, col_e, col_l, figure=1.2, plank_ids=R.id)
    tone = 0.92 + 0.12 * per_id(R.id, seed + 2)
    mott = norm01(noise(h, w, seed + 3, 2.6))
    col = tint(ramp(mott, [(0, '#7c7a75'), (1, '#a19e98')]), tone * (1 - 0.06 * late))
    ridge = 1 - sstep(0, 2.5, R.edge)
    ht = hw * 6 + ridge * 0.4 + noise(h, w, seed + 4, 2.4) * 0.15 + pores(h, w, seed + 5, 30, 0.5, 2.5, 0.8)
    # trous de banche (cônes) tous les 60 cm
    for cx_ in (0.25, 0.75):
        for cy_ in (0.25, 0.75):
            d = np.hypot(((xs - cx_ * w + w / 2) % w) - w / 2, ((ys - cy_ * h + h / 2) % h) - h / 2) * px
            cone = sstep(0, 1, 1 - d / 14)
            ht = ht - cone * 8
            col = tint(col, 1 - 0.45 * cone)
    return col, ht, 0.85


@material('parpaing', 1020, 420 / 1020)
def parpaing(seed):
    h, w = dims(420 / 1020)
    R = running_bond(h, w, 2, 2, 0.5)
    px = 1020 / w
    top, ht = joints(R, 10 / px, 1.5, 6)
    g = noise(h, w, seed, 0.6, fmin=220)
    p = pores(h, w, seed + 1, 10, 0.5, 2.5, 1.5)
    ht = ht + (g * 0.25 + p) * top
    t = per_id(R.id, seed + 2)
    col = ramp(norm01(g + noise(h, w, seed + 3, 2.4) * 0.7), [(0, '#7a7874'), (0.6, '#96938d'), (1, '#aaa69f')])
    col = tint(col, (0.92 + 0.1 * t) * (1 + 0.5 * np.clip(p / 1.5, -1, 0)))
    mortar = ramp(norm01(noise(h, w, seed + 4, 1.0, fmin=150)), [(0, '#8c877d'), (1, '#a8a294')])
    col = mix(mortar, col, top)
    return col, ht, 0.92


@material('chape', 1000)
def chape(seed):
    h, w = dims(1)
    xs, ys = grid(h, w)
    arcs = np.sin(np.hypot(((xs + 300) % w) - w / 2, ((ys + 200) % h) - h / 2) * 2 * np.pi / 60 + noise(h, w, seed, 3, ) * 3)
    mott = norm01(noise(h, w, seed + 1, 2.6))
    col = ramp(mott, [(0, '#8a857d'), (1, '#aaa49a')])
    col = tint(col, 1 + 0.025 * arcs + 0.04 * noise(h, w, seed + 2, 0.8, fmin=250))
    ht = arcs * 0.04 + noise(h, w, seed + 3, 0.8, fmin=250) * 0.04
    return col, ht, 0.8


# ================================================================ 3. Plâtre et enduits

@material('platre_lisse', 1000)
def platre_lisse(seed):
    h, w = dims(1)
    mott = norm01(noise(h, w, seed, 2.8))
    col = ramp(mott, [(0, '#e3dfd6'), (1, '#f1eee7')])
    col = tint(col, 1 + 0.012 * noise(h, w, seed + 1, 1.0, fmin=200))
    ht = noise(h, w, seed + 2, 2.8) * 0.05 + noise(h, w, seed + 3, 1.0, fmin=200) * 0.01
    return col, ht, 0.75


@material('carreaux_platre', 1332, 1000 / 1332)
def carreaux_platre(seed):
    h, w = dims(1000 / 1332)
    R = running_bond(h, w, 2, 2, 0.5)
    px = 1332 / w
    top, ht = joints(R, 2.5 / px, 1.2, 0.6)
    mott = norm01(noise(h, w, seed, 2.6))
    col = ramp(mott, [(0, '#dcd8ce'), (1, '#ebe7de')])
    col = tint(col, (0.98 + 0.03 * per_id(R.id, seed + 1)) * (1 + 0.015 * noise(h, w, seed + 2, 1.0, fmin=180)))
    col = mix(plain(h, w, '#cfcac0'), col, top)
    ht = ht + noise(h, w, seed + 3, 2.8) * 0.04 + pores(h, w, seed + 4, 60, 0.5, 1.5, 0.15)
    return col, ht, 0.72


@material('plaque_platre', 1200)
def plaque_platre(seed):
    h, w = dims(1)
    xs, ys = grid(h, w)
    px = 1200 / w
    dxj = np.minimum(xs, w - xs) * px  # distance au joint (bord de l'image), mm
    band = 1 - sstep(25, 60, dxj)
    paper = ramp(norm01(noise(h, w, seed, 2.6)), [(0, '#d9d6cf'), (1, '#e6e3dc')])
    enduit = plain(h, w, '#eeebe5')
    col = mix(paper, enduit, band * 0.9)
    col = tint(col, 1 + 0.01 * noise(h, w, seed + 1, 1.0, fmin=200))
    ht = band * 0.25 + noise(h, w, seed + 2, 1.2, fmin=150) * 0.006
    # vis tous les 30 cm sur les montants (bords et milieu de plaque)
    for vx in (0.0, 0.5):
        for k in range(4):
            d = np.hypot(((xs - vx * w + w / 2) % w) - w / 2, ((ys - (k + 0.5) * h / 4 + h / 2) % h) - h / 2) * px
            spot = sstep(0, 1, 1 - d / 9)
            col = mix(col, plain(h, w, '#f3f1ec'), spot * 0.8)
            ht = ht + spot * 0.05
    return col, ht, 0.8 - 0.1 * band


@material('crepi', 500)
def crepi(seed):
    h, w = dims(1)
    a = noise(h, w, seed, 1.6, fmin=40)
    blobs = sstep(0.2, 1.4, a)
    ht = blobs * 1.6 + noise(h, w, seed + 1, 0.8, fmin=250) * 0.08
    col = ramp(norm01(noise(h, w, seed + 2, 2.8)), [(0, '#e6ddca'), (1, '#f1eadb')])
    return col, ht, 0.95


@material('enduit_chaux', 1000)
def enduit_chaux(seed):
    h, w = dims(1)
    m = noise(h, w, seed, 2.4)
    m2 = noise(h, w, seed + 1, 1.8, fmin=12, aniso=(1, 0.5), angle=0.6)
    t = norm01(m + 0.5 * m2)
    col = ramp(t, [(0, '#c9b593'), (0.5, '#dccaa8'), (1, '#ead9bb')])
    col = tint(col, 1 + 0.03 * noise(h, w, seed + 2, 0.8, fmin=200))
    ht = m2 * 0.25 + noise(h, w, seed + 3, 1.0, fmin=150) * 0.04
    return col, ht, 0.85


# ================================================================ 4. Pierre

def crinoids(h, w, seed, n, rmin, rmax):
    """Débris de fossiles (entroques) : petits anneaux et taches claires de la pierre bleue."""
    r = rng(seed)
    img = Image.new('L', (w, h), 0)
    d = ImageDraw.Draw(img)
    for _ in range(n):
        x, y = r.uniform(0, w), r.uniform(0, h)
        rr = r.uniform(rmin, rmax)
        e = r.uniform(0.4, 1.0)
        kind = r.random()
        g = int(r.uniform(90, 255))
        bb = (x - rr, y - rr, x + rr, y + rr)

        def dr(dx, dy, x=x, y=y, rr=rr, e=e, kind=kind, g=g):
            box = [x - rr + dx, y - rr * e + dy, x + rr + dx, y + rr * e + dy]
            if kind < 0.45:
                d.ellipse(box, outline=g, width=max(1, int(rr / 3)))
            else:
                d.ellipse(box, fill=g)
        draw_wrapped(dr, w, h, bb)
    return blur(np.asarray(img, F) / 255, 0.6)


def veins(h, w, seed, fmax, width, warp=1.0, aniso=(1.0, 1.0), angle=0.0):
    """Veines (marbre, calcite) : lignes de passage à zéro d'un bruit doux déformé (étiré)."""
    n = (noise(h, w, seed, 3.2, fmax=fmax, aniso=aniso, angle=angle)
         + warp * 0.3 * noise(h, w, seed + 1, 2.0, fmin=fmax, fmax=fmax * 4))
    return np.exp(-((n / width) ** 2)).astype(F)


@material('pierre_bleue_adoucie', 600)
def pierre_bleue_adoucie(seed):
    h, w = dims(1)
    mott = norm01(noise(h, w, seed, 2.4))
    col = ramp(mott, [(0, '#3f444b'), (0.5, '#484e56'), (1, '#525860')])
    fine = noise(h, w, seed + 1, 1.0, fmin=200)
    col = tint(col, 1 + 0.05 * fine)
    fos = crinoids(h, w, seed + 2, 2600, 1.2, 6)
    col = mix(col, plain(h, w, '#8d939b'), fos * 0.55)
    v = veins(h, w, seed + 3, 6, 0.025, 1.4, (1, 0.35), 0.5)
    col = mix(col, plain(h, w, '#c9ccd0'), v * 0.6)
    ht = fine * 0.005 + fos * 0.01
    return col, ht, 0.5 - 0.1 * fos


@material('pierre_bleue_bouchardee', 400)
def pierre_bleue_bouchardee(seed):
    h, w = dims(1)
    f1, f2, ids, _, _ = voronoi(h, w, 150, 150, seed, 1.0)
    pit = sstep(0, 1, 1 - f1 / (2 + 2.5 * per_id(ids, seed + 1)))
    ht = -pit * 0.5 + noise(h, w, seed + 2, 0.8, fmin=250) * 0.12 + noise(h, w, seed + 3, 2.4) * 0.2
    mott = norm01(noise(h, w, seed + 4, 2.4))
    col = ramp(mott, [(0, '#767c83'), (0.5, '#7e848b'), (1, '#868c93')])
    col = tint(col, 1 + 0.18 * noise(h, w, seed + 5, 0.8, fmin=250) - 0.4 * pit)
    fos = crinoids(h, w, seed + 6, 900, 0.8, 3.5)
    col = mix(col, plain(h, w, '#a9aeb3'), fos * 0.4)
    return col, ht, 0.9


@material('pierre_calcaire', 1200, 0.5)
def pierre_calcaire(seed):
    h, w = dims(0.5)
    R = running_bond(h, w, 2, 2, 0.5)
    px = 1200 / w
    wob = noise(h, w, seed, 1.5, fmin=60) * 1.2
    top, ht = joints(R, 8 / px, 3, 5, wob)
    g = grains(h, w, seed + 1)
    ht = ht + g * 0.25 * top + noise(h, w, seed + 2, 2.4) * 0.4
    t = per_id(R.id, seed + 3)
    col = ramp(norm01(noise(h, w, seed + 4, 2.4) + t * 1.5), [(0, '#b9a98a'), (0.5, '#cdbf9f'), (1, '#ddd2b6')])
    col = tint(col, 1 + 0.05 * g)
    fos = crinoids(h, w, seed + 5, 500, 0.8, 3)
    col = mix(col, plain(h, w, '#e8e0cc'), fos * 0.4)
    mortar = ramp(norm01(noise(h, w, seed + 6, 1.0, fmin=150)), [(0, '#bdb4a2'), (1, '#d3cbba')])
    col = mix(mortar, col, top)
    return col, ht, 0.88


@material('moellons', 1000)
def moellons(seed):
    h, w = dims(1)
    f1, f2, ids, _, _ = voronoi(h, w, 7, 9, seed, 0.95)
    px = 1000 / w
    wob = noise(h, w, seed + 1, 1.6, fmin=40) * 3
    e = (f2 - f1) / 2 - 14 / px / 2 + wob
    top = sstep(0, 10, e)
    dome = np.sqrt(np.clip(e / 60, 0, 1))
    g = grains(h, w, seed + 2)
    ht = dome * 18 + g * 0.6 * top - (1 - top) * 6 + noise(h, w, seed + 3, 2.0, fmin=15) * 1.5 * top
    t = per_id(ids, seed + 4)
    col = ramp(t, [(0, '#6e655a'), (0.25, '#8f8270'), (0.5, '#a89a83'), (0.7, '#7f7a72'), (0.85, '#b5a68c'), (1, '#5f5a53')])
    col = tint(col, 0.85 + 0.25 * norm01(g + noise(h, w, seed + 5, 2.0, fmin=15)))
    mortar = ramp(norm01(noise(h, w, seed + 6, 1.0, fmin=150)), [(0, '#9b9282'), (1, '#beb4a0')])
    col = mix(mortar, col, top)
    return col, ht, 0.9


@material('marbre_blanc', 1000)
def marbre_blanc(seed):
    h, w = dims(1)
    base = ramp(norm01(noise(h, w, seed, 2.8)), [(0, '#ebe9e4'), (1, '#f6f4f0')])
    v1 = veins(h, w, seed + 1, 6, 0.05, 1.6, (1, 0.3), 0.7)
    v1b = veins(h, w, seed + 1, 6, 0.22, 1.6, (1, 0.3), 0.7)
    v2 = veins(h, w, seed + 2, 10, 0.025, 1.2, (1, 0.4), 0.9)
    cloud = sstep(0.5, 1, norm01(noise(h, w, seed + 3, 3.0))) * 0.08
    col = mix(base, plain(h, w, '#7d8085'), np.clip(v1 * 0.75 + v1b * 0.18 + v2 * 0.35 + cloud, 0, 1))
    return col, v1 * 0.002, 0.12


@material('granit', 500)
def granit(seed):
    h, w = dims(1)
    f1, f2, ids, _, _ = voronoi(h, w, 180, 180, seed, 1.0)
    t = per_id(ids, seed + 1)
    blk = t < 0.22
    wht = t > 0.78
    pink = (t > 0.6) & (t <= 0.78)
    base = ramp(norm01(noise(h, w, seed + 2, 1.0, fmin=150)), [(0, '#8e8a87'), (1, '#aaa6a2')])
    col = np.where(blk[..., None], plain(h, w, '#1f1f22'), base)
    col = np.where(wht[..., None], plain(h, w, '#dad7d2'), col)
    col = np.where(pink[..., None], plain(h, w, '#b39a90'), col)
    col = tint(col, 0.9 + 0.2 * per_id(ids, seed + 3))
    col = blur(col, 0.4)
    return col, noise(h, w, seed + 4, 1.0, fmin=200) * 0.002, 0.22


@material('ardoise', 600)
def ardoise(seed):
    h, w = dims(1)
    layers = noise(h, w, seed, 2.2, aniso=(1, 0.15), angle=0.2)
    steps = np.floor(norm01(layers) * 6) / 6
    ht = steps * 1.5 + noise(h, w, seed + 1, 1.2, fmin=100) * 0.08
    col = ramp(norm01(noise(h, w, seed + 2, 1.6, fmin=20) * 0.5 + steps), [(0, '#2f3338'), (0.5, '#3a3f45'), (1, '#474c53')])
    col = tint(col, 1 + 0.06 * noise(h, w, seed + 3, 1.0, fmin=150))
    rust = sstep(0.8, 1, norm01(noise(h, w, seed + 4, 3.0))) * 0.15
    col = mix(col, plain(h, w, '#6b5a45'), rust)
    return col, ht, 0.65


# ================================================================ 5. Briques

def bricks(seed, pal, mortar_pal, chip=1.0, paint=False):
    h, w = dims(600 / 900)
    R = running_bond(h, w, 4, 8, 0.5)
    px = 900 / w
    wob = noise(h, w, seed, 1.4, fmin=60) * 1.0 * chip
    top, ht = joints(R, 10 / px, 2, 6, wob)
    g = grains(h, w, seed + 1, 1.5)
    ht = ht + g * 0.25 * top + noise(h, w, seed + 2, 2.4) * 0.3
    t = per_id(R.id, seed + 3)
    col = ramp(t, pal)
    burn = sstep(0.6, 1, norm01(noise(h, w, seed + 4, 2.4))) * (per_id(R.id, seed + 5) > 0.6)
    col = tint(col, (1 - 0.35 * burn) * (0.9 + 0.18 * norm01(g)))
    mortar = ramp(norm01(noise(h, w, seed + 6, 1.0, fmin=150)), mortar_pal)
    col = mix(mortar, col, top)
    if paint:
        col = mix(col, plain(h, w, '#eeece6'), 0.9)
        col = tint(col, 0.97 + 0.05 * norm01(noise(h, w, seed + 7, 2.0)))
    return col, ht, 0.9 if not paint else 0.7


@material('brique_rouge', 900, 600 / 900)
def brique_rouge(seed):
    return bricks(seed, [(0, '#7d3424'), (0.3, '#934029'), (0.6, '#a24c31'), (0.85, '#b25c3c'), (1, '#6b2d20')],
                  [(0, '#a49d90'), (1, '#beb7a9')])


@material('brique_claire', 900, 600 / 900)
def brique_claire(seed):
    return bricks(seed, [(0, '#b09265'), (0.4, '#c6a978'), (0.7, '#d4bb8c'), (1, '#a07f58')],
                  [(0, '#b4ad9f'), (1, '#cbc4b5')])


@material('brique_blanche', 900, 600 / 900)
def brique_blanche(seed):
    return bricks(seed, [(0, '#8a3a28'), (1, '#a24c31')], [(0, '#a49d90'), (1, '#beb7a9')], paint=True)


# ================================================================ 6. Carrelage

def tiles(seed, nx, ny, size, joint, bevel, pal, grout, rough_tile, rough_grout, offset=0.0, aspect=1.0, depth=1.5):
    h, w = dims(aspect)
    R = running_bond(h, w, nx, ny, offset)
    px = size / w
    top, ht = joints(R, joint / px, bevel / px, depth)
    t = per_id(R.id, seed)
    col = ramp(t, pal)
    col = tint(col, 1 + 0.008 * noise(h, w, seed + 1, 2.4))
    gcol = ramp(norm01(noise(h, w, seed + 2, 1.0, fmin=150)), grout)
    col = mix(gcol, col, top)
    wave = noise(h, w, seed + 3, 3.0) * 0.004
    ht = ht + wave * top
    return R, col, ht, rough_grout + (rough_tile - rough_grout) * top


@material('carrelage_blanc', 800)
def carrelage_blanc(seed):
    _, col, ht, r = tiles(seed, 4, 4, 800, 2, 1.2, [(0, '#ecebe7'), (1, '#f6f5f1')], [(0, '#b9b6af'), (1, '#cdcac3')], 0.1, 0.85)
    return col, ht, r


@material('carrelage_gris', 1200)
def carrelage_gris(seed):
    h, w = dims(1)
    R, col, ht, r = tiles(seed, 2, 2, 1200, 3, 1.0, [(0, '#76767a'), (1, '#86868a')], [(0, '#5f5e5c'), (1, '#6e6d6a')], 0.35, 0.85)
    stone = norm01(noise(h, w, seed + 5, 2.4) + noise(h, w, seed + 6, 1.0, fmin=150) * 0.5)
    col = tint(col, 0.92 + 0.14 * stone)
    return col, ht, r


@material('faience_metro', 600, 0.5)
def faience_metro(seed):
    R, col, ht, r = tiles(seed, 4, 4, 600, 2, 4, [(0, '#f1f1ee'), (1, '#fbfbf8')], [(0, '#d2d0ca'), (1, '#e0ded8')], 0.06, 0.8, offset=0.5, aspect=0.5, depth=2.5)
    return col, ht, r


@material('carreaux_ciment', 800)
def carreaux_ciment(seed):
    h, w = dims(1)
    R, col, ht, r = tiles(seed, 4, 4, 800, 1, 0.5, [(0, '#e7e0d0'), (1, '#ede6d6')], [(0, '#cfc7b6'), (1, '#d8d0c0')], 0.5, 0.7, depth=0.6)
    cw = w / 4
    u = (R.lx / cw) * 2 - 1
    v = (R.ly / cw) * 2 - 1
    au, av = np.abs(u), np.abs(v)
    rr = np.hypot(u, v)
    navy, terra, sage = plain(h, w, '#24364d'), plain(h, w, '#b0573a'), plain(h, w, '#7f8f78')
    # motif : losange central, rosace, coins en quarts de cercle, filet de bord
    diamond = (au + av) < 0.55
    petals = (np.abs(rr - 0.62) < 0.1) | ((np.minimum(au, av) < 0.06) & (rr < 0.95) & (rr > 0.3))
    corner = np.hypot(1 - au, 1 - av) < 0.42
    ring = (np.hypot(1 - au, 1 - av) < 0.55) & ~corner
    border = (np.maximum(au, av) > 0.9) & (np.maximum(au, av) < 0.95)
    col = np.where(diamond[..., None], terra, col)
    col = np.where((rr < 0.22)[..., None], plain(h, w, '#e7e0d0'), col)
    col = np.where(petals[..., None], navy, col)
    col = np.where(corner[..., None], navy, col)
    col = np.where(ring[..., None], sage, col)
    col = np.where(border[..., None], navy, col)
    col = tint(col, 0.94 + 0.1 * norm01(noise(h, w, seed + 7, 2.2)))
    col = blur(col, 0.5)
    return col, ht, r


@material('mosaique', 300)
def mosaique(seed):
    _, col, ht, r = tiles(seed, 12, 12, 300, 2, 0.8, [(0, '#1f6f86'), (0.3, '#2b8aa0'), (0.6, '#3ca3b5'), (0.8, '#7cc4cf'), (1, '#174f63')],
                          [(0, '#c9c6bf'), (1, '#dad7d0')], 0.08, 0.8, depth=1.2)
    return col, ht, r


@material('tomettes', 640, 0.8660)
def tomettes(seed):
    h, w = dims(0.8660)
    xs, ys = grid(h, w)
    # centres d'un réseau hexagonal raccordable : 4 colonnes × 4 rangées décalées
    cols_, rows_ = 4, 4
    sx, sy = w / cols_, h / rows_
    best = np.full((h, w), np.inf, F)
    sec = np.full((h, w), np.inf, F)
    ids = np.zeros((h, w), np.int32)
    for j in range(rows_):
        for i in range(cols_):
            cx_ = (i + 0.5 * (j % 2)) * sx
            cy_ = j * sy
            d = np.hypot(((xs - cx_ + w / 2) % w) - w / 2, ((ys - cy_ + h / 2) % h) - h / 2)
            closer = d < best
            sec = np.where(closer, best, np.minimum(sec, d))
            best = np.where(closer, d, best)
            ids = np.where(closer, j * cols_ + i, ids)
    px = 640 / w
    e = (sec - best) / 2 - 4 / px / 2 + noise(h, w, seed, 1.4, fmin=60) * 0.8
    top = sstep(0, 3, e)
    t = per_id(ids, seed + 1)
    col = ramp(t, [(0, '#8e3b22'), (0.3, '#a6492a'), (0.6, '#b85a34'), (0.85, '#c56b3f'), (1, '#7a321d')])
    worn = norm01(noise(h, w, seed + 2, 2.4))
    col = tint(col, 0.85 + 0.25 * worn)
    col = mix(plain(h, w, '#8f857a'), col, top)
    ht = (top - 1) * 2 + noise(h, w, seed + 3, 2.4) * 0.15 * top
    return col, ht, 0.55 + 0.25 * (1 - worn)


# ================================================================ 7. Bois

def wood_panel(seed, early, late, ring, figure, px):
    h, w = dims(1)
    xs, ys = grid(h, w)
    c, hw, l = wood(xs, ys, seed, ring, px, hexc(early), hexc(late), figure)
    return c, hw * 4, 0.6 - 0.1 * l


@material('chene', 600)
def chene(seed):
    c, h, r = wood_panel(seed, '#bf9563', '#86592f', 9.0, 1.0, 600 / W)
    hh, ww = c.shape[:2]
    rays = sstep(1.8, 3.2, noise(hh, ww, seed + 9, 1.2, fmin=60, aniso=(0.3, 1.0)))
    c = mix(c, plain(hh, ww, '#c9a272'), rays * 0.35)
    return c, h, r


@material('pin', 600)
def pin(seed):
    h, w = dims(1)
    xs, ys = grid(h, w)
    px = 600 / w
    c, hw, l = wood(xs, ys, seed, 12.0, px, hexc('#e6c48e'), hexc('#b9803f'), 1.4)
    # nœuds
    r = rng(seed + 5)
    for _ in range(3):
        kx, ky = r.uniform(0, w), r.uniform(0, h)
        d = np.hypot((((xs - kx) + w / 2) % w - w / 2) * 0.6, ((ys - ky) + h / 2) % h - h / 2) * px
        knot = sstep(0, 1, 1 - d / r.uniform(8, 16))
        halo = sstep(0, 1, 1 - d / 45) * (1 - knot)
        c = mix(c, plain(h, w, '#6b4421'), knot * 0.9)
        c = tint(c, 1 - 0.2 * halo * (0.5 + 0.5 * np.sin(d * 1.6)))
        hw = hw - knot * 0.05
    return c, hw * 4, 0.6 - 0.1 * l


@material('noyer', 600)
def noyer(seed):
    return wood_panel(seed, '#7a5236', '#3e2918', 8.0, 1.3, 600 / W)


@material('parquet_lames', 1120)
def parquet_lames(seed):
    h, w = dims(1)
    R = planks(h, w, 8, seed, w * 0.35, w * 0.9)
    px = 1120 / w
    c, hw, l = wood(R.lx, R.ly, seed + 1, 7.0, px, hexc('#cda273'), hexc('#93683b'), 1.0, plank_ids=R.id)
    top, ht = joints(R, 0.8 / px, 1.0, 0.8)
    c = mix(plain(h, w, '#4a3523'), c, sstep(0, 1, top))
    return c, ht + hw * 3, 0.35 + 0.4 * (1 - top)


@material('parquet_chevrons', 840)
def parquet_chevrons(seed):
    h, w = dims(1)
    R = herringbone(h, w, w / 12, 6)
    px = 840 / w
    c, hw, l = wood(R.lx, R.ly, seed + 1, 6.0, px, hexc('#cfa470'), hexc('#946a3c'), 1.0, plank_ids=R.id)
    top, ht = joints(R, 0.8 / px, 0.8, 0.8)
    c = mix(plain(h, w, '#4a3523'), c, top)
    return c, ht + hw * 3, 0.35 + 0.4 * (1 - top)


@material('terrasse', 900)
def terrasse(seed):
    h, w = dims(1)
    R = planks(h, w, 6, seed, w * 1.0, w * 1.0)
    px = 900 / w
    c, hw, l = wood(R.lx, R.ly, seed + 1, 7.0, px, hexc('#95623f'), hexc('#5a3620'), 1.1, plank_ids=R.id)
    top, ht = joints(R, 6 / px, 2.5 / px, 12)
    grooves = np.sin(R.ly * px * 2 * np.pi / 6) * 0.25
    weather = norm01(noise(h, w, seed + 2, 2.6))
    c = mix(c, tint(c, 1.0) * 0 + hexc('#8d867c'), weather * 0.25)
    c = mix(plain(h, w, '#141210'), c, top)
    return c, ht + grooves * top + hw * 3, 0.7


@material('contreplaque', 1000)
def contreplaque(seed):
    h, w = dims(1)
    xs, ys = grid(h, w)
    c, hw, l = wood(xs, ys, seed, 28.0, 1000 / w, hexc('#e6cda2'), hexc('#c49f69'), 2.5)
    c = tint(c, 1 + 0.03 * noise(h, w, seed + 3, 2.0))
    return c, hw * 2, 0.6


@material('osb', 1000)
def osb(seed):
    h, w = dims(1)
    r = rng(seed)
    img = Image.new('RGB', (w, h), (150, 110, 60))
    hh = Image.new('L', (w, h), 0)
    dc, dh = ImageDraw.Draw(img), ImageDraw.Draw(hh)
    pal = [hexc(c) for c in ('#c9a066', '#b88d52', '#d8b77d', '#a77c45', '#e0c48e', '#9c7240')]
    n = 9000
    for k in range(n):
        x, y = r.uniform(0, w), r.uniform(0, h)
        a = r.uniform(-0.5, 0.5) + (0 if r.random() < 0.6 else np.pi / 2)
        L, Wd = r.uniform(40, 110), r.uniform(10, 28)
        ca, sa = np.cos(a), np.sin(a)
        pts = [(x + ca * L / 2 * sx - sa * Wd / 2 * sy, y + sa * L / 2 * sx + ca * Wd / 2 * sy) for sx, sy in ((1, 1), (1, -1), (-1, -1), (-1, 1))]
        c = pal[r.integers(len(pal))] * r.uniform(0.85, 1.1)
        col = tuple(int(np.clip(v, 0, 1) * 255) for v in c)
        g = int(255 * k / n)
        xs_ = [p[0] for p in pts]
        ys_ = [p[1] for p in pts]

        def dr(dx, dy, pts=pts, col=col, g=g):
            q = [(p[0] + dx, p[1] + dy) for p in pts]
            dc.polygon(q, fill=col)
            dh.polygon(q, fill=g)
        draw_wrapped(dr, w, h, (min(xs_), min(ys_), max(xs_), max(ys_)))
    col = np.asarray(img, F) / 255
    ht = np.asarray(hh, F) / 255
    edges = np.abs(ht - blur(ht, 1.5))
    col = tint(col, 1 - 1.2 * np.clip(edges, 0, 0.3))
    fib = noise(h, w, seed + 1, 1.0, fmin=150)
    col = tint(col, 1 + 0.06 * fib)
    return col, ht * 0.6 + fib * 0.02, 0.75


# ================================================================ 8. Toiture et bardage

@material('tuiles', 1000)
def tuiles(seed):
    h, w = dims(1)
    xs, ys = grid(h, w)
    ncol, nrow = 5, 3
    cw, rh = w / ncol, h / nrow
    row = np.floor(ys / rh).astype(int)
    colx = np.floor(xs / cw).astype(int)
    ids = (row % nrow) * ncol + (colx % ncol)
    u = (xs % cw) / cw
    v = (ys % rh) / rh  # 0 = haut de la rangée (sous la tuile du dessus), 1 = bord bas
    prof = np.sin(u * np.pi) ** 0.8
    ht = prof * 30 + v * 15
    lip = sstep(0.93, 1.0, v)
    ht = ht * (1 - lip) + lip * (prof * 30 - 10)
    t = per_id(ids, seed)
    col = ramp(t, [(0, '#8c3a23'), (0.35, '#a5472a'), (0.7, '#b65a35'), (1, '#7a3a28')])
    moss = sstep(0.75, 1, norm01(noise(h, w, seed + 1, 2.6))) * (1 - prof) * 0.6
    col = mix(col, plain(h, w, '#4d4a2a'), moss)
    col = tint(col, (0.85 + 0.25 * norm01(grains(h, w, seed + 2))) * (0.55 + 0.45 * prof) * (1 - 0.5 * sstep(0, 0.12, 0.12 - v)))
    return col, ht + grains(h, w, seed + 3) * 0.2, 0.8


@material('ardoises_toit', 1200)
def ardoises_toit(seed):
    h, w = dims(1)
    R = running_bond(h, w, 4, 6, 0.5)
    px = 1200 / w
    top, ht = joints(R, 3 / px, 1, 2)
    rowv = R.ly / (h / 6)
    ht = ht + rowv * 6
    lay = noise(h, w, seed, 2.2, aniso=(1, 0.2)) * 0.3
    t = per_id(R.id, seed + 1)
    col = ramp(norm01(t + noise(h, w, seed + 2, 2.4) * 0.3), [(0, '#2a2e33'), (0.5, '#353a40'), (1, '#454b52')])
    col = tint(col, (1 + 0.08 * lay) * (0.6 + 0.4 * sstep(0, 0.25, rowv)))
    col = mix(plain(h, w, '#0e0f11'), col, top)
    return col, ht + lay, 0.6


@material('zinc', 1000)
def zinc(seed):
    h, w = dims(1)
    xs, ys = grid(h, w)
    px = 1000 / w
    d = np.abs(((xs + w / 4) % (w / 2)) - w / 4) * px  # distance à la tasseau (mm)
    seam = sstep(0, 1, 1 - d / 12)
    ht = seam * 25 + noise(h, w, seed, 3.0, aniso=(0.3, 1)) * 0.3
    pat = norm01(noise(h, w, seed + 1, 2.4, aniso=(1, 0.3)))
    col = ramp(pat, [(0, '#6f777e'), (0.5, '#80888f'), (1, '#919aa1')])
    streak = noise(h, w, seed + 2, 1.5, fmin=40, aniso=(1, 0.05))
    col = tint(col, 1 + 0.05 * streak)
    return col, ht, 0.5 + 0.1 * pat


@material('bardage_bois', 1040)
def bardage_bois(seed):
    h, w = dims(1)
    Rv = planks(w, h, 8, seed, h * 1.0, h * 1.0)  # lames horizontales puis rotation d'un quart
    px = 1040 / w
    c, hw, l = wood(Rv.lx, Rv.ly, seed + 1, 9.0, px, hexc('#a68f76'), hexc('#6f5c49'), 1.2, plank_ids=Rv.id)
    weather = norm01(noise(w, h, seed + 2, 2.6, aniso=(0.2, 1)))
    c = mix(c, plain(w, h, '#9a9590'), weather * 0.55)
    top, ht = joints(Rv, 3 / px, 3 / px, 10)
    shadow = 1 - 0.5 * sstep(0, 1, 1 - Rv.ly / (6 / px))
    c = tint(mix(plain(w, h, '#1a1714'), c, top), shadow)
    return np.transpose(c, (1, 0, 2)).copy(), (ht + hw * 3).T.copy(), 0.8


@material('tole_ondulee', 760)
def tole_ondulee(seed):
    h, w = dims(1)
    xs, ys = grid(h, w)
    prof = np.sin(xs / w * 10 * 2 * np.pi)
    ht = prof * 9
    streak = noise(h, w, seed, 1.5, fmin=40, aniso=(1, 0.04))
    col = ramp(norm01(streak + noise(h, w, seed + 1, 2.4) * 0.5), [(0, '#8d9399'), (1, '#a9afb4')])
    return col, ht, 0.4 + 0.1 * norm01(streak)


# ================================================================ 9. Métaux et divers

@material('acier_rouille', 500)
def acier_rouille(seed):
    h, w = dims(1)
    m = norm01(noise(h, w, seed, 2.4) + 0.4 * noise(h, w, seed + 1, 1.5, fmin=40))
    rust = sstep(0.35, 0.65, m)
    steel = ramp(norm01(noise(h, w, seed + 2, 1.5, fmin=60)), [(0, '#4f5357'), (1, '#6a6e72')])
    rc = ramp(norm01(noise(h, w, seed + 3, 1.2, fmin=80) + m), [(0, '#5a2a14'), (0.4, '#7e3c1a'), (0.7, '#9c5424'), (1, '#b8743a')])
    col = mix(steel, rc, rust)
    p = pores(h, w, seed + 4, 14, 0.6, 2.5, 0.4) * rust
    ht = rust * 0.15 + noise(h, w, seed + 5, 0.9, fmin=220) * 0.04 * rust + p
    return col, ht, 0.45 + 0.5 * rust


@material('tole_larmee', 300)
def tole_larmee(seed):
    h, w = dims(1)
    xs, ys = grid(h, w)
    n = 10
    cs = w / n
    i = np.floor(xs / cs)
    j = np.floor(ys / cs)
    u = (xs % cs) / cs - 0.5
    v = (ys % cs) / cs - 0.5
    alt = ((i + j) % 2) == 0
    a = np.where(alt, np.pi / 4, -np.pi / 4)
    ru = u * np.cos(a) + v * np.sin(a)
    rv = -u * np.sin(a) + v * np.cos(a)
    tear = 1 - np.hypot(ru / 0.42, rv / 0.09)
    bump = sstep(0, 0.4, tear)
    ht = bump * 1.5
    col = ramp(norm01(noise(h, w, seed, 1.5, fmin=40, aniso=(1, 0.1))), [(0, '#8e9398'), (1, '#b2b7bb')])
    col = tint(col, 1 + 0.08 * bump)
    return col, ht, 0.35 - 0.1 * bump


@material('galvanise', 500)
def galvanise(seed):
    h, w = dims(1)
    f1, f2, ids, _, _ = voronoi(h, w, 22, 22, seed, 1.0)
    t = per_id(ids, seed + 1)
    col = ramp(t, [(0, '#8b9196'), (0.5, '#a5abb0'), (1, '#c0c5c9')])
    fl = noise(h, w, seed + 2, 1.0, fmin=120, aniso=(1, 0.2))
    col = tint(col, 1 + 0.04 * fl)
    edge = 1 - sstep(0, 1.2, (f2 - f1) / 2)
    col = tint(col, 1 - 0.1 * edge)
    return col, edge * 0.01, 0.25 + 0.2 * t


@material('moquette', 300)
def moquette(seed):
    h, w = dims(1)
    a = noise(h, w, seed, 0.3, fmin=300)
    loops = sstep(-0.5, 1.2, a)
    col = ramp(norm01(noise(h, w, seed + 1, 2.4) * 0.2 + a * 0.8), [(0, '#3d4552'), (0.5, '#505a69'), (1, '#677283')])
    col = tint(col, 0.75 + 0.35 * loops)
    return col, loops * 1.2, 0.98


@material('cuir', 300)
def cuir(seed):
    h, w = dims(1)
    f1, f2, ids, _, _ = voronoi(h, w, 90, 90, seed, 1.0)
    e = (f2 - f1) / 2
    peb = np.sqrt(np.clip(e / 4, 0, 1))
    crease = sstep(0.6, 1.5, np.abs(noise(h, w, seed + 1, 2.0, fmin=10, aniso=(1, 0.3), angle=0.4)))
    ht = peb * 0.15 - (1 - crease) * 0.05
    col = ramp(norm01(noise(h, w, seed + 2, 2.6)), [(0, '#58331d'), (0.5, '#62391f'), (1, '#6e4224')])
    col = tint(col, (0.82 + 0.25 * peb) * (0.85 + 0.15 * crease))
    return col, ht, 0.5 - 0.15 * peb
