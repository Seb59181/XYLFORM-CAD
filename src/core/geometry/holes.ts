/**
 * Assistant de perçage : dimensions normalisées
 * des trous métriques ISO de M3 à M20 et demi-profil de l'outil (révolution autour de l'axe).
 *
 * - Passage : perçage moyen ISO 273.
 * - Lamé : vis à tête cylindrique à six pans creux ISO 4762 (DIN 974-1).
 * - Fraisé : vis à tête fraisée 90° ISO 10642 (ISO 15065).
 * - Taraudé : avant-trou de taraudage (d − pas), filetage réel en option.
 * - Insert : inserts laiton à chaud pour l'impression 3D (M2 à M8, valeurs courantes).
 */

export type HoleType = 'simple' | 'counterbore' | 'countersink' | 'tapped' | 'insert';

export interface HoleSpec {
  type: HoleType;
  /** Taille normalisée, ex. « M6 » (ou « Ø » pour un trou simple de diamètre libre). */
  size: string;
  /** Diamètre de perçage (passage, avant-trou, insert). */
  diameter: number;
  /** Profondeur utile depuis la face ; 0 = débouchant (traverse tout le solide). */
  depth: number;
  /** Lamage : diamètre et profondeur. */
  cbDiameter?: number;
  cbDepth?: number;
  /** Fraisure : diamètre en surface (angle 90°). */
  csDiameter?: number;
  /** Taraudé : diamètre nominal et pas (filetage réel si `thread`). */
  nominal?: number;
  pitch?: number;
  thread?: boolean;
  /**
   * Ancien jeu (jusqu'à la 1.9.5) : ajouté au Ø du filet, ce qui ne laissait que le quart du
   * jeu sur les flancs. Conservé pour reconstruire les anciens dessins à l'identique.
   */
  clearance?: number;
  /** Filetage réel : jeu d'impression par côté, perpendiculaire aux flancs (mm). */
  gap?: number;
  /**
   * Compensation des trous imprimés (passage, lamé, fraisé) : ajoutée aux Ø de perçage, de
   * lamage et de fraisure, car les trous sortent trop petits en impression FDM.
   */
  comp?: number;
}

interface Row {
  d: number;
  pitch: number;
  clearance: number;
  tap: number;
  cbD: number;
  cbH: number;
  csD: number;
}

/** Tableau des tailles (mm). */
export const METRIC: Record<string, Row> = {
  M2: { d: 2, pitch: 0.4, clearance: 2.4, tap: 1.6, cbD: 4.3, cbH: 2.3, csD: 4.4 },
  M2_5: { d: 2.5, pitch: 0.45, clearance: 2.9, tap: 2.05, cbD: 5, cbH: 2.8, csD: 5.5 },
  M3: { d: 3, pitch: 0.5, clearance: 3.4, tap: 2.5, cbD: 6.5, cbH: 3.4, csD: 6.6 },
  M4: { d: 4, pitch: 0.7, clearance: 4.5, tap: 3.3, cbD: 8, cbH: 4.6, csD: 9 },
  M5: { d: 5, pitch: 0.8, clearance: 5.5, tap: 4.2, cbD: 10, cbH: 5.7, csD: 11 },
  M6: { d: 6, pitch: 1, clearance: 6.6, tap: 5, cbD: 11, cbH: 6.8, csD: 13 },
  M8: { d: 8, pitch: 1.25, clearance: 9, tap: 6.8, cbD: 15, cbH: 9, csD: 17.2 },
  M10: { d: 10, pitch: 1.5, clearance: 11, tap: 8.5, cbD: 18, cbH: 11, csD: 21.5 },
  M12: { d: 12, pitch: 1.75, clearance: 13.5, tap: 10.2, cbD: 20, cbH: 13, csD: 25.5 },
  M14: { d: 14, pitch: 2, clearance: 15.5, tap: 12, cbD: 24, cbH: 15, csD: 28.5 },
  M16: { d: 16, pitch: 2, clearance: 17.5, tap: 14, cbD: 26, cbH: 17.5, csD: 32 },
  M20: { d: 20, pitch: 2.5, clearance: 22, tap: 17.5, cbD: 33, cbH: 21.5, csD: 40.4 },
};

/** Inserts laiton à chaud : diamètre et profondeur du logement. */
export const INSERTS: Record<string, { d: number; depth: number }> = {
  M2: { d: 3.2, depth: 4 },
  M2_5: { d: 3.6, depth: 4.5 },
  M3: { d: 4, depth: 5.7 },
  M4: { d: 5.6, depth: 8.1 },
  M5: { d: 6.4, depth: 9.5 },
  M6: { d: 8, depth: 12.7 },
  M8: { d: 9.6, depth: 12.7 },
};

