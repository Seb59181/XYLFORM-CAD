/**
 * Synchronisation document → scène Three.js.
 *
 * Les entités sont immuables : un objet n'est reconstruit que si l'entité, son calque ou le
 * style d'affichage ont changé. Les courbes 2D sont regroupées par couleur et épaisseur dans
 * quelques `LineSegments2` (un appel de dessin par lot, quelle que soit la taille du dessin) ;
 * textes, hachures pleines et solides ont leurs propres objets.
 *
 * Les aides (surbrillance de sélection et de survol, poignées, aperçu des commandes, contraintes)
 * vivent dans un groupe séparé, ignoré par le zoom étendu.
 */
import * as THREE from 'three';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import type { Vec3 } from '../core/commands/types';
import type { Entity, LayerDef, TextAlign, TextVAlign, UnderlayDef } from '../core/document/Document';
import { solidEdges } from './solidEdges';
import { CONSTRAINT_GLYPH, isDimensional } from '../core/constraints/types';
import { gripsOf, partPosition, partSegment } from '../core/entities/edit';
import { curvePoints, dimensionGeometry, dimensionText, entityBBox, hatchSegments, textLayout, underlayMatrix } from '../core/entities/geometry';
import { fadeColor, underlayEntities, underlayPickData } from '../core/entities/underlay';
import type { AppHost } from '../app/AppHost';
import { constraintDisplay } from '../app/commands/constraints';
import { materialById } from '../core/materials';
import { dashPolys, patternOf } from '../core/linetypes';
import { CadViewport } from './CadViewport';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;
type Underlay = Extract<Entity, { type: 'UNDERLAY' }>;

/** Contenu d'un fond de plan vectoriel dans le repère du dessin (désignation, accrochage). */
export interface UnderlaySub {
  entities: Entity[];
  polys: Vec3[][][];
  boxes: ({ min: Vec3; max: Vec3 } | null)[];
}

interface Rec {
  entity: Entity;
  layer: LayerDef | undefined;
  style: number;
  visible: boolean;
  /** Lot de segments (couleur|épaisseur) et segments de l'entité (paires de points). */
  batch: string | null;
  segs: Float32Array | null;
  /** Lot de points (entités POINT). */
  pointBatch: string | null;
  obj: THREE.Object3D | null;
  /** Maillage d'un solide (lancer de rayon). */
  mesh: THREE.Mesh | null;
  /** Polylignes de désignation (coordonnées SCG). */
  polys: Vec3[][];
  bbox: { min: Vec3; max: Vec3 } | null;
  /** Fond de plan : définition affichée et contenu placé. */
  def?: UnderlayDef | undefined;
  sub?: UnderlaySub | null;
}

interface Batch {
  key: string;
  color: string;
  width: number;
  handles: Set<string>;
  obj: THREE.Object3D | null;
  dirty: boolean;
}

export interface GripRef {
  handle: string;
  index: number;
  point: Vec3;
}

const SELECT_COLOR = '#4ea1ff';
const HOVER_COLOR = '#ffffff';
const SUB_COLOR = '#ff9f1a';
const PREVIEW_COLOR = '#dbe8ff';

