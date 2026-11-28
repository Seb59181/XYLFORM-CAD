"""
Génère la bibliothèque de textures de Xylform CAD dans public/textures/<id>/ :
  couleur.webp (1024 px), hauteur.webp (512 px, relief en niveaux de gris, 0 = creux), rugosite.webp
  (512 px, gris), vignette.webp (160 px, éclairée pour la fenêtre de choix) ; et le tableau
  src/core/textureLibrary.data.json (taille réelle et profondeur du relief de chaque matériau).

La carte de normales est calculée par l'application à partir de la hauteur (comme pour une
photo importée), ce qui garde la bibliothèque légère.

Usage : python3 -I scripts/textures/generer.py [id ...]     (sans argument : tout)
Nécessite numpy et Pillow. Les images sont entièrement calculées (aucune photo tierce).
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

from lib import F, blur, cavity, height_to_normal  # noqa: E402
from materials import REGISTRY  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'textures')


def to8(a: np.ndarray) -> np.ndarray:
    return (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)


def build(mid: str, spec: dict, seed: int) -> dict:
    col, hmm, rough = spec['fn'](seed)
    h, w = hmm.shape
    if np.ndim(rough) == 0:
        rough = np.full((h, w), float(rough), F)
    px_mm = spec['size'] / w
    nrm = height_to_normal(hmm, px_mm)
    # occlusion des creux cuite dans la couleur (joints, entre les pierres…)
    ao = cavity(hmm, 6, max(float(np.percentile(hmm, 99) - np.percentile(hmm, 1)), 1e-3) * 0.9)
    col = col * (0.55 + 0.45 * ao[..., None])
    d = os.path.join(OUT, mid)
    os.makedirs(d, exist_ok=True)
    Image.fromarray(to8(col)).save(os.path.join(d, 'couleur.webp'), quality=82, method=6)
    lo, hi = float(hmm.min()), float(hmm.max())
    depth = max(hi - lo, 1e-4)
    hq = (hmm - lo) / depth
    # demi-résolution : le grain fin est porté par la couleur, le relief par les formes
    Image.fromarray(to8(hq), 'L').resize((w // 2, h // 2), Image.LANCZOS).save(os.path.join(d, 'hauteur.webp'), quality=85, method=6)
    old = os.path.join(d, 'relief.webp')
    if os.path.exists(old):
        os.remove(old)
    Image.fromarray(to8(rough)).resize((w // 2, h // 2), Image.LANCZOS).save(os.path.join(d, 'rugosite.webp'), quality=85, method=6)
    # vignette : couleur éclairée en rasant par le relief
    n = nrm * 2 - 1
    L = np.array([-0.45, -0.55, 0.7], F)
    L /= np.linalg.norm(L)
    shade = np.clip((n @ L) / L[2], 0, 1.6)
    th = to8(col * (0.35 + 0.65 * shade[..., None]))
    tw = 160
    Image.fromarray(th).resize((tw, max(1, round(tw * h / w))), Image.LANCZOS).save(os.path.join(d, 'vignette.webp'), quality=82, method=6)
    return {'size': spec['size'], 'height': round(spec['size'] * h / w, 2), 'relief': round(depth, 4)}


def main(ids: list[str]) -> None:
    todo = ids or list(REGISTRY)
    data_path = os.path.join(ROOT, 'src', 'core', 'textureLibrary.data.json')
    data = json.load(open(data_path, encoding='utf-8')) if os.path.exists(data_path) else {}
    for k, mid in enumerate(todo):
        if mid not in REGISTRY:
            raise SystemExit(f'matériau inconnu : {mid}')
        t = time.time()
        data[mid] = build(mid, REGISTRY[mid], 1000 + list(REGISTRY).index(mid) * 37)
        print(f'{k + 1}/{len(todo)} {mid} {time.time() - t:.1f} s', flush=True)
    data = {k: data[k] for k in REGISTRY if k in data}
    with open(data_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main(sys.argv[1:])
