/**
 * Interaction souris dans le viewport :
 *   - curseur en croix et point courant sur le plan de travail (ou sur la verticale pour les hauteurs) ;
 *   - accrochage aux objets (extrémité, milieu, centre, quadrant, intersection, nodal, insertion,
 *     perpendiculaire, tangente, proche) avec marqueurs, accrochage à la grille, ORTHO et repérage polaire ;
 *   - aperçu dynamique des commandes et élastique ;
 *   - sélection par clic, fenêtre (gauche → droite) et capture (droite → gauche), Maj = retirer ;
 *   - désignation d'objets, d'arêtes et de faces de solides ;
 *   - poignées, survol, double-clic (modification), menu contextuel.
 */
import * as THREE from 'three';
import { promptAxis, type PromptSpec, type Vec3 } from '../core/commands/types';
import type { Entity } from '../core/document/Document';
import { intersectionsWith } from '../core/entities/edit';
import { constrainDyn, dynLayout } from '../core/commands/dynInput';
import { SNAP_LABEL, snapPoints, type SnapKind } from '../core/entities/geometry';
import type { CadViewport } from '../render/CadViewport';
import type { SceneSync, UnderlaySub } from '../render/SceneSync';
import { TransformGizmo, type GizmoHandle } from '../render/TransformGizmo';
import type { Affine } from '../kernel/protocol';
import { apply as applyAffine, translation } from '../core/math/affine';
import { ask } from '../core/commands';
import { cmd, outlines } from './commands/helpers';
import type { AppHost, MenuItem } from './AppHost';
import { editConstraintExpression } from './commands/constraints';

export interface OverlayState {
  cursor: { x: number; y: number } | null;
  marker: { kind: SnapKind; x: number; y: number; label: string } | null;
  box: { x0: number; y0: number; x1: number; y1: number; crossing: boolean } | null;
  /** Info-bulle de repérage (polaire, ortho). */
  tip: string | null;
  /** Carré de sélection au centre du curseur. */
  pickbox: boolean;
  /** Curseur en croix (sinon flèche, navigation). */
  crosshair: boolean;
  /** Lignes d'inférence (axes en couleur, alignements), en pixels. */
  guides: Guide[];
  /** Points acquis pour les alignements (petites croix). */
  acquired: { x: number; y: number }[];
}

export interface Guide {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  dashed?: boolean;
}

/** Couleurs des axes (comme le SCU) : X rouge, Y vert, Z bleu. */
const AXES: { dir: Vec3; color: string; name: string }[] = [
  { dir: { x: 1, y: 0, z: 0 }, color: '#ff5555', name: 'rouge (X)' },
  { dir: { x: 0, y: 1, z: 0 }, color: '#3fd65a', name: 'vert (Y)' },
  { dir: { x: 0, y: 0, z: 1 }, color: '#4ea1ff', name: 'bleu (Z)' },
];
/** Tolérance (px) des inférences. */
const INFER = 9;
const ACQUIRE: SnapKind[] = ['END', 'MID', 'CEN', 'INT', 'QUA', 'NOD', 'INS'];

interface Proj {
  x: number;
  y: number;
  /** Profondeur (distance caméra) ; < 0 derrière la caméra. */
  w: number;
}

const APERTURE = 12;
const PICK = 6;
const PRIORITY: SnapKind[] = ['END', 'INT', 'MID', 'CEN', 'QUA', 'NOD', 'INS', 'PER', 'TAN', 'NEA'];

export class Interaction {
  state: OverlayState = { cursor: null, marker: null, box: null, tip: null, pickbox: true, crosshair: true, guides: [], acquired: [] };
  /** Points accrochés récemment (repérage d'alignement, repérage d'objets). */
  private acquired: Vec3[] = [];
  /** Segments droits survolés récemment (accrochages Prolongement et Parallèle). */
  private acquiredSegs: [Vec3, Vec3][] = [];
  /** Segment droit sous le curseur au dernier accrochage. */
  private hoverSeg: [Vec3, Vec3] | null = null;
  /** Manipulateur 3D de la sélection. */
  readonly gizmo: TransformGizmo;
  private drag: {
    handle: GizmoHandle;
    origin: Vec3;
    handles: string[];
    start: number;
    value: number;
    matrix: Affine | null;
    sx: number;
    sy: number;
    flat: Vec3[][];
  } | null = null;
  navMode: 'orbit' | 'pan' | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly el: HTMLCanvasElement;
  private readonly raycaster = new THREE.Raycaster();
  private m = new THREE.Matrix4();
  private W = 1;
  private H = 1;
  private last: { x: number; y: number; shift: boolean } | null = null;
  private frame = 0;
  private down: { x: number; y: number; button: number; time: number } | null = null;
  /** Fenêtre de sélection commencée par un clic (clic-clic). */
  private boxStart: { x: number; y: number } | null = null;
  private dragging = false;
  private current: Vec3 | null = null;
  private readonly disposers: (() => void)[] = [];
  private lastMiddle = 0;
  /** Clic droit en cours : un appui court vaut Entrée, un appui long ouvre le menu. */
  private right: { x: number; y: number; timer: number; menu: boolean } | null = null;
  private lastRightUp = 0;

