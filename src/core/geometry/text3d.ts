/**
 * Contours des lettres pour le texte 3D (TEXTE3D) : polices Droid (Apache 2.0, accents
 * français) au format typeface de Three.js, chargées à la demande. Chaque glyphe donne des
 * régions fermées (contour extérieur + trous : « o », « e », « A »…) que le noyau extrude.
 */
import { Font } from 'three/examples/jsm/loaders/FontLoader.js';

export type FontName = 'sans' | 'sans-bold' | 'serif' | 'mono';

export const FONT_LABEL: Record<FontName, string> = {
  sans: 'Droid Sans',
  'sans-bold': 'Droid Sans gras',
  serif: 'Droid Serif',
  mono: 'Droid Sans Mono',
};

const loaders: Record<FontName, () => Promise<{ default: unknown }>> = {
  sans: () => import('three/examples/fonts/droid/droid_sans_regular.typeface.json'),
  'sans-bold': () => import('three/examples/fonts/droid/droid_sans_bold.typeface.json'),
  serif: () => import('three/examples/fonts/droid/droid_serif_regular.typeface.json'),
  mono: () => import('three/examples/fonts/droid/droid_sans_mono_regular.typeface.json'),
};

const cache = new Map<FontName, Promise<Font>>();

export function loadFont(name: FontName): Promise<Font> {
  let f = cache.get(name);
  if (!f) {
    f = loaders[name]().then((m) => new Font(m.default as never));
    cache.set(name, f);
  }
  return f;
}

/** Hauteur des majuscules des polices Droid, en fraction du corps (em). */
const CAP = 1462 / 2048;

export type Pt2 = [number, number];
export interface Region2D {
  outer: Pt2[];
  holes: Pt2[][];
}

function signedArea(p: Pt2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i]!, [x2, y2] = p[(i + 1) % p.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Retire les points confondus (et le point de fermeture) ; orientation imposée. */
function clean(pts: { x: number; y: number }[], ccw: boolean, tol: number): Pt2[] | null {
  const out: Pt2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last[0], p.y - last[1]) > tol) out.push([p.x, p.y]);
  }
  while (out.length > 2 && Math.hypot(out[0]![0] - out[out.length - 1]![0], out[0]![1] - out[out.length - 1]![1]) <= tol) out.pop();
  if (out.length < 3) return null;
  const a = signedArea(out);
  if (Math.abs(a) < tol * tol) return null;
  if (a > 0 !== ccw) out.reverse();
  return out;
}

/**
 * Régions d'un texte de hauteur de majuscules `height`, centrées sur l'origine (lignes
 * séparées par « \n »). `segments` : subdivisions des courbes de chaque glyphe.
 */
export function textRegions(font: Font, text: string, height: number, segments = 5): Region2D[] {
  const size = height / CAP;
  const shapes = font.generateShapes(text, size);
  const tol = height * 1e-4;
  const regions: Region2D[] = [];
  for (const sh of shapes) {
    const { shape, holes } = sh.extractPoints(segments);
    const outer = clean(shape, true, tol);
    if (!outer) continue;
    regions.push({ outer, holes: holes.map((h) => clean(h, false, tol)).filter((h): h is Pt2[] => !!h) });
  }
  if (!regions.length) return regions;
  // centrage sur la boîte englobante
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of regions) for (const [x, y] of r.outer) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const shift = (p: Pt2): Pt2 => [p[0] - cx, p[1] - cy];
  return regions.map((r) => ({ outer: r.outer.map(shift), holes: r.holes.map((h) => h.map(shift)) }));
}

/** Largeur et hauteur du texte (régions centrées). */
export function regionsSize(regions: Region2D[]): { w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of regions) for (const [x, y] of r.outer) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  return Number.isFinite(x0) ? { w: x1 - x0, h: y1 - y0 } : { w: 0, h: 0 };
}
