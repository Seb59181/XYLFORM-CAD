/**
 * Base de données du dessin : entités indexées par handle, table des calques, contraintes
 * paramétriques, variables système et journal annuler/rétablir.
 *
 * Les entités sont immuables : chaque modification produit un nouvel objet. Un instantané
 * du journal ne copie donc que des références (les maillages et les formes B-rep, conservées
 * dans le worker du noyau, ne sont jamais dupliqués).
 */
import type { Vec3 } from '../commands/types';
import type { Affine, DisplayMesh, KernelOp } from '../../kernel/protocol';
import type { Constraint, NewConstraint } from '../constraints/types';
import { isIsometry, multiply } from '../math/affine';
import type { HoleSpec } from '../geometry/holes';
import type { Linetype } from '../linetypes';

export interface LayerDef {
  name: string;
  /** Couleur TrueColor (#RRGGBB). */
  color: string;
  /** Épaisseur de ligne en mm. */
  lineweight: number;
  /** Type de ligne (continu par défaut). */
  linetype?: Linetype;
  visible: boolean;
  frozen: boolean;
  locked: boolean;
}

interface EntityBase {
  handle: string;
  layer: string;
  /** Couleur propre (sinon DuCalque). */
  color?: string;
  /** Masqué individuellement (œil du Navigateur, MASQUEROBJETS), indépendamment du calque. */
  hidden?: boolean;
}

export type TextAlign = 'left' | 'center' | 'right';
export type TextVAlign = 'baseline' | 'bottom' | 'middle' | 'top';
export type HatchPattern = 'SOLID' | 'ANSI31' | 'ANSI37' | 'NET' | 'GRADIENT';

export type Entity =
  | (EntityBase & { type: 'LINE'; start: Vec3; end: Vec3 })
  | (EntityBase & { type: 'CIRCLE'; center: Vec3; radius: number })
  /** Arc dans le sens trigonométrique de startAngle à endAngle (radians). */
  | (EntityBase & { type: 'ARC'; center: Vec3; radius: number; startAngle: number; endAngle: number })
  /**
   * Polyligne : `bulges[i]` = renflement du segment i → i+1 (tan(angle inclus / 4), > 0 = sens trigo).
   * Absent ou 0 = segment droit.
   */
  | (EntityBase & { type: 'POLYLINE'; points: Vec3[]; closed: boolean; bulges?: number[] })
  /** Ellipse : demi-grand axe vectoriel et rapport petit/grand axe. */
  | (EntityBase & { type: 'ELLIPSE'; center: Vec3; majorAxis: Vec3; ratio: number })
  /** Spline d'interpolation (passe par les points de lissage). */
  | (EntityBase & { type: 'SPLINE'; fitPoints: Vec3[]; closed: boolean })
  | (EntityBase & { type: 'POINT'; position: Vec3 })
  | (EntityBase & { type: 'HELIX'; center: Vec3; baseRadius: number; topRadius: number; height: number; turns: number; ccw: boolean })
  | (EntityBase & {
      type: 'HATCH';
      boundaries: Vec3[][];
      pattern: HatchPattern;
      scale: number;
      angle: number;
      /** Seconde couleur des dégradés. */
      color2?: string;
    })
  /**
   * Texte (une ou plusieurs lignes séparées par « \n ») : `position` est le
   * point d'accroche défini par `align` (gauche par défaut) et `valign` (ligne de base par défaut).
   */
  | (EntityBase & {
      type: 'TEXT';
      position: Vec3;
      height: number;
      text: string;
      rotation: number;
      align?: TextAlign;
      valign?: TextVAlign;
      /** Facteur de largeur des caractères, 1 par défaut. */
      widthFactor?: number;
      /** Facteur d'interligne (1 = 5/3 de la hauteur). */
      lineSpacing?: number;
    })
  /**
   * Cote : alignée (p1–p2), linéaire (projection sur la direction `rotation`), rayon ou diamètre
   * (p1 = centre, p2 = point du cercle), angulaire (sommet `center`, côtés par p1 et p2), longueur
   * d'arc (centre `center`, arc de p1 à p2) ou ordonnée (p1 mesuré depuis l'origine `center`).
   * La ligne de cote / le texte passent par `offsetPoint`.
   */
  | (EntityBase & {
      type: 'DIMENSION';
      dimType?: 'aligned' | 'linear' | 'radius' | 'diameter' | 'angular' | 'arclength' | 'ordinate';
      p1: Vec3;
      p2: Vec3;
      offsetPoint: Vec3;
      /** Sommet (angulaire), centre de l'arc (longueur d'arc) ou origine (ordonnée). */
      center?: Vec3;
      /** Cote angulaire entre deux lignes (les côtés sont des droites : quatre secteurs possibles). */
      angLines?: boolean;
      /** Cote ordonnée : coordonnée mesurée (x par défaut). */
      ordAxis?: 'x' | 'y';
      rotation?: number;
      textOverride?: string;
      textHeight?: number;
    })
  /** `primitive` : primitive d'origine (cotes modifiables dans la palette Propriétés). */
  | (EntityBase & { type: '3DSOLID'; name: string; shapeId: string; display: DisplayMesh; primitive?: PrimitiveDef; history?: Feature[]; material?: string; threadsReal?: boolean })
  /**
   * Fond de plan (référence externe) : instance d'une définition `UnderlayDef` du document,
   * placée par point d'insertion, échelle, rotation (radians) et symétrie éventuelle.
   * `bounds` recopie l'emprise locale de la définition (cadre, désignation, zoom).
   */
  | (EntityBase & { type: 'UNDERLAY'; ref: string; position: Vec3; scale: number; rotation: number; mirrored?: boolean; bounds: Bounds });