/** Segments (paires de points) d'un ensemble de polylignes. */
function segmentsOf(polys: Vec3[][], out: number[] = []): number[] {
  for (const pl of polys)
    for (let i = 0; i + 1 < pl.length; i++) {
      const a = pl[i]!, b = pl[i + 1]!;
      out.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  return out;
}

export function solidEdgePolys(d: Solid3D['display']): Vec3[][] {
  const out: Vec3[][] = [];
  for (let i = 0; i + 1 < d.edgeOffsets.length; i++) {
    const pts: Vec3[] = [];
    for (let k = d.edgeOffsets[i]!; k < d.edgeOffsets[i + 1]!; k++) pts.push({ x: d.edgePoints[3 * k]!, y: d.edgePoints[3 * k + 1]!, z: d.edgePoints[3 * k + 2]! });
    out.push(pts);
  }
  return out;
}

/** Texture de texte (police Arial ; la hauteur est celle des majuscules). */
const CAP = 0.716;
interface TextTex {
  texture: THREE.CanvasTexture;
  /** Largeur et hauteur du plan pour un corps de 1 (em), décalage de la ligne de base. */
  w: number;
  h: number;
  base: number;
  /** Marge à gauche et à droite du texte (em). */
  pad: number;
  refs: number;
}

export class SceneSync {
  private readonly recs = new Map<string, Rec>();
  private readonly batches = new Map<string, Batch>();
  private readonly pointBatches = new Map<string, Batch>();
  private readonly lineMats = new Map<string, LineMaterial>();
  private readonly meshMats = new Map<string, THREE.Material>();
  private readonly textures = new Map<string, TextTex>();
  /** Images décodées des fonds de plan (par octets source et mode gris). */
  private readonly bitmaps = new WeakMap<Uint8Array, Promise<ImageBitmap>>();
  private style = 0;

  readonly overlay = new THREE.Group();
  private readonly selectionGroup = new THREE.Group();
  private readonly hoverGroup = new THREE.Group();
  private readonly gripGroup = new THREE.Group();
  private readonly subGroup = new THREE.Group();
  private readonly hoverSubGroup = new THREE.Group();
  private readonly previewGroup = new THREE.Group();
  private readonly constraintGroup = new THREE.Group();
  /** Sprites à taille constante à l'écran (contraintes) : taille en pixels. */
  private readonly screenSprites: { sprite: THREE.Sprite; px: number; aspect: number }[] = [];
  /** Positions des étiquettes de contraintes (double-clic = modifier). */
  constraintLabels: { id: string; point: Vec3 }[] = [];
  grips: GripRef[] = [];
  hotGrip = -1;
  private gripSquare: THREE.Texture;
  private readonly disposers: (() => void)[] = [];

  constructor(
    private readonly app: AppHost,
    private readonly vp: CadViewport,
  ) {
    this.overlay.name = 'Overlay';
    this.overlay.add(this.selectionGroup, this.hoverGroup, this.subGroup, this.hoverSubGroup, this.constraintGroup, this.previewGroup, this.gripGroup);
    this.selectionGroup.renderOrder = 5;
    this.hoverGroup.renderOrder = 6;
    this.previewGroup.renderOrder = 8;
    this.gripGroup.renderOrder = 9;
    vp.scene.add(this.overlay);
    this.gripSquare = makeGripTexture();
    vp.beforeRender.add(this.beforeRender);
    this.disposers.push(
      app.on('doc', () => this.sync()),
      app.on('selection', () => this.updateHighlights()),
      app.on('command', () => this.updateGrips()),
      app.on('constraints', () => this.updateConstraints()),
      app.on('settings', () => this.updateConstraints()),
    );
    vp.setRenderMode(app.settings.visualStyle === 'render');
    this.sync();
  }

  dispose(): void {
    this.disposers.forEach((d) => d());
    this.vp.beforeRender.delete(this.beforeRender);
    for (const r of this.recs.values()) this.disposeRec(r);
    this.recs.clear();
    this.vp.scene.remove(this.overlay);
  }

  private readonly beforeRender = () => {
    const w = this.vp.container.clientWidth, h = this.vp.container.clientHeight;
    for (const m of this.lineMats.values()) m.resolution.set(w, h);
    const k = this.vp.worldUnitsPerPixel();
    for (const s of this.screenSprites) s.sprite.scale.set(s.px * s.aspect * k, s.px * k, 1);
  };

  // =========================================================================
  // Matériaux
  // =========================================================================

  private lineMat(color: string, width: number, opts: { overlay?: boolean; opacity?: number; underlay?: boolean; solidEdge?: boolean } = {}): LineMaterial {
    // arêtes de solides : matériau à part (l'analyse de coupe les découpe, pas les courbes 2D)
    const key = `${color}|${width}|${opts.overlay ? 1 : 0}|${opts.opacity ?? 1}|${opts.underlay ? 1 : 0}|${opts.solidEdge ? 1 : 0}`;
    let m = this.lineMats.get(key);
    if (!m) {
      m = new LineMaterial({
        color: new THREE.Color(color).getHex(),
        linewidth: width,
        worldUnits: false,
        transparent: (opts.opacity ?? 1) < 1 || !!opts.overlay,
        opacity: opts.opacity ?? 1,
        depthTest: !opts.overlay,
        // fond de plan : dessiné en premier sans écrire la profondeur (le dessin passe devant)
        depthWrite: !opts.overlay && !opts.underlay,
      });
      m.toneMapped = false;
      m.resolution.set(this.vp.container.clientWidth, this.vp.container.clientHeight);
      this.lineMats.set(key, m);
    }
    return m;
  }

  private solidMat(color: string, surface: boolean, material?: string): THREE.Material {
    const style = this.app.settings.visualStyle;
    const lib = style === 'realistic' || style === 'render' ? materialById(material) : undefined;
    const key = `${color}|${style}|${surface ? 1 : 0}|${lib?.id ?? ''}`;
    let m = this.meshMats.get(key);
    if (!m && lib) {
      // matériau de la bibliothèque : métal, plastique, verre…
      const pm = new THREE.MeshPhysicalMaterial({
        color: lib.color ?? color,
        metalness: lib.metalness,
        roughness: lib.roughness,
        clearcoat: lib.clearcoat ?? 0,
        clearcoatRoughness: 0.15,
        transparent: lib.opacity !== undefined,
        opacity: lib.opacity ?? 1,
        depthWrite: lib.opacity === undefined,
        envMapIntensity: lib.metalness > 0.5 ? 1.6 : 1,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
      });
      if (surface || lib.opacity !== undefined) pm.side = THREE.DoubleSide;
      m = pm;
      this.meshMats.set(key, m);
    }
    if (!m) {
      const sm = CadViewport.solidMaterial(shadeColor(color));
      if (surface) sm.side = THREE.DoubleSide;
      if (style === 'xray') {
        sm.transparent = true;
        sm.opacity = 0.32;
        sm.depthWrite = false;
      }
      if (style === 'shaded') sm.roughness = 0.45;
      m = sm;
      this.meshMats.set(key, m);
    }
    return m;
  }

  private lineWidth(layer: LayerDef | undefined): number {
    if (!this.app.settings.lwt) return 1;
    const lw = layer?.lineweight ?? 0.25;
    return Math.round(Math.max(1, Math.min(8, lw * 4)) * 4) / 4;
  }

  // =========================================================================
  // Synchronisation
  // =========================================================================

  /** Reconstruit tout (changement de style visuel, d'épaisseurs…). */
  rebuild(): void {
    this.style++;
    this.vp.setRenderMode(this.app.settings.visualStyle === 'render');
    for (const m of this.meshMats.values()) m.dispose();
    this.meshMats.clear();
    this.sync();
    this.updateConstraints();
  }

  sync(): void {
    const doc = this.app.doc;
    const seen = new Set<string>();
    for (const e of doc.all()) {
      seen.add(e.handle);
      const layer = doc.layer(e.layer);
      const rec = this.recs.get(e.handle);
      if (rec && rec.entity === e && rec.layer === layer && rec.style === this.style && (e.type !== 'UNDERLAY' || rec.def === doc.underlays[e.ref])) continue;
      if (rec) this.disposeRec(rec);
      this.recs.set(e.handle, this.build(e, layer));
    }
    for (const [h, rec] of this.recs)
      if (!seen.has(h)) {
        this.disposeRec(rec);
        this.recs.delete(h);
      }
    // ordre de tracé (ORDRETRACE) : rang dans le document entre remplissages et entre textes
    const n = Math.max(1, doc.size);
    let i = 0;
    for (const e of doc.all()) {
      const o = this.recs.get(e.handle)?.obj;
      if (o && (e.type === 'HATCH' || e.type === 'TEXT')) o.renderOrder = (e.type === 'HATCH' ? -0.5 : 1) + (i / n) * 0.01;
      i++;
    }
    this.flush();
    this.updateHighlights();
    this.updateConstraints();
    this.vp.requestRender();
  }

  private build(e: Entity, layer: LayerDef | undefined): Rec {
    const visible = !!layer && layer.visible && !layer.frozen && !e.hidden;
    const rec: Rec = { entity: e, layer, style: this.style, visible, batch: null, segs: null, pointBatch: null, obj: null, mesh: null, polys: [], bbox: null };
    const color = this.app.doc.colorOf(e);
    const width = this.lineWidth(layer);
    if (e.type === 'UNDERLAY') {
      rec.polys = curvePoints(e);
      rec.bbox = entityBBox(e);
      const def = this.app.doc.underlays[e.ref];
      rec.def = def;
      rec.visible = visible && !!def?.loaded;
      if (!rec.visible || !def) return rec;
      rec.obj = this.underlayObject(e, def, rec);
      rec.obj.userData.handle = e.handle;
      this.vp.modelRoot.add(rec.obj);
      return rec;
    }
    if (e.type === '3DSOLID') {
      rec.polys = solidEdgePolys(e.display);
      rec.bbox = e.display.bbox;
    } else {
      rec.polys = curvePoints(e);
      rec.bbox = entityBBox(e);
    }
    if (!visible) return rec;

    const segs: number[] = [];
    switch (e.type) {
      case 'POINT': {
        rec.pointBatch = color;
        this.addTo(this.pointBatches, color, color, 1, e.handle);
        break;
      }
      case 'TEXT':
        rec.obj = this.textMesh(e.text, color, e.position, e.height, e.rotation, e);
        break;
      case 'DIMENSION': {
        const g = dimensionGeometry(e, this.app.sysvars.DIMASZ);
        segmentsOf(g.lines, segs);
        const h = e.textHeight ?? this.app.sysvars.DIMTXT;
        let a = g.angle;
        if (a > Math.PI / 2 + 1e-6 || a < -Math.PI / 2 - 1e-6) a += Math.PI; // texte lisible
        // texte au-dessus de la ligne de cote (sens de lecture), centré
        const line = g.lines[2];
        const ref = e.dimType === 'radius' || e.dimType === 'diameter' || !line ? e.offsetPoint : { x: (line[0]!.x + line[1]!.x) / 2, y: (line[0]!.y + line[1]!.y) / 2, z: line[0]!.z };
        const at = { x: ref.x - Math.sin(a) * h * 0.5, y: ref.y + Math.cos(a) * h * 0.5, z: ref.z };
        rec.obj = this.textMesh(dimensionText(e, this.app.sysvars.DIMDEC), color, at, h, a, { align: 'center' });
        break;
      }
      case 'HATCH': {
        if (e.pattern === 'SOLID' || e.pattern === 'GRADIENT') rec.obj = this.hatchMesh(e, color);
        else segmentsOf(hatchSegments(e.boundaries, e.pattern, e.scale, e.angle), segs);
        break;
      }
      case '3DSOLID':
        rec.obj = this.solidObject(e, color, width);
        rec.mesh = (rec.obj.userData.mesh as THREE.Mesh | undefined) ?? null;
        break;
      default:
        segmentsOf(layer?.linetype ? dashPolys(rec.polys, patternOf(layer.linetype, this.app.sysvars.LTSCALE)) : rec.polys, segs);
    }
    if (segs.length) {
      rec.segs = new Float32Array(segs);
      rec.batch = `${color}|${width}`;
      this.addTo(this.batches, rec.batch, color, width, e.handle);
    }
    if (rec.obj) {
      rec.obj.userData.handle = e.handle;
      this.vp.modelRoot.add(rec.obj);
    }
    return rec;
  }

  private addTo(map: Map<string, Batch>, key: string, color: string, width: number, handle: string): void {
    let b = map.get(key);
    if (!b) map.set(key, (b = { key, color, width, handles: new Set(), obj: null, dirty: true }));
    b.handles.add(handle);
    b.dirty = true;
  }

  private disposeRec(r: Rec): void {
    const h = r.entity.handle;
    if (r.batch) {
      const b = this.batches.get(r.batch);
      if (b) b.handles.delete(h), (b.dirty = true);
    }
    if (r.pointBatch) {
      const b = this.pointBatches.get(r.pointBatch);
      if (b) b.handles.delete(h), (b.dirty = true);
    }
    if (r.obj) {
      this.vp.modelRoot.remove(r.obj);
      r.obj.traverse((o) => {
        const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        // la géométrie du maillage d'un solide référence les tableaux du document : on libère seulement le GPU
        g?.dispose();
        const tex = o.userData.textKey as string | undefined;
        if (tex) this.releaseText(tex);
        if (o.userData.ownMaterial) {
          const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial;
          m.map?.dispose();
          m.dispose();
        }
      });
    }
  }

  /** Reconstruit les lots modifiés. */
  private flush(): void {
    for (const b of this.batches.values()) {
      if (!b.dirty) continue;
      b.dirty = false;
      if (b.obj) {
        this.vp.modelRoot.remove(b.obj);
        (b.obj as LineSegments2).geometry.dispose();
        b.obj = null;
      }
      let n = 0;
      for (const h of b.handles) n += this.recs.get(h)?.segs?.length ?? 0;
      if (!n) continue;
      const arr = new Float32Array(n);
      let o = 0;
      for (const h of b.handles) {
        const s = this.recs.get(h)?.segs;
        if (s) arr.set(s, o), (o += s.length);
      }
      const geo = new LineSegmentsGeometry();
      geo.setPositions(arr);
      const obj = new LineSegments2(geo, this.lineMat(b.color, b.width));
      obj.name = `Lot ${b.key}`;
      b.obj = obj;
      this.vp.modelRoot.add(obj);
    }
    for (const b of this.pointBatches.values()) {
      if (!b.dirty) continue;
      b.dirty = false;
      if (b.obj) {
        this.vp.modelRoot.remove(b.obj);
        (b.obj as THREE.Points).geometry.dispose();
        b.obj = null;
      }
      const pts: number[] = [];
      for (const h of b.handles) {
        const e = this.recs.get(h)?.entity;
        if (e?.type === 'POINT') pts.push(e.position.x, e.position.y, e.position.z);
      }
      if (!pts.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      const mat = new THREE.PointsMaterial({ color: b.color, size: 3, sizeAttenuation: false });
      mat.toneMapped = false;
      b.obj = new THREE.Points(geo, mat);
      this.vp.modelRoot.add(b.obj);
    }
  }

  // =========================================================================
  // Objets individuels
  // =========================================================================

  private textTexture(text: string, color: string, align: TextAlign, lineSpacing: number): { key: string; tex: TextTex } {
    const key = `${color}|${align}|${lineSpacing}|${text}`;
    let t = this.textures.get(key);
    if (!t) {
      const lines = text.split('\n');
      const ctx2 = document.createElement('canvas').getContext('2d')!;
      const font = (px: number) => `${px}px Arial, "Helvetica Neue", Helvetica, sans-serif`;
      ctx2.font = font(64);
      const wEm = Math.max(...lines.map((l) => ctx2.measureText(l || ' ').width)) / 64 + 0.125;
      const pitch = (5 / 3) * lineSpacing * CAP;
      const hEm = 1.02 + (lines.length - 1) * pitch + 0.3;
      // 64 px par cadratin, réduit pour les très longs textes (canevas limité à 4096 px)
      const S = Math.max(4, Math.min(64, 4096 / wEm, 4096 / hEm));
      const canvas = ctx2.canvas;
      canvas.width = Math.ceil(wEm * S);
      canvas.height = Math.ceil(hEm * S);
      ctx2.font = font(S);
      ctx2.fillStyle = color;
      ctx2.textBaseline = 'alphabetic';
      ctx2.textAlign = align;
      const pad = 0.0625;
      const x = align === 'left' ? pad * S : align === 'right' ? canvas.width - pad * S : canvas.width / 2;
      lines.forEach((l, i) => ctx2.fillText(l, x, (1.02 + i * pitch) * S));
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      texture.generateMipmaps = true;
      t = { texture, w: canvas.width / S, h: canvas.height / S, base: 1.02, pad, refs: 0 };
      this.textures.set(key, t);
    }
    t.refs++;
    return { key, tex: t };
  }

  private releaseText(key: string): void {
    const t = this.textures.get(key);
    if (!t) return;
    if (--t.refs <= 0) {
      t.texture.dispose();
      this.textures.delete(key);
    }
  }

  /** Texte posé dans le plan XY : `height` = hauteur des majuscules, `at` = point d'accroche. */
  private textMesh(
    text: string,
    color: string,
    at: Vec3,
    height: number,
    rotation: number,
    o: { align?: TextAlign; valign?: TextVAlign; widthFactor?: number; lineSpacing?: number } = {},
  ): THREE.Mesh {
    const align = o.align ?? 'left', wf = o.widthFactor ?? 1;
    const { key, tex } = this.textTexture(text, color, align, o.lineSpacing ?? 1);
    const em = height / CAP;
    const w = tex.w * em * wf, h = tex.h * em;
    const geo = new THREE.PlaneGeometry(w, h);
    // bord gauche et haut du canevas dans le repère du texte (origine au point d'accroche)
    const left = align === 'left' ? -tex.pad * em * wf : align === 'right' ? -w + tex.pad * em * wf : -w / 2;
    const top = textLayout({ text, height, valign: o.valign, lineSpacing: o.lineSpacing }).base0 + tex.base * em;
    geo.translate(left + w / 2, top - h / 2, 0);
    const mat = new THREE.MeshBasicMaterial({ map: tex.texture, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.toneMapped = false;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(at.x, at.y, at.z);
    mesh.rotation.z = rotation;
    mesh.userData.textKey = key;
    mesh.renderOrder = 1;
    return mesh;
  }

  private hatchMesh(e: Extract<Entity, { type: 'HATCH' }>, color: string): THREE.Mesh {
    const loops = e.boundaries.filter((b) => b.length >= 3);
    const z = loops[0]?.[0]?.z ?? 0;
    const inside = (p: Vec3, loop: Vec3[]) => {
      let c = false;
      for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const a = loop[i]!, b = loop[j]!;
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
      }
      return c;
    };
    const depth = loops.map((l, i) => loops.reduce((n, o, j) => (j !== i && inside(l[0]!, o) ? n + 1 : n), 0));
    const positions: number[] = [];
    const indices: number[] = [];
    loops.forEach((outer, i) => {
      if (depth[i]! % 2) return;
      const holes = loops.filter((h, j) => depth[j] === depth[i]! + 1 && inside(h[0]!, outer));
      const v2 = (l: Vec3[]) => l.map((p) => new THREE.Vector2(p.x, p.y));
      const contour = v2(outer);
      const hs = holes.map(v2);
      if (THREE.ShapeUtils.isClockWise(contour)) contour.reverse();
      hs.forEach((h) => !THREE.ShapeUtils.isClockWise(h) && h.reverse());
      const tris = THREE.ShapeUtils.triangulateShape(contour, hs);
      const base = positions.length / 3;
      for (const p of [contour, ...hs].flat()) positions.push(p.x, p.y, z);
      for (const t of tris) indices.push(base + t[0]!, base + t[1]!, base + t[2]!);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    let mat: THREE.MeshBasicMaterial;
    if (e.pattern === 'GRADIENT') {
      const c1 = new THREE.Color(color), c2 = new THREE.Color(e.color2 ?? '#1d3557');
      const u = { x: Math.cos(e.angle), y: Math.sin(e.angle) };
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < positions.length; i += 3) {
        const s = positions[i]! * u.x + positions[i + 1]! * u.y;
        lo = Math.min(lo, s), hi = Math.max(hi, s);
      }
      const cols: number[] = [];
      const c = new THREE.Color();
      for (let i = 0; i < positions.length; i += 3) {
        const t = hi > lo ? (positions[i]! * u.x + positions[i + 1]! * u.y - lo) / (hi - lo) : 0;
        c.copy(c1).lerp(c2, t);
        cols.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.92 });
    } else mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.85 });
    mat.toneMapped = false;
    mat.depthWrite = false;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 2;
    mat.polygonOffsetUnits = 2;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -0.5;
    return mesh;
  }

  /**
   * Fond de plan : contenu vectoriel estompé (lots de segments par couleur, textes, hachures
   * pleines) ou image texturée. Dessiné avant le reste et sans écrire la profondeur.
   */
  private underlayObject(e: Underlay, def: UnderlayDef, rec: Rec): THREE.Group {
    const g = new THREE.Group();
    g.name = `Fond de plan ${def.name}`;
    const shade = (c: string) => fadeColor(c, def.fade, def.monochrome);
    if (def.image) {
      const img = def.image;
      const w = img.pxWidth * img.pixelSize, h = img.pxHeight * img.pixelSize;
      const geo = new THREE.PlaneGeometry(w, h);
      geo.translate(w / 2, h / 2, 0);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 1 - Math.min(90, def.fade) / 100, depthWrite: false });
      mat.toneMapped = false;
      const mono = def.monochrome, invert = !!def.adjustColors;
      if (mono || invert) {
        // gris et/ou inversion de la clarté (teinte conservée) dans le shader
        mat.onBeforeCompile = (sh) => {
          sh.fragmentShader = sh.fragmentShader.replace(
            '#include <map_fragment>',
            `#include <map_fragment>
            {
              vec3 s = pow(max(diffuseColor.rgb, 0.0), vec3(1.0 / 2.2));
              ${mono ? 's = vec3(dot(s, vec3(0.3, 0.59, 0.11)));' : ''}
              ${invert ? 's += 1.0 - max(s.r, max(s.g, s.b)) - min(s.r, min(s.g, s.b));' : ''}
              diffuseColor.rgb = pow(s, vec3(2.2));
            }`,
          );
        };
        mat.customProgramCacheKey = () => `underlay${mono ? 1 : 0}${invert ? 1 : 0}`;
      }
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.ownMaterial = true;
      mesh.renderOrder = -0.95; // après la grille, avant le dessin
      const m = underlayMatrix(e);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);
      g.add(mesh);
      void this.underlayBitmap(img.data, img.mime).then((bmp) => {
        if (rec.obj !== g) return; // reconstruit entre-temps
        const tex = new THREE.Texture(bmp);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false; // image déjà retournée au décodage
        tex.anisotropy = 4;
        tex.needsUpdate = true;
        mat.map = tex;
        mat.needsUpdate = true;
        this.vp.requestRender();
      });
      rec.sub = null; // désignation par le cadre
      return g;
    }
    const ents = underlayEntities(e, def);
    const { polys, boxes } = underlayPickData(ents);
    rec.sub = { entities: ents, polys, boxes };
    const byColor = new Map<string, number[]>();
    const segsFor = (c: string) => {
      let a = byColor.get(c);
      if (!a) byColor.set(c, (a = []));
      return a;
    };
    ents.forEach((x, i) => {
      const color = shade(x.color ?? '#ffffff');
      switch (x.type) {
        case 'POINT':
        case '3DSOLID':
        case 'UNDERLAY':
          return;
        case 'TEXT': {
          const t = this.textMesh(x.text, color, x.position, x.height, x.rotation, x);
          t.renderOrder = -0.9;
          g.add(t);
          return;
        }
        case 'HATCH':
          if (x.pattern === 'SOLID' || x.pattern === 'GRADIENT') {
            const hm = this.hatchMesh(x, color);
            hm.userData.ownMaterial = true;
            hm.renderOrder = -0.92;
            g.add(hm);
          } else segmentsOf(hatchSegments(x.boundaries, x.pattern, x.scale, x.angle), segsFor(color));
          return;
        default:
          segmentsOf(polys[i]!, segsFor(color));
      }
    });
    for (const [color, arr] of byColor) {
      const geo = new LineSegmentsGeometry();
      geo.setPositions(arr);
      const obj = new LineSegments2(geo, this.lineMat(color, 1, { underlay: true }));
      obj.renderOrder = -0.9;
      g.add(obj);
    }
    return g;
  }

  /** Décode (une fois) l'image d'un fond de plan, réduite si elle dépasse la taille de texture du GPU. */
  private underlayBitmap(data: Uint8Array, mime: string): Promise<ImageBitmap> {
    let p = this.bitmaps.get(data);
    if (!p) {
      const blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: mime });
      const max = Math.min(8192, this.vp.renderer.capabilities.maxTextureSize);
      p = createImageBitmap(blob).then((full) => {
        const k = Math.min(1, max / Math.max(full.width, full.height));
        const w = Math.max(1, Math.floor(full.width * k)), h = Math.max(1, Math.floor(full.height * k));
        full.close();
        return createImageBitmap(blob, { imageOrientation: 'flipY', resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
      });
      this.bitmaps.set(data, p);
    }
    return p;
  }

  private solidObject(e: Solid3D, color: string, width: number): THREE.Group {
    const g = new THREE.Group();
    const d = e.display;
    const style = this.app.settings.visualStyle;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(d.indices, 1));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.solidMat(color, d.solidCount === 0, e.material));
    mesh.castShadow = mesh.receiveShadow = style === 'render';
    mesh.userData.handle = e.handle;
    mesh.userData.closedSolid = d.solidCount > 0; // bouchage des coupes possible
    mesh.visible = style !== 'wireframe';
    g.add(mesh);
    g.userData.mesh = mesh;
    g.userData.solid = true; // concerné par l'analyse de coupe
    if (style !== 'shaded' && style !== 'render') {
      const segs = solidEdges(d);
      if (segs.length) {
        const eg = new LineSegmentsGeometry();
        eg.setPositions(segs);
        const edgeColor = style === 'realistic' ? darken(color) : color;
        g.add(new LineSegments2(eg, this.lineMat(edgeColor, width, { solidEdge: true })));
      }
    }
    return g;
  }

  // =========================================================================
  // Données de désignation (utilisées par l'interaction)
  // =========================================================================

  pickData(handle: string): { entity: Entity; polys: Vec3[][]; bbox: { min: Vec3; max: Vec3 } | null; mesh: THREE.Mesh | null; sub: UnderlaySub | null } | null {
    const r = this.recs.get(handle);
    if (!r || !r.visible) return null;
    return { entity: r.entity, polys: r.polys, bbox: r.bbox, mesh: r.mesh, sub: r.sub ?? null };
  }

  /** Maillages des solides visibles (lancer de rayon). */
  solidMeshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    for (const r of this.recs.values()) if (r.visible && r.mesh) out.push(r.mesh);
    return out;
  }

  // =========================================================================
  // Aides visuelles
  // =========================================================================

  private clearGroup(g: THREE.Group): void {
    for (const c of [...g.children]) {
      g.remove(c);
      c.traverse((o) => {
        const geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
        if (geo && !o.userData.sharedGeometry) geo.dispose();
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        if (m && o.userData.ownMaterial) m.dispose();
      });
    }
  }

  private overlayLines(group: THREE.Group, segs: number[], color: string, width: number, opacity = 1, solidEdge = false): void {
    if (!segs.length) return;
    const geo = new LineSegmentsGeometry();
    geo.setPositions(segs);
    const l = new LineSegments2(geo, this.lineMat(color, width, { overlay: true, opacity, solidEdge }));
    l.renderOrder = group.renderOrder;
    group.add(l);
  }

  /** Sous-groupe des surbrillances de solides (découpé par l'analyse de coupe, comme les solides). */
  private solidPart(group: THREE.Group): THREE.Group {
    const g = new THREE.Group();
    g.userData.solid = true;
    g.renderOrder = group.renderOrder;
    group.add(g);
    return g;
  }

  private highlight(group: THREE.Group, handles: Iterable<string>, color: string, width: number, opacity: number): void {
    const segs: number[] = [];
    const solidSegs: number[] = [];
    let sg: THREE.Group | null = null;
    for (const h of handles) {
      const r = this.recs.get(h);
      if (!r || !r.visible) continue;
      if (r.entity.type === '3DSOLID') {
        solidEdges(r.entity.display, undefined, solidSegs);
        sg ??= this.solidPart(group);
        if (r.mesh) {
          const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, side: THREE.DoubleSide });
          const m = new THREE.Mesh(r.mesh.geometry, mat);
          m.userData.sharedGeometry = true;
          m.userData.ownMaterial = true;
          sg.add(m);
        }
      } else if (r.entity.type === 'HATCH') segmentsOf(r.polys, segs);
      else segmentsOf(r.polys, segs);
    }
    this.overlayLines(group, segs, color, width, opacity);
    if (sg) this.overlayLines(sg, solidSegs, color, width, opacity, true);
  }

  updateHighlights(): void {
    this.clearGroup(this.selectionGroup);
    this.highlight(this.selectionGroup, this.app.selection.list(), SELECT_COLOR, 2.5, 0.9);
    this.updateSub();
    this.updateGrips();
    this.updateHover();
  }

  updateHover(): void {
    this.clearGroup(this.hoverGroup);
    const h = this.app.hover;
    if (h && !this.app.selection.has(h)) this.highlight(this.hoverGroup, [h], HOVER_COLOR, 2.5, 0.55);
    this.vp.requestRender();
  }

  private updateSub(): void {
    this.subParts(this.subGroup, this.app.subHighlight, SUB_COLOR, 0.45);
  }

  /** Arête ou face survolée pendant une désignation. */
  hoverSub(s: { handle: string; edges: number[]; faces: number[] } | null): void {
    this.subParts(this.hoverSubGroup, s, '#ffd166', 0.3);
    this.vp.requestRender();
  }

  private subParts(group: THREE.Group, s: { handle: string; edges: number[]; faces: number[] } | null, color: string, faceOpacity: number): void {
    this.clearGroup(group);
    const r = s && this.recs.get(s.handle);
    if (!s || !r || r.entity.type !== '3DSOLID') return;
    const d = r.entity.display;
    group = this.solidPart(group);
    this.overlayLines(group, solidEdges(d, new Set(s.edges)), color, 3.5, 1, true);
    if (s.faces.length) {
      const faces = new Set(s.faces);
      const idx: number[] = [];
      for (let t = 0; t < d.faceIds.length; t++) if (faces.has(d.faceIds[t]!)) idx.push(d.indices[3 * t]!, d.indices[3 * t + 1]!, d.indices[3 * t + 2]!);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(d.positions, 3));
      geo.setIndex(idx);
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: faceOpacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, side: THREE.DoubleSide });
      const m = new THREE.Mesh(geo, mat);
      m.userData.ownMaterial = true;
      group.add(m);
    }
  }

  /** Poignées des objets sélectionnés quand aucune commande n'est active. */
  updateGrips(): void {
    this.clearGroup(this.gripGroup);
    this.grips = [];
    const sel = this.app.selection.list();
    if (!this.app.processor.isIdle || !sel.length || sel.length > 200) {
      this.vp.requestRender();
      return;
    }
    for (const h of sel) {
      const r = this.recs.get(h);
      if (!r || !r.visible || r.entity.type === '3DSOLID') continue;
      if (!this.app.doc.isPickable(r.entity)) continue;
      gripsOf(r.entity).forEach((g, index) => this.grips.push({ handle: h, index, point: g.point }));
    }
    if (this.grips.length) {
      const cold: number[] = [], hot: number[] = [];
      this.grips.forEach((g, i) => (i === this.hotGrip ? hot : cold).push(g.point.x, g.point.y, g.point.z));
      for (const [pts, color] of [
        [cold, '#2f81f7'],
        [hot, '#ff4d4f'],
      ] as const) {
        if (!pts.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
        const mat = new THREE.PointsMaterial({ color, size: 10, sizeAttenuation: false, map: this.gripSquare, transparent: true, depthTest: false, alphaTest: 0.2 });
        mat.toneMapped = false;
        const p = new THREE.Points(geo, mat);
        p.userData.ownMaterial = true;
        p.renderOrder = 10;
        this.gripGroup.add(p);
      }
    }
    this.vp.requestRender();
  }

  setHotGrip(i: number): void {
    if (i === this.hotGrip) return;
    this.hotGrip = i;
    this.updateGrips();
  }

  /** Aperçu de la commande en cours (polylignes) et élastique depuis le point de base. */
  /**
   * Déplacement en direct (manipulateur 3D) : les solides désignés et la surbrillance de la
   * sélection suivent la matrice `m` sans reconstruire la géométrie ; null = position réelle.
   */
  setLiveTransform(handles: string[], m: THREE.Matrix4 | null): void {
    const apply = (o: THREE.Object3D) => {
      o.matrixAutoUpdate = !m;
      if (m) o.matrix.copy(m);
      else o.matrix.identity();
      o.matrixWorldNeedsUpdate = true;
    };
    for (const h of handles) {
      const r = this.recs.get(h);
      if (r?.obj && r.entity.type === '3DSOLID') apply(r.obj);
    }
    // la surbrillance ne suit que si toute la sélection fait partie des objets déplacés
    const sel = this.app.selection.list();
    const follow = !m || (sel.length > 0 && sel.every((h) => handles.includes(h)));
    if (follow) {
      apply(this.selectionGroup);
      apply(this.subGroup);
    }
    this.gripGroup.visible = !m;
    this.vp.requestRender();
  }

  setPreview(polys: Vec3[][], rubber: [Vec3, Vec3] | null, tracking: [Vec3, Vec3] | null = null): void {
    this.clearGroup(this.previewGroup);
    this.overlayLines(this.previewGroup, segmentsOf(polys), PREVIEW_COLOR, 1.5, 0.95);
    if (rubber) this.overlayLines(this.previewGroup, segmentsOf([rubber]), '#a8b3c2', 1, 0.8);
    if (tracking) this.overlayLines(this.previewGroup, segmentsOf([tracking]), '#3fb950', 1, 0.7);
    this.vp.requestRender();
  }

  // =========================================================================
  // Contraintes
  // =========================================================================

  private sprite(text: string, color: string, bg: string, px: number): { sprite: THREE.Sprite; aspect: number } {
    const S = 48;
    const ctx2 = document.createElement('canvas').getContext('2d')!;
    const font = `600 ${S * 0.62}px "Segoe UI", Arial, sans-serif`;
    ctx2.font = font;
    const w = Math.ceil(ctx2.measureText(text).width + S * 0.5);
    ctx2.canvas.width = Math.max(w, S);
    ctx2.canvas.height = S;
    ctx2.font = font;
    ctx2.fillStyle = bg;
    const r = 8;
    const W = ctx2.canvas.width;
    ctx2.beginPath();
    ctx2.roundRect(1, 1, W - 2, S - 2, r);
    ctx2.fill();
    ctx2.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx2.lineWidth = 2;
    ctx2.stroke();
    ctx2.fillStyle = color;
    ctx2.textAlign = 'center';
    ctx2.textBaseline = 'middle';
    ctx2.fillText(text, W / 2, S / 2 + 1);
    const tex = new THREE.CanvasTexture(ctx2.canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    mat.toneMapped = false;
    const sprite = new THREE.Sprite(mat);
    sprite.userData.ownMaterial = true;
    sprite.renderOrder = 7;
    const aspect = W / S;
    this.screenSprites.push({ sprite, px, aspect });
    return { sprite, aspect };
  }

  updateConstraints(): void {
    for (const s of this.screenSprites) (s.sprite.material as THREE.SpriteMaterial).map?.dispose();
    this.screenSprites.length = 0;
    this.clearGroup(this.constraintGroup);
    this.constraintLabels = [];
    if (!this.app.settings.showConstraints) return this.vp.requestRender();
    const doc = this.app.doc;
    const perEntity = new Map<string, number>();
    const k = this.vp.worldUnitsPerPixel();
    const segs: number[] = [];
    for (const c of doc.constraints) {
      if (isDimensional(c)) {
        const d = constraintDisplay(this.app, c);
        if (!d) continue;
        segmentsOf(d.lines, segs);
        const { sprite } = this.sprite(`🔒 ${d.text}`, '#e6edf3', 'rgba(32,58,92,0.92)', 18);
        sprite.position.set(d.at.x, d.at.y, d.at.z);
        sprite.userData.constraintId = c.id;
        this.constraintGroup.add(sprite);
        this.constraintLabels.push({ id: c.id, point: d.at });
        continue;
      }
      // pictogrammes près de chaque objet référencé
      for (const ref of c.refs) {
        const e = doc.get(ref.handle);
        if (!e || !doc.isVisible(e)) continue;
        const anchor = glyphAnchor(e, ref.part);
        if (!anchor) continue;
        const n = perEntity.get(ref.handle + ref.part) ?? 0;
        perEntity.set(ref.handle + ref.part, n + 1);
        const { sprite } = this.sprite(CONSTRAINT_GLYPH[c.type], '#f0f6fc', 'rgba(60,66,76,0.9)', 16);
        // barre de contraintes sous l'objet (les cotes se placent en général au-dessus)
        const at = { x: anchor.x + 20 * n * k, y: anchor.y - 16 * k, z: anchor.z };
        sprite.position.set(at.x, at.y, at.z);
        sprite.userData.constraintId = c.id;
        this.constraintGroup.add(sprite);
        this.constraintLabels.push({ id: c.id, point: at });
      }
    }
    this.overlayLines(this.constraintGroup, segs, '#79b8ff', 1, 0.9);
    this.vp.requestRender();
  }
}

function glyphAnchor(e: Entity, part: string): Vec3 | null {
  if (part === 'line' || part.startsWith('seg:')) {
    const s = partSegment(e, part);
    if (s) return { x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2, z: s[0].z };
  }
  if (part === 'circle' && (e.type === 'CIRCLE' || e.type === 'ARC')) return { x: e.center.x + e.radius * 0.7071, y: e.center.y + e.radius * 0.7071, z: e.center.z };
  return partPosition(e, part);
}

/** Couleur de face des solides : un calque blanc donne un gris clair. */
function shadeColor(hex: string): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  if (hsl.l > 0.7) c.setHSL(hsl.h, hsl.s, 0.62 + (hsl.l - 0.7) * 0.2);
  return `#${c.getHexString()}`;
}

function darken(hex: string): string {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s * 0.6, Math.max(0.06, hsl.l * 0.22));
  return `#${c.getHexString()}`;
}

function makeGripTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(4, 4, 24, 24);
  g.strokeStyle = '#0b0f14';
  g.lineWidth = 3;
  g.strokeRect(4, 4, 24, 24);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
