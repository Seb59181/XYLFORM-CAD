/**
 * Hôte de l'application : relie le document, le noyau 3D, l'interpréteur de commandes, la
 * sélection, les réglages (barre d'état) et l'interface. C'est l'objet reçu par chaque commande
 * dans `ctx.document`. Il ne dépend pas de React : l'interface s'abonne à ses événements.
 */
import { CommandCancelled, CommandProcessor, CommandRegistry, ask, type CommandContext, type CommandDefinition, type PromptSpec } from '../core/commands';
import type { Vec3 } from '../core/commands/types';
import { DrawingDocument, featureId, placeHistory, placePrimitive, type DocumentChange, type Entity, type Feature, type Joint, type NewEntity, type PrimitiveDef, type PrimitiveOp } from '../core/document/Document';
import { hasExpressions, hasRealThread, refreshExpressions, replayHistory } from './history';
import { solveConstraints } from '../core/constraints/Solver';
import type { Constraint } from '../core/constraints/types';
import { curvePoints, transformEntity, type SnapKind } from '../core/entities/geometry';
import { gripsOf } from '../core/entities/edit';
import { apply, applyVector, isIsometry, norm, rotationAxis, scale, translation, type Affine } from '../core/math/affine';
import { KernelClient } from '../kernel/KernelClient';
import type { KernelRequest, SolidResult } from '../kernel/protocol';
import type { StandardView, Workspace } from '../render/CadViewport';
import type { SaveHandle } from '../io/fileAccess';
import type { Autosaver } from '../io/autosave';

export type VisualStyle = 'realistic' | 'render' | 'shaded' | 'wireframe' | 'xray' | 'technical';
export type HostEvent = 'log' | 'prompt' | 'input' | 'settings' | 'selection' | 'kernel' | 'command' | 'cursor' | 'doc' | 'constraints' | 'tabs';

/** Disposition des fenêtres de vue : une seule, deux (côte à côte / l'une sur l'autre), trois, quatre. */
export type ViewportLayout = '1' | '2v' | '2h' | '3' | '4';

/** Position de caméra d'une vue (mémorisée par dessin ouvert). */
export interface ViewState {
  projection: 'perspective' | 'orthographic';
  position: Vec3;
  target: Vec3;
  up: Vec3;
  /** Demi-hauteur visible en projection parallèle. */
  halfHeight: number;
}

/**
 * Dessin ouvert dans un onglet : document (avec son annulation), fichier d'origine, vue,
 * sélection et plan de travail propres. Les solides partagent le même noyau 3D.
 */
export interface DocTab {
  readonly id: string;
  readonly doc: DrawingDocument;
  fileHandle: SaveHandle | null;
  view: ViewState | null;
  selection: string[];
  elevation: number;
  constraintStatus: { dof: number; ok: boolean; message?: string };
  /** Désabonnement du document. */
  off(): void;
}
export type PanelName = 'properties' | 'layers' | 'params' | 'underlays' | 'browser' | 'parts';

export interface Settings {
  grid: boolean;
  /** Accrochage à la grille (F9). */
  snap: boolean;
  ortho: boolean;
  polar: boolean;
  osnap: boolean;
  dyn: boolean;
  /**
   * Saisie dynamique : coordonnées tapées relatives au point précédent (« # » force
   * l'absolu) ; false = absolues sauf « @ ».
   */
  dynRelative: boolean;
  lwt: boolean;
  osnapModes: SnapKind[];
  /**
   * Repérage et inférences (F11) : axes X/Y/Z en couleur depuis le point de base,
   * alignements sur les points accrochés, accrochage « sur la face » des solides en 3D.
   */
  infer: boolean;
  /** Manipulateur 3D (flèches et anneaux) sur la sélection, en espace 3D. */
  gizmo: boolean;
  /** Pas de la grille (GRILLE › Pas) ; 0 = grille adaptative qui suit le zoom. */
  gridUnit: number;
  /** Pas de la résolution F9 (RESOL › Pas) ; 0 = celui de la grille affichée. */
  snapUnit: number;
  /** Incrément de l'accrochage polaire (degrés). */
  polarIncrement: number;
  showConstraints: boolean;
  visualStyle: VisualStyle;
  projection: 'perspective' | 'orthographic';
  panel: PanelName | null;
  /** Hauteur de la ligne de commande (lignes d'historique visibles). */
  historyLines: number;
  /** Clic droit : appui plus long que ce délai (ms) = menu, plus court = Entrée ; 0 = toujours le menu. */
  rightClickDelay: number;
  /** Espace de travail : dessin 2D (léger) ou modélisation 3D. */
  workspace: Workspace;
  /** Raccourcis clavier personnalisés : « Ctrl+Maj+B » → commande (PERSONNALISER). */
  shortcuts: Record<string, string>;
  /** Onglet du ruban sur mesure : nom et commandes (vide = onglet masqué). */
  customTab: { label: string; items: string[] };
  /** Ordre des groupes du ruban par onglet (titres), réorganisé par glisser-déposer. */
  ribbonOrder: Record<string, string[]>;
  /** Sauvegarde automatique : intervalle en minutes (0 = désactivée), comme SAVETIME. */
  autosaveMinutes: number;
  /** Propriétés détachées dans leur propre fenêtre libre, déplaçable sur le dessin. */
  propsFloating: boolean;
  /** Fenêtre libre des Propriétés affichée (si `propsFloating`). */
  propsWindow: boolean;
  /**
   * Compensation des trous imprimés (mm sur le Ø) : ajoutée aux nouveaux trous de passage,
   * lamés, fraisés (PERCAGE) et aux trous des pièces de la bibliothèque. 0 = cotes exactes.
   */
  holeComp: number;
  /**
   * Filetages réels : « export » = aperçu cosmétique pendant le dessin, filet exact calculé à
   * l'export STL/3MF/STEP ; « always » = filet exact tout de suite (lent).
   */
  threadMode: 'export' | 'always';
  /** Barre d'onglets des dessins (sous le ruban). */
  fileTabs: boolean;
  /** Disposition des fenêtres de vue et vue de chaque fenêtre secondaire. */
  viewports: ViewportLayout;
  viewportViews: StandardView[];
  /** Éléments masqués de la barre d'état (menu ☰ de personnalisation). */
  statusHidden: string[];
  /** Version bureau installée : recherche d'une mise à jour sur GitHub au démarrage. */
  autoUpdate: boolean;
}

export type { Workspace };

