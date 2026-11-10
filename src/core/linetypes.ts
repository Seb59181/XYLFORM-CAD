/**
 * Types de ligne (calques) : continu, caché (tirets), axe (trait mixte), tirets longs.
 * Motifs en mm « papier », multipliés par l'échelle des types de ligne (LTSCALE). Le découpage
 * en tirets est fait une fois pour toutes sur les polylignes (affichage, SVG, PDF).
 */
import type { Vec3 } from './commands/types';

export type Linetype = 'CONTINUOUS' | 'HIDDEN' | 'CENTER' | 'DASHED' | 'PHANTOM';

/** Motif : longueurs positives = traits, négatives = espaces, 0 = point. */
export const LINETYPES: Record<Linetype, { label: string; dxf: string; description: string; pattern: number[] }> = {
  CONTINUOUS: { label: 'Continu', dxf: 'CONTINUOUS', description: 'Solid line', pattern: [] },
  HIDDEN: { label: 'Cachée (tirets courts)', dxf: 'HIDDEN', description: 'Hidden __ __ __ __', pattern: [3, -1.5] },
  CENTER: { label: 'Axe (trait mixte)', dxf: 'CENTER', description: 'Center ____ _ ____ _', pattern: [12, -2.5, 2, -2.5] },
  DASHED: { label: 'Tirets longs', dxf: 'DASHED', description: 'Dashed __ __ __', pattern: [6, -2.5] },
  PHANTOM: { label: 'Fantôme (trait mixte double)', dxf: 'PHANTOM', description: 'Phantom ____ _ _ ____', pattern: [12, -2.5, 2, -2.5, 2, -2.5] },
};

export const LINETYPE_IDS = Object.keys(LINETYPES) as Linetype[];

/** Type de ligne d'après un nom DXF (HIDDEN2, DASHDOT, ACAD_ISO02W100…). */
export function linetypeFromDxf(name: string | undefined): Linetype | undefined {
  const n = (name ?? '').toUpperCase();
  if (!n || n === 'CONTINUOUS' || n === 'BYLAYER' || n === 'BYBLOCK') return undefined;
  if (n.startsWith('HIDDEN') || n.includes('ISO02') || n.includes('ISO03')) return 'HIDDEN';
  if (n.startsWith('CENTER') || n.startsWith('DASHDOT') || n.includes('ISO04') || n.includes('ISO10')) return 'CENTER';
  if (n.startsWith('PHANTOM') || n.startsWith('DIVIDE') || n.includes('ISO05')) return 'PHANTOM';
  if (n.startsWith('DASH') || n.includes('ISO')) return 'DASHED';
  return undefined;
}

/** Motif effectif (unités du dessin). Vide = trait continu. */
export function patternOf(lt: Linetype | undefined, scale: number): number[] {
  const p = lt ? LINETYPES[lt]?.pattern : undefined;
  if (!p?.length || !(scale > 0)) return [];
  return p.map((x) => x * scale);
}

/**
 * Découpe des polylignes en tirets selon le motif. Le motif repart au début de chaque
 * polyligne et se poursuit d'un segment à l'autre. Une polyligne plus courte qu'un trait
 * reste pleine (petits détails lisibles).
 */
export function dashPolys(polys: Vec3[][], pattern: number[], maxDashes = 200000): Vec3[][] {
  if (!pattern.length) return polys;
  const period = pattern.reduce((s, x) => s + Math.abs(x), 0);
  if (period <= 1e-9) return polys;
  const out: Vec3[][] = [];
  let budget = maxDashes;
  for (const pl of polys) {
    let total = 0;
    for (let i = 1; i < pl.length; i++) total += dist(pl[i - 1]!, pl[i]!);
    if (total <= Math.abs(pattern[0]!) * 1.2 || budget <= 0 || total / period > budget) {
      out.push(pl);
      continue;
    }
    let k = 0; // élément du motif
    let left = Math.abs(pattern[0]!); // reste de l'élément courant
    let cur: Vec3[] | null = pattern[0]! >= 0 ? [pl[0]!] : null;
    for (let i = 1; i < pl.length; i++) {
      let a = pl[i - 1]!;
      const b = pl[i]!;
      let seg = dist(a, b);
      while (seg > 1e-12) {
        if (left >= seg) {
          left -= seg;
          if (cur) cur.push(b);
          seg = 0;
        } else {
          const p = lerp(a, b, left / seg);
          seg -= left;
          if (cur) {
            cur.push(p);
            out.push(cur);
            budget--;
            cur = null;
          }
          a = p;
          k = (k + 1) % pattern.length;
          const v = pattern[k]!;
          left = Math.abs(v);
          if (v >= 0) cur = [p];
          if (v === 0) {
            // point : un tiret minuscule (visible à l'écran comme à l'impression)
            const q = lerp(a, b, Math.min(1, (period * 0.02) / Math.max(seg, 1e-9)));
            out.push([p, q]);
            cur = null;
          }
        }
      }
    }
    if (cur && cur.length > 1) out.push(cur);
  }
  return out;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
}

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}