/** Opérations du noyau qui créent une primitive 3D paramétrique. */
export type PrimitiveOp = Extract<KernelOp, { op: 'box' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'pyramid' }>;

/**
 * Historique d'une primitive : l'opération qui l'a créée et le placement rigide (déplacements,
 * rotations, symétries) appliqué depuis. Reconstruire = rejouer `op` puis `matrix`.
 */
export interface PrimitiveDef {
  op: PrimitiveOp;
  matrix?: Affine;
}

/** Primitive après la transformation `m` ; undefined si `m` change les dimensions (échelle). */
export function placePrimitive(p: PrimitiveDef | undefined, m: Affine): PrimitiveDef | undefined {
  if (!p || !isIsometry(m)) return undefined;
  return { op: p.op, matrix: p.matrix ? multiply(m, p.matrix) : m };
}

/** Opérations du noyau qui créent un corps à partir de rien (premier élément d'un historique). */
export type CreateOp = Extract<KernelOp, { op: 'box' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'pyramid' | 'extrude' | 'revolve' | 'sweep' | 'loft' | 'extrudeRegions' | 'sheetMetal' }>;
/** Opérations qui modifient la forme courante (`shapeId` remplacé à la reconstruction). */
export type ModifyOp = Extract<KernelOp, { op: 'fillet' | 'chamfer' | 'shell' | 'pressPull' | 'thicken' }>;

/**
 * Étape de l'historique paramétrique d'un corps (une chronologie des opérations) : rejouer les
 * étapes dans l'ordre reconstruit le corps ; modifier une cote d'une étape reconstruit tout ce
 * qui suit. `exprs` : cotes liées à des expressions (paramètres utilisateur, ex. `ep*2`).
 * `off` : étape supprimée (ignorée à la reconstruction).
 */
export type Feature = (
  | { kind: 'create'; op: CreateOp }
  | { kind: 'modify'; op: ModifyOp }
  | { kind: 'transform'; matrix: Affine }
  | { kind: 'boolean'; bool: 'union' | 'subtract' | 'intersect'; tools: Feature[][] }
  | { kind: 'hole'; spec: HoleSpec; at: Vec3[]; normal: Vec3 }
  /**
   * Pièce de la bibliothèque (identifiant, valeurs, solide n° `index`, placement). Gardée pour
   * les filetages réels (`realThread`) : aperçu cosmétique au dessin, filet exact à l'export.
   */
  | { kind: 'part'; part: string; values: Record<string, number | string>; index: number; matrix: Affine; realThread?: boolean }
) & { id: string; name: string; off?: boolean; exprs?: Record<string, string> };

let featureSeq = 0;
export const featureId = (): string => `f${Date.now().toString(36)}${(featureSeq++).toString(36)}`;

/** Historique après une transformation : fusionnée avec une transformation finale existante. */
export function placeHistory(h: Feature[] | undefined, m: Affine): Feature[] | undefined {
  if (!h) return undefined;
  const last = h[h.length - 1];
  if (last?.kind === 'transform' && !last.off) return [...h.slice(0, -1), { ...last, matrix: multiply(m, last.matrix) }];
  return [...h, { kind: 'transform', matrix: m, id: featureId(), name: 'Déplacement' }];
}