const DEFAULT_SETTINGS: Settings = {
  grid: true,
  snap: false,
  ortho: false,
  polar: true,
  osnap: true,
  dyn: true,
  dynRelative: true,
  lwt: false,
  osnapModes: ['END', 'MID', 'CEN', 'QUA', 'INT', 'NOD', 'INS', 'PER', 'TAN'],
  infer: true,
  gizmo: true,
  gridUnit: 0,
  snapUnit: 0,
  polarIncrement: 15,
  showConstraints: true,
  visualStyle: 'realistic',
  projection: 'perspective',
  panel: 'properties',
  historyLines: 3,
  rightClickDelay: 500,
  workspace: '3d',
  shortcuts: {},
  customTab: { label: 'Mon onglet', items: [] },
  ribbonOrder: {},
  autosaveMinutes: 5,
  propsFloating: false,
  propsWindow: false,
  holeComp: 0,
  threadMode: 'export',
  fileTabs: true,
  viewports: '1',
  viewportViews: ['TOP', 'FRONT', 'RIGHT'],
  statusHidden: [],
  autoUpdate: true,
};

export interface ViewportApi {
  zoomExtents(): void;
  zoomWindow(a: Vec3, b: Vec3): void;
  zoomToPoints(pts: Vec3[]): void;
  zoomFactor(f: number): void;
  setView(v: StandardView): void;
  setProjection(p: 'perspective' | 'orthographic'): void;
  setWorkspace(ws: Workspace): void;
  /** Analyse de coupe : plan (point + normale, côté conservé = côté de la normale) ou arrêt ; `live` = aperçu. */
  setSection(s: { origin: Vec3; normal: Vec3 } | null, live?: boolean): void;
  /** Plan de travail (grille, icône SCU) à la hauteur z. */
  setWorkPlane(z: number): void;
  /** Pas de la grille (0 = adaptatif). */
  setGridUnit(step: number): void;
  /** Direction unitaire cible → caméra. */
  viewDirection(): Vec3;
  readonly section: { origin: Vec3; normal: Vec3 } | null;
  screenshot(): Promise<Blob | null>;
  /** Image de rendu hors écran (fond : couleur CSS, 'studio' ou null = transparent). */
  renderImage(width: number, height: number, background: string | 'studio' | null, supersample?: number): Promise<Blob | null>;
  /** Taille du viewport en pixels. */
  viewSize(): { w: number; h: number };
  /** Taille d'un pixel en unités du dessin (à la cible de la caméra). */
  worldUnitsPerPixel(): number;
  /** Déplacement en direct des solides (aperçu, sans reconstruire) ; null = position réelle. */
  setLiveTransform(handles: string[], m: Affine | null): void;
  redraw(): void;
  rebuild(): void;
  /** Position de la caméra (changement d'onglet de dessin). */
  getViewState(): ViewState;
  setViewState(v: ViewState): void;
  /** Vue de départ d'un nouveau dessin (zone de travail de 200 mm). */
  homeView(): void;
  /**
   * Zones colorées par-dessus les solides (contrôle d'imprimabilité) : triangles en
   * coordonnées du dessin et couleur RVB (0–1) par sommet ; null efface.
   */
  setAnalysis(layers: { positions: Float32Array; colors: Float32Array }[] | null): void;
}

export interface MeshExportSettings {
  unit: 'mm' | 'cm' | 'm' | 'in' | 'ft';
  linearDeflection: number;
  angularDeflection: number;
  repair: boolean;
  /** 3MF : un objet par solide (sinon fusion). */
  separate: boolean;
  /** Contrôle d'imprimabilité avant l'écriture (chevauchements, parois fines, porte-à-faux). */
  check?: boolean;
  /** Épaisseur de paroi minimale (mm) et porte-à-faux maximal sans support (° depuis la verticale). */
  minWall?: number;
  overhang?: number;
}

export interface UiApi {
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  openFile(accept: string): Promise<File | null>;
  prompt(title: string, initial?: string, label?: string): Promise<string | null>;
  confirm(message: string, title?: string, labels?: { ok: string; cancel: string }): Promise<boolean>;
  /** `unit` : unité proposée (celle du dessin). */
  meshExport(format: 'stl' | '3mf', solids: number, unit?: MeshExportSettings['unit']): Promise<MeshExportSettings | null>;
  showHelp(): void;
  /** Écran « Quoi de neuf » : notes des versions données (Markdown du CHANGELOG). */
  showNews(notes: { version: string; date: string; body: string }[], previous: string | null): Promise<void>;
  /** Personnalisation : raccourcis clavier et onglet du ruban sur mesure. */
  customize(): void;
  contextMenu(x: number, y: number, items: MenuItem[]): void;
  /** Formulaire générique (sélection rapide, options, rechercher…) ; null si annulé. */
  form(spec: FormSpec): Promise<FormValues | null>;
  /** Boîte à plusieurs boutons : renvoie l'indice choisi (Échap = dernier bouton). */
  choose(message: string, title: string, buttons: string[]): Promise<number>;
}

export type FormValues = Record<string, string | number | boolean>;

export interface FormField {
  key: string;
  label: string;
  type: 'number' | 'text' | 'select' | 'checkbox';
  value: string | number | boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
}

export interface FormSpec {
  title: string;
  intro?: string;
  fields: FormField[];
  ok?: string;
}

export interface MenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
  shortcut?: string;
  /** Icône (nom du jeu d'icônes de l'interface). */
  icon?: string;
  /** Coche (option active). */
  checked?: boolean;
  /** Sous-menu (ouvert au survol). */
  children?: MenuItem[];
}

export interface CursorInfo {
  /** Position écran relative au viewport (px). */
  screen: { x: number; y: number } | null;
  world: Vec3 | null;
  snap: { kind: SnapKind; point: Vec3 } | null;
}

/** Jeu de sélection ordonné (l'ordre compte pour LISSAGE). */
export class SelectionSet {
  private items = new Set<string>();
  constructor(private readonly onChange: () => void) {}
  get size(): number {
    return this.items.size;
  }
  has(h: string): boolean {
    return this.items.has(h);
  }
  list(): string[] {
    return [...this.items];
  }
  add(hs: Iterable<string>): void {
    let changed = false;
    for (const h of hs) if (!this.items.has(h)) this.items.add(h), (changed = true);
    if (changed) this.onChange();
  }
  remove(hs: Iterable<string>): void {
    let changed = false;
    for (const h of hs) changed = this.items.delete(h) || changed;
    if (changed) this.onChange();
  }
  toggle(h: string): void {
    if (this.items.has(h)) this.items.delete(h);
    else this.items.add(h);
    this.onChange();
  }
  set(hs: Iterable<string>): void {
    this.items = new Set(hs);
    this.onChange();
  }
  clear(): void {
    if (!this.items.size) return;
    this.items.clear();
    this.onChange();
  }
}