  constructor(
    private readonly app: AppHost,
    private readonly vp: CadViewport,
    private readonly scene: SceneSync,
  ) {
    this.el = vp.renderer.domElement;
    this.gizmo = new TransformGizmo(vp);
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      this.el.addEventListener(type, fn as EventListener);
      this.disposers.push(() => this.el.removeEventListener(type, fn as EventListener));
    };
    on('pointermove', (e) => this.onMove(e));
    on('pointerdown', (e) => this.onDown(e));
    on('pointerup', (e) => this.onUp(e));
    on('pointerleave', () => this.onLeave());
    on('dblclick', (e) => this.onDouble(e));
    on('contextmenu', (e) => this.onContext(e));
    this.disposers.push(
      app.on('prompt', () => this.refresh()),
      app.on('input', () => this.app.settings.dyn && this.refresh()),
      app.on('command', () => {
        this.acquired = [];
        this.acquiredSegs = [];
        this.boxStart = null;
        this.setState({ box: null });
        this.refresh();
      }),
      app.on('doc', () => (this.refresh(), this.updateGizmo())),
      app.on('selection', () => this.updateGizmo()),
      app.on('settings', () => this.updateGizmo()),
      app.on('prompt', () => this.updateGizmo()),
      app.on('command', () => this.updateGizmo()),
    );
    vp.controls.addEventListener('change', this.onCamera);
  }

  dispose(): void {
    this.gizmo.dispose();
    this.disposers.forEach((d) => d());
    this.vp.controls.removeEventListener('change', this.onCamera);
    cancelAnimationFrame(this.frame);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private setState(patch: Partial<OverlayState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  setNavMode(mode: 'orbit' | 'pan' | null): void {
    if (mode === 'orbit' && this.vp.workspace === '2d') mode = 'pan'; // pas d'orbite en 2D
    this.navMode = mode;
    const THREE_MOUSE = THREE.MOUSE;
    this.vp.controls.mouseButtons = { LEFT: mode === 'orbit' ? THREE_MOUSE.ROTATE : mode === 'pan' ? THREE_MOUSE.PAN : null, MIDDLE: THREE_MOUSE.PAN, RIGHT: null } as never;
    this.el.style.cursor = mode ? (mode === 'orbit' ? 'grab' : 'move') : 'none';
    this.setState({ crosshair: !mode, marker: null });
    this.updateGizmo();
    this.app.log(mode ? `<${mode === 'orbit' ? 'Orbite' : 'Panoramique'} : faites glisser avec le bouton gauche, Échap pour quitter>` : '<Navigation terminée>');
    this.app.emit('settings');
  }

  // =========================================================================
  // Projection
  // =========================================================================

  private updateMatrix(): void {
    const cam = this.vp.activeCamera;
    cam.updateMatrixWorld();
    this.m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.W = this.el.clientWidth;
    this.H = this.el.clientHeight;
  }

  /** Coordonnées écran (px, relatives au viewport) d'un point du modèle. */
  project(p: Vec3): Proj {
    const e = this.m.elements;
    const x = e[0]! * p.x + e[4]! * p.y + e[8]! * p.z + e[12]!;
    const y = e[1]! * p.x + e[5]! * p.y + e[9]! * p.z + e[13]!;
    const w = e[3]! * p.x + e[7]! * p.y + e[11]! * p.z + e[15]!;
    const iw = 1 / (Math.abs(w) < 1e-12 ? 1e-12 : w);
    return { x: ((x * iw + 1) / 2) * this.W, y: ((1 - y * iw) / 2) * this.H, w };
  }

  private ray(sx: number, sy: number): THREE.Ray {
    const ndc = new THREE.Vector2((sx / this.W) * 2 - 1, -(sy / this.H) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.vp.activeCamera);
    return this.raycaster.ray;
  }

  /** Point du plan de travail sous le curseur (plan de vue si le regard est rasant). */
  worldAt(sx: number, sy: number, spec?: PromptSpec | null): Vec3 {
    const ray = this.ray(sx, sy);
    const axis = promptAxis(spec);
    if (axis && spec?.basePoint) {
      // point de l'axe (verticale, normale de face…) passant par la base le plus proche du rayon
      const b = spec.basePoint;
      const p0 = new THREE.Vector3(b.x, b.y, b.z);
      const u = new THREE.Vector3(axis.x, axis.y, axis.z);
      const w0 = new THREE.Vector3().subVectors(p0, ray.origin);
      const a = u.dot(u), bb = u.dot(ray.direction), c = ray.direction.dot(ray.direction), d = u.dot(w0), e = ray.direction.dot(w0);
      const den = a * c - bb * bb;
      const s = Math.abs(den) < 1e-12 ? 0 : (bb * e - c * d) / den;
      return { x: b.x + u.x * s, y: b.y + u.y * s, z: b.z + u.z * s };
    }
    const z = spec?.basePoint?.z ?? this.app.processor.elevation;
    const dir = ray.direction;
    if (Math.abs(dir.z) > 0.08) {
      const t = (z - ray.origin.z) / dir.z;
      if (t > 0) {
        const p = ray.origin.clone().addScaledVector(dir, t);
        return { x: p.x, y: p.y, z };
      }
    }
    // vue de face / de côté : plan perpendiculaire au regard passant par la cible (ou la base)
    const target = spec?.basePoint ? new THREE.Vector3(spec.basePoint.x, spec.basePoint.y, spec.basePoint.z) : this.vp.controls.target;
    const n = new THREE.Vector3();
    this.vp.activeCamera.getWorldDirection(n);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, target);
    const p = new THREE.Vector3();
    if (ray.intersectPlane(plane, p)) return { x: p.x, y: p.y, z: p.z };
    return { x: target.x, y: target.y, z: target.z };
  }

  // =========================================================================
  // Recherche d'objets sous le curseur
  // =========================================================================

  private candidates(sx: number, sy: number, tol: number): string[] {
    const out: string[] = [];
    for (const e of this.app.doc.all()) {
      const d = this.scene.pickData(e.handle);
      if (d?.bbox && this.boxNear(d.bbox, sx, sy, tol)) out.push(e.handle);
    }
    return out;
  }

  /**
   * Contour fermé désigné par l'intérieur, s'il n'est
   * pas caché par un solide plus proche ; le plus petit contour contenant le curseur l'emporte.
   */
  private closedProfileAt(sx: number, sy: number, ok: (h: string) => boolean, ray: THREE.Ray, maxDist: number): { handle: string; point: Vec3 } | null {
    let best: { handle: string; point: Vec3; area: number } | null = null;
    for (const h of this.candidates(sx, sy, PICK)) {
      if (!ok(h)) continue;
      const pd = this.scene.pickData(h);
      const poly = pd?.polys[0];
      if (!pd || !poly || poly.length < 3 || pd.entity.type === '3DSOLID' || pd.entity.type === 'UNDERLAY') continue;
      if (this.screenDistance(pd.polys, sx, sy).d > PICK && !this.insideScreenPolygon(poly, sx, sy)) continue;
      // profondeur : rayon ∩ plan horizontal du contour
      const z = poly[0]!.z;
      const t = Math.abs(ray.direction.z) > 1e-9 ? (z - ray.origin.z) / ray.direction.z : NaN;
      if (!(t > 0) || t > maxDist * 1.001 + 1e-6) continue;
      const pts = poly.map((p) => this.project(p));
      let area = 0;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) area += (pts[j]!.x - pts[i]!.x) * (pts[j]!.y + pts[i]!.y);
      area = Math.abs(area / 2);
      if (!best || area < best.area) best = { handle: h, point: v(ray.at(t, new THREE.Vector3())), area };
    }
    return best && { handle: best.handle, point: best.point };
  }

  /** L'emprise projetée à l'écran passe-t-elle à moins de `tol` pixels du curseur ? */
  private boxNear(b: { min: Vec3; max: Vec3 }, sx: number, sy: number, tol: number): boolean {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, front = false;
    for (let i = 0; i < 8; i++) {
      const p = this.project({ x: i & 1 ? b.max.x : b.min.x, y: i & 2 ? b.max.y : b.min.y, z: i & 4 ? b.max.z : b.min.z });
      if (p.w > 0) front = true;
      x0 = Math.min(x0, p.x), y0 = Math.min(y0, p.y), x1 = Math.max(x1, p.x), y1 = Math.max(y1, p.y);
    }
    return front && sx >= x0 - tol && sx <= x1 + tol && sy >= y0 - tol && sy <= y1 + tol;
  }

  /** Objets d'un fond de plan vectoriel proches du curseur (au plus `limit`). */
  private underlayNear(sub: UnderlaySub, sx: number, sy: number, tol: number, limit: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < sub.entities.length && out.length < limit; i++) {
      const b = sub.boxes[i];
      if (b && this.boxNear(b, sx, sy, tol)) out.push(i);
    }
    return out;
  }

  /** Distance écran du curseur aux polylignes. */
  private screenDistance(polys: Vec3[][], sx: number, sy: number): { d: number; poly: number; seg: number; t: number } {
    let best = { d: Infinity, poly: -1, seg: -1, t: 0 };
    polys.forEach((pl, pi) => {
      let prev: Proj | null = null;
      for (let i = 0; i < pl.length; i++) {
        const p = this.project(pl[i]!);
        if (p.w <= 0) {
          prev = null;
          continue;
        }
        if (pl.length === 1 || (prev === null && i === pl.length - 1)) {
          const d = Math.hypot(p.x - sx, p.y - sy);
          if (d < best.d) best = { d, poly: pi, seg: i, t: 0 };
        }
        if (prev) {
          const dx = p.x - prev.x, dy = p.y - prev.y;
          const l2 = dx * dx + dy * dy;
          const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((sx - prev.x) * dx + (sy - prev.y) * dy) / l2)) : 0;
          const d = Math.hypot(prev.x + t * dx - sx, prev.y + t * dy - sy);
          if (d < best.d) best = { d, poly: pi, seg: i - 1, t };
        }
        prev = p;
      }
    });
    return best;
  }

  private insideScreenPolygon(poly: Vec3[], sx: number, sy: number): boolean {
    const pts = poly.map((p) => this.project(p));
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i]!, b = pts[j]!;
      if (a.y > sy !== b.y > sy && sx < ((b.x - a.x) * (sy - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  }

  /** Objet (ou arête/face) sous le curseur. */
  pickAt(sx: number, sy: number, opts: { filter?: (h: string) => boolean; mode?: 'entity' | 'edge' | 'face' } = {}): { handle: string; point: Vec3; sub?: number } | null {
    const mode = opts.mode ?? 'entity';
    const doc = this.app.doc;
    const ok = (h: string) => {
      const e = doc.get(h);
      return !!e && doc.isPickable(e) && (!opts.filter || opts.filter(h));
    };
    // 1. solides : lancer de rayon
    const ray = this.ray(sx, sy);
    const meshes = this.scene.solidMeshes().filter((m) => ok(m.userData.handle as string));
    const wire = this.app.settings.visualStyle === 'wireframe';
    let hit: THREE.Intersection | null = null;
    if (meshes.length) {
      for (const m of meshes) m.visible = true;
      this.raycaster.params.Line = { threshold: 0 };
      const hits = this.raycaster.intersectObjects(meshes, false);
      if (wire) for (const m of meshes) m.visible = false;
      hit = hits[0] ?? null;
    }
    if (mode === 'face') {
      // contour fermé dessiné sur une face (esquisse) : prioritaire sur la face qui le porte
      const prof = this.closedProfileAt(sx, sy, ok, ray, hit ? hit.distance : Infinity);
      if (prof) return prof;
    }
    if (mode === 'face' && hit && hit.faceIndex != null) {
      const h = hit.object.userData.handle as string;
      const e = doc.get(h) as Extract<Entity, { type: '3DSOLID' }>;
      return { handle: h, point: v(hit.point), sub: e.display.faceIds[hit.faceIndex] };
    }
    if (mode === 'edge') {
      let best: { handle: string; edge: number; d: number; point: Vec3 } | null = null;
      const camPos = this.vp.activeCamera.position;
      const hitDist = hit ? hit.distance : Infinity;
      for (const m of meshes) {
        const h = m.userData.handle as string;
        const pd = this.scene.pickData(h);
        if (!pd) continue;
        pd.polys.forEach((pl, i) => {
          const r = this.screenDistance([pl], sx, sy);
          if (r.d > 9 || (best && r.d >= best.d)) return;
          const a = pl[r.seg]!, b = pl[Math.min(r.seg + 1, pl.length - 1)]!;
          const p = { x: a.x + (b.x - a.x) * r.t, y: a.y + (b.y - a.y) * r.t, z: a.z + (b.z - a.z) * r.t };
          // arête masquée par une face plus proche : ignorée
          const dc = Math.hypot(p.x - camPos.x, p.y - camPos.y, p.z - camPos.z);
          if (!wire && dc > hitDist * 1.002 + 1e-6 && hit && hit.object !== m) return;
          if (!wire && hit && hit.object === m && dc > hitDist * 1.02 + 0.05) return;
          best = { handle: h, edge: i, d: r.d, point: p };
        });
      }
      const b = best as { handle: string; edge: number; d: number; point: Vec3 } | null;
      return b ? { handle: b.handle, point: b.point, sub: b.edge } : null;
    }
    // 2. courbes 2D (et arêtes des solides en filaire)
    let best: { handle: string; d: number; point: Vec3 } | null = null;
    for (const h of this.candidates(sx, sy, PICK)) {
      if (!ok(h)) continue;
      const pd = this.scene.pickData(h);
      if (!pd) continue;
      const e = pd.entity;
      if (e.type === '3DSOLID' && !wire) continue;
      let d: number;
      if (e.type === 'TEXT') d = pd.polys[0] && this.insideScreenPolygon(pd.polys[0], sx, sy) ? 0 : this.screenDistance(pd.polys, sx, sy).d;
      else if (e.type === 'HATCH') d = pd.polys.some((pl) => this.insideScreenPolygon(pl, sx, sy)) ? 3 : Infinity;
      else if (e.type === 'UNDERLAY') {
        // vectoriel : sur l'un de ses objets ; image : dans le cadre
        if (pd.sub) d = Math.min(Infinity, ...this.underlayNear(pd.sub, sx, sy, PICK, 400).map((i) => this.screenDistance(pd.sub!.polys[i]!, sx, sy).d));
        else d = pd.polys[0] && this.insideScreenPolygon(pd.polys[0], sx, sy) ? PICK : Infinity;
      } else d = this.screenDistance(pd.polys, sx, sy).d;
      if (d <= PICK && (!best || d < best.d)) best = { handle: h, d, point: this.worldAt(sx, sy) };
    }
    if (best) {
      // une courbe 2D devant un solide l'emporte ; derrière, c'est le solide
      return { handle: best.handle, point: best.point };
    }
    // mode face sans solide sous le curseur : seules les courbes (contours fermés) comptent
    if (mode === 'face') return null;
    if (hit) return { handle: hit.object.userData.handle as string, point: v(hit.point) };
    return null;
  }

  // =========================================================================
  // Accrochage
  // =========================================================================

  private snap(sx: number, sy: number, spec: PromptSpec | null): { point: Vec3; kind: SnapKind } | null {
    this.hoverSeg = null;
    if (!this.app.settings.osnap) return null;
    const modes = new Set(this.app.settings.osnapModes);
    if (!modes.size) return null;
    const doc = this.app.doc;
    const near = this.candidates(sx, sy, APERTURE).filter((h) => {
      const e = doc.get(h);
      return !!e && doc.isVisible(e);
    });
    if (!near.length) return null;
    const base = spec?.basePoint;
    let best: { point: Vec3; kind: SnapKind; d: number } | null = null;
    /** `effective` : distance de classement imposée (accrochages « sur la courbe »). */
    const consider = (kind: SnapKind, point: Vec3, effective?: number) => {
      if (!modes.has(kind)) return;
      const p = this.project(point);
      if (p.w <= 0) return;
      const d = effective ?? Math.hypot(p.x - sx, p.y - sy);
      if (d > APERTURE + 4) return;
      if (!best || d < best.d - 1.5 || (Math.abs(d - best.d) <= 1.5 && PRIORITY.indexOf(kind) < PRIORITY.indexOf(best.kind))) best = { point, kind, d };
    };
    const ents: Entity[] = [];
    const onEntity = (e: Entity, polys: Vec3[][]) => {
      ents.push(e);
      for (const c of snapPoints(e)) consider(c.kind, c.point);
      // sur la courbe : centre, perpendiculaire, tangente, proche
      const curve = e.type === '3DSOLID' ? null : this.screenDistance(polys, sx, sy);
      if (!curve || curve.d > APERTURE) return;
      if (e.type === 'CIRCLE' || e.type === 'ARC') consider('CEN', e.center, curve.d + 2);
      const pl = polys[curve.poly]!;
      const a = pl[curve.seg]!, b = pl[Math.min(curve.seg + 1, pl.length - 1)]!;
      const onCurve = { x: a.x + (b.x - a.x) * curve.t, y: a.y + (b.y - a.y) * curve.t, z: a.z + (b.z - a.z) * curve.t };
      if (e.type === 'LINE') this.hoverSeg = [e.start, e.end];
      else if (e.type === 'POLYLINE' && !e.bulges?.[curve.seg]) this.hoverSeg = [a, b];
      if (base) {
        if (e.type === 'LINE' || (e.type === 'POLYLINE' && !(e.bulges?.[curve.seg]))) {
          const s = e.type === 'LINE' ? [e.start, e.end] : [a, b];
          const foot = perpendicularFoot(base, s[0]!, s[1]!);
          if (foot) consider('PER', foot, curve.d + 3);
        }
        if (e.type === 'CIRCLE' || e.type === 'ARC') {
          const dx = base.x - e.center.x, dy = base.y - e.center.y, L = Math.hypot(dx, dy);
          if (L > 1e-9) {
            const foot = { x: e.center.x + (dx / L) * e.radius, y: e.center.y + (dy / L) * e.radius, z: e.center.z };
            consider('PER', foot, curve.d + 3);
            if (L > e.radius) {
              const ang = Math.atan2(dy, dx), da = Math.acos(e.radius / L);
              const tps = [ang + da, ang - da].map((t) => ({ x: e.center.x + e.radius * Math.cos(t), y: e.center.y + e.radius * Math.sin(t), z: e.center.z }));
              const tp = tps.sort((p, q) => distScreen(this, p, sx, sy) - distScreen(this, q, sx, sy))[0]!;
              consider('TAN', tp, curve.d + 3);
            }
          }
        }
      }
      consider('NEA', onCurve, curve.d + 4);
    };
    for (const h of near.slice(0, 60)) {
      const pd = this.scene.pickData(h);
      if (!pd) continue;
      if (pd.entity.type === 'UNDERLAY') {
        // accrochage sur les objets du fond de plan (comme une référence externe)
        consider('INS', pd.entity.position);
        if (pd.sub) for (const i of this.underlayNear(pd.sub, sx, sy, APERTURE, 40)) onEntity(pd.sub.entities[i]!, pd.sub.polys[i]!);
        continue;
      }
      onEntity(pd.entity, pd.polys);
    }
    // intersections entre objets proches
    if (modes.has('INT') && ents.length > 1) {
      const flat = ents.filter((e) => e.type !== '3DSOLID' && e.type !== 'TEXT' && e.type !== 'HATCH' && e.type !== 'POINT').slice(0, 12);
      for (let i = 0; i < flat.length; i++) for (const p of intersectionsWith(flat[i]!, flat.slice(i + 1))) consider('INT', p);
    }
    const b = best as { point: Vec3; kind: SnapKind; d: number } | null;
    return b ? { point: b.point, kind: b.kind } : null;
  }

  /** Point courant : accrochage objet, sinon grille / ortho / polaire. */
  private resolvePoint(sx: number, sy: number, spec: PromptSpec | null): ResolvedPoint {
    const r = this.resolveDyn(this.resolveFree(sx, sy, spec), spec);
    // courbe plane (polyligne, spline) : le point reste à la hauteur du point précédent, même
    // accroché à un objet plus haut ou plus bas (sinon le profil n'est plus plan)
    const b = spec?.planar ? spec.basePoint : undefined;
    if (b && r.point.z !== b.z) return { ...r, point: { ...r.point, z: b.z } };
    return r;
  }

  /** Saisie dynamique : point verrouillé sur les valeurs déjà tapées dans les cases (longueur, X…). */
  private resolveDyn(r: ResolvedPoint, spec: PromptSpec | null): ResolvedPoint {
    const s = this.app.settings;
    if (!s.dyn || !this.app.input.trim()) return r;
    const layout = dynLayout(spec, s.dynRelative);
    const p = layout && constrainDyn(layout, this.app.input, r.point);
    return p ? { point: p, snap: null, tip: null, tracking: null } : r;
  }

  /** Pas de la résolution F9 : réglé (RESOL), sinon celui de la grille réglée, sinon adaptatif. */
  private snapStep(): number {
    const s = this.app.settings;
    return s.snapUnit > 0 ? s.snapUnit : s.gridUnit > 0 ? s.gridUnit : this.vp.grid.currentStep;
  }

  private resolveFree(sx: number, sy: number, spec: PromptSpec | null): ResolvedPoint {
    const raw = this.worldAt(sx, sy, spec);
    const axis = promptAxis(spec);
    if (axis && spec?.basePoint) {
      const b = spec.basePoint;
      const along = (p: Vec3) => (p.x - b.x) * axis.x + (p.y - b.y) * axis.y + (p.z - b.z) * axis.z;
      const at = (t: number) => ({ x: b.x + axis.x * t, y: b.y + axis.y * t, z: b.z + axis.z * t });
      const s = this.snap(sx, sy, spec);
      // accrochage : projeté sur l'axe (hauteur d'un sommet, profondeur d'une face…)
      if (s) return { point: at(along(s.point)), snap: s, tip: null, tracking: null };
      return { point: raw, snap: null, tip: `${spec.vertical ? 'Hauteur' : 'Distance'} : ${along(raw).toFixed(3)}`, tracking: null };
    }
    const s = this.snap(sx, sy, spec);
    if (s) return { point: s.point, snap: s, tip: null, tracking: null };
    if (spec?.kind === 'point') {
      const t = this.trackSegments(sx, sy, spec);
      if (t) return t;
    }
    if (this.app.settings.infer && spec?.kind === 'point') {
      const inf = this.infer(sx, sy, spec);
      if (inf) return inf;
    }
    let p = raw;
    if (this.app.settings.snap) {
      const step = this.snapStep();
      p = { x: Math.round(p.x / step) * step, y: Math.round(p.y / step) * step, z: p.z };
    }
    const base = spec?.basePoint;
    const angular = spec && (spec.kind === 'point' || spec.kind === 'distance' || spec.kind === 'angle');
    if (base && angular) {
      const dx = p.x - base.x, dy = p.y - base.y;
      const L = Math.hypot(dx, dy);
      if (this.app.settings.ortho && L > 0) {
        p = Math.abs(dx) >= Math.abs(dy) ? { x: p.x, y: base.y, z: base.z } : { x: base.x, y: p.y, z: base.z };
        return { point: p, snap: null, tip: null, tracking: null };
      }
      if (this.app.settings.polar && L > 0) {
        const inc = (this.app.settings.polarIncrement * Math.PI) / 180;
        const ang = Math.atan2(dy, dx);
        const k = Math.round(ang / inc) * inc;
        const q = { x: base.x + L * Math.cos(k) * Math.cos(ang - k), y: base.y + L * Math.sin(k) * Math.cos(ang - k), z: base.z };
        const qs = this.project(q), ps = this.project(p);
        if (Math.hypot(qs.x - ps.x, qs.y - ps.y) < 10) {
          const len = L * Math.cos(ang - k);
          const far = { x: base.x + len * 4 * Math.cos(k) + Math.cos(k) * 1e-3, y: base.y + len * 4 * Math.sin(k), z: base.z };
          const deg = (((k * 180) / Math.PI) % 360 + 360) % 360;
          return { point: q, snap: null, tip: `Polaire : ${len.toFixed(4).replace(/\.?0+$/, '')} < ${deg.toFixed(0)}°`, tracking: [base, far] };
        }
      }
    }
    return { point: p, snap: null, tip: null, tracking: null };
  }

  /**
   * Prolongement d'un segment survolé au-delà de ses extrémités, ou parallèle à ce segment depuis
   * le point de base (accrochages EXT et PAR).
   */
  private trackSegments(sx: number, sy: number, spec: PromptSpec): ResolvedPoint | null {
    const st = this.app.settings;
    if (!st.osnap || !this.acquiredSegs.length) return null;
    const modes = new Set(st.osnapModes);
    const ray = this.ray(sx, sy);
    const color = '#d86bff';
    const scr = (p: Vec3) => {
      const q = this.project(p);
      return q.w > 0 ? Math.hypot(q.x - sx, q.y - sy) : Infinity;
    };
    let best: { r: ResolvedPoint; d: number } | null = null;
    const keep = (r: ResolvedPoint, d: number) => {
      if (d <= INFER && (!best || d < best.d)) best = { r, d };
    };
    const planar = (p: Vec3, z: number) => (this.vp.workspace === '3d' ? p : { ...p, z });
    for (const [a, b] of this.acquiredSegs) {
      const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
      const L = Math.hypot(u.x, u.y, u.z);
      if (L < 1e-9) continue;
      if (modes.has('EXT')) {
        const { p, t } = this.onLine(ray, a, u);
        // au-delà d'une extrémité seulement (sur le segment, c'est l'accrochage Proche)
        if (t > 1 + 1e-6 || t < -1e-6) {
          const from = t > 1 ? b : a;
          const g = this.guide(from, p, color, true);
          const len = Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z);
          keep({ point: p, snap: { kind: 'EXT', point: p }, tip: `Prolongement : ${len.toFixed(3).replace(/\.?0+$/, '')}`, tracking: null, guides: g ? [g] : [] }, scr(p));
        }
      }
      const base = spec.basePoint;
      if (base && modes.has('PAR')) {
        const { p, t } = this.onLine(ray, base, u);
        if (Math.abs(t) * L > this.vp.worldUnitsPerPixel() * 20) {
          const q = planar(p, base.z);
          const g = this.guide(base, q, color, true);
          keep({ point: q, snap: { kind: 'PAR', point: q }, tip: `Parallèle : ${(Math.abs(t) * L).toFixed(3).replace(/\.?0+$/, '')}`, tracking: null, guides: g ? [g] : [] }, scr(q) + 1);
        }
      }
    }
    return (best as { r: ResolvedPoint } | null)?.r ?? null;
  }

  // =========================================================================
  // Inférences
  // =========================================================================

  /** Point de la droite p0 + t·u le plus proche du rayon de vue, et son paramètre t. */
  private onLine(ray: THREE.Ray, p0: Vec3, u: Vec3): { p: Vec3; t: number } {
    const w0 = new THREE.Vector3(p0.x - ray.origin.x, p0.y - ray.origin.y, p0.z - ray.origin.z);
    const U = new THREE.Vector3(u.x, u.y, u.z);
    const a = U.dot(U), b = U.dot(ray.direction), c = ray.direction.dot(ray.direction), d = U.dot(w0), e = ray.direction.dot(w0);
    const den = a * c - b * b;
    const t = Math.abs(den) < 1e-12 ? 0 : (b * e - c * d) / den;
    return { p: { x: p0.x + u.x * t, y: p0.y + u.y * t, z: p0.z + u.z * t }, t };
  }

  /** Segment écran (prolongé) d'une droite du modèle pour l'afficher en guide. */
  private guide(a: Vec3, b: Vec3, color: string, dashed = false): Guide | null {
    const pa = this.project(a), pb = this.project(b);
    if (pa.w <= 0 || pb.w <= 0) return null;
    const dx = pb.x - pa.x, dy = pb.y - pa.y, L = Math.hypot(dx, dy);
    if (L < 1) return null;
    const k = 4000 / L;
    return { x1: pa.x - dx * (dashed ? k : 0), y1: pa.y - dy * (dashed ? k : 0), x2: pb.x + dx * k, y2: pb.y + dy * k, color, dashed };
  }

  /**
   * Inférences : axe X/Y/Z depuis le point de base (ligne de couleur), alignement sur un point
   * accroché (pointillés, intersection de deux alignements), puis point sur la face d'un solide.
   */
  private infer(sx: number, sy: number, spec: PromptSpec): ResolvedPoint | null {
    const ray = this.ray(sx, sy);
    const is3d = this.vp.workspace === '3d';
    // courbe plane : pas d'axe Z (un clic près de la verticale ferait sortir le point du plan)
    const axes = is3d && !spec.planar ? AXES : AXES.slice(0, 2);
    const base = spec.basePoint;
    type Cand = { p: Vec3; d: number; color: string; from: Vec3; label: string; axis: number };
    const near = (from: Vec3, maxD: number): Cand[] => {
      const out: Cand[] = [];
      axes.forEach((ax, i) => {
        const { p } = this.onLine(ray, from, ax.dir);
        const q = this.project(p), f = this.project(from);
        if (q.w <= 0) return;
        const d = Math.hypot(q.x - sx, q.y - sy);
        // l'axe vu en bout (perpendiculaire à l'écran) n'est pas une direction utilisable
        const k = this.vp.worldUnitsPerPixel() * 40;
        const tip = this.project({ x: from.x + ax.dir.x * k, y: from.y + ax.dir.y * k, z: from.z + ax.dir.z * k });
        if (Math.hypot(tip.x - f.x, tip.y - f.y) < 8) return;
        if (d <= maxD && Math.hypot(q.x - f.x, q.y - f.y) > 6) out.push({ p, d, color: ax.color, from, label: ax.name, axis: i });
      });
      return out.sort((a, b) => a.d - b.d);
    };
    const fmt = (v: number) => v.toFixed(3).replace(/\.?0+$/, '');
    // 1. axe depuis le point de base
    if (base) {
      const c = near(base, INFER)[0];
      if (c) {
        const len = Math.hypot(c.p.x - base.x, c.p.y - base.y, c.p.z - base.z);
        // alignement simultané sur un point acquis : point d'intersection
        for (const a of this.acquired) {
          const other = near(a, INFER).find((o) => o.axis !== c.axis);
          if (!other) continue;
          const hit = closestBetween(base, AXES[c.axis]!.dir, a, AXES[other.axis]!.dir);
          if (!hit) continue;
          const g1 = this.guide(base, hit, c.color), g2 = this.guide(a, hit, other.color, true);
          return { point: hit, snap: null, tip: `Axe ${c.label} et alignement ${other.label}`, tracking: null, guides: [g1, g2].filter((g): g is Guide => !!g) };
        }
        const g = this.guide(base, c.p, c.color);
        return { point: c.p, snap: null, tip: `Sur l'axe ${c.label} : ${fmt(len)}`, tracking: null, guides: g ? [g] : [] };
      }
    }
    // 2. alignement sur les points acquis
    const cands = this.acquired.flatMap((a) => near(a, INFER - 2));
    if (cands.length) {
      const c = cands[0]!;
      const second = cands.find((o) => o.from !== c.from && o.axis !== c.axis);
      if (second) {
        const hit = closestBetween(c.from, AXES[c.axis]!.dir, second.from, AXES[second.axis]!.dir);
        if (hit) {
          const gs = [this.guide(c.from, hit, c.color, true), this.guide(second.from, hit, second.color, true)].filter((g): g is Guide => !!g);
          return { point: hit, snap: null, tip: 'Intersection des alignements', tracking: null, guides: gs };
        }
      }
      // en 2D (ou sans base) on reste dans le plan de travail : on prend le point du plan sur l'alignement
      const p = is3d ? c.p : { ...c.p, z: base?.z ?? this.app.processor.elevation };
      const g = this.guide(c.from, p, c.color, true);
      return { point: p, snap: null, tip: `Alignement ${c.label}`, tracking: null, guides: g ? [g] : [] };
    }
    // 3. sur la face d'un solide (3D) : le point suit la surface sous le curseur
    if (is3d && this.app.settings.osnap) {
      const meshes = this.scene.solidMeshes().filter((m) => {
        const e = this.app.doc.get(m.userData.handle as string);
        return !!e && this.app.doc.isVisible(e);
      });
      if (meshes.length && this.app.settings.visualStyle !== 'wireframe') {
        this.raycaster.params.Line = { threshold: 0 };
        const hit = this.raycaster.intersectObjects(meshes, false)[0];
        if (hit) return { point: v(hit.point), snap: { kind: 'FACE', point: v(hit.point) }, tip: null, tracking: null };
      }
    }
    return null;
  }

  // =========================================================================
  // Manipulateur 3D
  // =========================================================================

  /** Affiche le manipulateur au centre de la sélection (3D, aucune commande en cours). */
  updateGizmo(): void {
    if (this.drag) return;
    const app = this.app;
    const sel = app.selection.list();
    const ok = app.settings.gizmo && this.vp.workspace === '3d' && app.processor.isIdle && !this.navMode && sel.length > 0;
    if (!ok) return this.gizmo.show(null);
    const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const h of sel) {
      const b = this.scene.pickData(h)?.bbox;
      if (!b) continue;
      min.x = Math.min(min.x, b.min.x), min.y = Math.min(min.y, b.min.y), min.z = Math.min(min.z, b.min.z);
      max.x = Math.max(max.x, b.max.x), max.y = Math.max(max.y, b.max.y), max.z = Math.max(max.z, b.max.z);
    }
    if (!Number.isFinite(min.x)) return this.gizmo.show(null);
    this.gizmo.show({ x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 });
  }

  private ndc(sx: number, sy: number): THREE.Vector2 {
    return new THREE.Vector2((sx / this.W) * 2 - 1, -(sy / this.H) * 2 + 1);
  }

  /** Paramètre du glisser : abscisse le long de l'axe (déplacer) ou angle dans le plan (pivoter). */
  private gizmoParam(h: GizmoHandle, origin: Vec3, sx: number, sy: number): number | null {
    const ray = this.ray(sx, sy);
    const u = AXES[h.axis]!.dir;
    if (h.kind === 'move') return this.onLine(ray, origin, u).t;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(u.x, u.y, u.z), new THREE.Vector3(origin.x, origin.y, origin.z));
    const q = new THREE.Vector3();
    if (!ray.intersectPlane(plane, q)) return null;
    const e1 = AXES[(h.axis + 1) % 3]!.dir, e2 = AXES[(h.axis + 2) % 3]!.dir;
    const d = { x: q.x - origin.x, y: q.y - origin.y, z: q.z - origin.z };
    return Math.atan2(d.x * e2.x + d.y * e2.y + d.z * e2.z, d.x * e1.x + d.y * e1.y + d.z * e1.z);
  }

  /** Matrice du manipulateur pour une valeur (distance ou angle en radians). */
  private gizmoMatrix(h: GizmoHandle, origin: Vec3, value: number): Affine {
    const u = AXES[h.axis]!.dir;
    if (h.kind === 'move') return translation({ x: u.x * value, y: u.y * value, z: u.z * value });
    const o = new THREE.Vector3(origin.x, origin.y, origin.z);
    const m = new THREE.Matrix4()
      .makeTranslation(o.x, o.y, o.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(u.x, u.y, u.z), value))
      .multiply(new THREE.Matrix4().makeTranslation(-o.x, -o.y, -o.z));
    const e = m.elements;
    return [e[0]!, e[4]!, e[8]!, e[12]!, e[1]!, e[5]!, e[9]!, e[13]!, e[2]!, e[6]!, e[10]!, e[14]!];
  }

  private static toMatrix4(a: Affine): THREE.Matrix4 {
    return new THREE.Matrix4().set(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8], a[9], a[10], a[11], 0, 0, 0, 1);
  }

  private startGizmoDrag(h: GizmoHandle, sx: number, sy: number): boolean {
    const origin = this.gizmo.position;
    const start = this.gizmoParam(h, origin, sx, sy);
    if (start === null) return false;
    const handles = this.app.selection.list().filter((x) => {
      const e = this.app.doc.get(x);
      return !!e && this.app.doc.isPickable(e) && e.type !== 'UNDERLAY';
    });
    if (!handles.length) return false;
    const flat = outlines(this.app, handles.filter((x) => this.app.doc.get(x)?.type !== '3DSOLID'));
    this.drag = { handle: h, origin, handles, start, value: 0, matrix: null, sx, sy, flat };
    this.gizmo.highlight(h);
    return true;
  }

  private moveGizmoDrag(sx: number, sy: number): void {
    const d = this.drag!;
    const now = this.gizmoParam(d.handle, d.origin, sx, sy);
    if (now === null) return;
    let value: number;
    let tip: string;
    const deg = 180 / Math.PI;
    if (d.handle.kind === 'move') {
      value = now - d.start;
      // pas d'accrochage : grille (RESOL) sinon arrondi lisible au zoom courant
      const step = this.app.settings.snap ? this.snapStep() : 10 ** Math.floor(Math.log10(Math.max(this.vp.worldUnitsPerPixel() * 4, 1e-6)));
      value = Math.round(value / step) * step;
      tip = `Déplacer ${'XYZ'[d.handle.axis]} : ${value.toFixed(4).replace(/\.?0+$/, '')}`;
    } else {
      let a = now - d.start;
      a = Math.atan2(Math.sin(a), Math.cos(a));
      const inc = this.app.settings.polar ? this.app.settings.polarIncrement : 1;
      value = (Math.round((a * deg) / inc) * inc) / deg;
      tip = `Pivoter autour de ${'XYZ'[d.handle.axis]} : ${(value * deg).toFixed(2).replace(/\.?0+$/, '')}°`;
    }
    d.value = value;
    d.matrix = this.gizmoMatrix(d.handle, d.origin, value);
    this.scene.setLiveTransform(d.handles, Interaction.toMatrix4(d.matrix));
    this.gizmo.show(applyAffine(d.matrix, d.origin));
    const m = d.matrix;
    this.scene.setPreview(d.flat.map((pl) => pl.map((p) => applyAffine(m, p))), null);
    this.setState({ tip, cursor: { x: sx, y: sy }, marker: null, guides: [], acquired: [] });
  }

  private cancelGizmoDrag(): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.scene.setLiveTransform(d.handles, null);
    this.scene.setPreview([], null);
    this.gizmo.highlight(null);
    this.setState({ tip: null });
    this.updateGizmo();
  }

  private async endGizmoDrag(sx: number, sy: number): Promise<void> {
    const d = this.drag!;
    const clicked = Math.hypot(sx - d.sx, sy - d.sy) < 4;
    if (clicked) {
      // simple clic sur une poignée : valeur exacte au clavier
      this.cancelGizmoDrag();
      const h = d.handle, origin = d.origin, handles = d.handles;
      const app = this.app;
      const axis = 'XYZ'[h.axis];
      await app.processor.run(
        cmd(h.kind === 'move' ? 'GIZMOMOVE' : 'GIZMOROTATE', h.kind === 'move' ? 'DEPLACERAXE' : 'PIVOTERAXE', [], '', async (ctx) => {
          const r = await ask(ctx, { kind: h.kind === 'move' ? 'distance' : 'real', message: h.kind === 'move' ? `Distance le long de ${axis}` : `Angle autour de ${axis} (degrés)`, allowNegative: true, allowZero: false });
          if (r.kind !== 'number') return;
          const value = h.kind === 'move' ? r.value : (r.value * Math.PI) / 180;
          await app.transformEntities(handles, this.gizmoMatrix(h, origin, value), { label: h.kind === 'move' ? 'Déplacer' : 'Rotation 3D', ctx });
          app.selection.set(handles);
        }),
      );
      return;
    }
    const m = d.matrix;
    const handles = d.handles;
    try {
      if (m && Math.abs(d.value) > 1e-12) {
        await this.app.transformEntities(handles, m, { label: d.handle.kind === 'move' ? 'Déplacer' : 'Rotation 3D' });
        this.app.log(this.state.tip ?? '');
      }
    } catch (e) {
      this.app.log(`Erreur : ${(e as Error).message}`);
    } finally {
      this.drag = null;
      this.scene.setLiveTransform(handles, null);
      this.scene.setPreview([], null);
      this.gizmo.highlight(null);
      this.setState({ tip: null });
      this.updateGizmo();
    }
  }

  // =========================================================================
  // Événements
  // =========================================================================

  private readonly onCamera = () => {
    if (this.last) this.schedule();
    else this.scene.updateConstraints();
  };

  private local(e: MouseEvent): { x: number; y: number } {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    if (this.drag) {
      this.updateMatrix();
      this.moveGizmoDrag(p.x, p.y);
      return;
    }
    this.last = { ...p, shift: e.shiftKey };
    if (this.down && this.down.button === 0 && !this.navMode && Math.hypot(p.x - this.down.x, p.y - this.down.y) > 5) {
      const spec = this.app.activeSpec;
      if (this.app.processor.isIdle || spec?.kind === 'selection') {
        if (!this.boxStart && this.hitTest(this.down.x, this.down.y) === null) this.boxStart = { x: this.down.x, y: this.down.y }, (this.dragging = true);
      }
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  /** Recalcule curseur, accrochage, aperçu et survol pour la dernière position connue. */
  refresh(): void {
    if (this.last) this.schedule();
    else this.scene.setPreview([], null);
  }

  private update(): void {
    const last = this.last;
    if (!last) return;
    this.updateMatrix();
    const { x, y } = last;
    const spec = this.app.activeSpec;
    const pointLike = !!spec && (spec.kind === 'point' || ((spec.kind === 'distance' || spec.kind === 'real' || spec.kind === 'angle') && !!spec.basePoint));
    const patch: Partial<OverlayState> = { cursor: { x, y }, box: this.boxStart ? { x0: this.boxStart.x, y0: this.boxStart.y, x1: x, y1: y, crossing: x < this.boxStart.x } : null };
    let hover: string | null = null;
    let hotGrip = -1;
    patch.guides = [];
    patch.acquired = [];
    if (this.navMode) {
      patch.marker = null;
      patch.tip = null;
      this.scene.setPreview([], null);
    } else if (pointLike) {
      const r = this.resolvePoint(x, y, spec);
      this.current = r.point;
      patch.marker = r.snap ? { kind: r.snap.kind, ...pick2(this.project(r.snap.point)), label: SNAP_LABEL[r.snap.kind] } : null;
      patch.tip = r.tip;
      if (r.snap && this.app.settings.infer && ACQUIRE.includes(r.snap.kind)) {
        const q = r.snap.point;
        if (!this.acquired.some((a) => Math.hypot(a.x - q.x, a.y - q.y, a.z - q.z) < 1e-9)) this.acquired = [q, ...this.acquired].slice(0, 4);
      }
      if (this.hoverSeg) {
        const [a, b] = this.hoverSeg;
        const same = (s: [Vec3, Vec3]) => Math.hypot(s[0].x - a.x, s[0].y - a.y, s[0].z - a.z) + Math.hypot(s[1].x - b.x, s[1].y - b.y, s[1].z - b.z) < 1e-9;
        if (!this.acquiredSegs.some(same)) this.acquiredSegs = [this.hoverSeg, ...this.acquiredSegs].slice(0, 3);
      }
      patch.guides = r.guides ?? [];
      patch.acquired = this.app.settings.infer ? this.acquired.map((a) => this.project(a)).filter((a) => a.w > 0).map(pick2) : [];
      patch.pickbox = false;
      const base = spec.basePoint;
      if (base) {
        // direction de l'élastique, en 3D (axe Z bleu, face, point accroché à une autre hauteur…) :
        // un nombre tapé au clavier = distance dans cette direction (entrée directe de distance)
        const d = { x: r.point.x - base.x, y: r.point.y - base.y, z: r.point.z - base.z };
        const L = Math.hypot(d.x, d.y, d.z);
        this.app.processor.cursorDirection = L > 1e-12 ? { x: d.x / L, y: d.y / L, z: d.z / L } : undefined;
      } else this.app.processor.cursorDirection = undefined;
      let polys: Vec3[][] = [];
      try {
        polys = spec.preview?.(r.point) ?? [];
      } catch {
        polys = [];
      }
      const rubber: [Vec3, Vec3] | null = base && !spec.noRubberBand ? [base, r.point] : null;
      this.scene.setPreview(polys, rubber, r.tracking);
      this.app.setCursor({ screen: { x, y }, world: r.point, snap: r.snap });
    } else {
      patch.marker = null;
      patch.tip = null;
      patch.pickbox = true;
      this.scene.setPreview([], null);
      const world = this.worldAt(x, y);
      this.current = world;
      this.app.setCursor({ screen: { x, y }, world, snap: null });
      const idle = this.app.processor.isIdle;
      const gh = idle && this.gizmo.visible && !this.boxStart ? this.gizmo.pick(this.ndc(x, y)) : null;
      this.gizmo.highlight(gh);
      if (gh) {
        patch.pickbox = false;
        patch.tip = gh.kind === 'move' ? `Glisser : déplacer le long de ${'XYZ'[gh.axis]} (clic : valeur exacte)` : `Glisser : pivoter autour de ${'XYZ'[gh.axis]} (clic : angle exact)`;
      } else if (!this.boxStart && (idle || spec?.kind === 'selection' || spec?.kind === 'entity')) {
        if (idle && this.scene.grips.length) hotGrip = this.gripAt(x, y);
        if (hotGrip < 0) {
          const mode = spec?.kind === 'entity' ? spec.pickMode : 'entity';
          const hit = this.pickAt(x, y, { filter: spec?.filter, mode });
          if (hit && (mode === 'edge' || mode === 'face') && hit.sub !== undefined) {
            this.hoverSub(hit.handle, mode, hit.sub);
          } else this.hoverSub(null, 'edge', 0);
          hover = hit && mode === 'entity' ? hit.handle : null;
        }
      }
    }
    this.scene.setHotGrip(hotGrip);
    if (hover !== this.app.hover) {
      this.app.hover = hover;
      this.scene.updateHover();
    }
    this.setState(patch);
  }

  private hoverSubKey = '';
  /** Survol d'une arête ou d'une face (désignation RACCORDBORD, COQUE…). */
  private hoverSub(handle: string | null, mode: 'edge' | 'face', sub: number): void {
    const key = handle ? `${handle}|${mode}|${sub}` : '';
    if (key === this.hoverSubKey) return;
    this.hoverSubKey = key;
    this.scene.hoverSub(handle ? { handle, edges: mode === 'edge' ? [sub] : [], faces: mode === 'face' ? [sub] : [] } : null);
  }

  private gripAt(x: number, y: number): number {
    let best = -1, bd = 8;
    this.scene.grips.forEach((g, i) => {
      const p = this.project(g.point);
      const d = Math.max(Math.abs(p.x - x), Math.abs(p.y - y));
      if (d <= bd) (bd = d), (best = i);
    });
    return best;
  }

  /** Objet sous le point écran (pour décider clic sur objet / début de fenêtre). */
  private hitTest(x: number, y: number): string | null {
    this.updateMatrix();
    const spec = this.app.activeSpec;
    return this.pickAt(x, y, { filter: spec?.kind === 'selection' ? spec.filter : undefined })?.handle ?? null;
  }

  private onLeave(): void {
    this.last = null;
    this.setState({ cursor: null, marker: null, tip: null, guides: [], acquired: [] });
    this.app.setCursor({ screen: null, world: this.app.cursor.world, snap: null });
    if (this.app.hover) {
      this.app.hover = null;
      this.scene.updateHover();
    }
  }

  private onDown(e: PointerEvent): void {
    this.el.focus?.();
    if (e.button === 2) {
      this.onRightDown(e);
      return;
    }
    if (e.button === 1) {
      e.preventDefault();
      // double-clic sur la molette : zoom étendu (pointerdown annulé : pas de mousedown)
      const t = performance.now();
      if (t - this.lastMiddle < 350) {
        this.vp.zoomExtents();
        this.lastMiddle = 0;
      } else this.lastMiddle = t;
    }
    if (e.button !== 0 || this.navMode) return;
    const p = this.local(e);
    if (this.gizmo.visible && this.app.processor.isIdle) {
      this.updateMatrix();
      const h = this.gizmo.pick(this.ndc(p.x, p.y));
      if (h && this.startGizmoDrag(h, p.x, p.y)) {
        this.el.setPointerCapture?.(e.pointerId);
        return;
      }
    }
    this.down = { x: p.x, y: p.y, button: 0, time: performance.now() };
    this.last = { ...p, shift: e.shiftKey };
  }

  private onUp(e: PointerEvent): void {
    if (e.button === 2) {
      this.onRightUp();
      return;
    }
    if (this.drag && e.button === 0) {
      const p = this.local(e);
      void this.endGizmoDrag(p.x, p.y);
      return;
    }
    const down = this.down;
    this.down = null;
    if (e.button !== 0 || !down || this.navMode) return;
    const p = this.local(e);
    this.updateMatrix();
    // fin de fenêtre (glisser ou second clic)
    if (this.boxStart && (this.dragging || Math.hypot(p.x - this.boxStart.x, p.y - this.boxStart.y) > 3)) {
      const b = this.boxStart;
      this.boxStart = null;
      this.dragging = false;
      this.finishBox(b.x, b.y, p.x, p.y, e.shiftKey);
      this.setState({ box: null });
      return;
    }
    this.dragging = false;
    this.click(p.x, p.y, e.shiftKey);
  }

  private click(x: number, y: number, shift: boolean): void {
    const app = this.app;
    const spec = app.activeSpec;
    const proc = app.processor;
    if (spec && (spec.kind === 'point' || ((spec.kind === 'distance' || spec.kind === 'real' || spec.kind === 'angle') && spec.basePoint))) {
      const r = this.resolvePoint(x, y, spec);
      // valeur tapée dans la saisie dynamique : consommée par le clic qui l'a utilisée
      if (app.input.trim() && app.settings.dyn && dynLayout(spec, app.settings.dynRelative)) app.setInput('');
      proc.pick(r.point);
      return;
    }
    if (spec?.kind === 'entity') {
      const hit = this.pickAt(x, y, { filter: spec.filter, mode: spec.pickMode });
      if (hit) proc.pickEntity(hit);
      return;
    }
    if (spec && spec.kind !== 'selection') return;
    // sélection (inactif ou prompt « Choisissez les objets »)
    if (!spec && this.scene.grips.length) {
      const gi = this.gripAt(x, y);
      if (gi >= 0) {
        const g = this.scene.grips[gi]!;
        app.startGripEdit(g.handle, g.index);
        return;
      }
    }
    const hit = this.pickAt(x, y, { filter: spec?.filter });
    if (hit) {
      if (shift) app.selection.remove([hit.handle]);
      else app.selection.add([hit.handle]);
      return;
    }
    if (this.boxStart) {
      const b = this.boxStart;
      this.boxStart = null;
      this.finishBox(b.x, b.y, x, y, shift);
      this.setState({ box: null });
    } else {
      this.boxStart = { x, y };
      this.schedule();
    }
  }

  private finishBox(x0: number, y0: number, x1: number, y1: number, remove: boolean): void {
    const crossing = x1 < x0;
    const r = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
    const inR = (p: Proj) => p.w > 0 && p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
    const spec = this.app.activeSpec;
    const out: string[] = [];
    for (const e of this.app.doc.all()) {
      if (!this.app.doc.isPickable(e)) continue;
      if (spec?.kind === 'selection' && spec.filter && !spec.filter(e.handle)) continue;
      const pd = this.scene.pickData(e.handle);
      if (!pd) continue;
      const polys = e.type === '3DSOLID' && pd.bbox ? [bboxCorners(pd.bbox)] : pd.polys;
      const pts = polys.flat().map((p) => this.project(p));
      if (!pts.length) continue;
      if (!crossing) {
        if (pts.every(inR)) out.push(e.handle);
        continue;
      }
      if (pts.some(inR)) {
        out.push(e.handle);
        continue;
      }
      const ePolys = e.type === '3DSOLID' ? pd.polys : polys;
      if (ePolys.some((pl) => pl.some((_, i) => i > 0 && segRect(this.project(pl[i - 1]!), this.project(pl[i]!), r)))) out.push(e.handle);
      else if ((e.type === 'HATCH' || e.type === 'TEXT') && pd.polys.some((pl) => this.insideScreenPolygon(pl, (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2))) out.push(e.handle);
    }
    if (remove) this.app.selection.remove(out);
    else this.app.selection.add(out);
  }

  private onDouble(e: MouseEvent): void {
    if (!this.app.processor.isIdle || this.navMode) return;
    const p = this.local(e);
    this.updateMatrix();
    // étiquette de cote pilotée
    for (const l of this.scene.constraintLabels) {
      const q = this.project(l.point);
      if (Math.hypot(q.x - p.x, q.y - p.y) < 22) {
        void editConstraintExpression(this.app, l.id);
        return;
      }
    }
    const hit = this.pickAt(p.x, p.y);
    if (!hit) return;
    const ent = this.app.doc.get(hit.handle);
    if (!ent) return;
    this.app.selection.set([hit.handle]);
    if (ent.type === 'TEXT') {
      void this.app.ui.prompt('Modifier le texte', ent.text.replace(/\n/g, '\\P'), 'Texte (\\P = nouvelle ligne)').then((t) => t !== null && (t = t.replace(/\\P/g, '\n')) !== ent.text && this.app.doc.replaceEntity(ent.handle, { text: t }));
    } else if (ent.type === 'DIMENSION') {
      void this.app.ui.prompt('Texte de la cote', ent.textOverride ?? '<>', '<> = valeur mesurée').then((t) => t !== null && this.app.doc.replaceEntity(ent.handle, { textOverride: t === '<>' || t === '' ? undefined : t }));
    } else this.app.set('panel', 'properties');
  }

  /**
   * Clic droit « sensible au temps » : relâché avant le délai
   * (0,5 s par défaut) = Entrée ; maintenu plus longtemps = menu contextuel.
   */
  private onRightDown(e: PointerEvent): void {
    if (this.right) clearTimeout(this.right.timer);
    const delay = this.app.settings.rightClickDelay;
    const at = { x: e.clientX, y: e.clientY };
    if (delay <= 0) {
      this.right = null;
      this.showMenu(at.x, at.y);
      return;
    }
    const r = { ...at, menu: false, timer: 0 };
    r.timer = window.setTimeout(() => {
      r.menu = true;
      this.showMenu(r.x, r.y);
    }, delay);
    this.right = r;
  }

  private onRightUp(): void {
    const r = this.right;
    this.right = null;
    this.lastRightUp = performance.now();
    if (!r || r.menu) return;
    clearTimeout(r.timer);
    // Entrée : valide la saisie en cours, termine la commande ou répète la dernière
    const v = this.app.input;
    this.app.setInput('');
    this.app.processor.submit(v);
  }

  private onContext(e: MouseEvent): void {
    e.preventDefault();
    // le clic droit souris est géré par onRightDown / onRightUp ; reste la touche Menu du clavier
    if (this.right || performance.now() - this.lastRightUp < 400) return;
    this.showMenu(e.clientX, e.clientY);
  }

  /** Menu du clic droit long. */
  private showMenu(clientX: number, clientY: number): void {
    const app = this.app;
    const proc = app.processor;
    const items: MenuItem[] = [];
    const sep = () => items.push({ label: '', separator: true });
    const is3d = app.settings.workspace === '3d';
    const zoom: MenuItem = {
      label: 'Zoom',
      icon: 'zoom-ext',
      children: [
        { label: 'Étendu', icon: 'zoom-ext', action: () => app.viewport?.zoomExtents() },
        { label: 'Fenêtre', icon: 'zoom-win', action: () => app.runSequence(['ZOOM', 'F']) },
        { label: 'Avant', action: () => app.viewport?.zoomFactor(1.6) },
        { label: 'Arrière', action: () => app.viewport?.zoomFactor(1 / 1.6) },
      ],
    };
    const pan: MenuItem = { label: 'Panoramique', icon: 'pan', action: () => this.setNavMode('pan') };
    const toggles: MenuItem = {
      label: 'Aides au dessin',
      children: [
        { label: 'Accrochage aux objets', shortcut: 'F3', checked: app.settings.osnap, action: () => app.toggle('osnap') },
        { label: 'Ortho', shortcut: 'F8', checked: app.settings.ortho, action: () => app.toggle('ortho') },
        { label: 'Repérage polaire', shortcut: 'F10', checked: app.settings.polar, action: () => app.toggle('polar') },
        { label: 'Grille', shortcut: 'F7', checked: app.settings.grid, action: () => app.toggle('grid') },
        { label: 'Résolution', shortcut: 'F9', checked: app.settings.snap, action: () => app.toggle('snap') },
        { label: 'Saisie dynamique', shortcut: 'F12', checked: app.settings.dyn, action: () => app.toggle('dyn') },
      ],
    };

    if (!proc.isIdle) {
      // pendant une commande : valider, annuler, options de la commande, navigation
      const spec = app.activeSpec;
      items.push({ label: 'Entrée', action: () => proc.submit(''), shortcut: 'Entrée' });
      items.push({ label: 'Annuler', action: () => proc.cancel(), shortcut: 'Échap' });
      if (spec?.keywords?.length) {
        sep();
        for (const k of spec.keywords) items.push({ label: k.local, action: () => proc.submit(k.local) });
      }
      sep();
      items.push(toggles, pan, zoom);
      app.ui.contextMenu(clientX, clientY, items);
      return;
    }

    const sel = app.selection.list();
    const last = proc.lastCommandName;
    const recent = [...proc.history.entries()].reverse().map((c) => c.trim().toUpperCase()).filter((c, i, a) => c && a.indexOf(c) === i).slice(0, 8);
    items.push({ label: last ? `Répéter ${last}` : 'Répéter', action: () => proc.submit(''), shortcut: 'Entrée', disabled: !last });
    items.push({ label: 'Commandes récentes', disabled: !recent.length, children: recent.map((c) => ({ label: c, action: () => app.run(c) })) });
    sep();
    if (sel.length) {
      items.push({ label: 'Effacer', icon: 'erase', action: () => app.run('EFFACER'), shortcut: 'Suppr' });
      items.push({ label: 'Déplacer', icon: 'move', action: () => app.run('DEPLACER') });
      items.push({ label: 'Copier la sélection', icon: 'copy', action: () => app.run('COPIER') });
      items.push({ label: 'Échelle', icon: 'scale', action: () => app.run('ECHELLE') });
      items.push({ label: 'Pivoter', icon: 'rotate', action: () => app.run('ROTATION') });
      items.push({ label: 'Miroir', icon: 'mirror', action: () => app.run('MIROIR') });
      items.push({
        label: 'Ordre de tracé',
        children: [
          { label: 'Premier plan', action: () => app.doc.reorder(app.selection.list(), 'front') },
          { label: 'Arrière-plan', action: () => app.doc.reorder(app.selection.list(), 'back') },
        ],
      });
      sep();
    }
    items.push({
      label: 'Presse-papiers',
      children: [
        { label: 'Couper', action: () => app.run('COUPERPP'), shortcut: 'Ctrl+X', disabled: !sel.length },
        { label: 'Copier', action: () => app.run('COPIERPP'), shortcut: 'Ctrl+C', disabled: !sel.length },
        { label: 'Copier avec point de base', action: () => app.run('COPIERBASE'), shortcut: 'Ctrl+Maj+C', disabled: !sel.length },
        { label: 'Coller', action: () => app.run('COLLERPP'), shortcut: 'Ctrl+V' },
        { label: 'Coller aux coordonnées d’origine', action: () => app.run('COLLERORIG') },
      ],
    });
    items.push({
      label: 'Isoler',
      children: [
        { label: 'Isoler les objets', action: () => app.run('ISOLER'), disabled: !sel.length },
        { label: 'Masquer les objets', icon: 'eye-off', action: () => app.run('MASQUEROBJETS'), disabled: !sel.length },
        { label: 'Fin de l’isolement des objets', icon: 'eye', action: () => app.run('AFFICHERTOUT'), disabled: !app.doc.all().some((e) => e.hidden) },
      ],
    });
    sep();
    items.push({ label: 'Annuler', icon: 'undo', action: () => app.run('ANNULER'), disabled: !app.doc.canUndo, shortcut: 'Ctrl+Z' });
    items.push({ label: 'Rétablir', icon: 'redo', action: () => app.run('RETABLIR'), disabled: !app.doc.canRedo, shortcut: 'Ctrl+Y' });
    items.push(pan, zoom);
    if (is3d) {
      items.push({ label: 'Orbite', icon: 'orbit', action: () => this.setNavMode('orbit') });
      items.push({
        label: 'Vues',
        children: [
          { label: 'Dessus', action: () => app.viewport?.setView('TOP') },
          { label: 'Face', action: () => app.viewport?.setView('FRONT') },
          { label: 'Droite', action: () => app.viewport?.setView('RIGHT') },
          { label: 'Isométrique SO', action: () => app.viewport?.setView('SWISO') },
          { label: 'Isométrique SE', action: () => app.viewport?.setView('SEISO') },
        ],
      });
    }
    sep();
    if (sel.length) {
      items.push({ label: 'Sélectionner similaire', action: () => app.run('SELECTSIMILAIRE') });
      items.push({ label: 'Désélectionner tout', action: () => app.selection.clear(), shortcut: 'Échap' });
    } else items.push({ label: 'Tout sélectionner', action: () => app.run('TOUTSEL'), shortcut: 'Ctrl+A' });
    sep();
    items.push({ label: 'Sélection rapide…', icon: 'qselect', action: () => app.run('SELECTRAPIDE') });
    items.push({ label: 'Rechercher…', icon: 'find', action: () => app.run('RECHERCHER') });
    items.push({ label: 'Propriétés', icon: 'pal-props', action: () => app.set('panel', 'properties'), shortcut: 'Ctrl+1' });
    items.push({ label: 'Options…', icon: 'options', action: () => app.run('OPTIONS') });
    app.ui.contextMenu(clientX, clientY, items);
  }

  /** Échap : annule la fenêtre en cours ou la navigation. */
  escape(): boolean {
    if (this.drag) {
      this.cancelGizmoDrag();
      return true;
    }
    if (this.navMode) {
      this.setNavMode(null);
      return true;
    }
    if (this.boxStart) {
      this.boxStart = null;
      this.setState({ box: null });
      return true;
    }
    return false;
  }

  /** Dernier point calculé sous le curseur. */
  get currentPoint(): Vec3 | null {
    return this.current;
  }
}

const v = (p: THREE.Vector3): Vec3 => ({ x: p.x, y: p.y, z: p.z });

interface ResolvedPoint {
  point: Vec3;
  snap: { kind: SnapKind; point: Vec3 } | null;
  tip: string | null;
  tracking: [Vec3, Vec3] | null;
  guides?: Guide[];
}

/** Point de rencontre de deux droites (milieu de leur plus courte distance), null si parallèles ou trop éloignées. */
function closestBetween(p1: Vec3, u: Vec3, p2: Vec3, w: Vec3): Vec3 | null {
  const r = { x: p1.x - p2.x, y: p1.y - p2.y, z: p1.z - p2.z };
  const a = u.x * u.x + u.y * u.y + u.z * u.z, b = u.x * w.x + u.y * w.y + u.z * w.z, c = w.x * w.x + w.y * w.y + w.z * w.z;
  const d = u.x * r.x + u.y * r.y + u.z * r.z, e = w.x * r.x + w.y * r.y + w.z * r.z;
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-12) return null;
  const s = (b * e - c * d) / den, t = (a * e - b * d) / den;
  const q1 = { x: p1.x + u.x * s, y: p1.y + u.y * s, z: p1.z + u.z * s }, q2 = { x: p2.x + w.x * t, y: p2.y + w.y * t, z: p2.z + w.z * t };
  // droites gauches (X depuis un point, Y depuis un autre à une autre hauteur) : pas d'intersection
  if (Math.hypot(q1.x - q2.x, q1.y - q2.y, q1.z - q2.z) > 1e-6 * (1 + Math.hypot(r.x, r.y, r.z))) return null;
  return q1;
}
const pick2 = (p: Proj) => ({ x: p.x, y: p.y });

function distScreen(it: Interaction, p: Vec3, sx: number, sy: number): number {
  const q = it.project(p);
  return Math.hypot(q.x - sx, q.y - sy);
}

function perpendicularFoot(p: Vec3, a: Vec3, b: Vec3): Vec3 | null {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const l2 = dx * dx + dy * dy + dz * dz;
  if (l2 < 1e-18) return null;
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy + (p.z - a.z) * dz) / l2;
  return { x: a.x + t * dx, y: a.y + t * dy, z: a.z + t * dz };
}

function bboxCorners(b: { min: Vec3; max: Vec3 }): Vec3[] {
  return Array.from({ length: 8 }, (_, i) => ({ x: i & 1 ? b.max.x : b.min.x, y: i & 2 ? b.max.y : b.min.y, z: i & 4 ? b.max.z : b.min.z }));
}

function segRect(a: Proj, b: Proj, r: { x0: number; y0: number; x1: number; y1: number }): boolean {
  if (a.w <= 0 || b.w <= 0) return false;
  const edges: [number, number, number, number][] = [
    [r.x0, r.y0, r.x1, r.y0],
    [r.x1, r.y0, r.x1, r.y1],
    [r.x1, r.y1, r.x0, r.y1],
    [r.x0, r.y1, r.x0, r.y0],
  ];
  return edges.some(([x3, y3, x4, y4]) => {
    const d = (b.x - a.x) * (y4 - y3) - (b.y - a.y) * (x4 - x3);
    if (Math.abs(d) < 1e-12) return false;
    const t = ((x3 - a.x) * (y4 - y3) - (y3 - a.y) * (x4 - x3)) / d;
    const u = ((x3 - a.x) * (b.y - a.y) - (y3 - a.y) * (b.x - a.x)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  });
}
