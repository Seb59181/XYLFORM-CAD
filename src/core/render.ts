/**
 * Rendu réaliste : sources de lumière du dessin, textures (images plaquées sur les faces des
 * solides) et réglages d'ambiance (environnement, exposition, occlusion ambiante).
 *
 * Tout est stocké dans le document (enregistré dans le .xcad) ; ce module ne dépend pas de
 * Three.js, il ne contient que les types, les valeurs par défaut et des calculs purs.
 */
import type { Vec3 } from './commands/types';

export type LightKind = 'point' | 'spot' | 'directional';

/** Source de lumière posée dans le dessin (LUMIERE). */
export interface LightDef {
  id: string;
  name: string;
  kind: LightKind;
  /** Position de la lampe (point, projecteur) ; direction d'arrivée pour la lumière directionnelle. */
  position: Vec3;
  /** Point visé (projecteur, lumière directionnelle). */
  target: Vec3;
  /** Couleur #RRGGBB. */
  color: string;
  /** Intensité en % : 100 = éclairage de référence au centre du modèle. */
  intensity: number;
  /** Projecteur : demi-angle du cône (degrés) et flou du bord (0–1). */
  angle?: number;
  penumbra?: number;
  /** Ombres portées (styles Rendu et Photoréaliste). */
  shadows: boolean;
  on: boolean;
}

/** Image de texture du dessin (TEXTURE) : octets d'origine, partagés par plusieurs solides. */
export interface TextureDef {
  id: string;
  name: string;
  mime: string;
  data: Uint8Array;
  /** Taille de l'image en pixels (information). */
  width?: number;
  height?: number;
  /**
   * Matériau de la bibliothèque intégrée (textureLibrary.ts) dont l'image vient : la vue y ajoute
   * son relief et sa rugosité. Absent = image importée (relief tiré de la photo).
   */
  library?: string;
}

/** Texture appliquée à un solide : taille d'un motif sur la pièce (mm), rotation, décalage. */
export interface TextureMapping {
  ref: string;
  /** Largeur d'un motif de l'image en mm (la hauteur suit les proportions de l'image). */
  size: number;
  /** Rotation du motif (degrés). */
  angle?: number;
  /** Décalage du motif (mm). */
  offsetU?: number;
  offsetV?: number;
  /**
   * Relief en % (Xylform CAD ≥ 1.6) : 100 = relief réel du matériau de la bibliothèque, ou relief
   * modéré tiré de l'image pour une photo importée ; 0 = surface lisse. Absent = 100 pour la
   * bibliothèque, 0 pour une image importée (dessins des versions précédentes inchangés).
   */
  relief?: number;
}

/** Relief effectif d'une texture (%). */
export function reliefPercent(m: Pick<TextureMapping, 'relief'>, def: Pick<TextureDef, 'library'> | undefined): number {
  const r = m.relief ?? (def?.library ? 100 : 0);
  return Number.isFinite(r) ? Math.min(400, Math.max(0, r)) : 0;
}

export type EnvironmentKind = 'studio' | 'outdoor' | 'workshop' | 'night';

/** Ambiance du rendu réaliste. */
export interface RenderEnvironment {
  environment: EnvironmentKind;
  /** Intensité de l'éclairage d'environnement (%). */
  envIntensity: number;
  /** Exposition (%) : 100 = neutre. */
  exposure: number;
  /** Occlusion ambiante (coins et creux assombris, style Photoréaliste). */
  ambientOcclusion: boolean;
  /** Fond du style Photoréaliste : environnement flou ou couleur de l'écran. */
  background: 'environment' | 'screen';
  /** Éclairage par défaut (soleil) gardé en plus des lumières du dessin. */
  defaultLights: boolean;
  /** Sol qui reçoit les ombres. */
  ground: boolean;
}

export const DEFAULT_RENDER_ENV: RenderEnvironment = {
  environment: 'studio',
  envIntensity: 100,
  exposure: 100,
  ambientOcclusion: true,
  background: 'environment',
  defaultLights: true,
  ground: true,
};

export const ENVIRONMENT_LABEL: Record<EnvironmentKind, string> = {
  studio: 'Studio photo (lumière douce)',
  outdoor: 'Extérieur (ciel et soleil)',
  workshop: 'Atelier (lumière chaude)',
  night: 'Nuit (seules vos lumières éclairent)',
};

export const LIGHT_KIND_LABEL: Record<LightKind, string> = {
  point: 'Ampoule (ponctuelle)',
  spot: 'Projecteur (cône)',
  directional: 'Soleil (directionnelle)',
};