/** Commandes qui laissent la sélection en place à la fin. */
const KEEP_SELECTION = new Set(['GRIP_EDIT', 'PROPERTIES', 'LIST', 'MASSPROP', 'ZOOM', 'VIEW', 'VSCURRENT', 'PERSPECTIVE', 'REGEN', 'LAYER', 'HELP', 'PASTECLIP', 'COPYCLIP', 'SELECTALL', 'DIST', 'ID', 'AREA', 'SOLIDCHECK', 'SAVE', 'SAVEAS', 'EXPORTSTL', 'EXPORT3MF', 'EXPORTSTEP', 'EXPORTDXF', 'EXPORTSVG', 'PNGOUT', 'SELECTSIMILAR', 'QSELECT', 'DRAWORDER', 'FIND', 'OPTIONS']);

const fallbackUi: UiApi = {
  toast: (m) => console.info(m),
  openFile: async () => null,
  prompt: async (_t, initial) => initial ?? null,
  confirm: async () => true,
  meshExport: async (_f, _n, unit) => ({ unit: unit ?? 'mm', linearDeflection: 0.05, angularDeflection: 15, repair: true, separate: true, check: true, minWall: 0.8, overhang: 45 }),
  showHelp: () => undefined,
  showNews: async () => undefined,
  customize: () => undefined,
  contextMenu: () => undefined,
  form: async (spec) => Object.fromEntries(spec.fields.map((f) => [f.key, f.value])),
  choose: async () => 0,
};

let tabCounter = 0;

export class AppHost {
  /** Dessins ouverts (onglets), dans l'ordre affiché. */
  docs: DocTab[] = [];
  private activeTab!: DocTab;
  /** Onglet « Démarrage » affiché à la place du dessin. */
  startPage = false;
  /** Écran épuré (Ctrl+0) : ruban et onglets masqués, toute la place au dessin. */
  cleanScreen = false;
  readonly kernel: KernelClient;
  readonly registry = new CommandRegistry();
  readonly processor: CommandProcessor;
  readonly selection: SelectionSet;
  settings: Settings;
  viewport: ViewportApi | null = null;
  ui: UiApi = fallbackUi;

  /** Historique affiché de la ligne de commande. */
  lines: string[] = [];
  promptText = 'Commande: ';
  activeSpec: PromptSpec | null = null;
  input = '';
  cursor: CursorInfo = { screen: null, world: null, snap: null };
  /** Sauvegarde automatique (posée au démarrage de l'interface). */
  autosave: Autosaver | null = null;
  /** Survol d'une entité (surbrillance). */
  hover: string | null = null;
  /** Arêtes / faces de solide désignées pendant RACCORDBORD, COQUE… */
  subHighlight: { handle: string; edges: number[]; faces: number[] } | null = null;

  private preselection: string[] = [];
  private readonly listeners = new Map<HostEvent, Set<() => void>>();
  private lastConstraints: Constraint[];
  private lastParamsVersion = 0;
  private solving = false;

  constructor(register: (r: CommandRegistry) => void, kernel?: KernelClient) {
    this.settings = loadSettings();
    this.kernel = kernel ?? new KernelClient();
    this.kernel.onStatus((st) => {
      this.emit('kernel');
      if (st === 'ready') this.scheduleBrepCache();
    });
    this.on('doc', () => this.scheduleBrepCache());
    this.selection = new SelectionSet(() => this.emit('selection'));
    register(this.registry);
    this.processor = new CommandProcessor(this.registry, this, {
      prompt: (spec, text) => {
        this.activeSpec = spec;
        this.promptText = text;
        this.emit('prompt');
      },
      print: (line) => this.log(line),
      idle: () => {
        this.activeSpec = null;
        this.promptText = 'Commande: ';
        this.emit('prompt');
      },
      commandStart: (def) => {
        if (this.startPage && !def.transparent) this.showStart(false);
        if (!def.transparent) {
          this.preselection = this.selection.list();
          this.doc.beginGroup(def.localName);
        }
        this.emit('command');
      },
      commandEnd: (def) => {
        if (!def.transparent) {
          this.doc.endGroup();
          this.preselection = [];
          if (!KEEP_SELECTION.has(def.name)) this.selection.clear();
        }
        this.emit('command');
        this.viewport?.redraw();
      },
    });
    this.processor.selectionSource = () => this.selection.list();
    this.processor.dynamicRelative = this.settings.dyn && this.settings.dynRelative;
    this.activeTab = this.createTab();
    this.docs.push(this.activeTab);
    this.lastConstraints = this.doc.constraints;
    this.log('Xylform CAD, by Seb. — tapez une commande (ex. LIGNE, CERCLE, BOITE) ou cliquez une icône du ruban.');
  }

  // --- Dessins ouverts (onglets) ------------------------------------------------------

  /** Document du dessin actif. */
  get doc(): DrawingDocument {
    return this.activeTab.doc;
  }

  /** Onglet du dessin actif. */
  get tab(): DocTab {
    return this.activeTab;
  }

  /** Fichier du dessin actif (Enregistrer le réécrit sans redemander). */
  get fileHandle(): SaveHandle | null {
    return this.activeTab.fileHandle;
  }

  set fileHandle(h: SaveHandle | null) {
    this.activeTab.fileHandle = h;
    this.emit('tabs');
  }

  /** Degrés de liberté restants (Paramétrique) du dessin actif. */
  get constraintStatus(): { dof: number; ok: boolean; message?: string } {
    return this.activeTab.constraintStatus;
  }

  set constraintStatus(v: { dof: number; ok: boolean; message?: string }) {
    this.activeTab.constraintStatus = v;
  }

  private createTab(fileName?: string): DocTab {
    const doc = new DrawingDocument();
    if (fileName) doc.fileName = fileName;
    const tab: DocTab = {
      id: `d${++tabCounter}-${Date.now().toString(36)}`,
      doc,
      fileHandle: null,
      view: null,
      selection: [],
      elevation: 0,
      constraintStatus: { dof: 0, ok: true },
      off: () => undefined,
    };
    let wasDirty = doc.dirty;
    const off = doc.subscribe((c) => {
      if (tab === this.activeTab) this.onDocChange(c);
      // l'astérisque de l'onglet suit l'état « modifié »
      if (doc.dirty !== wasDirty || tab !== this.activeTab) this.emit('tabs');
      wasDirty = doc.dirty;
    });
    tab.off = off;
    return tab;
  }

  /** Nom libre pour un nouveau dessin (Dessin1, Dessin2…). */
  nextDrawingName(): string {
    const used = new Set(this.docs.map((t) => t.doc.fileName.toLowerCase()));
    for (let i = 1; ; i++) if (!used.has(`dessin${i}.xcad`)) return `Dessin${i}.xcad`;
  }

