"""
Outils de génération de textures procédurales raccordables (le bord droit continue le bord
gauche, le bas continue le haut) : bruits par transformée de Fourier, cellules de Voronoï,
pavages de rectangles (appareils de briques, chevrons, lames de parquet), cartes de relief.

Toutes les images sont calculées : aucune photo ni texture tierce, donc aucune question de
licence. Les hauteurs sont exprimées en millimètres (la carte de relief en dépend).
"""
from __future__ import annotations

import numpy as np

F = np.float32
REF = 1024  # les fréquences des bruits sont comptées en cycles pour 1024 pixels


def rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def noise(h: int, w: int, seed: int, beta: float = 2.0, fmin: float = 0.0, fmax: float | None = None,
          aniso: tuple[float, float] = (1.0, 1.0), angle: float = 0.0) -> np.ndarray:
    """Bruit gaussien raccordable de spectre en 1/f^beta (moyenne 0, écart type 1).

    fmin/fmax : bande de fréquences gardée (cycles pour 1024 px). aniso : échelle selon x et y
    (aniso=(0.1, 1) donne des stries dix fois plus longues selon x que selon y). angle : rotation de l'étirement (radians).
    """
    r = rng(seed)
    wn = r.standard_normal((h, w)).astype(F)
    spec = np.fft.rfft2(wn)
    fy = (np.fft.fftfreq(h) * REF)[:, None]
    fx = (np.fft.rfftfreq(w) * REF)[None, :]
    if angle:
        c, s = np.cos(angle), np.sin(angle)
        fx, fy = fx * c + fy * s, -fx * s + fy * c
    f = np.sqrt((fx / aniso[0]) ** 2 + (fy / aniso[1]) ** 2)
    f[0, 0] = 1e9
    amp = f ** (-beta / 2)
    if fmin:
        amp = amp * (1 / (1 + (fmin / np.maximum(f, 1e-6)) ** 4))
    if fmax:
        amp = amp * np.exp(-((f / fmax) ** 2))
    amp[0, 0] = 0
    out = np.fft.irfft2(spec * amp, s=(h, w)).astype(F)
    sd = out.std()
    return (out - out.mean()) / (sd if sd > 0 else 1)


def blur(a: np.ndarray, sigma_px: float) -> np.ndarray:
    """Flou gaussien raccordable (par FFT)."""
    if sigma_px <= 0:
        return a
    h, w = a.shape[:2]
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    g = np.exp(-2 * (np.pi * sigma_px) ** 2 * (fx ** 2 + fy ** 2))
    if a.ndim == 2:
        return np.fft.irfft2(np.fft.rfft2(a) * g, s=(h, w)).astype(F)
    return np.stack([blur(a[..., i], sigma_px) for i in range(a.shape[2])], -1)


def norm01(a: np.ndarray) -> np.ndarray:
    lo, hi = np.percentile(a, 0.5), np.percentile(a, 99.5)
    return np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1).astype(F)


