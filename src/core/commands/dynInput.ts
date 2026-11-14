/**
 * Saisie dynamique à deux champs : près du curseur, la valeur tapée est
 * découpée en deux cases que Tab fait passer de l'une à l'autre.
 *
 * - « polar » : point demandé après un point de base → Longueur Tab Angle (« 100<30 »), relatif ;
 * - « xy » : coin opposé d'un rectangle (`dynBase`) ou point sans point de base → X Tab Y (« 100,50 »). Il est relatif à `dynBase`
 *   quand le prompt en donne un (2e coin du RECTANGLE : largeur Tab hauteur), absolu sinon.
 *
 * Tant qu'une case est remplie, le curseur est « verrouillé » sur cette valeur (aperçu et clic),
 * comme pour la saisie directe : taper 100 puis cliquer pose le point à 100 dans la direction du curseur.
 */
import { promptAxis, type PromptSpec, type Vec3 } from './types';
import { evaluateAngle, evaluateNumber } from './InputParser';

export type DynMode = 'polar' | 'xy';

export interface DynLayout {
  mode: DynMode;
  /** Point de référence des valeurs tapées (null = coordonnées absolues). */
  base: Vec3 | null;
  labels: [string, string];
}

/** Disposition des cases pour ce prompt (null = une seule valeur, pas de cases). */
export function dynLayout(spec: PromptSpec | null | undefined, relative = true): DynLayout | null {
  if (!spec || spec.kind !== 'point' || promptAxis(spec)) return null;
  if (spec.dynBase && relative) return { mode: 'xy', base: spec.dynBase, labels: spec.dynLabels ?? ['ΔX', 'ΔY'] };
  if (spec.basePoint && relative) return { mode: 'polar', base: spec.basePoint, labels: ['Longueur', 'Angle'] };
  return { mode: 'xy', base: null, labels: ['X', 'Y'] };
}

export const dynSeparator = (mode: DynMode): string => (mode === 'polar' ? '<' : ',');

/** Texte tapé déjà explicite (@, #, coordonnées 3D, mot-clé…) : pas de découpage en cases. */
function explicit(text: string, mode: DynMode): boolean {
  const s = text.trim();
  if (/^[@#]/.test(s)) return true;
  if (mode === 'polar' && s.includes(',')) return true;
  if (mode === 'xy' && (s.includes('<') || s.split(',').length > 2)) return true;
  return /[a-z]/i.test(s.replace(/\b(pi|sqrt|sin|cos|tan)\b/gi, '').replace(/[dgr]$/i, ''));
}

/** Cases remplies et case active (0 ou 1) ; null si le texte ne se découpe pas en cases. */
export function splitDyn(text: string, mode: DynMode): { fields: [string, string]; active: 0 | 1 } | null {
  if (explicit(text, mode)) return null;
  const sep = dynSeparator(mode);
  const i = text.indexOf(sep);
  if (i < 0) return { fields: [text, ''], active: 0 };
  return { fields: [text.slice(0, i), text.slice(i + 1)], active: 1 };
}

/** Tab : passe à la seconde case (ajoute le séparateur) ou revient à la première. */
export function tabDyn(text: string, mode: DynMode): string {
  const parts = splitDyn(text, mode);
  if (!parts) return text;
  const sep = dynSeparator(mode);
  if (parts.active === 0) return parts.fields[0].trim() ? `${parts.fields[0]}${sep}` : text;
  return parts.fields[1] ? text : parts.fields[0];
}

/**
 * Point du curseur verrouillé sur les cases remplies (aperçu et clic) ; null si rien n'est tapé
 * ou si la valeur n'est pas encore un nombre.
 */
export function constrainDyn(layout: DynLayout, text: string, cursor: Vec3): Vec3 | null {
  const parts = splitDyn(text, layout.mode);
  if (!parts) return null;
  const [a, b] = parts.fields.map((f) => f.trim());
  if (!a && !b) return null;
  if (layout.mode === 'polar') {
    const base = layout.base!;
    const L = a ? evaluateNumber(a) : null;
    const ang = b ? evaluateAngle(b) : null;
    if ((a && L === null) || (b && ang === null)) return null;
    const dx = cursor.x - base.x, dy = cursor.y - base.y, dz = cursor.z - base.z;
    const cur = Math.hypot(dx, dy, dz);
    if (ang !== null) {
      const len = L ?? Math.hypot(dx, dy);
      return { x: base.x + len * Math.cos(ang), y: base.y + len * Math.sin(ang), z: base.z };
    }
    if (L === null || cur < 1e-12) return null;
    return { x: base.x + (dx / cur) * L, y: base.y + (dy / cur) * L, z: base.z + (dz / cur) * L };
  }
  const x = a ? evaluateNumber(a) : null;
  const y = b ? evaluateNumber(b) : null;
  if ((a && x === null) || (b && y === null)) return null;
  const o = layout.base ?? { x: 0, y: 0, z: cursor.z };
  return { x: x === null ? cursor.x : o.x + x, y: y === null ? cursor.y : o.y + y, z: layout.base ? layout.base.z : cursor.z };
}
