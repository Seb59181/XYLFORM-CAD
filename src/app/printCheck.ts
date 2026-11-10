/**
 * Contrôle d'imprimabilité (avant export STL/3MF, ou commande IMPRIMABILITE) :
 * solides qui se chevauchent (volume commun calculé par le noyau), parois trop fines et
 * porte-à-faux (analyse du maillage, zones colorées dans la vue).
 */
import type { CommandContext } from '../core/commands';
import type { Entity } from '../core/document/Document';
import type { IndexedMesh } from '../core/mesh/IndexedMesh';
import { analyzePrintability, type PrintabilityReport } from '../core/mesh/Printability';
import { prepareForPrint, MM_PER_UNIT, type LengthUnit } from '../io/exporters/PrintPreparation';
import type { AppHost, MeshExportSettings } from './AppHost';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

/** Unité de longueur du dessin ($INSUNITS) ; mm par défaut (sans unité, ou unité rare). */
export function drawingUnit(insunits: unknown): MeshExportSettings['unit'] {
  switch (Number(insunits)) {
    case 1:
      return 'in';
    case 2:
      return 'ft';
    case 5:
      return 'cm';
    case 6:
      return 'm';
    default:
      return 'mm';
  }
}

export interface Overlap {
  a: number;
  b: number;
  /** Volume commun en unités du dessin³. */
  volume: number;
}

const boxesTouch = (A: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }, B: typeof A) =>
  A.min.x <= B.max.x && B.min.x <= A.max.x && A.min.y <= B.max.y && B.min.y <= A.max.y && A.min.z <= B.max.z && B.min.z <= A.max.z;

/** Paires de solides qui partagent du volume (`ids` : formes à tester, dans l'ordre de `solids`). */
export async function findOverlaps(app: AppHost, solids: Solid3D[], ids: string[], ctx?: CommandContext): Promise<Overlap[]> {
  const out: Overlap[] = [];
  for (let i = 0; i < solids.length; i++)
    for (let j = i + 1; j < solids.length; j++) {
      if (!boxesTouch(solids[i]!.display.bbox, solids[j]!.display.bbox)) continue;
      try {
        const r = await app.solid(ctx, { op: 'boolean', kind: 'intersect', targets: [ids[i]!], tools: [ids[j]!], lazy: true });
        void app.kernel.call({ op: 'release', shapeIds: [r.shapeId] }).catch(() => undefined);
        if (r.display.volume > 1e-6) out.push({ a: i, b: j, volume: r.display.volume });
      } catch (e) {
        if ((e as Error).name === 'CommandCancelled') throw e;
        /* pas de volume commun */
      }
    }
  return out;
}

/** Groupes de solides reliés par des chevauchements (union-find), seulement ceux de 2 et plus. */
export function overlapGroups(n: number, overlaps: Overlap[]): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (const o of overlaps) parent[find(o.a)] = find(o.b);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

export interface MeshCheck {
  report: PrintabilityReport | null;
  /** Maillage analysé (unités du dessin, orienté vers l'extérieur). */
  mesh: IndexedMesh;
}

/**
 * Parois fines et porte-à-faux de maillages en unités du dessin ; `minWall` en mm (converti
 * avec l'unité du dessin `unit`).
 */
export function analyzeMeshes(meshes: IndexedMesh[], unit: LengthUnit, minWall: number, overhang: number, sharedBed = true): MeshCheck[] {
  const k = MM_PER_UNIT[unit] ?? 1;
  // plateau commun (objets imprimés ensemble à leur place) ou propre à chaque objet
  let bedZ: number | undefined;
  if (sharedBed) {
    bedZ = Infinity;
    for (const m of meshes) for (let i = 2; i < m.positions.length; i += 3) if (m.positions[i]! < bedZ) bedZ = m.positions[i]!;
  }
  return meshes.map((m) => {
    let mesh = m;
    try {
      mesh = prepareForPrint(m, { sourceUnit: 'mm', allowNonManifold: true }).mesh;
    } catch {
      /* maillage inexploitable : analysé tel quel */
    }
    try {
      return { mesh, report: analyzePrintability(mesh.positions, mesh.indices, { minWall: minWall / k, overhangDeg: overhang, bedZ }) };
    } catch {
      return { mesh, report: null };
    }
  });
}

const RED = [0.92, 0.18, 0.18];
const ORANGE = [1, 0.62, 0.05];

/** Calques colorés pour la vue : porte-à-faux en rouge, parois fines en orange. */
export function analysisLayers(checks: MeshCheck[]): { positions: Float32Array; colors: Float32Array }[] {
  const out: { positions: Float32Array; colors: Float32Array }[] = [];
  for (const { mesh, report } of checks) {
    if (!report) continue;
    const color = new Map<number, number[]>();
    for (const t of report.overhang) color.set(t, RED);
    for (const t of report.thin) color.set(t, ORANGE);
    if (!color.size) continue;
    const pos = new Float32Array(color.size * 9), col = new Float32Array(color.size * 9);
    let o = 0;
    for (const [t, c] of color) {
      for (let v = 0; v < 3; v++) {
        const i = mesh.indices[3 * t + v]! * 3;
        pos[o] = mesh.positions[i]!;
        pos[o + 1] = mesh.positions[i + 1]!;
        pos[o + 2] = mesh.positions[i + 2]!;
        col[o] = c[0]!;
        col[o + 1] = c[1]!;
        col[o + 2] = c[2]!;
        o += 3;
      }
    }
    out.push({ positions: pos, colors: col });
  }
  return out;
}

const f = (v: number, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toString().replace('.', ',');

/** Lignes de compte rendu (surfaces en mm², épaisseurs en mm) ; vide si rien à signaler. */
export function describeChecks(names: string[], checks: MeshCheck[], unit: LengthUnit, minWall: number, overhang: number): string[] {
  const k = MM_PER_UNIT[unit] ?? 1;
  const lines: string[] = [];
  checks.forEach(({ report: r }, i) => {
    if (!r || (!r.thin.length && !r.overhang.length)) return;
    const parts: string[] = [];
    if (r.thin.length) parts.push(`paroi fine (${f(r.minThickness * k, 2)} mm au plus fin, moins de ${f(minWall, 2)} mm) sur ${f(r.thinArea * k * k)} mm²`);
    if (r.overhang.length) parts.push(`porte-à-faux de plus de ${f(overhang, 0)}° sur ${f(r.overhangArea * k * k)} mm² (${f((100 * r.overhangArea) / (r.area || 1), 0)} % de la surface, supports conseillés)`);
    lines.push(`${names[i]} : ${parts.join(' ; ')}.`);
  });
  return lines;
}

/** Affiche les zones colorées et les efface à la prochaine modification du dessin. */
export function showAnalysis(app: AppHost, checks: MeshCheck[] | null): number {
  const layers = checks ? analysisLayers(checks) : [];
  app.viewport?.setAnalysis(layers.length ? layers : null);
  if (layers.length) {
    const off = app.on('doc', () => {
      off();
      app.viewport?.setAnalysis(null);
    });
  }
  return layers.length;
}