  /** Le dessin est vierge (jamais modifié, sans fichier) : ouvrir un fichier peut le remplacer. */
  isBlank(tab: DocTab = this.activeTab): boolean {
    return tab.doc.size === 0 && !tab.doc.dirty && !tab.fileHandle && !tab.doc.canUndo;
  }

  /** Ouvre un nouvel onglet de dessin vide (à droite de l'onglet actif) et l'active. */
  newTab(fileName = this.nextDrawingName()): DocTab {
    const tab = this.createTab(fileName);
    const i = this.docs.indexOf(this.activeTab);
    this.docs.splice(i < 0 ? this.docs.length : i + 1, 0, tab);
    this.activate(tab, true);
    return tab;
  }

  /**
   * Passe à un autre dessin : la commande en cours est annulée, la vue, la sélection et le plan
   * de travail du dessin quitté sont mémorisés, ceux du dessin repris restaurés.
   */
  activate(tab: DocTab, fresh = false): void {
    if (!this.docs.includes(tab)) return;
    const wasStart = this.startPage;
    this.startPage = false;
    if (tab === this.activeTab) {
      if (wasStart) this.emit('tabs');
      return;
    }
    const old = this.activeTab;
    old.doc.endGroup();
    if (this.docs.includes(old)) {
      old.selection = this.selection.list().filter((h) => old.doc.get(h));
      old.elevation = this.processor.elevation;
      if (this.viewport) old.view = this.viewport.getViewState();
    }
    this.activeTab = tab;
    this.hover = null;
    this.subHighlight = null;
    this.preselection = [];
    this.lastConstraints = tab.doc.constraints;
    this.lastParamsVersion = tab.doc.paramsVersion;
    this.histParamsVersion = tab.doc.paramsVersion;
    this.processor.elevation = tab.elevation;
    this.viewport?.setWorkPlane(tab.elevation);
    this.viewport?.setSection(null);
    this.viewport?.setAnalysis(null);
    this.selection.set(tab.selection.filter((h) => tab.doc.get(h)));
    this.emit('doc');
    this.emit('constraints');
    this.emit('tabs');
    this.emit('settings');
    if (tab.view) this.viewport?.setViewState(tab.view);
    else if (!fresh && tab.doc.size) setTimeout(() => this.viewport?.zoomExtents(), 30);
    else this.viewport?.homeView();
    this.viewport?.redraw();
  }

  /**
   * Avant de quitter le dessin actif (clic sur un onglet) : la commande en cours est annulée.
   * Refusé pendant un calcul 3D, dont le résultat doit revenir au bon dessin.
   */
  async leaveCommand(): Promise<boolean> {
    if (this.processor.isIdle) return true;
    if (this.kernel.busy > 0) {
      this.ui.toast('Calcul 3D en cours : attendez la fin (ou Échap) avant de changer de dessin.', 'info');
      return false;
    }
    for (let i = 0; i < 6 && !this.processor.isIdle; i++) {
      this.processor.cancel();
      await new Promise((r) => setTimeout(r, 0));
    }
    return this.processor.isIdle;
  }

  /** Affiche la page « Démarrage » (le dessin actif reste ouvert derrière). */
  showStart(on = true): void {
    this.startPage = on;
    this.emit('tabs');
  }

  toggleCleanScreen(): void {
    this.cleanScreen = !this.cleanScreen;
    this.emit('settings');
  }

  /** Change l'ordre des onglets (glisser-déposer). */
  moveTab(tab: DocTab, index: number): void {
    const i = this.docs.indexOf(tab);
    if (i < 0) return;
    this.docs.splice(i, 1);
    this.docs.splice(Math.max(0, Math.min(this.docs.length, index)), 0, tab);
    this.emit('tabs');
  }

  /**
   * Retire un onglet sans rien demander (la confirmation est faite par FERMER). Les formes du
   * noyau qui ne servent plus à aucun autre dessin sont libérées. Le dernier onglet fermé est
   * remplacé par un dessin vide.
   */
  removeTab(tab: DocTab, keepShapes: Iterable<string> = []): void {
    const i = this.docs.indexOf(tab);
    if (i < 0) return;
    this.docs.splice(i, 1);
    tab.off();
    const others = new Set<string>(keepShapes);
    for (const t of this.docs) for (const e of t.doc.all()) if (e.type === '3DSOLID') others.add(e.shapeId);
    const release = [...new Set(tab.doc.all().filter((e): e is Extract<Entity, { type: '3DSOLID' }> => e.type === '3DSOLID').map((e) => e.shapeId))].filter((id) => !others.has(id));
    for (const id of release) this.brepCache.delete(id);
    if (release.length && this.kernel.status === 'ready') void this.kernel.call({ op: 'release', shapeIds: release }).catch(() => undefined);
    if (!this.docs.length) {
      const blank = this.createTab(this.nextDrawingName());
      this.docs.push(blank);
      this.activate(blank, true);
      return;
    }
    if (tab === this.activeTab) {
      // comme un navigateur : l'onglet de droite, sinon celui de gauche (activate() ne
      // mémorise rien de l'onglet fermé, qui n'est plus dans la liste)
      this.activate(this.docs[Math.min(i, this.docs.length - 1)]!);
    } else this.emit('tabs');
  }

  // --- Événements ------------------------------------------------------------

