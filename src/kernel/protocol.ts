/**
 * Protocole entre le thread UI et le worker du noyau OpenCascade.
 * Le thread UI ne manipule jamais d'objet OCC : il envoie des descriptions géométriques
 * et reçoit des identifiants de forme (`shapeId`) et des buffers d'affichage.
 */
import type { Vec3 } from '../core/commands/types';
import type { SheetMetalDef } from '../core/geometry/sheetmetal';

/** Profil ou trajectoire décrit à partir des entités 2D du dessin. */
export type ProfileDef =
  | { kind: 'circle'; center: Vec3; radius: number }
  | { kind: 'poly'; points: Vec3[]; closed: boolean; bulges?: number[] }
  | { kind: 'arc'; center: Vec3; radius: number; startAngle: number; endAngle: number }
  | { kind: 'helix'; center: Vec3; baseRadius: number; topRadius: number; height: number; turns: number; ccw: boolean };

/** Matrice 3×4 ligne par ligne (rotation/échelle uniforme + translation). */
export type Affine = [number, number, number, number, number, number, number, number, number, number, number, number];

export type KernelRequest = KernelOp & {
  /**
   * Étape intermédiaire d'une construction : le résultat n'est pas triangulé
   * (`display` ne contient que volume, boîte et nombre de solides).
   */
  lazy?: boolean;
};

export type KernelOp =
  | { op: 'box'; corner: Vec3; size: Vec3 }
  /** `axis` : direction de l'axe (Z par défaut). */
  | { op: 'cylinder'; center: Vec3; radius: number; height: number; axis?: Vec3 }
  | { op: 'cone'; center: Vec3; radius: number; topRadius: number; height: number; axis?: Vec3 }
  | { op: 'sphere'; center: Vec3; radius: number }
  | { op: 'torus'; center: Vec3; radius: number; tubeRadius: number }
  | { op: 'pyramid'; center: Vec3; sides: number; radius: number; topRadius: number; height: number; rotation: number }
  /** `surface` : crée une surface (profil ouvert accepté) au lieu d'un solide. */
  | { op: 'extrude'; profile: ProfileDef; height: number; taperDeg: number; surface?: boolean; direction?: Vec3 }
  | { op: 'revolve'; profile: ProfileDef; axisStart: Vec3; axisEnd: Vec3; angleDeg: number; startDeg: number; surface?: boolean }
  | { op: 'sweep'; profile: ProfileDef; path: ProfileDef; align: boolean; surface?: boolean }
  | { op: 'loft'; sections: ProfileDef[]; ruled: boolean; surface?: boolean }
  /** Régions planes à trous (lettres d'un texte 3D) extrudées le long de `direction`. */
  | { op: 'extrudeRegions'; regions: { outer: Vec3[]; holes: Vec3[][] }[]; direction: Vec3 }
  /** Surface plane bornée par un contour fermé. */
  | { op: 'planeSurface'; profile: ProfileDef }
  /** Surface de raccord (carreau) bornée par des courbes formant une boucle. */
  | { op: 'patch'; edges: ProfileDef[] }
  /** Épaissir une surface en solide. */
  | { op: 'thicken'; shapeId: string; thickness: number }
  /** Coupe par un plan : conserve les deux moitiés ou un seul côté (normale = côté positif). */
  | { op: 'slice'; shapeId: string; origin: Vec3; normal: Vec3; keep: 'both' | 'positive' | 'negative' }
  | { op: 'check'; shapeId: string }
  /** `exact` : ni tolérance floue ni fusion des faces (formes hélicoïdales : filetages). */
  | { op: 'boolean'; kind: 'union' | 'subtract' | 'intersect'; targets: string[]; tools: string[]; exact?: boolean }
  /** `radius2` : rayon de fin d'arête (congé à rayon variable linéaire). */
  | { op: 'fillet'; shapeId: string; edges: number[] | 'all'; radius: number; radius2?: number }
  | { op: 'chamfer'; shapeId: string; edges: number[] | 'all'; distance: number }
  | { op: 'shell'; shapeId: string; faces: number[]; thickness: number }
  /** Appuyer/tirer : face plane déplacée de `distance` le long de sa normale extérieure. */
  | { op: 'pressPull'; shapeId: string; face: number; distance: number }
  | { op: 'transform'; shapeId: string; matrix: Affine }
  | { op: 'display'; shapeId: string }
  | { op: 'exportMesh'; shapeIds: string[]; linearDeflection: number; angularDeflectionDeg: number }
  | { op: 'exportStep'; shapeIds: string[] }
  | { op: 'importStep'; data: Uint8Array }
  /** Maillage importé (STL, 3MF) → solide (fermé) ou surface ; `merge` : fusion des faces coplanaires. */
  | { op: 'meshToSolid'; positions: Float64Array; indices: Uint32Array; closed: boolean; merge: boolean }
  /** Maillage importé gardé tel quel (corps maillé : booléens et coupe par manifold-3d). */
  | { op: 'meshBody'; positions: Float64Array; indices: Uint32Array; closed: boolean }
  /** Corps maillé → solide B-rep (CONVSOLIDE). */
  | { op: 'convertToSolid'; shapeId: string; merge: boolean }
  | { op: 'saveBrep'; shapeId: string }
  | { op: 'loadBrep'; data: Uint8Array }
  /**
   * Projection à lignes cachées (mise en plan) : arêtes vues depuis `dir` (vers l'observateur),
   * exprimées dans le repère de la vue (x = `xDir`, y = dir × xDir).
   */
  | { op: 'hlr'; shapeIds: string[]; dir: Vec3; xDir: Vec3; hidden: boolean; smooth: boolean }
  /** Tôle pliée : tôle de base + bords (voir core/geometry/sheetmetal). */
  | { op: 'sheetMetal'; def: SheetMetalDef }
  /** Libère des formes intermédiaires (mémoire du noyau). */
  | { op: 'release'; shapeIds: string[] };