/**
 * Liaison d'assemblage : les corps `parts` tournent (pivot) ou glissent
 * (glissière) autour / le long de l'axe `origin` + `axis`. `value` est la position courante
 * (degrés ou unités du dessin) déjà appliquée à la géométrie, bornée par `min` et `max`.
 */
export interface Joint {
  id: string;
  name: string;
  type: 'revolute' | 'slider';
  parts: string[];
  origin: Vec3;
  axis: Vec3;
  value: number;
  min: number;
  max: number;
}

/** Vue projetée d'une mise en plan (régénérée par MAJVUES quand le modèle change). */
export interface DrawingView {
  id: string;
  name: string;
  /** Solides projetés. */
  sources: string[];
  /** Direction vers l'observateur et axe horizontal de la vue. */
  dir: Vec3;
  xDir: Vec3;
  /** Point du dessin où tombe l'origine du modèle projetée. */
  at: Vec3;
  hidden: boolean;
  smooth: boolean;
  axes: boolean;
  /** Entités générées (arêtes, axes, titre). */
  handles: string[];
}

export type PaperFormat = 'A4' | 'A3' | 'A2' | 'A1' | 'A0';

/** Feuille de mise en plan : vues vraie grandeur, cadre et cartouche agrandis de 1/échelle. */
export interface DrawingSheet {
  id: string;
  name: string;
  /** Format papier, ou null (vues seules, sans cadre). */
  format: PaperFormat | null;
  landscape: boolean;
  /** Unités du dessin par mm papier (2 pour une échelle 1:2). */
  k: number;
  /** Coin inférieur gauche du cadre. */
  origin: Vec3;
  title: string;
  frame: string[];
  views: DrawingView[];
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
}

export type UnderlayKind = 'dwg' | 'dxf' | 'pdf' | 'image';

/**
 * Définition d'un fond de plan : contenu d'un DWG/DXF (entités dans leurs propres coordonnées,
 * non modifiables) ou image (PNG/JPEG, PDF rasterisé). Partagée par toutes ses instances.
 */
export interface UnderlayDef {
  id: string;
  /** Nom affiché (unique dans le dessin). */
  name: string;
  kind: UnderlayKind;
  fileName: string;
  /** Chemin complet du fichier source (version bureau) : rechargement sans redemander. */
  path?: string;
  /** Chargé (affiché) ou déchargé. */
  loaded: boolean;
  /** Estompage 0 à 90 %. */
  fade: number;
  /** Affichage en gris. */
  monochrome: boolean;
  /** Images / PDF : clair et foncé inversés pour rester lisibles sur le fond sombre. */
  adjustColors?: boolean;
  entities?: NewEntity[];
  /** Calques du fond, avec leur visibilité propre. */
  layers?: { name: string; color: string; visible: boolean }[];
  /** Image : octets PNG/JPEG et taille en pixels ; un pixel vaut `pixelSize` unités. */
  image?: { data: Uint8Array; mime: string; pxWidth: number; pxHeight: number; pixelSize: number };
  /** PDF : numéro de page. */
  page?: number;
  bounds: Bounds;
  /** Unités du fichier source ($INSUNITS : 1 pouce, 4 mm, 5 cm, 6 m…). */
  units?: number;
  /** Date de chargement (ms). */
  loadedAt: number;
}

export type EntityType = Entity['type'];

/** Vue nommée : position de caméra (comme `ViewState` de l'application) et style visuel. */
export interface NamedView {
  name: string;
  view: {
    projection: 'perspective' | 'orthographic';
    position: Vec3;
    target: Vec3;
    up: Vec3;
    halfHeight: number;
  };
  /** Style visuel enregistré avec la vue (réaliste, technique…). */
  style?: string;
  workspace?: '2d' | '3d';
}

/** Entité avant insertion (handle et calque attribués par le document). */
export type NewEntity = Entity extends infer E ? (E extends Entity ? Omit<E, 'handle' | 'layer'> & { layer?: string } : never) : never;

interface Snapshot {
  entities: Entity[];
  constraints: Constraint[];
  joints: Joint[];
  sheets: DrawingSheet[];
  underlays: Record<string, UnderlayDef>;
  parameters: Record<string, string>;
  label: string;
}