export const SIZES = ['M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M14', 'M16', 'M20'];

export const HOLE_LABEL: Record<HoleType, string> = {
  simple: 'Trou de passage',
  counterbore: 'Trou lamé',
  countersink: 'Trou fraisé',
  tapped: 'Trou taraudé',
  insert: 'Logement d’insert',
};

export const sizeLabel = (s: string) => s.replace('_', ',');

/** Compensation (Ø) appliquée à ce type de trou : passage, lamé et fraisé seulement. */
export const holeComp = (h: HoleSpec): number => (h.type === 'simple' || h.type === 'counterbore' || h.type === 'countersink' ? Math.max(0, h.comp ?? 0) : 0);

/**
 * Dimensions normalisées d'un trou ; `depth` 0 = débouchant. `gap` : jeu par côté du filetage
 * réel ; `comp` : compensation des trous imprimés (Ø).
 */
export function standardHole(type: HoleType, size: string, depth = 0, thread = false, gap = 0, comp = 0): HoleSpec {
  const r = METRIC[size];
  if (!r) throw new Error(`Taille inconnue : ${size}`);
  const c = comp > 0 ? { comp } : {};
  switch (type) {
    case 'simple':
      return { type, size, diameter: r.clearance, depth, ...c };
    case 'counterbore':
      return { type, size, diameter: r.clearance, depth, cbDiameter: r.cbD, cbDepth: r.cbH, ...c };
    case 'countersink':
      return { type, size, diameter: r.clearance, depth, csDiameter: r.csD, ...c };
    case 'tapped':
      // l'avant-trou s'agrandit du jeu (sommet du filet femelle) ; le filet est creusé par l'outil
      return { type, size, diameter: r.tap + (thread ? 2 * gap : 0), depth, nominal: r.d, pitch: r.pitch, thread, ...(thread ? { gap } : {}) };
    case 'insert': {
      const i = INSERTS[size];
      if (!i) throw new Error(`Pas d’insert normalisé en ${sizeLabel(size)} (M2 à M8).`);
      return { type, size, diameter: i.d, depth: depth || i.depth };
    }
  }
}

/** Description courte (« Lamé M6 Ø6,6 × 12 »). */
export function holeTitle(h: HoleSpec): string {
  const kind = { simple: 'Passage', counterbore: 'Lamé', countersink: 'Fraisé', tapped: 'Taraudé', insert: 'Insert' }[h.type];
  const size = h.size && h.size !== 'Ø' ? ` ${sizeLabel(h.size)}` : '';
  const f = (v: number) => String(Math.round(v * 100) / 100).replace('.', ',');
  const comp = holeComp(h);
  const jeu = h.gap ? ` (jeu ${f(h.gap)}/côté)` : h.clearance ? ` (jeu Ø ${f(h.clearance)})` : '';
  return `${kind}${size} Ø${f(h.diameter)}${comp ? ` (+${f(comp)} impr.)` : ''} ${h.depth > 0 ? `× ${f(h.depth)}` : 'débouchant'}${h.type === 'tapped' && h.thread ? `, filet réel${jeu}` : ''}`;
}

/**
 * Demi-profil de l'outil dans le plan (r, z) : z = 0 sur la face, z > 0 dans la matière.
 * L'outil dépasse de `over` au-dessus de la face (pas de faces coplanaires dans le booléen) ;
 * un trou borgne se termine par la pointe du foret à 118°. `through` = longueur d'un trou
 * débouchant (plus grande que le solide).
 */
export function holeProfile(h: HoleSpec, through: number, over = 0.5): [number, number][] {
  const comp = holeComp(h);
  const r = (h.diameter + comp) / 2;
  const depth = h.depth > 0 ? h.depth : through;
  const tip = h.depth > 0 && h.type !== 'insert' ? r / Math.tan((59 * Math.PI) / 180) : 0;
  const pts: [number, number][] = [[0, -over]];
  if (h.type === 'counterbore' && h.cbDiameter && h.cbDepth) {
    const R = (h.cbDiameter + comp) / 2;
    pts.push([R, -over], [R, h.cbDepth], [r, h.cbDepth]);
  } else if (h.type === 'countersink' && h.csDiameter) {
    const R = (h.csDiameter + comp) / 2;
    // fraisure à 90° : cône prolongé au-dessus de la face
    pts.push([R + over, -over], [r, R - r]);
  } else pts.push([r, -over]);
  pts.push([r, depth]);
  if (tip > 0) pts.push([0, depth + tip]);
  else pts.push([0, depth]);
  return pts;
}
