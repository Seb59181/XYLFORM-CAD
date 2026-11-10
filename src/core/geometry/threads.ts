/**
 * Profil de filet métrique ISO 68-1 (60°) utilisé pour le filetage réel, avec jeu d'impression.
 *
 * Le jeu `gap` est mesuré PERPENDICULAIREMENT aux flancs (et radialement au sommet et au fond) :
 * c'est le vrai espace entre la vis imprimée et son taraudage. Grossir seulement le diamètre ne
 * laisse sur un flanc à 60° que le quart du jeu (ancienne méthode, jusqu'à la 1.9.5).
 *
 * La dent est décrite dans le plan (r, z) autour de son milieu (z = 0) : base (côté axe) à
 * `rBase`, demi-largeur `base` ; sommet à `rCrest`, demi-largeur `tip`. Le noyau cylindrique
 * de rayon `core` porte la dent.
 */
export interface ThreadProfile {
  rBase: number;
  rCrest: number;
  /** Demi-largeur de la dent à la base et au sommet (axiale). */
  base: number;
  tip: number;
  /** Rayon du noyau (cylindre qui porte le filet). */
  core: number;
  /** Jeu appliqué (éventuellement plafonné). */
  gap: number;
  /** Le jeu demandé dépassait le maximum admissible pour ce pas. */
  capped: boolean;
}

/** Jeu maximal par côté pour un pas donné : au-delà le filet du taraudage disparaît. */
export const maxThreadGap = (pitch: number): number => Math.round(0.2 * pitch * 1000) / 1000;

/** Demi-largeur maximale d'une dent à sa base (les spires voisines ne doivent pas se toucher). */
const MAX_HALF = 0.47;

export function threadProfile(d: number, p: number, gap = 0): ThreadProfile {
  const H = 0.866 * p;
  const r1 = d / 2 - (5 / 8) * H; // rayon à fond de filet
  const rIn = r1 - 0.05 * p; // la base de la dent est noyée dans le cœur
  const flank = p * 0.4375; // demi-largeur à la base, laisse un jeu entre les spires
  const tip0 = p / 16;
  const R = d / 2;
  const g = Math.min(Math.max(0, gap), maxThreadGap(p));
  // flanc inférieur de (rIn, -flank) à (R, -tip0), décalé de g vers l'extérieur de la dent
  const dr = R - rIn, dz = flank - tip0, L = Math.hypot(dr, dz);
  const ar = rIn + (g * dz) / L, az = -flank - (g * dr) / L;
  const slope = dz / dr;
  const half = (r: number) => -(az + (r - ar) * slope);
  const rCrest = R + g;
  let rBase = rIn + g;
  // dent trop large à la base : on la remonte (le cœur grossit, l'engagement diminue)
  if (half(rBase) > MAX_HALF * p) rBase = ar + (-MAX_HALF * p - az) / slope;
  return { rBase, rCrest, base: half(rBase), tip: half(rCrest), core: rBase + 0.06 * p, gap: g, capped: gap > g + 1e-9 };
}

/**
 * Profondeur d'engagement radiale entre une vis nominale et un taraudage creusé avec ce jeu
 * (Ø extérieur de la vis − Ø intérieur du taraudage) / 2.
 */
export function threadEngagement(d: number, p: number, gap: number): number {
  return d / 2 - threadProfile(d, p, gap).core;
}
