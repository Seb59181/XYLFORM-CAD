/**
 * Fonds de plan (références externes) : contenu d'une définition ramené dans le repère du
 * dessin, unités, emprise et couleurs estompées.
 */
import type { Bounds, Entity, NewEntity, UnderlayDef } from '../document/Document';
import { curvePoints, entityBBox, transformEntity, underlayMatrix } from './geometry';

type UnderlayEntity = Extract<Entity, { type: 'UNDERLAY' }>;

/** Millimètres par unité ($INSUNITS). 0 = sans unité. */
const MM_PER_UNIT: Record<number, number> = {
  1: 25.4,
  2: 304.8,
  3: 1_609_344,
  4: 1,
  5: 10,
  6: 1000,
  7: 1_000_000,
  8: 0.0000254,
  9: 0.0254,
  10: 914.4,
  14: 100,
};

export const UNIT_NAME: Record<number, string> = { 0: 'sans unité', 1: 'pouces', 2: 'pieds', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 10: 'yards', 14: 'dm' };

/** Échelle d'insertion qui convertit les unités du fond vers celles du dessin (1 si inconnues). */
export function unitScale(source: number | undefined, host: number): number {
  const a = source ? MM_PER_UNIT[source] : undefined, b = host ? MM_PER_UNIT[host] : undefined;
  return a && b ? a / b : 1;
}

/** Emprise d'un ensemble d'entités (coordonnées propres du fond). */
export function boundsOf(entities: NewEntity[]): Bounds {
  const min = { x: Infinity, y: Infinity, z: 0 }, max = { x: -Infinity, y: -Infinity, z: 0 };
  for (const ne of entities) {
    const b = entityBBox({ ...ne, handle: '', layer: '' } as Entity);
    if (!b || !Number.isFinite(b.min.x)) continue;
    min.x = Math.min(min.x, b.min.x), min.y = Math.min(min.y, b.min.y);
    max.x = Math.max(max.x, b.max.x), max.y = Math.max(max.y, b.max.y);
  }
  if (!Number.isFinite(min.x)) return { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } };
  return { min, max };
}

/**
 * Objets du fond placés dans le dessin, avec leur couleur effective (propre ou du calque du fond).
 * Les calques masqués dans la définition sont omis.
 */
export function underlayEntities(e: UnderlayEntity, def: UnderlayDef): Entity[] {
  if (!def.entities) return [];
  const layers = new Map((def.layers ?? []).map((l) => [l.name, l]));
  const m = underlayMatrix(e);
  const out: Entity[] = [];
  def.entities.forEach((ne, i) => {
    const layerName = ne.layer ?? '0';
    const l = layers.get(layerName);
    if (l && !l.visible) return;
    const local = { ...ne, handle: `${e.handle}:${i}`, layer: layerName, color: ne.color ?? l?.color ?? '#ffffff' } as Entity;
    out.push({ ...local, ...transformEntity(local, m) } as Entity);
  });
  return out;
}

/** Polylignes et emprises des objets d'un fond (désignation, accrochage). */
export function underlayPickData(entities: Entity[]): { polys: ReturnType<typeof curvePoints>[]; boxes: (Bounds | null)[] } {
  const polys = entities.map((x) => curvePoints(x));
  const boxes = polys.map((ps) => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const pl of ps)
      for (const p of pl) {
        x0 = Math.min(x0, p.x), y0 = Math.min(y0, p.y), z0 = Math.min(z0, p.z);
        x1 = Math.max(x1, p.x), y1 = Math.max(y1, p.y), z1 = Math.max(z1, p.z);
      }
    return Number.isFinite(x0) ? { min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } } : null;
  });
  return { polys, boxes };
}

/** Couleur estompée vers le fond d'écran (estompage 0–90 %), éventuellement en gris. */
export function fadeColor(color: string, fade: number, monochrome: boolean, background = '#212830'): string {
  const hex = (c: string) => {
    const v = /^#?([0-9a-f]{6})$/i.exec(c)?.[1] ?? 'ffffff';
    return [0, 2, 4].map((k) => parseInt(v.slice(k, k + 2), 16));
  };
  let [r, g, b] = hex(color) as [number, number, number];
  if (monochrome) {
    const y = Math.round(0.3 * r + 0.59 * g + 0.11 * b);
    r = g = b = Math.max(110, y);
  }
  const bg = hex(background);
  const t = Math.max(0, Math.min(0.9, fade / 100));
  const mix = (a: number, k: number) => Math.round(a + (bg[k]! - a) * t);
  return `#${[mix(r, 0), mix(g, 1), mix(b, 2)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Nom libre dérivé du fichier (« plan », « plan (2) »…). */
export function uniqueUnderlayName(base: string, taken: string[]): string {
  const set = new Set(taken.map((n) => n.toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!set.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
}