  on(ev: HostEvent, fn: () => void): () => void {
    let set = this.listeners.get(ev);
    if (!set) this.listeners.set(ev, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  emit(ev: HostEvent): void {
    for (const fn of this.listeners.get(ev) ?? []) fn();
  }

  log(line: string): void {
    this.lines.push(line);
    if (this.lines.length > 800) this.lines.splice(0, this.lines.length - 800);
    this.emit('log');
  }

  setInput(v: string): void {
    this.input = v;
    this.emit('input');
  }

  setCursor(c: CursorInfo): void {
    this.cursor = c;
    this.emit('cursor');
  }

  // --- Réglages ----------------------------------------------------------------

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    // Propriétés détachées : les ouvrir affiche leur fenêtre libre (la palette latérale ne change pas)
    if (key === 'panel' && value === 'properties' && this.settings.propsFloating) return this.set('propsWindow', true);
    this.settings = { ...this.settings, [key]: value };
    // ORTHO et POLAIRE s'excluent mutuellement
    if (key === 'ortho' && value) this.settings.polar = false;
    if (key === 'polar' && value) this.settings.ortho = false;
    saveSettings(this.settings);
    this.processor.dynamicRelative = this.settings.dyn && this.settings.dynRelative;
    this.emit('settings');
    if (key === 'gridUnit' || key === 'snapUnit') this.viewport?.setGridUnit(this.settings.gridUnit);
    if (key === 'projection' && this.settings.workspace === '3d') this.viewport?.setProjection(value as Settings['projection']);
    if (key === 'workspace') {
      // le noyau 3D (≈ 50 Mo de WebAssembly) n'est préchargé qu'en 3D
      if (value === '3d') void this.kernel.start();
      this.viewport?.setWorkspace(value as Workspace);
    }
    if (key === 'visualStyle' || key === 'lwt' || key === 'showConstraints') this.viewport?.rebuild();
    this.viewport?.redraw();
  }

  toggle(key: 'grid' | 'snap' | 'ortho' | 'polar' | 'osnap' | 'dyn' | 'lwt' | 'showConstraints' | 'infer' | 'gizmo'): void {
    this.set(key, !this.settings[key]);
    const names: Record<string, string> = { gizmo: 'Manipulateur 3D', infer: 'Repérage et inférences', grid: 'Grille', snap: 'Résolution', ortho: 'Ortho', polar: 'Repérage polaire', osnap: 'Accrochage aux objets', dyn: 'Saisie dynamique', lwt: 'Épaisseurs de ligne', showConstraints: 'Contraintes' };
    this.log(`<${names[key]} ${this.settings[key] ? 'activé' : 'désactivé'}>`);
  }

  showPanel(panel: PanelName | null): void {
    if (panel === 'properties' && this.settings.propsFloating) return this.set('propsWindow', !this.settings.propsWindow);
    this.set('panel', this.settings.panel === panel ? null : panel);
  }

  /** Détache les Propriétés dans une fenêtre libre sur le dessin, ou les rattache à la palette. */
  setPropertiesFloating(floating: boolean): void {
    this.settings = { ...this.settings, propsFloating: floating, propsWindow: floating };
    if (floating && this.settings.panel === 'properties') this.settings.panel = null;
    if (!floating) this.settings.panel = 'properties';
    saveSettings(this.settings);
    this.emit('settings');
  }

  get sysvars() {
    return this.doc.sysvars;
  }

  // --- Commandes -----------------------------------------------------------------

  execute(text: string): void {
    this.processor.execute(text);
  }

  /** Bouton du ruban : lance la commande (annule la commande courante si besoin). */
  run(command: string): void {
    this.setInput('');
    this.processor.execute(command);
  }

  /**
   * Lance une commande puis répond automatiquement à ses premiers prompts
   * (variantes du ruban : CERCLE + « 2P », VUE + « Dessus »…).
   */
  runSequence(steps: string[]): void {
    const [first, ...rest] = steps;
    if (!first) return;
    if (rest.length) {
      let i = 0;
      const off = this.on('prompt', () => {
        if (!this.activeSpec) return;
        const s = rest[i++];
        if (i >= rest.length) off();
        if (s !== undefined) queueMicrotask(() => this.processor.submit(s));
      });
      setTimeout(off, 5000);
    }
    this.run(first);
  }

  /** Objets présélectionnés au lancement de la commande (PICKFIRST), consommés une fois. */
  takePreselection(filter?: (h: string) => boolean): string[] {
    const list = this.preselection.filter((h) => {
      const e = this.doc.get(h);
      return !!e && this.doc.isPickable(e) && (!filter || filter(h));
    });
    this.preselection = [];
    return list;
  }

  /** Édition par poignée : étire le point choisi de l'entité. */
  startGripEdit(handle: string, gripIndex: number): void {
    const e = this.doc.get(handle);
    const grip = e && gripsOf(e)[gripIndex];
    if (!e || !grip) return;
    const host = this;
    const def: CommandDefinition = {
      name: 'GRIP_EDIT',
      localName: 'ÉTIRER',
      async run(ctx: CommandContext) {
        const r = await ask(ctx, {
          kind: 'point',
          message: '** ÉTIRER ** Spécifiez le point d’étirement',
          basePoint: grip.point,
          preview: (p) => curvePoints({ ...e, ...grip.apply(p) } as Entity),
        });
        if (r.kind === 'point') host.doc.replaceEntity(handle, grip.apply(r.value));
        host.selection.set([handle]);
      },
    };
    void this.processor.run(def);
  }

  setSubHighlight(h: { handle: string; edges: number[]; faces: number[] } | null): void {
    this.subHighlight = h ? { handle: h.handle, edges: [...h.edges], faces: [...h.faces] } : null;
    this.emit('selection');
  }

  // --- Document --------------------------------------------------------------------

  addEntity(e: NewEntity): string {
    return this.doc.addEntity(e);
  }

  removeEntity(handle: string): void {
    this.doc.removeEntity(handle);
  }

  entity(handle: string): Entity | undefined {
    return this.doc.get(handle);
  }

  /** Entités visibles du document. */
  visible(): Entity[] {
    return this.doc.all().filter((e) => this.doc.isVisible(e));
  }

  /** Élévation du plan de travail (ELEV, esquisse sur une face) : curseur et grille à cette hauteur. */
  setElevation(z: number): void {
    this.processor.elevation = z;
    this.viewport?.setWorkPlane(z);
    this.emit('settings');
  }

  // --- Noyau 3D -----------------------------------------------------------------------

  async ensureKernel(ctx?: CommandContext): Promise<void> {
    if (this.kernel.status === 'ready') return;
    if (this.kernel.status === 'failed') throw new Error('Le noyau 3D n’a pas pu démarrer (voir la console).');
    ctx?.print('Chargement du noyau 3D OpenCascade (première utilisation)…');
    await this.kernel.ready;
  }

  async solid(ctx: CommandContext | undefined, req: KernelRequest): Promise<SolidResult> {
    await this.ensureKernel(ctx);
    const r = await this.kernel.solid(req);
    // Échap pendant le calcul : le noyau ne s'interrompt pas, mais le résultat est abandonné
    if (ctx?.signal.aborted) {
      void this.kernel.call({ op: 'release', shapeIds: [r.shapeId] }).catch(() => undefined);
      throw new CommandCancelled();
    }
    return r;
  }

  // --- Interruption d'un calcul (Échap) ------------------------------------------------

  /**
   * Copie B-rep de chaque solide du dessin, tenue à jour en tâche de fond quand le noyau est
   * libre : elle permet de relancer le noyau au milieu d'un calcul sans rien perdre, et
   * accélère l'enregistrement.
   */
  readonly brepCache = new Map<string, Uint8Array>();
  private brepTimer: ReturnType<typeof setTimeout> | null = null;
  private restarting = false;

  private scheduleBrepCache(delay = 1500): void {
    if (this.brepTimer || typeof setTimeout === 'undefined') return;
    this.brepTimer = setTimeout(() => {
      this.brepTimer = null;
      void this.fillBrepCache();
    }, delay);
  }

  private async fillBrepCache(): Promise<void> {
    if (this.kernel.status !== 'ready' || this.restarting) return;
    const live = new Set<string>();
    for (const t of this.docs) for (const e of t.doc.all()) if (e.type === '3DSOLID') live.add(e.shapeId);
    for (const id of [...this.brepCache.keys()]) if (!live.has(id)) this.brepCache.delete(id);
    for (const id of live) {
      if (this.brepCache.has(id)) continue;
      // l'utilisateur fait calculer le noyau : on repasse plus tard
      if (this.kernel.busy > 0 || this.restarting) return this.scheduleBrepCache(3000);
      const gen = this.kernel.generation;
      try {
        const data = await this.kernel.call<Uint8Array>({ op: 'saveBrep', shapeId: id }, { background: true });
        if (gen === this.kernel.generation) this.brepCache.set(id, data);
      } catch {
        /* forme libérée entre-temps */
      }
    }
  }

  /** Un calcul du noyau 3D est en cours (hors tâches de fond). */
  get kernelBusy(): boolean {
    return this.kernel.busy > 0 && !this.restarting;
  }

  /**
   * Échap pendant un calcul 3D : OpenCascade ne sait pas s'interrompre, le worker est donc
   * arrêté net puis relancé, et les solides du dessin sont rechargés (copie B-rep de secours,
   * sinon reconstruction par l'historique). Renvoie true si le noyau a été relancé.
   * `now` : sans le court délai de grâce (bouton « Arrêter »).
   */
  async interruptKernel(now = false): Promise<boolean> {
    if (this.restarting || this.kernel.busy === 0) return false;
    if (!now) {
      await new Promise((r) => setTimeout(r, 300));
      if (this.kernel.busy === 0 || this.restarting) return false;
    }
    this.restarting = true;
    this.emit('kernel');
    this.log('Calcul 3D interrompu : redémarrage du noyau…');
    try {
      await this.kernel.restart();
      await this.restoreSolids();
    } catch (e) {
      this.log(`Redémarrage du noyau 3D : ${(e as Error).message}`);
    } finally {
      this.restarting = false;
      this.emit('kernel');
    }
    return true;
  }

  /** Recharge les solides du dessin dans un noyau neuf. */
  private async restoreSolids(): Promise<void> {
    const cache = new Map(this.brepCache);
    this.brepCache.clear();
    const map = new Map<string, string>();
    let rebuilt = 0;
    const meshed: string[] = [];
    const lost: string[] = [];
    const solids = this.docs.flatMap((t) => t.doc.all());
    for (const e of solids) {
      if (e.type !== '3DSOLID' || map.has(e.shapeId)) continue;
      const data = cache.get(e.shapeId);
      try {
        if (data) {
          const r = await this.kernel.call<SolidResult>({ op: 'loadBrep', data });
          this.brepCache.set(r.shapeId, data);
          map.set(e.shapeId, r.shapeId);
        } else if (e.history) {
          const r = await this.replay(e.history, undefined, undefined, !!e.threadsReal, true);
          map.set(e.shapeId, r.shapeId);
          rebuilt++;
        } else {
          // dernier recours : le maillage affiché devient un corps maillé
          const d = e.display;
          const r = await this.kernel.call<SolidResult>({ op: 'meshBody', positions: Float64Array.from(d.positions), indices: d.indices, closed: d.solidCount > 0 });
          map.set(e.shapeId, r.shapeId);
          meshed.push(e.name || e.handle);
        }
      } catch {
        lost.push(e.name || e.handle);
      }
    }
    for (const t of this.docs) if (t.doc.all().some((e) => e.type === '3DSOLID')) t.doc.rebindShapes(map);
    const n = map.size;
    this.log(`Noyau 3D relancé : ${n} solide(s) rechargé(s)${rebuilt ? `, dont ${rebuilt} reconstruit(s) par l’historique` : ''}. L’historique d’annulation a été vidé.`);
    if (meshed.length) this.log(`Rechargé(s) en corps maillé (sans B-rep) : ${meshed.join(', ')}.`);
    if (lost.length) this.log(`Impossible de recharger : ${lost.join(', ')}. Enregistrez puis rouvrez le dessin.`);
    this.scheduleBrepCache();
  }

  /**
   * `feature` : opération de création d'une primitive (cotes modifiables ensuite dans
   * Propriétés) ou historique paramétrique complet du nouveau corps.
   */
  addSolid(r: SolidResult, name: string, from?: Entity, ctx?: CommandContext, feature?: PrimitiveOp | Feature[]): string {
    for (const w of r.warnings) ctx?.print(w);
    const history = Array.isArray(feature) ? feature : feature ? [{ kind: 'create' as const, op: feature, id: featureId(), name }] : undefined;
    return this.doc.addEntity({
      type: '3DSOLID',
      name,
      shapeId: r.shapeId,
      display: r.display,
      layer: from?.layer,
      color: from?.color,
      ...(feature && !Array.isArray(feature) ? { primitive: { op: feature } } : {}),
      ...(history ? { history } : {}),
    });
  }

  /**
   * Ajoute une étape à un corps en l'appliquant à sa forme actuelle (sans tout rejouer) ;
   * l'historique est prolongé s'il existe. Annulable.
   */
  async applyStep(handle: string, f: Feature, label: string, ctx?: CommandContext): Promise<SolidResult> {
    const e = this.doc.get(handle);
    if (e?.type !== '3DSOLID') throw new Error('Solide introuvable.');
    const real = this.settings.threadMode === 'always';
    const r = await this.replay([f], ctx, { shapeId: e.shapeId, display: e.display, warnings: [] }, real);
    const history = e.history ? [...e.history, f] : undefined;
    // filets exacts si tout l'était déjà et que cette étape l'est aussi
    const threadsReal = real && (!!e.threadsReal || !hasRealThread(e.history)) && hasRealThread(history ?? [f]);
    this.doc.transaction(label, () => this.doc.replaceEntity(handle, { shapeId: r.shapeId, display: r.display, history, threadsReal }));
    if (!real && hasRealThread([f])) ctx?.print('Filetage réel : aperçu cosmétique pendant le dessin ; le filet exact sera calculé à l’export (ou avec FILETAGEREEL).');
    return r;
  }

  /**
   * Rejoue un historique : forme finale maillée (sauf `noDisplay`), intermédiaires libérés.
   * `real` : filetages exacts ; sinon aperçu cosmétique (rapide). Par défaut : réglage threadMode.
   */
  async replay(history: Feature[], ctx?: CommandContext, start?: SolidResult, real = this.settings.threadMode === 'always', noDisplay = false): Promise<SolidResult> {
    await this.ensureKernel(ctx);
    const created: string[] = [];
    const k = async (req: KernelRequest) => {
      const r = await this.solid(ctx, { ...req, lazy: true });
      created.push(r.shapeId);
      return r;
    };
    try {
      const parts = await import('./parts');
      const last = await replayHistory(
        k,
        history,
        {
          threaded: (kk, d, p, z0, L, gap) => (real ? parts.threadedRod(kk, d, p, z0, L, false, gap) : parts.groovedRod(kk, d + 2 * gap, p, z0, L)),
          part: (kk, f) => parts.buildPart(kk, f.part, f.values, f.index, f.matrix, real),
        },
        start ?? null,
      );
      if (noDisplay) return last;
      const display = await this.kernel.call<SolidResult['display']>({ op: 'display', shapeId: last.shapeId });
      return { ...last, display };
    } finally {
      const done = created.slice(0, -1);
      if (done.length) void this.kernel.call({ op: 'release', shapeIds: done }).catch(() => undefined);
    }
  }

  /**
   * Formes à filetage exact pour l'export : les corps en aperçu cosmétique sont reconstruits
   * (temporairement) avec leurs vrais filets. `release()` libère ces formes temporaires.
   */
  async exactShapes(solids: Extract<Entity, { type: '3DSOLID' }>[], ctx?: CommandContext): Promise<{ ids: string[]; release(): void }> {
    const temp: string[] = [];
    const ids: string[] = [];
    try {
      for (const s of solids) {
        if (!s.history || s.threadsReal || !hasRealThread(s.history)) {
          ids.push(s.shapeId);
          continue;
        }
        ctx?.print(`Filetage réel de « ${s.name || s.handle} » : calcul du filet exact…`);
        const r = await this.replay(s.history, ctx, undefined, true, true);
        temp.push(r.shapeId);
        ids.push(r.shapeId);
      }
    } catch (e) {
      if (temp.length) void this.kernel.call({ op: 'release', shapeIds: temp }).catch(() => undefined);
      throw e;
    }
    return { ids, release: () => temp.length && void this.kernel.call({ op: 'release', shapeIds: temp }).catch(() => undefined) };
  }

  /**
   * Remplace l'historique d'un corps et le reconstruit (annulable). En cas d'échec, le corps
   * reste tel quel et l'erreur indique l'étape fautive.
   */
  async rebuildSolid(handle: string, history: Feature[], label = 'Historique', ctx?: CommandContext): Promise<void> {
    const e = this.doc.get(handle);
    if (e?.type !== '3DSOLID') return;
    const real = this.settings.threadMode === 'always' || (!!e.threadsReal && hasRealThread(history));
    const r = await this.replay(history, ctx, undefined, real);
    const primitive = primitiveOfHistory(history);
    this.doc.transaction(label, () => this.doc.replaceEntity(handle, { shapeId: r.shapeId, display: r.display, history, primitive, threadsReal: real && hasRealThread(history) }));
  }

  /**
   * Modifie les cotes d'une primitive (palette Propriétés) : la forme est reconstruite par le noyau
   * puis replacée (déplacements / rotations subis depuis sa création). Annulable.
   */
  async editPrimitive(handle: string, op: PrimitiveOp): Promise<void> {
    const e = this.doc.get(handle);
    if (e?.type !== '3DSOLID' || !e.primitive) throw new Error('Ce solide n’est pas une primitive modifiable.');
    const h0 = e.history?.[0];
    if (h0?.kind === 'create') return this.rebuildSolid(handle, [{ ...h0, op }, ...e.history!.slice(1)], 'Propriétés');
    await this.ensureKernel();
    let r = await this.kernel.solid({ ...op, lazy: !!e.primitive.matrix });
    if (e.primitive.matrix) {
      const raw = r.shapeId;
      r = await this.kernel.solid({ op: 'transform', shapeId: raw, matrix: e.primitive.matrix });
      void this.kernel.call({ op: 'release', shapeIds: [raw] }).catch(() => undefined);
    }
    const primitive: PrimitiveDef = { op, ...(e.primitive.matrix ? { matrix: e.primitive.matrix } : {}) };
    // la forme précédente reste dans le noyau (annuler)
    this.doc.transaction('Propriétés', () => this.doc.replaceEntity(handle, { shapeId: r.shapeId, display: r.display, primitive }));
  }

  /** Applique une transformation à des entités (2D directement, solides via le noyau). */
  async transformEntities(handles: string[], m: Affine, opts: { copy?: boolean; label: string; ctx?: CommandContext }): Promise<string[]> {
    const ents = handles.map((h) => this.doc.get(h)).filter((e): e is Entity => !!e);
    const solids = ents.filter((e) => e.type === '3DSOLID') as Extract<Entity, { type: '3DSOLID' }>[];
    if (solids.length) await this.ensureKernel(opts.ctx);
    const results = await Promise.all(solids.map((s) => this.kernel.solid({ op: 'transform', shapeId: s.shapeId, matrix: m })));
    const solidPatch = new Map(solids.map((s, i) => [s.handle, { shapeId: results[i]!.shapeId, display: results[i]!.display }]));
    const out: string[] = [];
    this.doc.transaction(opts.label, () => {
      for (const e of ents) {
        const patch = e.type === '3DSOLID' ? { ...solidPatch.get(e.handle)!, primitive: placePrimitive(e.primitive, m), history: placeHistory(e.history, m), threadsReal: e.threadsReal } : transformEntity(e, m);
        if (opts.copy) {
          const { handle: _h, ...rest } = e;
          out.push(this.doc.addEntity({ ...rest, ...patch } as NewEntity));
        } else {
          this.doc.replaceEntity(e.handle, patch);
          out.push(e.handle);
        }
      }
      // liaisons dont toutes les pièces bougent : leur axe suit (déplacement rigide seulement)
      if (!opts.copy && isIsometry(m)) this.moveJointsWith(new Set(handles), m);
    });
    return out;
  }

  /**
   * Copies multiples (réseaux) : une copie des entités par matrice, en une seule étape
   * d'annulation. Renvoie les poignées créées.
   */
  async copyEntities(handles: string[], ms: Affine[], label: string, ctx?: CommandContext): Promise<string[]> {
    const ents = handles.map((h) => this.doc.get(h)).filter((e): e is Entity => !!e);
    const solids = ents.filter((e) => e.type === '3DSOLID') as Extract<Entity, { type: '3DSOLID' }>[];
    if (solids.length) await this.ensureKernel(ctx);
    const results: SolidResult[][] = [];
    for (const m of ms) results.push(await Promise.all(solids.map((s) => this.kernel.solid({ op: 'transform', shapeId: s.shapeId, matrix: m }))));
    const out: string[] = [];
    this.doc.transaction(label, () => {
      ms.forEach((m, k) => {
        for (const e of ents) {
          const { handle: _h, ...rest } = e;
          if (e.type === '3DSOLID') {
            const r = results[k]![solids.indexOf(e)]!;
            out.push(this.doc.addEntity({ ...rest, shapeId: r.shapeId, display: r.display, primitive: placePrimitive(e.primitive, m), history: placeHistory(e.history, m) } as NewEntity));
          } else out.push(this.doc.addEntity({ ...rest, ...transformEntity(e, m) } as NewEntity));
        }
      });
    });
    return out;
  }

  private moveJointsWith(moved: Set<string>, m: Affine, except?: string): void {
    for (const j of this.doc.joints)
      if (j.id !== except && j.parts.length && j.parts.every((p) => moved.has(p))) this.doc.updateJoint(j.id, { origin: apply(m, j.origin), axis: norm(applyVector(m, j.axis)) });
  }

  // --- Liaisons d'assemblage ----------------------------------------------------------

  /** Mouvement d'une liaison pour une variation `delta` (degrés ou unités). */
  jointMatrix(j: Joint, delta: number): Affine {
    return j.type === 'revolute' ? rotationAxis(j.origin, j.axis, (delta * Math.PI) / 180) : translation(scale(norm(j.axis), delta));
  }

  /** Amène une liaison à la position `value` (bornée) : ses pièces bougent, annulable. */
  async driveJoint(id: string, value: number, ctx?: CommandContext): Promise<void> {
    const j = this.doc.joint(id);
    if (!j) return;
    const v = Math.max(j.min, Math.min(j.max, value));
    const delta = v - j.value;
    if (Math.abs(delta) < 1e-9) return;
    const m = this.jointMatrix(j, delta);
    const solids = j.parts.map((h) => this.doc.get(h)).filter((e): e is Extract<Entity, { type: '3DSOLID' }> => e?.type === '3DSOLID');
    await this.ensureKernel(ctx);
    const results = await Promise.all(solids.map((s) => this.kernel.solid({ op: 'transform', shapeId: s.shapeId, matrix: m })));
    this.doc.transaction(`Piloter ${j.name}`, () => {
      solids.forEach((s, i) => this.doc.replaceEntity(s.handle, { shapeId: results[i]!.shapeId, display: results[i]!.display, primitive: placePrimitive(s.primitive, m), history: placeHistory(s.history, m) }));
      this.doc.updateJoint(id, { value: v });
      // liaisons portées par les pièces déplacées (charnière sur un volet…)
      this.moveJointsWith(new Set(j.parts), m, id);
    });
  }

  // --- Contraintes ------------------------------------------------------------------------

  private histParamsVersion = 0;

  /** Paramètres utilisateur modifiés : corps dont des cotes en dépendent reconstruits. */
  private async refreshParametricBodies(): Promise<void> {
    for (const e of this.doc.all()) {
      if (e.type !== '3DSOLID' || !e.history || !hasExpressions(e.history)) continue;
      const next = refreshExpressions(e.history, this.doc.constraints, this.doc.parameters);
      if (!next) continue;
      try {
        await this.rebuildSolid(e.handle, next, 'Paramètres : reconstruction');
        this.log(`${e.name || e.handle} reconstruit (paramètres modifiés).`);
      } catch (err) {
        this.ui.toast(`${e.name || e.handle} : ${(err as Error).message}`, 'error');
      }
    }
  }

  private onDocChange(change: DocumentChange): void {
    this.emit('doc');
    if (this.doc.paramsVersion !== this.histParamsVersion) {
      this.histParamsVersion = this.doc.paramsVersion;
      if (this.doc.all().some((e) => e.type === '3DSOLID' && e.history && hasExpressions(e.history))) void this.refreshParametricBodies();
    }
    if (this.solving) return;
    const cs = this.doc.constraints;
    const constraintsChanged = cs !== this.lastConstraints || this.doc.paramsVersion !== this.lastParamsVersion;
    const added = constraintsChanged && cs.length > this.lastConstraints.length && cs[cs.length - 1]!.id !== this.lastConstraints[this.lastConstraints.length - 1]?.id;
    if (!cs.length) {
      this.lastConstraints = cs;
      this.lastParamsVersion = this.doc.paramsVersion;
      if (constraintsChanged) this.constraintStatus = { dof: 0, ok: true };
      if (constraintsChanged) this.emit('constraints');
      return;
    }
    const constrained = new Set(cs.flatMap((c) => c.refs.map((r) => r.handle)));
    const edited = [...change.touched].filter((h) => constrained.has(h));
    if (!constraintsChanged && !edited.length) return;
    let heavy = new Set(edited);
    if (added) {
      // l'objet désigné en dernier s'adapte au premier (règle DXF)
      const c = cs[cs.length - 1]!;
      const mover = c.refs[c.refs.length - 1]?.handle;
      heavy = new Set([...constrained].filter((h) => h !== mover));
    }
    this.solving = true;
    try {
      const r = solveConstraints((h) => this.doc.get(h), cs, { edited: heavy, user: this.doc.parameters });
      if (r.ok) {
        this.doc.patchFromSolver(r.patches);
        this.constraintStatus = { dof: r.dof, ok: true };
      } else if (added) {
        this.doc.undo();
        this.log(`Contrainte refusée : ${r.message ?? 'conflit'}`);
        this.ui.toast('Contrainte refusée : elle entre en conflit avec les contraintes existantes.', 'error');
      } else {
        this.constraintStatus = { dof: r.dof, ok: false, message: r.message };
        this.log(`Attention : ${r.message}`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (added) this.doc.undo();
      this.log(`Contraintes : ${msg}`);
      this.ui.toast(msg, 'error');
    } finally {
      this.solving = false;
      this.lastConstraints = this.doc.constraints;
      this.lastParamsVersion = this.doc.paramsVersion;
      this.emit('constraints');
    }
  }
}

/** Primitive « simple » (cotes dans Propriétés) : création seule, éventuellement déplacée. */
function primitiveOfHistory(h: Feature[]): PrimitiveDef | undefined {
  const [a, b, ...rest] = h;
  if (rest.length || a?.kind !== 'create' || a.off) return undefined;
  const prim = ['box', 'cylinder', 'cone', 'sphere', 'torus', 'pyramid'].includes(a.op.op) ? (a.op as PrimitiveOp) : undefined;
  if (!prim) return undefined;
  if (!b) return { op: prim };
  if (b.kind !== 'transform' || b.off) return undefined;
  return placePrimitive({ op: prim }, b.matrix);
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('sebcad.settings');
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* stockage indisponible */
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem('sebcad.settings', JSON.stringify(s));
  } catch {
    /* stockage indisponible */
  }
}