def sstep(e0: float, e1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return (t * t * (3 - 2 * t)).astype(F)


def hexc(s: str) -> np.ndarray:
    s = s.lstrip('#')
    return np.array([int(s[i:i + 2], 16) / 255 for i in (0, 2, 4)], F)


def ramp(t: np.ndarray, stops: list[tuple[float, str]]) -> np.ndarray:
    """Dégradé de couleurs : t (0–1) → RGB."""
    t = np.clip(t, 0, 1)
    xs = np.array([s[0] for s in stops], F)
    cs = np.stack([hexc(s[1]) for s in stops])
    return np.stack([np.interp(t, xs, cs[:, i]) for i in range(3)], -1).astype(F)


def mix(a: np.ndarray, b: np.ndarray, t: np.ndarray) -> np.ndarray:
    t = np.asarray(t, F)
    if t.ndim == 2 and a.ndim == 3:
        t = t[..., None]
    return (a * (1 - t) + b * t).astype(F)


def tint(c: np.ndarray, k: np.ndarray) -> np.ndarray:
    """Multiplie une couleur par un facteur par pixel."""
    k = np.asarray(k, F)
    return (c * (k[..., None] if k.ndim == 2 else k)).astype(F)


def grid(h: int, w: int) -> tuple[np.ndarray, np.ndarray]:
    ys, xs = np.mgrid[0:h, 0:w].astype(F)
    return xs + 0.5, ys + 0.5


def voronoi(h: int, w: int, cx: int, cy: int, seed: int, jitter: float = 1.0):
    """Cellules de Voronoï raccordables (un germe par case d'une grille cx × cy).

    Renvoie F1 (distance au germe, px), F2 (2e germe), id de cellule, et le vecteur
    pixel → germe (dx, dy).
    """
    r = rng(seed)
    px = r.random((cy, cx)).astype(F)
    py = r.random((cy, cx)).astype(F)
    xs, ys = grid(h, w)
    u = xs * cx / w
    v = ys * cy / h
    iu = np.floor(u).astype(np.int32)
    iv = np.floor(v).astype(np.int32)
    sx, sy = w / cx, h / cy
    f1 = np.full((h, w), np.inf, F)
    f2 = np.full((h, w), np.inf, F)
    ids = np.zeros((h, w), np.int32)
    ddx = np.zeros((h, w), F)
    ddy = np.zeros((h, w), F)
    rad = 2 if jitter > 0.85 else 1
    for dj in range(-rad, rad + 1):
        for di in range(-rad, rad + 1):
            cu = iu + di
            cv = iv + dj
            wu = cu % cx
            wv = cv % cy
            gx = (cu + 0.5 + jitter * (px[wv, wu] - 0.5)) * sx
            gy = (cv + 0.5 + jitter * (py[wv, wu] - 0.5)) * sy
            dx = gx - xs
            dy = gy - ys
            d = np.sqrt(dx * dx + dy * dy)
            closer = d < f1
            f2 = np.where(closer, f1, np.minimum(f2, d))
            f1 = np.where(closer, d, f1)
            ids = np.where(closer, wv * cx + wu, ids)
            ddx = np.where(closer, dx, ddx)
            ddy = np.where(closer, dy, ddy)
    return f1, f2, ids, ddx, ddy


def per_id(ids: np.ndarray, seed: int, n: int | None = None) -> np.ndarray:
    """Valeur aléatoire uniforme (0–1) par identifiant (couleur propre d'une brique…)."""
    n = int(ids.max()) + 1 if n is None else n
    return rng(seed).random(n).astype(F)[ids]


class Rects:
    """Pavage par rectangles alignés (briques, carreaux, lames, chevrons), raccordable.

    Chaque pixel reçoit l'id du rectangle, sa distance au bord du rectangle (px), ses
    coordonnées locales (lx le long de la grande longueur, ly en travers) et l'orientation.
    """

    def __init__(self, h: int, w: int):
        self.h, self.w = h, w
        self.id = np.full((h, w), -1, np.int32)
        self.edge = np.zeros((h, w), F)
        self.lx = np.zeros((h, w), F)
        self.ly = np.zeros((h, w), F)
        self.vert = np.zeros((h, w), bool)
        self.n = 0

    def add(self, x0: float, y0: float, x1: float, y1: float, vertical: bool | None = None) -> int:
        i = self.n
        self.n += 1
        if vertical is None:
            vertical = (y1 - y0) > (x1 - x0)
        xa, xb = int(np.floor(x0)), int(np.ceil(x1))
        ya, yb = int(np.floor(y0)), int(np.ceil(y1))
        xs = np.arange(xa, xb, dtype=F) + 0.5
        ys = np.arange(ya, yb, dtype=F) + 0.5
        X, Y = np.meshgrid(xs, ys)
        inside = (X >= x0) & (X < x1) & (Y >= y0) & (Y < y1)
        if not inside.any():
            return i
        e = np.minimum(np.minimum(X - x0, x1 - X), np.minimum(Y - y0, y1 - Y))
        rows = (np.arange(ya, yb) % self.h)[:, None]
        cols = (np.arange(xa, xb) % self.w)[None, :]
        rr = np.broadcast_to(rows, X.shape)[inside]
        cc = np.broadcast_to(cols, X.shape)[inside]
        self.id[rr, cc] = i
        self.edge[rr, cc] = e[inside]
        if vertical:
            self.lx[rr, cc] = (Y - y0)[inside]
            self.ly[rr, cc] = (X - x0)[inside]
        else:
            self.lx[rr, cc] = (X - x0)[inside]
            self.ly[rr, cc] = (Y - y0)[inside]
        self.vert[rr, cc] = vertical
        return i


def running_bond(h: int, w: int, nx: int, ny: int, offset: float = 0.5) -> Rects:
    """Appareil à joints décalés : ny rangées de nx éléments, décalées de `offset` élément.

    Les éléments coupés par le bord se raccordent de l'autre côté (pixels pris modulo).
    """
    R = Rects(h, w)
    cw, ch = w / nx, h / ny
    for j in range(ny):
        sh = ((j * offset) % 1) * cw
        for i in range(nx):
            x0 = i * cw + sh
            R.add(x0, j * ch, x0 + cw, (j + 1) * ch, vertical=False)
    return R


def herringbone(h: int, w: int, unit: float, k: int) -> Rects:
    """Chevrons à bâtons rompus : éléments unit × k·unit (px), motif de période 2·k·unit.

    L'image doit mesurer un multiple de 2·k·unit pixels de côté.
    """
    R = Rects(h, w)
    W, L = unit, unit * k
    P = 2 * k * W
    # le réseau des chevrons modulo la période P×P compte 2k positions : m·(W, W), m = 0…2k−1
    for m in range(2 * k):
        for oy in np.arange(0, h - 1e-6, P):
            for ox in np.arange(0, w - 1e-6, P):
                x, y = ox + m * W, oy + m * W
                R.add(x, y, x + L, y + W, vertical=False)
                R.add(x, y + W, x + W, y + W + L, vertical=True)
    return R


def planks(h: int, w: int, rows: int, seed: int, lmin: float, lmax: float) -> Rects:
    """Lames de parquet : `rows` rangées horizontales de longueurs aléatoires (px), raccordées."""
    R = Rects(h, w)
    r = rng(seed)
    ch = h / rows
    for j in range(rows):
        x0 = r.random() * w
        cuts = [0.0]
        while cuts[-1] < w:
            cuts.append(cuts[-1] + r.uniform(lmin, lmax))
        cuts[-1] = w
        if len(cuts) > 2 and cuts[-1] - cuts[-2] < lmin * 0.6:
            del cuts[-2]
        for a, b in zip(cuts[:-1], cuts[1:]):
            R.add(x0 + a, j * ch, x0 + b, (j + 1) * ch, vertical=False)
    return R


def height_to_normal(hmm: np.ndarray, px_mm: float, strength: float = 1.0) -> np.ndarray:
    """Carte de relief (RGB 0–1) d'un champ de hauteurs en mm, raccordable.

    Axe vert orienté vers le bas de l'image (les images sont chargées sans retournement).
    """
    dx = (np.roll(hmm, -1, 1) - np.roll(hmm, 1, 1)) / (2 * px_mm) * strength
    dy = (np.roll(hmm, -1, 0) - np.roll(hmm, 1, 0)) / (2 * px_mm) * strength
    n = np.stack([-dx, -dy, np.ones_like(dx)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return (n * 0.5 + 0.5).astype(F)


def cavity(hmm: np.ndarray, sigma_px: float, depth_mm: float) -> np.ndarray:
    """Occlusion des creux (0 = creux profond, 1 = surface) à cuire dans la couleur."""
    c = blur(hmm, sigma_px) - hmm
    return np.clip(1 - np.maximum(c, 0) / max(depth_mm, 1e-6), 0, 1).astype(F)


def draw_wrapped(draw_fn, w: int, h: int, bbox: tuple[float, float, float, float]) -> None:
    """Appelle draw_fn(dx, dy) pour chaque copie décalée qui touche l'image (raccord)."""
    x0, y0, x1, y1 = bbox
    for dy in (-h, 0, h):
        for dx in (-w, 0, w):
            if x1 + dx >= 0 and x0 + dx < w and y1 + dy >= 0 and y0 + dy < h:
                draw_fn(dx, dy)