export interface DocumentChange {
  /** Handles ajoutés ou modifiés pendant la dernière transaction. */
  touched: Set<string>;
  removed: Set<string>;
}

export class DrawingDocument {
  private entities = new Map<string, Entity>();
  private nextHandle = 0x100;
  private readonly undoStack: Snapshot[] = [];
  private readonly redoStack: Snapshot[] = [];
  private readonly listeners = new Set<(c: DocumentChange) => void>();
  private openTx: string | null = null;
  /** Groupe d'annulation ouvert (toute une commande interactive = une seule étape). */
  private group: { label: string; pushed: boolean } | null = null;
  private pendingChange: DocumentChange = { touched: new Set(), removed: new Set() };
  /** Version incrémentée à chaque changement (pour React). */
  version = 0;
  /** Le document a des modifications non enregistrées. */
  dirty = false;
  fileName = 'Dessin1.xcad';

  constraints: Constraint[] = [];
  private nextConstraint = 1;

  layers: LayerDef[] = defaultLayers();
  currentLayer = '0';
  /** États de calque nommés (Gestionnaire des états de calque). */
  layerStates: Record<string, LayerDef[]> = {};
  /** Paramètres utilisateur (Gestionnaire de paramètres), utilisables dans les cotes pilotées. */
  parameters: Record<string, string> = {};
  /** Définitions des fonds de plan (références externes), par identifiant. */
  underlays: Record<string, UnderlayDef> = {};
  /** Liaisons d'assemblage (pivots, glissières). */
  joints: Joint[] = [];
  private nextJoint = 1;
  /** Feuilles de mise en plan. */
  sheets: DrawingSheet[] = [];
  /** Vues nommées (VUESNOMMEES) : cadrage, projection et style visuel (scènes). */
  namedViews: NamedView[] = [];

  readonly sysvars = {
    CIRCLERAD: 0,
    FILLETRAD: 0,
    CHAMFERA: 0,
    OFFSETDIST: 10,
    HPNAME: 'ANSI31' as HatchPattern,
    HPSCALE: 1,
    /** Angle des hachures (degrés). */
    HPANG: 0,
    /** Seconde couleur des dégradés. */
    HPCOLOR2: '#1d3557',
    /** Distances de chanfrein et rayon des congés 3D. */
    CHAMFERB: 0,
    FILLETRAD3D: 1,
    DIMTXT: 2.5,
    DIMASZ: 2.5,
    /** Décimales affichées des cotes. */
    DIMDEC: 2,
    /** Écart entre cotes empilées (COTLIGNEBASE) ; 0 = 2,2 × hauteur du texte. */
    DIMDLI: 0,
    /** Origine des cotes ordonnées (COTORD › Origine). */
    ORDBASEX: 0,
    ORDBASEY: 0,
    TEXTSIZE: 2.5,
    /** Unités d'insertion : 4 = millimètres. */
    INSUNITS: 4,
    POLYSIDES: 6,
    /** Échelle des types de ligne (longueur des tirets). */
    LTSCALE: 1,
  };

  subscribe(fn: (c: DocumentChange) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    this.dirty = true;
    const change = this.pendingChange;
    this.pendingChange = { touched: new Set(), removed: new Set() };
    for (const fn of this.listeners) fn(change);
  }

  // --- Transactions ----------------------------------------------------------

  /** Regroupe plusieurs modifications en une seule étape d'annulation. */
  transaction<T>(label: string, fn: () => T): T {
    if (this.openTx) return fn();
    this.touch(label);
    this.openTx = label;
    try {
      return fn();
    } finally {
      this.openTx = null;
      this.emit();
    }
  }

  private snapshot(label: string): Snapshot {
    return { entities: [...this.entities.values()], constraints: [...this.constraints], joints: this.joints, sheets: this.sheets, underlays: this.underlays, parameters: this.parameters, label };
  }