/** Couleurs de lumière usuelles (température de couleur). */
export const LIGHT_PRESETS: { label: string; color: string }[] = [
  { label: 'Bougie 1900 K', color: '#ff9329' },
  { label: 'Ampoule chaude 2700 K', color: '#ffb46b' },
  { label: 'Blanc chaud 3000 K', color: '#ffc58f' },
  { label: 'Blanc neutre 4000 K', color: '#ffe2c6' },
  { label: 'Lumière du jour 5500 K', color: '#fff4ea' },
  { label: 'Blanc froid 6500 K', color: '#fff9fd' },
  { label: 'Ciel bleu 10 000 K', color: '#c9dcff' },
];

export function newLightId(lights: LightDef[]): string {
  let i = 1;
  while (lights.some((l) => l.id === `L${i}`)) i++;
  return `L${i}`;
}

export function newTextureId(textures: Record<string, TextureDef>): string {
  let i = 1;
  while (textures[`T${i}`]) i++;
  return `T${i}`;
}

/** Lumière par défaut d'un type donné, posée en `position` et visant `target`. */
export function defaultLight(lights: LightDef[], kind: LightKind, position: Vec3, target: Vec3): LightDef {
  const id = newLightId(lights);
  const n = lights.filter((l) => l.kind === kind).length + 1;
  const base = { point: 'Ampoule', spot: 'Projecteur', directional: 'Soleil' }[kind];
  return {
    id,
    name: `${base} ${n}`,
    kind,
    position: { ...position },
    target: { ...target },
    color: kind === 'directional' ? '#fff4ea' : '#ffc58f',
    intensity: 100,
    ...(kind === 'spot' ? { angle: 30, penumbra: 0.3 } : {}),
    shadows: true,
    on: true,
  };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Valeurs bornées (fichier modifié à la main, saisie hors limites). */
export function sanitizeLight(l: LightDef): LightDef {
  return {
    ...l,
    intensity: clamp(Number.isFinite(l.intensity) ? l.intensity : 100, 0, 2000),
    color: /^#[0-9a-f]{6}$/i.test(l.color) ? l.color.toLowerCase() : '#ffffff',
    ...(l.kind === 'spot' ? { angle: clamp(l.angle ?? 30, 1, 89), penumbra: clamp(l.penumbra ?? 0.3, 0, 1) } : {}),
  };
}

export function sanitizeEnv(e: Partial<RenderEnvironment> | undefined): RenderEnvironment {
  const v = { ...DEFAULT_RENDER_ENV, ...(e ?? {}) };
  return {
    ...v,
    environment: v.environment in ENVIRONMENT_LABEL ? v.environment : 'studio',
    envIntensity: clamp(v.envIntensity, 0, 400),
    exposure: clamp(v.exposure, 10, 400),
  };
}

/**
 * Coordonnées de texture « projection cubique » : chaque sommet est projeté sur le plan
 * perpendiculaire à l'axe dominant de sa normale (XY pour le dessus et le dessous, XZ pour
 * l'avant et l'arrière, YZ pour les côtés). Les coordonnées sont en motifs : 1 = une image.
 * `aspect` = hauteur / largeur de l'image (le motif garde les proportions de l'image).
 */
export function boxUVs(positions: ArrayLike<number>, normals: ArrayLike<number>, m: Pick<TextureMapping, 'size' | 'angle' | 'offsetU' | 'offsetV'>, aspect = 1): Float32Array {
  const n = Math.floor(positions.length / 3);
  const uv = new Float32Array(n * 2);
  const su = 1 / Math.max(1e-6, m.size);
  const sv = 1 / Math.max(1e-6, m.size * (aspect > 0 ? aspect : 1));
  const a = ((m.angle ?? 0) * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a);
  const ou = m.offsetU ?? 0, ov = m.offsetV ?? 0;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3]!, y = positions[i * 3 + 1]!, z = positions[i * 3 + 2]!;
    const nx = Math.abs(normals[i * 3]!), ny = Math.abs(normals[i * 3 + 1]!), nz = Math.abs(normals[i * 3 + 2]!);
    let u: number, v: number;
    if (nz >= nx && nz >= ny) {
      u = x;
      v = normals[i * 3 + 2]! >= 0 ? y : -y;
    } else if (ny >= nx) {
      u = normals[i * 3 + 1]! <= 0 ? x : -x;
      v = z;
    } else {
      u = normals[i * 3]! >= 0 ? y : -y;
      v = z;
    }
    const ru = u * ca - v * sa - ou, rv = u * sa + v * ca - ov;
    uv[i * 2] = ru * su;
    uv[i * 2 + 1] = rv * sv;
  }
  return uv;
}

/**
 * Intensité Three.js d'une lampe ponctuelle ou d'un projecteur (décroissance physique en 1/d²) :
 * `percent` = 100 donne au point de référence (centre du modèle) le même éclairement qu'une
 * lumière directionnelle d'intensité `reference`.
 */
export function pointIntensity(percent: number, distance: number, reference = 2.4): number {
  const d = Math.max(distance, 1e-3);
  return (percent / 100) * reference * d * d;
}
