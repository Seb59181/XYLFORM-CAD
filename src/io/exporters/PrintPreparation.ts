/**
 * Chaîne commune STL / 3MF : nettoyage → vérification manifold → réorientation → mise à l'échelle.
 * Toute erreur topologique non réparable bloque l'export (sauf `allowNonManifold`), car un
 * fichier non étanche produit des couches fausses dans le trancheur.
 */
import { cleanMesh, type CleanReport } from '../../core/mesh/MeshCleaner';
import { checkManifold, NonManifoldError, repairOrientation, type ManifoldReport } from '../../core/mesh/ManifoldCheck';
import type { IndexedMesh } from '../../core/mesh/IndexedMesh';

/** Unités de dessin (variable INSUNITS). L'impression 3D attend des millimètres. */
export type LengthUnit = 'um' | 'mm' | 'cm' | 'm' | 'in' | 'ft';

export const MM_PER_UNIT: Record<LengthUnit, number> = {
  um: 0.001,
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  ft: 304.8,
};

export interface PrintExportOptions {
  /** Unités du document source (défaut : mm). */
  sourceUnit?: LengthUnit;
  /** Réparer automatiquement l'orientation des triangles (défaut : true). */
  autoRepair?: boolean;
  /** Exporter malgré tout un maillage non étanche, avec avertissement (défaut : false). */
  allowNonManifold?: boolean;
  /** Tolérance de soudure en unités source. */
  weldTolerance?: number;
}

export interface PreparedMesh {
  /** Maillage en millimètres, normales sortantes. */
  mesh: IndexedMesh;
  clean: CleanReport;
  manifold: ManifoldReport;
  flippedTriangles: number;
  warnings: string[];
}

export function prepareForPrint(source: IndexedMesh, opts: PrintExportOptions = {}): PreparedMesh {
  const warnings: string[] = [];
  const { mesh: cleaned, report: clean } = cleanMesh(source, { weldTolerance: opts.weldTolerance });

  let report = checkManifold(cleaned);
  let mesh = cleaned;
  let flippedTriangles = 0;

  if (!report.isManifold) {
    if (!opts.allowNonManifold) throw new NonManifoldError(report);
    warnings.push(new NonManifoldError(report).message);
  } else if (opts.autoRepair ?? true) {
    const fixed = repairOrientation(cleaned);
    flippedTriangles = fixed.flippedTriangles;
    if (flippedTriangles) warnings.push(`${flippedTriangles} triangle(s) réorienté(s) (normales inversées).`);
    mesh = fixed.mesh;
    report = checkManifold(mesh);
  }
  if (report.isManifold && !report.isOriented) warnings.push('Orientation incohérente non corrigée.');
  if (report.volume <= 0 && report.isWatertight) warnings.push('Volume nul ou négatif.');

  // Mise à l'échelle vers le millimètre
  const k = MM_PER_UNIT[opts.sourceUnit ?? 'mm'];
  if (k !== 1) {
    const p = new Float64Array(mesh.positions.length);
    for (let i = 0; i < p.length; i++) p[i] = mesh.positions[i]! * k;
    mesh = { positions: p, indices: mesh.indices };
    report = { ...report, volume: report.volume * k * k * k };
  }

  return { mesh, clean, manifold: report, flippedTriangles, warnings };
}