  private pushUndo(label: string): void {
    this.undoStack.push(this.snapshot(label));
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private touch(label: string): void {
    if (this.openTx) return;
    if (this.group) {
      if (!this.group.pushed) this.pushUndo(this.group.label), (this.group.pushed = true);
      return;
    }
    this.pushUndo(label);
  }

  /** Ouvre un groupe d'annulation : les modifications suivantes forment une seule étape. */
  beginGroup(label: string): void {
    if (!this.group) this.group = { label, pushed: false };
  }

  endGroup(): void {
    this.group = null;
  }

  private restore(s: Snapshot): void {
    const before = new Set(this.entities.keys());
    this.entities = new Map(s.entities.map((e) => [e.handle, e]));
    this.constraints = [...s.constraints];
    this.joints = s.joints;
    this.sheets = s.sheets;
    this.underlays = s.underlays;
    if (s.parameters !== this.parameters) this.paramsVersion++;
    this.parameters = s.parameters;
    for (const h of before) if (!this.entities.has(h)) this.pendingChange.removed.add(h);
    for (const h of this.entities.keys()) this.pendingChange.touched.add(h);
  }

  /**
   * Après un redémarrage du noyau 3D (calcul interrompu) : nouvelles formes des solides, hors
   * annulation. Les états d'annulation désignent des formes perdues : ils sont oubliés.
   */
  rebindShapes(map: Map<string, string>): void {
    for (const [h, e] of this.entities) {
      if (e.type !== '3DSOLID') continue;
      const id = map.get(e.shapeId);
      if (!id) continue;
      this.entities.set(h, { ...e, shapeId: id });
      this.pendingChange.touched.add(h);
    }
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit();
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): string | null {
    this.group = null;
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push(this.snapshot(s.label));
    this.restore(s);
    this.emit();
    return s.label;
  }

  redo(): string | null {
    this.group = null;
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push(this.snapshot(s.label));
    this.restore(s);
    this.emit();
    return s.label;
  }

  // --- Entités ---------------------------------------------------------------

  addEntity(e: NewEntity): string {
    this.touch(`Ajout ${e.type}`);
    const handle = (this.nextHandle++).toString(16).toUpperCase();
    const entity = { ...e, layer: e.layer ?? this.currentLayer, handle } as Entity;
    this.entities.set(handle, entity);
    this.pendingChange.touched.add(handle);
    if (!this.openTx) this.emit();
    return handle;
  }

  removeEntity(handle: string): void {
    if (!this.entities.has(handle)) return;
    this.touch('Effacer');
    this.entities.delete(handle);
    this.pendingChange.removed.add(handle);
    // les contraintes qui portaient sur l'entité disparaissent avec elle
    this.constraints = this.constraints.filter((c) => !c.refs.some((r) => r.handle === handle));
    if (this.joints.some((j) => j.parts.includes(handle)))
      this.joints = this.joints.map((j) => ({ ...j, parts: j.parts.filter((p) => p !== handle) })).filter((j) => j.parts.length);
    if (!this.openTx) this.emit();
  }

  replaceEntity(handle: string, patch: Partial<NewEntity>): void {
    const e = this.entities.get(handle);
    if (!e) return;
    this.touch('Modifier');
    const next = { ...e, ...patch, handle } as Entity;
    // forme remplacée par une autre opération (congé, coque, appuyer/tirer…) : ce n'est plus la primitive
    if (next.type === '3DSOLID' && 'shapeId' in patch && !('primitive' in patch)) delete next.primitive;
    // idem pour l'historique : une opération qui ne l'enregistre pas le rompt (corps « figé »)
    if (next.type === '3DSOLID' && 'shapeId' in patch && !('history' in patch)) delete next.history;
    if (next.type === '3DSOLID' && 'history' in patch && !patch.history) delete next.history;
    if (next.type === '3DSOLID' && 'primitive' in patch && !patch.primitive) delete next.primitive;
    // « filetages exacts » : vrai seulement pour la forme qui a été construite ainsi
    if (next.type === '3DSOLID' && (('shapeId' in patch && !('threadsReal' in patch)) || ('threadsReal' in patch && !patch.threadsReal))) delete next.threadsReal;
    this.entities.set(handle, next);
    this.pendingChange.touched.add(handle);
    if (!this.openTx) this.emit();
  }

  /**
   * Écriture du solveur de contraintes : rattachée à la dernière étape d'annulation
   * (le résultat de la résolution fait partie de la modification de l'utilisateur).
   */
  patchFromSolver(patches: Map<string, Partial<NewEntity>>): void {
    if (!patches.size) return;
    const touched = new Set<string>();
    for (const [handle, patch] of patches) {
      const e = this.entities.get(handle);
      if (e) this.entities.set(handle, { ...e, ...patch, handle } as Entity), touched.add(handle);
    }
    this.version++;
    for (const fn of this.listeners) fn({ touched, removed: new Set() });
  }

  get(handle: string): Entity | undefined {
    return this.entities.get(handle);
  }

  all(): Entity[] {
    return [...this.entities.values()];
  }

  /** Ordre de tracé : place les objets devant (fin de liste) ou derrière (début) tous les autres. */
  reorder(handles: string[], where: 'front' | 'back'): void {
    const set = new Set(handles.filter((h) => this.entities.has(h)));
    if (!set.size) return;
    this.touch('Ordre de tracé');
    const moved = [...this.entities.values()].filter((e) => set.has(e.handle));
    const rest = [...this.entities.values()].filter((e) => !set.has(e.handle));
    const list = where === 'front' ? [...rest, ...moved] : [...moved, ...rest];
    this.entities = new Map(list.map((e) => [e.handle, e]));
    for (const h of set) this.pendingChange.touched.add(h);
    if (!this.openTx) this.emit();
  }

  get size(): number {
    return this.entities.size;
  }

  // --- Contraintes -------------------------------------------------------------

  addConstraint(c: NewConstraint): Constraint {
    this.touch(`Contrainte ${c.type}`);
    const full = { ...c, id: `C${this.nextConstraint++}` } as Constraint;
    this.constraints = [...this.constraints, full];
    if (!this.openTx) this.emit();
    return full;
  }

  updateConstraint(id: string, patch: Partial<Constraint>): void {
    this.touch('Modifier la cote');
    this.constraints = this.constraints.map((c) => (c.id === id ? ({ ...c, ...patch } as Constraint) : c));
    if (!this.openTx) this.emit();
  }

  removeConstraint(id: string): void {
    this.touch('Supprimer la contrainte');
    this.constraints = this.constraints.filter((c) => c.id !== id);
    if (!this.openTx) this.emit();
  }

  // --- Liaisons d'assemblage ------------------------------------------------------

  joint(id: string): Joint | undefined {
    return this.joints.find((j) => j.id === id);
  }

  addJoint(j: Omit<Joint, 'id'>): Joint {
    this.touch('Liaison');
    const full = { ...j, id: `J${this.nextJoint++}` };
    this.joints = [...this.joints, full];
    if (!this.openTx) this.emit();
    return full;
  }

  updateJoint(id: string, patch: Partial<Omit<Joint, 'id'>>): void {
    this.touch('Modifier la liaison');
    this.joints = this.joints.map((j) => (j.id === id ? { ...j, ...patch } : j));
    if (!this.openTx) this.emit();
  }

  removeJoint(id: string): void {
    this.touch('Supprimer la liaison');
    this.joints = this.joints.filter((j) => j.id !== id);
    if (!this.openTx) this.emit();
  }

  // --- Mises en plan ---------------------------------------------------------------

  sheet(id: string): DrawingSheet | undefined {
    return this.sheets.find((s) => s.id === id);
  }

  /** Ajoute ou remplace une feuille (dans la transaction en cours). */
  putSheet(sheet: DrawingSheet): void {
    this.touch('Mise en plan');
    const i = this.sheets.findIndex((s) => s.id === sheet.id);
    this.sheets = i < 0 ? [...this.sheets, sheet] : this.sheets.map((s, k) => (k === i ? sheet : s));
    if (!this.openTx) this.emit();
  }

  removeSheet(id: string): void {
    this.touch('Supprimer la mise en plan');
    this.sheets = this.sheets.filter((s) => s.id !== id);
    if (!this.openTx) this.emit();
  }

  /** Identifiant libre de feuille (F1, F2…). */
  nextSheetId(): string {
    let i = 1;
    while (this.sheets.some((s) => s.id === `F${i}`)) i++;
    return `F${i}`;
  }

  // --- Fonds de plan -------------------------------------------------------------

  underlayInstances(id: string): Extract<Entity, { type: 'UNDERLAY' }>[] {
    return [...this.entities.values()].filter((e): e is Extract<Entity, { type: 'UNDERLAY' }> => e.type === 'UNDERLAY' && e.ref === id);
  }

  /** Ajoute ou remplace une définition (rechargement : les instances suivent la nouvelle emprise). */
  setUnderlayDef(def: UnderlayDef, label = 'Fond de plan'): void {
    this.touch(label);
    this.underlays = { ...this.underlays, [def.id]: def };
    for (const e of this.underlayInstances(def.id)) {
      if (e.bounds !== def.bounds) this.entities.set(e.handle, { ...e, bounds: def.bounds });
      this.pendingChange.touched.add(e.handle);
    }
    if (!this.openTx) this.emit();
  }

  updateUnderlayDef(id: string, patch: Partial<Omit<UnderlayDef, 'id'>>, label = 'Fond de plan'): void {
    const d = this.underlays[id];
    if (d) this.setUnderlayDef({ ...d, ...patch }, label);
  }

  /** Détache une définition et efface toutes ses instances. */
  removeUnderlayDef(id: string): void {
    this.transaction('Détacher le fond de plan', () => {
      for (const e of this.underlayInstances(id)) this.removeEntity(e.handle);
      this.touch('Détacher le fond de plan');
      const { [id]: _, ...rest } = this.underlays;
      this.underlays = rest;
    });
  }

  // --- Calques -----------------------------------------------------------------

  layer(name: string): LayerDef | undefined {
    return this.layers.find((l) => l.name === name);
  }

  /** Entité sélectionnable : calque visible, non gelé, non verrouillé. */
  isPickable(e: Entity): boolean {
    const l = this.layer(e.layer);
    return !!l && l.visible && !l.frozen && !l.locked && !e.hidden;
  }

  isVisible(e: Entity): boolean {
    const l = this.layer(e.layer);
    return !!l && l.visible && !l.frozen && !e.hidden;
  }

  colorOf(e: Entity): string {
    return e.color ?? this.layer(e.layer)?.color ?? '#ffffff';
  }

  updateLayer(name: string, patch: Partial<LayerDef>): void {
    if (patch.name && patch.name !== name) {
      if (this.layer(patch.name)) throw new Error(`Le calque "${patch.name}" existe déjà.`);
      if (name === '0') throw new Error('Le calque 0 ne peut pas être renommé.');
      for (const e of this.entities.values()) if (e.layer === name) this.entities.set(e.handle, { ...e, layer: patch.name });
      if (this.currentLayer === name) this.currentLayer = patch.name;
    }
    if ((patch.frozen || patch.visible === false) && name === this.currentLayer && patch.frozen) {
      throw new Error('Impossible de geler le calque courant.');
    }
    this.layers = this.layers.map((l) => (l.name === name ? { ...l, ...patch } : l));
    for (const e of this.entities.values()) if (e.layer === (patch.name ?? name)) this.pendingChange.touched.add(e.handle);
    this.emit();
  }

  addLayer(name?: string, color?: string): string {
    let n = name;
    if (!n) {
      let i = 1;
      while (this.layer(`Calque${i}`)) i++;
      n = `Calque${i}`;
    }
    if (this.layer(n)) return n;
    const palette = ['#4fa8e8', '#5fb878', '#c678dd', '#e2a847', '#56b6c2', '#ff8c69'];
    this.layers = [
      ...this.layers,
      { name: n, color: color ?? palette[this.layers.length % palette.length]!, lineweight: 0.25, visible: true, frozen: false, locked: false },
    ];
    this.emit();
    return n;
  }

  removeLayer(name: string): void {
    if (name === '0') throw new Error('Le calque 0 ne peut pas être supprimé.');
    if (name === this.currentLayer) throw new Error('Impossible de supprimer le calque courant.');
    if ([...this.entities.values()].some((e) => e.layer === name)) throw new Error('Le calque contient des objets.');
    this.layers = this.layers.filter((l) => l.name !== name);
    this.emit();
  }

  setCurrentLayer(name: string): void {
    const l = this.layer(name);
    if (!l) throw new Error(`Calque inconnu : ${name}`);
    if (l.frozen) throw new Error('Impossible de rendre courant un calque gelé.');
    this.currentLayer = name;
    this.emit();
  }

  // --- Vues nommées ---------------------------------------------------------------

  /** Ajoute ou remplace (même nom, sans tenir compte de la casse) une vue nommée. */
  putNamedView(v: NamedView): void {
    const i = this.namedViews.findIndex((n) => n.name.toLowerCase() === v.name.toLowerCase());
    this.namedViews = i < 0 ? [...this.namedViews, v] : this.namedViews.map((n, k) => (k === i ? v : n));
    this.emit();
  }

  namedView(name: string): NamedView | undefined {
    const q = name.trim().toLowerCase();
    return this.namedViews.find((n) => n.name.toLowerCase() === q);
  }

  deleteNamedView(name: string): void {
    const q = name.trim().toLowerCase();
    this.namedViews = this.namedViews.filter((n) => n.name.toLowerCase() !== q);
    this.emit();
  }

  saveLayerState(name: string): void {
    this.layerStates = { ...this.layerStates, [name]: this.layers.map((l) => ({ ...l })) };
    this.emit();
  }

  restoreLayerState(name: string): void {
    const st = this.layerStates[name];
    if (!st) throw new Error(`État de calque inconnu : ${name}`);
    this.layers = this.layers.map((l) => {
      const saved = st.find((s) => s.name === l.name);
      return saved ? { ...saved, frozen: saved.frozen && l.name !== this.currentLayer } : l;
    });
    for (const e of this.entities.values()) this.pendingChange.touched.add(e.handle);
    this.emit();
  }

  deleteLayerState(name: string): void {
    const { [name]: _, ...rest } = this.layerStates;
    this.layerStates = rest;
    this.emit();
  }

  setParameter(name: string, expression: string | null): void {
    this.touch('Paramètre');
    const next = { ...this.parameters };
    if (expression === null) delete next[name];
    else next[name] = expression;
    this.parameters = next;
    this.paramsVersion++;
    if (!this.openTx) this.emit();
  }

  /** Incrémenté quand les paramètres utilisateur changent (relance du solveur). */
  paramsVersion = 0;

  /** Remplace tout le contenu (ouverture de fichier). */
  load(data: {
    entities: Entity[];
    layers: LayerDef[];
    constraints: Constraint[];
    currentLayer?: string;
    fileName: string;
    layerStates?: Record<string, LayerDef[]>;
    parameters?: Record<string, string>;
    underlays?: Record<string, UnderlayDef>;
    joints?: Joint[];
    sheets?: DrawingSheet[];
    namedViews?: NamedView[];
  }): void {
    const before = [...this.entities.keys()];
    this.entities = new Map(data.entities.map((e) => [e.handle, e]));
    this.layers = data.layers.length ? data.layers : defaultLayers();
    if (!this.layer('0')) this.layers.unshift(defaultLayers()[0]!);
    this.constraints = data.constraints;
    this.layerStates = data.layerStates ?? {};
    this.parameters = data.parameters ?? {};
    this.underlays = data.underlays ?? {};
    this.joints = (data.joints ?? []).filter((j) => j.parts.some((p) => this.entities.has(p)));
    this.nextJoint = this.joints.reduce((m, j) => Math.max(m, parseInt(j.id.slice(1)) || 0), 0) + 1;
    this.sheets = data.sheets ?? [];
    this.namedViews = data.namedViews ?? [];
    this.currentLayer = data.currentLayer && this.layer(data.currentLayer) ? data.currentLayer : '0';
    this.fileName = data.fileName;
    const maxHandle = data.entities.reduce((m, e) => Math.max(m, parseInt(e.handle, 16) || 0), 0xff);
    this.nextHandle = maxHandle + 1;
    this.nextConstraint = data.constraints.reduce((m, c) => Math.max(m, parseInt(c.id.slice(1)) || 0), 0) + 1;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    for (const h of before) this.pendingChange.removed.add(h);
    for (const h of this.entities.keys()) this.pendingChange.touched.add(h);
    this.emit();
    this.dirty = false;
  }

  clear(fileName = 'Dessin1.xcad'): void {
    this.load({ entities: [], layers: defaultLayers(), constraints: [], fileName });
  }

  /** Notification après une modification externe (ex. variable système). */
  changed(): void {
    this.emit();
  }
}

function defaultLayers(): LayerDef[] {
  return [
    { name: '0', color: '#e6e9ee', lineweight: 0.25, visible: true, frozen: false, locked: false },
    { name: 'Contours', color: '#ff5a4f', lineweight: 0.35, visible: true, frozen: false, locked: false },
    { name: 'Axes', color: '#f2c94c', lineweight: 0.18, visible: true, frozen: false, locked: false },
    { name: 'Cotes', color: '#4fc3f7', lineweight: 0.18, visible: true, frozen: false, locked: false },
    { name: 'Hachures', color: '#8e9aaf', lineweight: 0.13, visible: true, frozen: false, locked: false },
    { name: 'Solides', color: '#b8c0ca', lineweight: 0.25, visible: true, frozen: false, locked: false },
  ];
}