/** Courbe 2D d'une vue projetée (repère de la vue). */
export type HlrCurve =
  | { k: 'line'; a: [number, number]; b: [number, number] }
  /** Arc (sens trigonométrique de a0 à a1, radians) ; `full` : cercle complet. */
  | { k: 'arc'; c: [number, number]; r: number; a0: number; a1: number; full: boolean }
  | { k: 'poly'; pts: [number, number][] };

export interface HlrResult {
  visible: HlrCurve[];
  hidden: HlrCurve[];
  /** Arêtes tangentes (raccords) visibles, tracées en trait fin. */
  smooth: HlrCurve[];
  /** Faces cylindriques (axes et marques de centre) : axe, rayon, étendue le long de l'axe. */
  cylinders: { c: Vec3; d: Vec3; r: number; t0: number; t1: number }[];
}

/** Maillage d'affichage : sommets non soudés par face (arêtes vives), identifiant de face par triangle. */
export interface DisplayMesh {
  positions: Float32Array;
  indices: Uint32Array;
  /** Index (0-based) de la face B-rep de chaque triangle. */
  faceIds: Uint32Array;
  /** Polylignes d'arêtes concaténées (x,y,z…) ; `edgeOffsets[i]` = premier sommet de l'arête i. */
  edgePoints: Float32Array;
  edgeOffsets: Uint32Array;
  volume: number;
  area: number;
  bbox: { min: Vec3; max: Vec3 };
  faceCount: number;
  edgeCount: number;
  /** 0 pour une surface (affichage double face). */
  solidCount: number;
  /** Corps maillé (STL/3MF importé) : nombre de triangles. Absent pour un solide B-rep. */
  meshTriangles?: number;
}

export interface CheckReport {
  valid: boolean;
  solids: number;
  shells: number;
  faces: number;
  edges: number;
  /** Arêtes libres (bord ouvert) : 0 pour un solide étanche. */
  freeEdges: number;
  volume: number;
}

export interface SolidResult {
  shapeId: string;
  display: DisplayMesh;
  warnings: string[];
}

export type KernelResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
