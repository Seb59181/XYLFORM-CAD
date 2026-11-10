/**
 * Contraintes paramétriques 2D (onglet Paramétrique).
 *
 * Une référence désigne une partie d'entité :
 *   'start' | 'end'        extrémités d'une ligne ou d'un arc
 *   'v:i'                  sommet i d'une polyligne
 *   'seg:i'                segment i d'une polyligne (côté ligne)
 *   'line'                 la ligne entière
 *   'center'               centre d'un cercle, d'un arc ou d'une ellipse
 *   'circle'               le cercle/arc (centre + rayon)
 *   'point'                une entité POINT
 */
import type { Vec3 } from '../commands/types';

export interface PartRef {
  handle: string;
  part: string;
}

export type GeometricType = 'horizontal' | 'vertical' | 'parallel' | 'perpendicular' | 'coincident' | 'concentric' | 'tangent' | 'equal' | 'fix';
export type DimensionalType = 'distance' | 'radius' | 'diameter' | 'angle';

export type Constraint =
  | { id: string; type: Exclude<GeometricType, 'fix' | 'tangent'>; refs: PartRef[] }
  | { id: string; type: 'tangent'; refs: PartRef[]; internal?: boolean }
  | { id: string; type: 'fix'; refs: PartRef[]; at: Vec3 }
  | {
      id: string;
      type: DimensionalType;
      refs: PartRef[];
      /** Nom du paramètre (d1, rad1, dia1, ang1). */
      name: string;
      /** Valeur ou expression (« largeur/2 », « d1*2 »). */
      expression: string;
      /** Position du texte de cote. */
      labelAt?: Vec3;
      /** Cote linéaire : distance horizontale (x) ou verticale (y) au lieu de la distance vraie. */
      axis?: 'x' | 'y';
    };

/** Contrainte avant insertion (identifiant attribué par le document). */
export type NewConstraint = Constraint extends infer C ? (C extends Constraint ? Omit<C, 'id'> : never) : never;

export const CONSTRAINT_LABEL: Record<Constraint['type'], string> = {
  horizontal: 'Horizontal',
  vertical: 'Vertical',
  parallel: 'Parallèle',
  perpendicular: 'Perpendiculaire',
  coincident: 'Coïncident',
  concentric: 'Concentrique',
  tangent: 'Tangent',
  equal: 'Égal',
  fix: 'Fixe',
  distance: 'Linéaire',
  radius: 'Rayon',
  diameter: 'Diamètre',
  angle: 'Angle',
};

/** Pictogramme affiché près des entités contraintes. */
export const CONSTRAINT_GLYPH: Record<Constraint['type'], string> = {
  horizontal: '═',
  vertical: '‖',
  parallel: '∥',
  perpendicular: '⊥',
  coincident: '●',
  concentric: '◎',
  tangent: '◠',
  equal: '=',
  fix: '🔒',
  distance: '↔',
  radius: 'R',
  diameter: 'Ø',
  angle: '∠',
};

export function isDimensional(c: Constraint): c is Extract<Constraint, { name: string }> {
  return c.type === 'distance' || c.type === 'radius' || c.type === 'diameter' || c.type === 'angle';
}
