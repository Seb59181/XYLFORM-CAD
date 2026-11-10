/**
 * Noyau de modélisation B-rep (OpenCascade.js). S'exécute dans le Web Worker du noyau
 * (et dans Node pour les tests d'intégration).
 *
 * Les formes sont conservées dans un magasin indexé par `shapeId` et ne sont jamais modifiées :
 * chaque opération crée une nouvelle forme. L'annulation côté document n'a donc qu'à
 * revenir à l'ancien identifiant.
 *
 * Les typages d'opencascade.js décrivent mal les énumérations et les handles : l'instance est
 * manipulée en `any` dans ce fichier, et chaque opération est couverte par tests/kernel.test.ts.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Vec3 } from '../core/commands/types';
import type { IndexedMesh } from '../core/mesh/IndexedMesh';
import { tessellate } from '../core/geometry/BooleanSubtract';
import { flangeFrame, flangeProfile, sheetLayout, type SheetMetalDef } from '../core/geometry/sheetmetal';
import type { Affine, CheckReport, DisplayMesh, HlrCurve, HlrResult, ProfileDef, SolidResult } from './protocol';
import type { ManifoldToplevel } from 'manifold-3d';
import { checkManifold } from '../core/mesh/ManifoldCheck';
import { checkClosedProfile } from '../core/geometry/profileCheck';
import { isMeshData, loadMeshBody, MESH_ONLY, meshBoolean, meshDisplay, meshSlice, saveMeshBody, transformMeshBody, type MeshBody } from './MeshBodies';

export class KernelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelError';
  }
}

const DEG = Math.PI / 180;
/** Nombre maximal de spires par arête d'hélice. */
const HELIX_CHUNK = 20;

export class OccKernel {
  private readonly shapes = new Map<string, any>();
  /** Corps maillés (STL/3MF importés), même espace d'identifiants que les formes B-rep. */
  private readonly meshes = new Map<string, MeshBody>();
  private seq = 1;
  /** Moteur de booléens maillés (chargé par le worker ; requis pour les corps maillés). */
  manifold: ManifoldToplevel | null = null;
  /**
   * Mode « étape intermédiaire » : le résultat n'est pas triangulé (seuls volume, boîte et
   * nombre de solides sont calculés). Les constructions en plusieurs étapes (pièces de la
   * bibliothèque) ne paient ainsi le maillage d'affichage qu'une fois, sur la forme finale.
   */
  lazy = false;
  /** Avertissements des étapes (profil aplani…) repris par le résultat de l’opération. */
  readonly notes: string[] = [];

  constructor(private readonly oc: any) {}

  // =========================================================================
  // Magasin
  // =========================================================================

  private store(shape: any): string {
    const id = `S${this.seq++}`;
    this.shapes.set(id, shape);
    return id;
  }

  private get(id: string): any {
    const s = this.shapes.get(id);
    if (!s) throw new KernelError(this.meshes.has(id) ? MESH_ONLY : `Forme inconnue : ${id}`);
    return s;
  }

  private storeMesh(b: MeshBody, warnings: string[] = []): SolidResult {
    const shapeId = `S${this.seq++}`;
    this.meshes.set(shapeId, b);
    return { shapeId, display: meshDisplay(b), warnings };
  }

  private mf(): ManifoldToplevel {
    if (!this.manifold) throw new KernelError('Moteur de booléens maillés indisponible.');
    return this.manifold;
  }

  /** Triangles d'un corps (maillé tel quel, B-rep tessélé finement). */
  private trianglesOf(id: string): IndexedMesh {
    const m = this.meshes.get(id);
    if (m) return m.mesh;
    const shape = this.get(id);
    const bb = this.bbox(shape);
    const diag = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
    return tessellate(this.oc, shape, { linearDeflection: Math.max(diag * 2e-4, 0.002), angularDeflection: 0.1 }).mesh;
  }

  /** Corps maillé importé (STL/3MF), conservé en triangles. */
  meshBody(positions: Float64Array, indices: Uint32Array, closed: boolean): SolidResult {
    if (!indices.length) throw new KernelError('Maillage vide.');
    return this.storeMesh({ mesh: { positions: Float64Array.from(positions), indices: Uint32Array.from(indices) }, closed });
  }

  /** CONVSOLIDE : corps maillé → solide B-rep (un solide B-rep est renvoyé tel quel). */
  convertToSolid(shapeId: string, merge: boolean): SolidResult {
    const b = this.meshes.get(shapeId);
    if (!b) throw new KernelError('Ce corps est déjà un solide B-rep.');
    return this.meshToSolid(b.mesh.positions, b.mesh.indices, b.closed, merge);
  }

  /** Libère des formes intermédiaires devenues inutiles (mémoire du WebAssembly). */
  release(ids: string[]): void {
    for (const id of ids) {
      this.meshes.delete(id);
      const s = this.shapes.get(id);
      if (!s) continue;
      this.shapes.delete(id);
      s.delete?.();
    }
  }

  /** Nombre de formes conservées (tests, diagnostic). */
  get shapeCount(): number {
    return this.shapes.size + this.meshes.size;
  }

  private progress(): any {
    return new this.oc.Message_ProgressRange_1();
  }

  // =========================================================================
  // Géométrie élémentaire
  // =========================================================================

  private pnt(v: Vec3): any {
    return new this.oc.gp_Pnt_3(v.x, v.y, v.z);
  }

  private dir(v: Vec3): any {
    const l = Math.hypot(v.x, v.y, v.z);
    if (l < 1e-12) throw new KernelError('Direction nulle.');
    return new this.oc.gp_Dir_4(v.x / l, v.y / l, v.z / l);
  }

  private ax2(origin: Vec3, normal: Vec3 = { x: 0, y: 0, z: 1 }): any {
    return new this.oc.gp_Ax2_3(this.pnt(origin), this.dir(normal));
  }

  /** Fil (wire) d'un profil ou d'une trajectoire. */
  private wire(p: ProfileDef): any {
    const oc = this.oc;
    switch (p.kind) {
      case 'circle': {
        const circ = new oc.gp_Circ_2(this.ax2(p.center), p.radius);
        const edge = new oc.BRepBuilderAPI_MakeEdge_8(circ).Edge();
        return new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
      }
      case 'arc': {
        const circ = new oc.gp_Circ_2(this.ax2(p.center), p.radius);
        let end = p.endAngle;
        while (end <= p.startAngle) end += 2 * Math.PI;
        const edge = new oc.BRepBuilderAPI_MakeEdge_9(circ, p.startAngle, end).Edge();
        return new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
      }
      case 'poly': {
        if (p.bulges?.some((b) => Math.abs(b) > 1e-9)) return this.bulgeWire(p);
        const pts = dedupe(p.points, p.closed);
        if (pts.length < 2) throw new KernelError('Polyligne trop courte.');
        const poly = new oc.BRepBuilderAPI_MakePolygon_1();
        for (const q of pts) poly.Add_1(this.pnt(q));
        if (p.closed) poly.Close();
        if (!poly.IsDone()) throw new KernelError('Polyligne invalide.');
        return poly.Wire();
      }
      case 'helix':
        return this.helixWire(p);
    }
  }

  /** Polyligne avec segments en arc (renflements) : arcs de cercle exacts. */
  private bulgeWire(p: Extract<ProfileDef, { kind: 'poly' }>): any {
    const oc = this.oc;
    const n = p.points.length;
    const mk = new oc.BRepBuilderAPI_MakeWire_1();
    const segs = p.closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const a = p.points[i]!, b = p.points[(i + 1) % n]!;
      if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) < 1e-9) continue;
      const bulge = p.bulges?.[i] ?? 0;
      let edge: any;
      if (Math.abs(bulge) < 1e-9) edge = new oc.BRepBuilderAPI_MakeEdge_3(this.pnt(a), this.pnt(b)).Edge();
      else {
        const m = bulgeMidpoint(a, b, bulge);
        const arc = new oc.GC_MakeArcOfCircle_4(this.pnt(a), this.pnt(m), this.pnt(b));
        if (!arc.IsDone()) throw new KernelError('Arc de polyligne invalide.');
        edge = new oc.BRepBuilderAPI_MakeEdge_24(new oc.Handle_Geom_Curve_2(arc.Value().get())).Edge();
      }
      mk.Add_1(edge);
      if (!mk.IsDone()) throw new KernelError('Polyligne discontinue ou auto-sécante.');
    }
    return mk.Wire();
  }

  /**
   * Hélice exacte : droite dans l'espace paramétrique (u, v) d'un cylindre ou d'un cône.
   * u = angle, v = abscisse le long de la génératrice. Une droite (u, v) = (2π·t, L·t)
   * donne un pas constant ; le sens horaire est obtenu par une pente négative en u.
   */
  private helixWire(p: Extract<ProfileDef, { kind: 'helix' }>): any {
    const oc = this.oc;
    if (p.turns <= 0 || p.height === 0) throw new KernelError('Hélice dégénérée.');
    // départ de l'hélice sur +X (comme son tracé à l'écran)
    const ax3 = new oc.gp_Ax3_3(this.pnt(p.center), this.dir({ x: 0, y: 0, z: 1 }), this.dir({ x: 1, y: 0, z: 0 }));
    const conical = Math.abs(p.topRadius - p.baseRadius) > 1e-9;
    const pitch = p.height / p.turns;
    let surface: any;
    let vPerTurn: number;
    if (conical) {
      const alpha = Math.atan2(p.topRadius - p.baseRadius, p.height);
      surface = new oc.Geom_ConicalSurface_1(ax3, alpha, p.baseRadius);
      vPerTurn = pitch / Math.cos(alpha);
    } else {
      surface = new oc.Geom_CylindricalSurface_1(ax3, p.baseRadius);
      vPerTurn = pitch;
    }
    const du = p.ccw ? 2 * Math.PI : -2 * Math.PI;
    const line = new oc.Geom2d_Line_3(new oc.gp_Pnt2d_3(0, 0), new oc.gp_Dir2d_4(du, vPerTurn));
    const perTurn = Math.hypot(2 * Math.PI, vPerTurn);
    const length = p.turns * perTurn;
    // une longue hélice d'une seule arête est mal approchée en 3D (le balayage d'un filetage de
    // plus de ≈ 80 spires échoue) : on la découpe en tronçons d'au plus HELIX_CHUNK spires
    const chunks = Math.max(1, Math.ceil(p.turns / HELIX_CHUNK));
    const wire = new oc.BRepBuilderAPI_MakeWire_1();
    const curve2d = new oc.Handle_Geom2d_Curve_2(line);
    const surf = new oc.Handle_Geom_Surface_2(surface);
    for (let i = 0; i < chunks; i++) {
      const edgeMaker = new oc.BRepBuilderAPI_MakeEdge_31(curve2d, surf, (length * i) / chunks, (length * (i + 1)) / chunks);
      if (!edgeMaker.IsDone()) throw new KernelError("Impossible de construire l'hélice.");
      const edge = edgeMaker.Edge();
      oc.BRepLib.BuildCurves3d_2(edge);
      wire.Add_1(edge);
      if (!wire.IsDone()) throw new KernelError("Impossible de construire l'hélice.");
      edgeMaker.delete();
    }
    return wire.Wire();
  }

  private face(p: ProfileDef): any {
    if (p.kind === 'poly' && !p.closed) throw new KernelError('Le profil doit être fermé.');
    if (p.kind === 'arc' || p.kind === 'helix') throw new KernelError('Le profil doit être une courbe fermée.');
    if (p.kind === 'poly') {
      // contour cliqué en 3D légèrement hors plan : aplani ; trop gauche ou qui se croise : refusé
      const arcs = !!p.bulges?.some((b) => Math.abs(b) > 1e-9);
      const pts = arcs ? p.points : dedupe(p.points, true);
      const chk = checkClosedProfile(pts, !arcs);
      if (chk.error) throw new KernelError(chk.error);
      if (chk.warning) this.notes.push(chk.warning);
      p = { ...p, points: chk.points };
    }
    const mk = new this.oc.BRepBuilderAPI_MakeFace_15(this.wire(p), true);
    if (!mk.IsDone()) throw new KernelError('Profil non plan : impossible d’en faire une face plane.');
    return mk.Face();
  }

  // =========================================================================
  // Validation et résultat
  // =========================================================================

  /** `strict` : un résultat invalide est refusé au lieu d'être réparé (congés, chanfreins). */
  private finish(shape: any, warnings: string[] = [], strict?: string, trusted = false): SolidResult {
    const oc = this.oc;
    if (this.notes.length) warnings = [...this.notes.splice(0), ...warnings];
    if (!shape || shape.IsNull()) throw new KernelError('Résultat vide.');
    let s = shape;
    // `trusted` : primitives et déplacements rigides, valides par construction (pas de contrôle)
    // contrôle topologique rapide d'abord : un résultat aberrant (congé trop grand) est
    // rejeté en quelques ms au lieu de plusieurs dizaines de secondes de contrôle géométrique
    let valid = trusted;
    if (!trusted) {
      const quick = new oc.BRepCheck_Analyzer(s, false, false);
      valid = quick.IsValid_2();
      quick.delete();
    }
    if (valid && !trusted) {
      const full = new oc.BRepCheck_Analyzer(s, true, false);
      valid = full.IsValid_2();
      full.delete();
    }
    if (!valid && strict) throw new KernelError(strict);
    if (!valid) {
      const fix = new oc.ShapeFix_Shape_2(s);
      fix.Perform(this.progress());
      s = fix.Shape();
      const again = new oc.BRepCheck_Analyzer(s, true, false);
      const ok = again.IsValid_2();
      again.delete();
      warnings.push(ok ? 'Solide réparé automatiquement.' : 'Solide potentiellement invalide.');
    }
    // solide retourné (normales vers l'intérieur, ex. épaississement) : on le remet à l'endroit
    const solids = this.solidCount(s);
    let volume = 0;
    if (solids > 0) {
      volume = this.volumeOf(s);
      if (volume < 0 && !trusted) {
        s = s.Reversed();
        volume = -volume;
      }
    }
    const shapeId = this.store(s);
    return { shapeId, display: this.lazy ? this.summary(s, volume, solids) : this.display(shapeId, { volume, solidCount: solids }), warnings };
  }

  /** Résumé sans maillage (mode `lazy`). */
  private summary(shape: any, volume: number, solidCount: number): DisplayMesh {
    return {
      positions: new Float32Array(0),
      indices: new Uint32Array(0),
      faceIds: new Uint32Array(0),
      edgePoints: new Float32Array(0),
      edgeOffsets: new Uint32Array(0),
      volume,
      area: 0,
      bbox: this.bbox(shape),
      faceCount: 0,
      edgeCount: 0,
      solidCount,
    };
  }

  // =========================================================================
  // Primitives
  // =========================================================================

  box(corner: Vec3, size: Vec3): SolidResult {
    const min = { x: Math.min(corner.x, corner.x + size.x), y: Math.min(corner.y, corner.y + size.y), z: Math.min(corner.z, corner.z + size.z) };
    const dx = Math.abs(size.x), dy = Math.abs(size.y), dz = Math.abs(size.z);
    if (dx < 1e-9 || dy < 1e-9 || dz < 1e-9) throw new KernelError('Les dimensions de la boîte doivent être non nulles.');
    return this.finish(new this.oc.BRepPrimAPI_MakeBox_3(this.pnt(min), dx, dy, dz).Shape(), [], undefined, true);
  }

  cylinder(center: Vec3, radius: number, height: number, axis?: Vec3): SolidResult {
    positive(radius, 'rayon');
    const { base, h, dir } = signedHeight(center, height, axis);
    return this.finish(new this.oc.BRepPrimAPI_MakeCylinder_3(this.ax2(base, dir), radius, h).Shape(), [], undefined, true);
  }

  cone(center: Vec3, radius: number, topRadius: number, height: number, axis?: Vec3): SolidResult {
    if (radius < 0 || topRadius < 0 || (radius === 0 && topRadius === 0)) throw new KernelError('Rayons du cône invalides.');
    if (Math.abs(radius - topRadius) < 1e-9) return this.cylinder(center, radius, height, axis);
    let r1 = radius, r2 = topRadius;
    const { base, h, dir } = signedHeight(center, height, axis);
    if (height < 0) [r1, r2] = [r2, r1];
    return this.finish(new this.oc.BRepPrimAPI_MakeCone_3(this.ax2(base, dir), r1, r2, h).Shape(), [], undefined, true);
  }

  sphere(center: Vec3, radius: number): SolidResult {
    positive(radius, 'rayon');
    return this.finish(new this.oc.BRepPrimAPI_MakeSphere_5(this.pnt(center), radius).Shape(), [], undefined, true);
  }

  torus(center: Vec3, radius: number, tubeRadius: number): SolidResult {
    positive(radius, 'rayon');
    positive(tubeRadius, 'rayon du tube');
    if (tubeRadius >= radius) throw new KernelError('Le rayon du tube doit être inférieur au rayon du tore.');
    return this.finish(new this.oc.BRepPrimAPI_MakeTorus_5(this.ax2(center), radius, tubeRadius).Shape(), [], undefined, true);
  }

  pyramid(center: Vec3, sides: number, radius: number, topRadius: number, height: number, rotation: number): SolidResult {
    const oc = this.oc;
    if (sides < 3 || sides > 32) throw new KernelError('Nombre de côtés entre 3 et 32.');
    positive(radius, 'rayon');
    if (height === 0) throw new KernelError('Hauteur nulle.');
    const ring = (r: number, z: number): Vec3[] =>
      Array.from({ length: sides }, (_, i) => {
        const a = rotation + (2 * Math.PI * i) / sides;
        return { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a), z };
      });
    const loft = new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6);
    loft.AddWire(this.wire({ kind: 'poly', points: ring(radius, center.z), closed: true }));
    if (topRadius > 1e-9) loft.AddWire(this.wire({ kind: 'poly', points: ring(topRadius, center.z + height), closed: true }));
    else loft.AddVertex(new oc.BRepBuilderAPI_MakeVertex(this.pnt({ x: center.x, y: center.y, z: center.z + height })).Vertex());
    loft.Build(this.progress());
    if (!loft.IsDone()) throw new KernelError('Échec de la pyramide.');
    return this.finish(loft.Shape());
  }

  // =========================================================================
  // Balayages
  // =========================================================================

  /** Extrusion linéaire selon Z, avec angle de dépouille (positif = rétrécit). */
  extrude(profile: ProfileDef, height: number, taperDeg: number, surface = false, direction?: Vec3): SolidResult {
    const oc = this.oc;
    if (Math.abs(height) < 1e-9) throw new KernelError('Hauteur d’extrusion nulle.');
    if (surface || direction) {
      const d = direction ? normalize(direction) : { x: 0, y: 0, z: 1 };
      const base = surface ? this.wire(profile) : this.face(profile);
      const prism = new oc.BRepPrimAPI_MakePrism_1(base, new oc.gp_Vec_4(d.x * height, d.y * height, d.z * height), false, true);
      return this.finish(prism.Shape());
    }
    if (Math.abs(taperDeg) < 1e-9) {
      const prism = new oc.BRepPrimAPI_MakePrism_1(this.face(profile), new oc.gp_Vec_4(0, 0, height), false, true);
      return this.finish(prism.Shape());
    }
    if (Math.abs(taperDeg) >= 89) throw new KernelError('Angle de dépouille trop grand.');
    const inset = Math.abs(height) * Math.tan(taperDeg * DEG);
    let top: any;
    if (profile.kind === 'circle') {
      const r = profile.radius - inset;
      if (r <= 1e-6) throw new KernelError('L’angle de dépouille referme le profil avant le sommet.');
      top = this.wire({ kind: 'circle', center: { ...profile.center, z: profile.center.z + height }, radius: r });
    } else if (profile.kind === 'poly') {
      top = this.translatedWire(this.offsetWire(this.wire(profile), -inset), height);
    } else throw new KernelError('Profil non pris en charge.');
    const loft = new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6);
    loft.AddWire(this.wire(profile));
    loft.AddWire(top);
    loft.Build(this.progress());
    if (!loft.IsDone()) throw new KernelError('Échec de l’extrusion avec dépouille.');
    return this.finish(loft.Shape());
  }

  /** Décalage plan d'un fil fermé ; `d < 0` = vers l'intérieur (quel que soit le sens du fil). */
  private offsetWire(w: any, d: number): any {
    const oc = this.oc;
    const area0 = this.wireArea(w);
    const attempt = (dist: number) => {
      const off = new oc.BRepOffsetAPI_MakeOffset_1();
      off.Init_2(oc.GeomAbs_JoinType.GeomAbs_Intersection, false);
      off.AddWire(w);
      off.Perform(dist, 0);
      if (!off.IsDone()) return null;
      const exp = new oc.TopExp_Explorer_2(off.Shape(), oc.TopAbs_ShapeEnum.TopAbs_WIRE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      return exp.More() ? oc.TopoDS.Wire_1(exp.Current()) : null;
    };
    for (const sign of [1, -1]) {
      const res = attempt(sign * d);
      if (!res) continue;
      const a = this.wireArea(res);
      if ((d < 0 && a < area0) || (d > 0 && a > area0)) return res;
    }
    throw new KernelError('Le décalage du profil a échoué (dépouille trop forte ?).');
  }

  private wireArea(w: any): number {
    const oc = this.oc;
    const face = new oc.BRepBuilderAPI_MakeFace_15(w, true).Face();
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(face, props, false, false);
    const a = props.Mass();
    props.delete();
    return a;
  }

  private translatedWire(w: any, dz: number): any {
    const oc = this.oc;
    const t = new oc.gp_Trsf_1();
    t.SetTranslation_1(new oc.gp_Vec_4(0, 0, dz));
    return oc.TopoDS.Wire_1(new oc.BRepBuilderAPI_Transform_2(w, t, true).Shape());
  }

  revolve(profile: ProfileDef, axisStart: Vec3, axisEnd: Vec3, angleDeg: number, startDeg: number, surface = false): SolidResult {
    const oc = this.oc;
    const axisDir = { x: axisEnd.x - axisStart.x, y: axisEnd.y - axisStart.y, z: axisEnd.z - axisStart.z };
    const axis = new oc.gp_Ax1_2(this.pnt(axisStart), this.dir(axisDir));
    let face = surface ? this.wire(profile) : this.face(profile);
    if (Math.abs(startDeg) > 1e-9) {
      const t = new oc.gp_Trsf_1();
      t.SetRotation_1(axis, startDeg * DEG);
      face = new oc.BRepBuilderAPI_Transform_2(face, t, true).Shape();
    }
    const angle = Math.max(-360, Math.min(360, angleDeg));
    if (Math.abs(angle) < 1e-6) throw new KernelError('Angle de révolution nul.');
    const revol = Math.abs(Math.abs(angle) - 360) < 1e-9
      ? new oc.BRepPrimAPI_MakeRevol_2(face, axis, false)
      : new oc.BRepPrimAPI_MakeRevol_1(face, axis, angle * DEG, false);
    if (!revol.IsDone()) throw new KernelError('Échec de la révolution (le profil coupe-t-il l’axe ?).');
    return this.finish(revol.Shape());
  }

  /**
   * Balayage d'un profil le long d'une trajectoire. Avec `align`, le profil (dessiné dans le
   * plan XY) est déplacé au départ de la trajectoire et rendu perpendiculaire à sa tangente.
   */
  sweep(profile: ProfileDef, path: ProfileDef, align: boolean, surface = false): SolidResult {
    const oc = this.oc;
    const spine = this.wire(path);
    let section = this.wire(profile);
    if (!surface && (profile.kind === 'helix' || (profile.kind === 'poly' && !profile.closed) || profile.kind === 'arc')) {
      throw new KernelError('Le profil à balayer doit être fermé (cercle ou polyligne close).');
    }
    if (align) {
      const { point, tangent } = this.wireStart(spine);
      const anchor = profileAnchor(profile);
      const from = new oc.gp_Ax3_3(this.pnt(anchor), this.dir({ x: 0, y: 0, z: 1 }), this.dir({ x: 1, y: 0, z: 0 }));
      const ref = Math.abs(tangent.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
      const xdir = normalize(cross(ref, tangent));
      const to = new oc.gp_Ax3_3(this.pnt(point), this.dir(tangent), this.dir(xdir));
      const t = new oc.gp_Trsf_1();
      t.SetDisplacement(from, to);
      section = oc.TopoDS.Wire_1(new oc.BRepBuilderAPI_Transform_2(section, t, true).Shape());
    }
    const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine);
    // hélice : section maintenue dans un plan contenant l'axe (binormale = axe Z), seul mode qui
    // donne des faces que les booléens savent recouper (filetages)
    if (path.kind === 'helix') pipe.SetMode_3(new oc.gp_Dir_4(0, 0, 1));
    else {
      pipe.SetMode_1(false); // Frenet corrigé : stable sur les segments droits
      pipe.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RightCorner);
    }
    pipe.Add_1(section, false, false);
    pipe.Build(this.progress());
    if (!pipe.IsDone()) throw new KernelError('Échec du balayage (profil trop grand pour la courbure de la trajectoire ?).');
    if (surface) return this.finish(pipe.Shape());
    if (!pipe.MakeSolid()) throw new KernelError('Le balayage ne forme pas un solide fermé.');
    return this.finish(pipe.Shape());
  }

  private wireStart(w: any): { point: Vec3; tangent: Vec3 } {
    const oc = this.oc;
    const exp = new oc.BRepTools_WireExplorer_2(w);
    const edge = exp.Current();
    const curve = new oc.BRepAdaptor_Curve_2(edge);
    const reversed = edge.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
    const u = reversed ? curve.LastParameter() : curve.FirstParameter();
    const p = new oc.gp_Pnt_1();
    const v = new oc.gp_Vec_1();
    curve.D1(u, p, v);
    const s = reversed ? -1 : 1;
    return { point: { x: p.X(), y: p.Y(), z: p.Z() }, tangent: normalize({ x: s * v.X(), y: s * v.Y(), z: s * v.Z() }) };
  }

  /** Lissage entre sections (au moins deux), solide fermé. */
  loft(sections: ProfileDef[], ruled: boolean, surface = false): SolidResult {
    const oc = this.oc;
    if (sections.length < 2) throw new KernelError('Il faut au moins deux sections.');
    const loft = new oc.BRepOffsetAPI_ThruSections(!surface, ruled, 1e-6);
    loft.CheckCompatibility(true);
    for (const s of sections) loft.AddWire(this.wire(s));
    loft.Build(this.progress());
    if (!loft.IsDone()) throw new KernelError('Échec du lissage (sections coplanaires ou croisées ?).');
    return this.finish(loft.Shape());
  }

  // =========================================================================
  // Surfaces
  // =========================================================================

  planeSurface(profile: ProfileDef): SolidResult {
    return this.finish(this.face(profile));
  }

  /** Carreau de surface (SURFCARREAU) : remplissage d'une boucle de courbes, continuité C0. */
  patch(edges: ProfileDef[]): SolidResult {
    const oc = this.oc;
    if (!edges.length) throw new KernelError('Sélectionnez les courbes du contour.');
    const fill = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
    for (const p of edges) {
      const exp = new oc.TopExp_Explorer_2(this.wire(p), oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      for (; exp.More(); exp.Next()) fill.Add_1(oc.TopoDS.Edge_1(exp.Current()), oc.GeomAbs_Shape.GeomAbs_C0, true);
      exp.delete();
    }
    try {
      fill.Build(this.progress());
    } catch {
      throw new KernelError('Les courbes ne forment pas un contour fermé.');
    }
    if (!fill.IsDone()) throw new KernelError('Les courbes ne forment pas un contour fermé.');
    return this.finish(fill.Shape());
  }

  /** ÉPAISSIR : surface → solide (épaisseur du côté de la normale si positive). */
  thicken(shapeId: string, thickness: number): SolidResult {
    if (Math.abs(thickness) < 1e-9) throw new KernelError('Épaisseur nulle.');
    const mk = new this.oc.BRepOffsetAPI_MakeThickSolid();
    try {
      mk.MakeThickSolidBySimple(this.get(shapeId), thickness);
    } catch {
      throw new KernelError('Épaississement impossible pour cette surface.');
    }
    if (!mk.IsDone()) throw new KernelError('Épaississement impossible pour cette surface.');
    return this.finish(mk.Shape());
  }

  /** COUPE : sépare un solide par un plan. */
  slice(shapeId: string, origin: Vec3, normal: Vec3, keep: 'both' | 'positive' | 'negative'): SolidResult[] {
    const oc = this.oc;
    const mb = this.meshes.get(shapeId);
    if (mb) {
      if (!mb.closed) throw new KernelError('Seul un corps maillé fermé peut être coupé.');
      const [pos, neg] = meshSlice(this.mf(), mb.mesh, origin, normal);
      const out = [...(keep !== 'negative' && pos ? [pos] : []), ...(keep !== 'positive' && neg ? [neg] : [])].map((b) => this.storeMesh(b));
      if (!out.length) throw new KernelError('Le plan ne coupe pas le solide de ce côté.');
      return out;
    }
    const shape = this.get(shapeId);
    const bb = this.bbox(shape);
    const size = 4 * (Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) + Math.hypot(origin.x - bb.min.x, origin.y - bb.min.y, origin.z - bb.min.z) + 1);
    const pln = new oc.gp_Pln_3(this.pnt(origin), this.dir(normal));
    const tool = new oc.BRepBuilderAPI_MakeFace_9(pln, -size, size, -size, size).Face();
    const sp = new oc.BRepAlgoAPI_Splitter_1();
    const args = new oc.TopTools_ListOfShape_1();
    args.Append_1(shape);
    const tools = new oc.TopTools_ListOfShape_1();
    tools.Append_1(tool);
    sp.SetArguments(args);
    sp.SetTools(tools);
    sp.Build(this.progress());
    if (sp.HasErrors()) throw new KernelError('La coupe a échoué.');
    const n = normalize(normal);
    const out: SolidResult[] = [];
    const exp = new oc.TopExp_Explorer_2(sp.Shape(), oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; exp.More(); exp.Next()) {
      const solid = exp.Current();
      const props = new oc.GProp_GProps_1();
      oc.BRepGProp.VolumeProperties_1(solid, props, true, false, false);
      const c = props.CentreOfMass();
      const side = (c.X() - origin.x) * n.x + (c.Y() - origin.y) * n.y + (c.Z() - origin.z) * n.z;
      props.delete();
      if (keep === 'both' || (keep === 'positive' && side > 0) || (keep === 'negative' && side < 0)) out.push(this.finish(solid));
    }
    exp.delete();
    if (!out.length) throw new KernelError('Le plan ne coupe pas le solide de ce côté.');
    return out;
  }

  /** VERIFSOLIDE : validité B-rep et étanchéité. */
  check(shapeId: string): CheckReport {
    const oc = this.oc;
    const mb = this.meshes.get(shapeId);
    if (mb) {
      const r = checkManifold(mb.mesh);
      return { valid: r.isManifold && r.isOriented, solids: mb.closed ? r.shells : 0, shells: r.shells, faces: r.triangles, edges: r.edges, freeEdges: r.boundaryEdges, volume: r.volume };
    }
    const shape = this.get(shapeId);
    const an = new oc.BRepCheck_Analyzer(shape, true, false);
    const valid = an.IsValid_2();
    an.delete();
    const count = (t: string) => {
      let k = 0;
      const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum[`TopAbs_${t}`], oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      for (; exp.More(); exp.Next()) k++;
      exp.delete();
      return k;
    };
    // arête libre = bordée par une seule face
    const map = new oc.TopTools_IndexedDataMapOfShapeListOfShape_1();
    oc.TopExp.MapShapesAndAncestors(shape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_FACE, map);
    let freeEdges = 0;
    for (let i = 1; i <= map.Extent(); i++) {
      const e = oc.TopoDS.Edge_1(map.FindKey(i));
      if (!oc.BRep_Tool.Degenerated(e) && map.FindFromIndex(i).Extent() < 2) freeEdges++;
    }
    const props = new oc.GProp_GProps_1();
    oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false);
    const volume = props.Mass();
    props.delete();
    return { valid, solids: count('SOLID'), shells: count('SHELL'), faces: count('FACE'), edges: map.Extent(), freeEdges, volume };
  }

  // =========================================================================
  // Booléens
  // =========================================================================

  boolean(kind: 'union' | 'subtract' | 'intersect', targets: string[], tools: string[], exact = false): SolidResult {
    const oc = this.oc;
    if (!targets.length) throw new KernelError('Aucun solide sélectionné.');
    // union et intersection : le premier solide est l'argument, les autres les outils
    const symmetric = kind !== 'subtract';
    const all = symmetric ? [...targets, ...tools] : targets;
    const toolIds = symmetric ? all.slice(1) : tools;
    const argIds = symmetric ? all.slice(0, 1) : targets;
    if (!toolIds.length) throw new KernelError(symmetric ? 'Sélectionnez au moins deux solides.' : 'Aucun solide à soustraire.');
    if ([...argIds, ...toolIds].some((id) => this.meshes.has(id))) {
      // au moins un corps maillé : booléen maillé (manifold-3d), résultat maillé
      try {
        const res = meshBoolean(this.mf(), kind, argIds.map((id) => this.trianglesOf(id)), toolIds.map((id) => this.trianglesOf(id)));
        return this.storeMesh(res, ['Résultat maillé (corps STL/3MF).']);
      } catch (e) {
        throw new KernelError((e as Error).message);
      }
    }

    const run = (fuzzy: number, unifyFaces = !exact) => {
      const args = new oc.TopTools_ListOfShape_1();
      for (const id of argIds) args.Append_1(this.get(id));
      const toolList = new oc.TopTools_ListOfShape_1();
      for (const id of toolIds) toolList.Append_1(this.get(id));
      const algo =
        kind === 'union' ? new oc.BRepAlgoAPI_Fuse_1() : kind === 'subtract' ? new oc.BRepAlgoAPI_Cut_1() : new oc.BRepAlgoAPI_Common_1();
      algo.SetArguments(args);
      algo.SetTools(toolList);
      if (fuzzy) algo.SetFuzzyValue(fuzzy);
      algo.SetRunParallel(false);
      algo.SetNonDestructive(true);
      algo.SetUseOBB(true);
      algo.Build(this.progress());
      if (algo.HasErrors()) throw new KernelError('Le noyau n’a pas pu calculer l’opération booléenne.');
      if (!unifyFaces) return algo.Shape();
      const unify = new oc.ShapeUpgrade_UnifySameDomain_2(algo.Shape(), true, true, false);
      unify.SetLinearTolerance(1e-6);
      unify.SetAngularTolerance(1e-4);
      unify.Build();
      return unify.Shape();
    };
    // la tolérance floue aide sur les faces coplanaires mais fait parfois ignorer des
    // intersections de surfaces gauches (filetages) : résultat incohérent → nouvel essai sans
    if (exact) {
      const shape = run(0);
      if (this.solidCount(shape) === 0) throw new KernelError('Le résultat est vide.');
      return this.finish(shape);
    }
    // corps à surfaces gauches (filetage réel, balayage) : la tolérance floue peut faire tourner
    // OCC pendant des dizaines de minutes (vis filetée soustraite d'une plaque : > 25 min contre
    // 1 s en exact) ; on commence donc en exact, sans fusion des faces, et le flou ne sert
    // qu'en secours
    const freeForm = [...argIds, ...toolIds].some((id) => this.hasFreeFormFaces(this.get(id)));
    let shape = freeForm ? run(0, false) : run(1e-6);
    const va = argIds.reduce((t, id) => t + Math.abs(this.volumeOf(this.get(id))), 0);
    const vt = toolIds.reduce((t, id) => t + Math.abs(this.volumeOf(this.get(id))), 0);
    const plausible = (sh: any) => {
      const v = Math.abs(this.volumeOf(sh)), eps = 1e-6 * (va + vt) + 1e-9;
      if (kind === 'union') return v >= Math.max(va, ...toolIds.map((id) => Math.abs(this.volumeOf(this.get(id))))) - eps && v <= va + vt + eps;
      if (kind === 'subtract') return v <= va + eps && v >= va - vt - eps;
      return v <= Math.min(va, vt) + eps;
    };
    if (!plausible(shape) || this.solidCount(shape) === 0) {
      const again = freeForm ? run(1e-6, false) : run(0);
      if (plausible(again) && this.solidCount(again) > 0) shape = again;
    }

    if (this.solidCount(shape) === 0) {
      throw new KernelError(kind === 'intersect' ? 'Les solides ne se recoupent pas.' : 'Le résultat est vide.');
    }
    return this.finish(shape);
  }

  /** Vrai si le solide a des faces BSpline, de Bézier ou balayées (filetages, lissages…). */
  private hasFreeFormFaces(shape: any): boolean {
    const oc = this.oc, T = oc.GeomAbs_SurfaceType;
    const simple = [T.GeomAbs_Plane, T.GeomAbs_Cylinder, T.GeomAbs_Cone, T.GeomAbs_Sphere, T.GeomAbs_Torus, T.GeomAbs_SurfaceOfRevolution];
    const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    let found = false;
    for (; exp.More() && !found; exp.Next()) {
      const surf = new oc.BRepAdaptor_Surface_2(oc.TopoDS.Face_1(exp.Current()), true);
      const t = surf.GetType();
      surf.delete();
      if (!simple.some((s) => s === t)) found = true;
    }
    exp.delete();
    return found;
  }

  private volumeOf(shape: any): number {
    const props = new this.oc.GProp_GProps_1();
    this.oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false);
    const v = props.Mass();
    props.delete();
    return v;
  }

  private solidCount(shape: any): number {
    const oc = this.oc;
    let n = 0;
    const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; exp.More(); exp.Next()) n++;
    exp.delete();
    return n;
  }

  // =========================================================================
  // Finitions
  // =========================================================================

  private indexedMap(shape: any, type: 'FACE' | 'EDGE'): any {
    const oc = this.oc;
    const map = new oc.TopTools_IndexedMapOfShape_1();
    oc.TopExp.MapShapes_1(shape, oc.TopAbs_ShapeEnum[`TopAbs_${type}`], map);
    return map;
  }

  private edgesOf(shape: any, edges: number[] | 'all'): any[] {
    const oc = this.oc;
    const map = this.indexedMap(shape, 'EDGE');
    const n = map.Size();
    const ids = edges === 'all' ? Array.from({ length: n }, (_, i) => i) : edges;
    const out: any[] = [];
    for (const i of ids) {
      if (i < 0 || i >= n) throw new KernelError(`Arête ${i} inexistante.`);
      const e = oc.TopoDS.Edge_1(map.FindKey(i + 1));
      if (!oc.BRep_Tool.Degenerated(e)) out.push(e);
    }
    if (!out.length) throw new KernelError('Aucune arête valide.');
    return out;
  }

  fillet(shapeId: string, edges: number[] | 'all', radius: number, radius2?: number): SolidResult {
    const oc = this.oc;
    positive(radius, 'rayon');
    if (radius2 !== undefined) positive(radius2, 'rayon de fin');
    const shape = this.get(shapeId);
    const mk = new oc.BRepFilletAPI_MakeFillet(shape, oc.ChFi3d_FilletShape.ChFi3d_Rational);
    for (const e of this.edgesOf(shape, edges)) {
      if (radius2 !== undefined && Math.abs(radius2 - radius) > 1e-9) mk.Add_3(radius, radius2, e);
      else mk.Add_2(radius, e);
    }
    try {
      mk.Build(this.progress());
    } catch {
      throw new KernelError('Congé impossible : rayon trop grand pour les faces adjacentes.');
    }
    const msg = 'Congé impossible : rayon trop grand pour les faces adjacentes.';
    if (!mk.IsDone()) throw new KernelError(msg);
    return this.finish(mk.Shape(), [], msg);
  }

  chamfer(shapeId: string, edges: number[] | 'all', distance: number): SolidResult {
    const oc = this.oc;
    positive(distance, 'distance');
    const shape = this.get(shapeId);
    const mk = new oc.BRepFilletAPI_MakeChamfer(shape);
    for (const e of this.edgesOf(shape, edges)) mk.Add_2(distance, e);
    try {
      mk.Build(this.progress());
    } catch {
      throw new KernelError('Chanfrein impossible : distance trop grande.');
    }
    const msg = 'Chanfrein impossible : distance trop grande.';
    if (!mk.IsDone()) throw new KernelError(msg);
    return this.finish(mk.Shape(), [], msg);
  }

  /**
   * Coque : épaisseur de paroi vers l'intérieur. Les faces listées sont retirées (ouvertures) ;
   * sans face retirée, le solide est évidé (cavité fermée, utile pour l'impression).
   */
  shell(shapeId: string, faces: number[], thickness: number): SolidResult {
    const oc = this.oc;
    positive(thickness, 'épaisseur');
    const shape = this.get(shapeId);
    if (!faces.length) {
      const off = new oc.BRepOffsetAPI_MakeOffsetShape();
      off.PerformByJoin(shape, -thickness, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, false, false,
        oc.GeomAbs_JoinType.GeomAbs_Arc, false, this.progress());
      if (!off.IsDone()) throw new KernelError('Évidement impossible : épaisseur trop grande.');
      const inner = off.Shape();
      const id = this.store(inner);
      const res = this.boolean('subtract', [shapeId], [id]);
      this.shapes.delete(id);
      return res;
    }
    const map = this.indexedMap(shape, 'FACE');
    const list = new oc.TopTools_ListOfShape_1();
    for (const f of faces) {
      if (f < 0 || f >= map.Size()) throw new KernelError(`Face ${f} inexistante.`);
      list.Append_1(map.FindKey(f + 1));
    }
    const mk = new oc.BRepOffsetAPI_MakeThickSolid();
    mk.MakeThickSolidByJoin(shape, list, -thickness, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, false, false,
      oc.GeomAbs_JoinType.GeomAbs_Arc, false, this.progress());
    if (!mk.IsDone()) throw new KernelError('Coque impossible : épaisseur trop grande pour la géométrie.');
    return this.finish(mk.Shape());
  }

  /**
   * Appuyer/tirer : la face plane est extrudée le long de sa normale extérieure, puis le prisme
   * est ajouté (distance > 0, tirer) ou retiré (distance < 0, appuyer) du solide.
   */
  pressPull(shapeId: string, face: number, distance: number): SolidResult {
    const oc = this.oc;
    if (!Number.isFinite(distance) || Math.abs(distance) < 1e-9) throw new KernelError('Distance nulle.');
    const shape = this.get(shapeId);
    const map = this.indexedMap(shape, 'FACE');
    if (face < 0 || face >= map.Size()) throw new KernelError(`Face ${face} inexistante.`);
    const f = oc.TopoDS.Face_1(map.FindKey(face + 1));
    const surf = new oc.BRepAdaptor_Surface_2(f, true);
    const planar = surf.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Plane;
    let n: Vec3 | null = null;
    if (planar) {
      const d = surf.Plane().Axis().Direction();
      const s = f.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED ? -1 : 1;
      n = { x: d.X() * s, y: d.Y() * s, z: d.Z() * s };
    }
    surf.delete();
    if (!n) throw new KernelError('Appuyer/tirer : choisissez une face plane.');
    const prism = new oc.BRepPrimAPI_MakePrism_1(f, new oc.gp_Vec_4(n.x * distance, n.y * distance, n.z * distance), false, true);
    const tool = this.store(prism.Shape());
    try {
      return this.boolean(distance > 0 ? 'union' : 'subtract', [shapeId], [tool]);
    } catch (e) {
      if (distance < 0 && /vide/.test((e as Error).message)) throw new KernelError('Appuyer/tirer : la profondeur traverse tout le solide.');
      throw e;
    } finally {
      this.shapes.delete(tool);
    }
  }

  transform(shapeId: string, m: Affine): SolidResult {
    const oc = this.oc;
    const mb = this.meshes.get(shapeId);
    if (mb) return this.storeMesh(transformMeshBody(mb, m));
    const t = new oc.gp_Trsf_1();
    t.SetValues(...m);
    const src = this.get(shapeId);
    if (isRigid(m)) {
      // déplacement rigide (rotation propre + translation) : la forme est seulement « placée »
      // (partage de la géométrie et du maillage déjà calculé, pas de copie ni de contrôle)
      const moved = src.Moved(new oc.TopLoc_Location_2(t), false);
      t.delete();
      return this.finish(moved, [], undefined, true);
    }
    const res = new oc.BRepBuilderAPI_Transform_2(src, t, true);
    const out = this.finish(res.Shape());
    res.delete();
    t.delete();
    return out;
  }

  // =========================================================================
  // Affichage
  // =========================================================================

  /** `known` : volume et nombre de solides déjà calculés par `finish` (évite un second calcul). */
  display(shapeId: string, known?: { volume: number; solidCount: number }): DisplayMesh {
    const oc = this.oc;
    const mb = this.meshes.get(shapeId);
    if (mb) return meshDisplay(mb);
    const shape = this.get(shapeId);
    const bb = this.bbox(shape);
    const diag = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
    const deflection = Math.max(diag * 6e-4, 0.002);
    // forme déjà maillée assez finement (déplacement rigide d'un solide affiché) : on réutilise
    if (!oc.BRepTools.Triangulation(shape, deflection, false)) new oc.BRepMesh_IncrementalMesh_2(shape, deflection, false, 0.2, false).delete();

    const positions: number[] = [];
    const indices: number[] = [];
    const faceIds: number[] = [];
    const faces = this.indexedMap(shape, 'FACE');
    for (let fi = 1; fi <= faces.Size(); fi++) {
      const face = oc.TopoDS.Face_1(faces.FindKey(fi));
      const loc = new oc.TopLoc_Location_1();
      const handle = oc.BRep_Tool.Triangulation(face, loc, 0);
      if (handle.IsNull()) continue;
      const tri = handle.get();
      const identity = loc.IsIdentity();
      const trsf = identity ? null : loc.Transformation();
      const base = positions.length / 3;
      const nodes = tri.NbNodes();
      for (let i = 1; i <= nodes; i++) {
        // chaque nœud renvoyé par valeur est un objet WebAssembly : on le libère aussitôt
        const n = tri.Node(i);
        const p = trsf ? n.Transformed(trsf) : n;
        positions.push(p.X(), p.Y(), p.Z());
        if (p !== n) p.delete();
        n.delete();
      }
      const reversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
      for (let t = 1; t <= tri.NbTriangles(); t++) {
        const T = tri.Triangle(t);
        const a = T.Value(1) - 1 + base, b = T.Value(2) - 1 + base, c = T.Value(3) - 1 + base;
        T.delete();
        if (reversed) indices.push(a, c, b);
        else indices.push(a, b, c);
        faceIds.push(fi - 1);
      }
      loc.delete();
    }

    const edgePts: number[] = [];
    const edgeOffsets: number[] = [];
    const edges = this.indexedMap(shape, 'EDGE');
    for (let ei = 1; ei <= edges.Size(); ei++) {
      edgeOffsets.push(edgePts.length / 3);
      const edge = oc.TopoDS.Edge_1(edges.FindKey(ei));
      if (oc.BRep_Tool.Degenerated(edge)) continue;
      const curve = new oc.BRepAdaptor_Curve_2(edge);
      if (curve.GetType() === oc.GeomAbs_CurveType.GeomAbs_Line) {
        for (const u of [curve.FirstParameter(), curve.LastParameter()]) {
          const p = curve.Value(u);
          edgePts.push(p.X(), p.Y(), p.Z());
        }
      } else {
        const disc = new oc.GCPnts_TangentialDeflection_2(curve, 0.1, diag * 5e-4, 2, 1e-9, 1e-7);
        for (let i = 1; i <= disc.NbPoints(); i++) {
          const p = disc.Value(i);
          edgePts.push(p.X(), p.Y(), p.Z());
        }
        disc.delete();
      }
      curve.delete();
    }
    edgeOffsets.push(edgePts.length / 3);

    const volume = known ? known.volume : this.volumeOf(shape);
    const sprops = new oc.GProp_GProps_1();
    oc.BRepGProp.SurfaceProperties_1(shape, sprops, false, false);
    const area = sprops.Mass();
    sprops.delete();

    return {
      positions: new Float32Array(positions),
      indices: new Uint32Array(indices),
      faceIds: new Uint32Array(faceIds),
      edgePoints: new Float32Array(edgePts),
      edgeOffsets: new Uint32Array(edgeOffsets),
      volume,
      area,
      bbox: bb,
      faceCount: faces.Size(),
      edgeCount: edges.Size(),
      solidCount: known ? known.solidCount : this.solidCount(shape),
    };
  }

  private bbox(shape: any): { min: Vec3; max: Vec3 } {
    const oc = this.oc;
    const box = new oc.Bnd_Box_1();
    oc.BRepBndLib.Add(shape, box, false);
    const min = box.CornerMin();
    const max = box.CornerMax();
    const r = { min: { x: min.X(), y: min.Y(), z: min.Z() }, max: { x: max.X(), y: max.Y(), z: max.Z() } };
    box.delete();
    return r;
  }

  // =========================================================================
  // Export / import
  // =========================================================================

  /** Maillage d'export (soudé, contrôlé) d'un ou plusieurs solides. */
  exportMesh(shapeIds: string[], linearDeflection: number, angularDeflectionDeg: number): IndexedMesh[] {
    return shapeIds.map(
      (id) =>
        this.meshes.get(id)?.mesh ??
        tessellate(this.oc, this.get(id), {
          linearDeflection,
          angularDeflection: angularDeflectionDeg * DEG,
        }).mesh,
    );
  }

  /** Tôle pliée : tôle de base extrudée, profils de pli extrudés le long des arêtes, fusion. */
  sheetMetal(def: SheetMetalDef): SolidResult {
    let layout: ReturnType<typeof sheetLayout>;
    try {
      layout = sheetLayout(def);
    } catch (e) {
      throw new KernelError((e as Error).message);
    }
    const temp: string[] = [];
    const lazy = this.lazy;
    this.lazy = true;
    try {
      const base = this.extrude({ kind: 'poly', points: layout.base, closed: true }, def.thickness, 0);
      temp.push(base.shapeId);
      const tools: string[] = [];
      for (const fl of layout.flanges) {
        const prof = flangeProfile(def, fl);
        const fr = flangeFrame(def, fl, layout.z0);
        const local = this.extrude({ kind: 'poly', points: prof.points, closed: true, bulges: prof.bulges }, fr.length, 0);
        temp.push(local.shapeId);
        const placed = this.transform(local.shapeId, fr.matrix);
        temp.push(placed.shapeId);
        tools.push(placed.shapeId);
      }
      this.lazy = lazy;
      if (!tools.length) return this.finish(this.get(base.shapeId), [], undefined, true);
      return this.boolean('union', [base.shapeId], tools);
    } finally {
      this.lazy = lazy;
      for (const id of temp) this.shapes.delete(id);
    }
  }

  // =========================================================================
  // Mise en plan
  // =========================================================================

  /** Vue projetée avec élimination des lignes cachées (HLRBRep exact). */
  hlr(shapeIds: string[], dir: Vec3, xDir: Vec3, hidden: boolean, smooth: boolean): HlrResult {
    const oc = this.oc;
    const ids = shapeIds.filter((id) => this.shapes.has(id));
    const out: HlrResult = { visible: [], hidden: [], smooth: [], cylinders: [] };
    if (!ids.length) return out;
    const shape = ids.length === 1 ? this.get(ids[0]!) : this.compound(ids);
    const origin = new oc.gp_Pnt_3(0, 0, 0);
    const ax = new oc.gp_Ax2_2(origin, this.dir(dir), this.dir(xDir));
    const projector = new oc.HLRAlgo_Projector_2(ax);
    const algo = new oc.HLRBRep_Algo_1();
    algo.Add_2(shape, 0);
    algo.Projector_1(projector);
    algo.Update();
    algo.Hide_1();
    const handle = new oc.Handle_HLRBRep_Algo_2(algo);
    const conv = new oc.HLRBRep_HLRToShape(handle);
    const bb = this.bbox(shape);
    const diag = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
    const collect = (comp: any, into: HlrCurve[]) => {
      if (!comp || comp.IsNull()) return;
      oc.BRepLib.BuildCurves3d_2(comp);
      const exp = new oc.TopExp_Explorer_2(comp, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      for (; exp.More(); exp.Next()) {
        const edge = oc.TopoDS.Edge_1(exp.Current());
        if (oc.BRep_Tool.Degenerated(edge)) continue;
        const c = this.hlrCurve(edge, diag);
        if (c) into.push(c);
      }
      exp.delete();
    };
    collect(conv.VCompound_1(), out.visible);
    collect(conv.OutLineVCompound_1(), out.visible);
    if (smooth) collect(conv.Rg1LineVCompound_1(), out.smooth);
    if (hidden) {
      collect(conv.HCompound_1(), out.hidden);
      collect(conv.OutLineHCompound_1(), out.hidden);
    }
    conv.delete();
    handle.delete();
    projector.delete();
    // faces cylindriques : axes et marques de centre
    const faces = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; faces.More() && out.cylinders.length < 2000; faces.Next()) {
      const face = oc.TopoDS.Face_1(faces.Current());
      const surf = new oc.BRepAdaptor_Surface_2(face, true);
      if (surf.GetType() === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
        const cyl = surf.Cylinder();
        const ax1 = cyl.Axis();
        const l = ax1.Location(), dd = ax1.Direction();
        const c = { x: l.X(), y: l.Y(), z: l.Z() }, d = { x: dd.X(), y: dd.Y(), z: dd.Z() };
        let t0 = Infinity, t1 = -Infinity;
        const vx = new oc.TopExp_Explorer_2(face, oc.TopAbs_ShapeEnum.TopAbs_VERTEX, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
        for (; vx.More(); vx.Next()) {
          const p = oc.BRep_Tool.Pnt(oc.TopoDS.Vertex_1(vx.Current()));
          const t = (p.X() - c.x) * d.x + (p.Y() - c.y) * d.y + (p.Z() - c.z) * d.z;
          p.delete();
          t0 = Math.min(t0, t), t1 = Math.max(t1, t);
        }
        vx.delete();
        if (t1 - t0 > 1e-6) out.cylinders.push({ c, d, r: cyl.Radius(), t0, t1 });
        cyl.delete();
      }
      surf.delete();
    }
    faces.delete();
    ax.delete();
    origin.delete();
    return out;
  }

  private hlrCurve(edge: any, diag: number): HlrCurve | null {
    const oc = this.oc;
    const curve = new oc.BRepAdaptor_Curve_2(edge);
    try {
      const u0 = curve.FirstParameter(), u1 = curve.LastParameter();
      const xy = (p: any): [number, number] => {
        const r: [number, number] = [p.X(), p.Y()];
        p.delete();
        return r;
      };
      const type = curve.GetType();
      if (type === oc.GeomAbs_CurveType.GeomAbs_Line) {
        const a = xy(curve.Value(u0)), b = xy(curve.Value(u1));
        return Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-9 ? null : { k: 'line', a, b };
      }
      if (type === oc.GeomAbs_CurveType.GeomAbs_Circle) {
        const circ = curve.Circle();
        const loc = circ.Location();
        const c: [number, number] = [loc.X(), loc.Y()];
        const r = circ.Radius();
        const z = circ.Axis().Direction().Z();
        circ.delete();
        const p0 = xy(curve.Value(u0)), p1 = xy(curve.Value(u1));
        const full = Math.abs(u1 - u0 - 2 * Math.PI) < 1e-6;
        let a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]), a1 = Math.atan2(p1[1] - c[1], p1[0] - c[0]);
        // cercle vu de dos (axe vers -Z) : le sens est inversé
        if (z < 0) [a0, a1] = [a1, a0];
        if (Math.abs(z) > 1e-6) return { k: 'arc', c, r, a0, a1, full };
      }
      const disc = new oc.GCPnts_TangentialDeflection_2(curve, 0.1, diag * 3e-4, 2, 1e-9, 1e-7);
      const pts: [number, number][] = [];
      for (let i = 1; i <= disc.NbPoints(); i++) pts.push(xy(disc.Value(i)));
      disc.delete();
      return pts.length > 1 ? { k: 'poly', pts } : null;
    } finally {
      curve.delete();
    }
  }

  private compound(ids: string[]): any {
    const oc = this.oc;
    const builder = new oc.BRep_Builder();
    const comp = new oc.TopoDS_Compound();
    builder.MakeCompound(comp);
    for (const id of ids) builder.Add(comp, this.get(id));
    return comp;
  }

  exportStep(shapeIds: string[]): Uint8Array {
    const oc = this.oc;
    const writer = new oc.STEPControl_Writer_1();
    const temp: string[] = [];
    shapeIds = shapeIds.map((id) => {
      const mb = this.meshes.get(id);
      if (!mb) return id;
      if (mb.mesh.indices.length / 3 > 20000) throw new KernelError('Corps maillé trop fin pour le STEP : convertissez-le d’abord avec CONVSOLIDE.');
      const r = this.meshToSolid(mb.mesh.positions, mb.mesh.indices, mb.closed, true);
      temp.push(r.shapeId);
      return r.shapeId;
    });
    const shape = shapeIds.length === 1 ? this.get(shapeIds[0]!) : this.compound(shapeIds);
    writer.Transfer(shape, oc.STEPControl_StepModelType.STEPControl_AsIs, true, this.progress());
    const path = `/export_${Date.now()}.step`;
    const status = writer.Write(path);
    if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new KernelError('Échec de l’écriture STEP.');
    const data = oc.FS.readFile(path) as Uint8Array;
    oc.FS.unlink(path);
    this.release(temp);
    return data;
  }

  importStep(data: Uint8Array): SolidResult[] {
    const oc = this.oc;
    const path = `/import_${Date.now()}.step`;
    oc.FS.writeFile(path, data);
    const reader = new oc.STEPControl_Reader_1();
    const status = reader.ReadFile(path);
    oc.FS.unlink(path);
    if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new KernelError('Fichier STEP illisible.');
    reader.TransferRoots(this.progress());
    const shape = reader.OneShape();
    const results: SolidResult[] = [];
    const exp = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_SOLID, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
    for (; exp.More(); exp.Next()) results.push(this.finish(exp.Current()));
    if (!results.length) {
      // pas de solide : surfaces et coques importées telles quelles
      const faces = new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
      if (faces.More()) results.push(this.finish(shape));
    }
    if (!results.length) throw new KernelError('Le fichier STEP ne contient aucune géométrie 3D.');
    return results;
  }

  /**
   * Extrusion de régions planes à trous (lettres d'un texte 3D) le long de `direction`
   * (longueur = profondeur). Les régions disjointes donnent un corps de plusieurs solides.
   */
  extrudeRegions(regions: { outer: Vec3[]; holes: Vec3[][] }[], direction: Vec3): SolidResult {
    const oc = this.oc;
    if (!regions.length) throw new KernelError('Aucun contour à extruder.');
    if (Math.hypot(direction.x, direction.y, direction.z) < 1e-9) throw new KernelError('Profondeur nulle.');
    const builder = new oc.BRep_Builder();
    const comp = new oc.TopoDS_Compound();
    builder.MakeCompound(comp);
    const vec = new oc.gp_Vec_4(direction.x, direction.y, direction.z);
    let count = 0;
    for (const r of regions) {
      try {
        const mk = new oc.BRepBuilderAPI_MakeFace_15(this.wire({ kind: 'poly', points: r.outer, closed: true }), true);
        if (!mk.IsDone()) continue;
        for (const h of r.holes) {
          try {
            mk.Add(this.wire({ kind: 'poly', points: h, closed: true }));
          } catch {
            /* trou dégénéré ignoré */
          }
        }
        // orientation des trous (sens inverse du contour) remise d'aplomb
        const fix = new oc.ShapeFix_Face_2(mk.Face());
        fix.Perform();
        const prism = new oc.BRepPrimAPI_MakePrism_1(fix.Face(), vec, false, true);
        if (prism.IsDone()) {
          builder.Add(comp, prism.Shape());
          count++;
        }
        prism.delete();
        fix.delete();
        mk.delete();
      } catch {
        /* contour dégénéré ignoré */
      }
    }
    vec.delete();
    if (!count) throw new KernelError('Aucune lettre n’a pu être construite.');
    return this.finish(comp);
  }

  /**
   * Maillage triangulaire (STL, 3MF importé) → forme B-rep : un sommet, une arête et une face
   * plane par élément du maillage, partagés (aucune couture à calculer, coût linéaire). Un
   * maillage fermé donne un solide, sinon une coque (surface). `merge` : fusion des triangles
   * coplanaires adjacents en faces planes (pièces mécaniques : faces et arêtes vraiment
   * modifiables par appuyer/tirer, raccords, coque…).
   */
  meshToSolid(positions: Float64Array | Float32Array, indices: Uint32Array, closed: boolean, merge: boolean): SolidResult {
    const oc = this.oc;
    const nv = positions.length / 3;
    const nt = indices.length / 3;
    if (!nt) throw new KernelError('Maillage vide.');
    const vertices: any[] = new Array(nv);
    const vertex = (i: number) => {
      let v = vertices[i];
      if (!v) {
        const p = new oc.gp_Pnt_3(positions[3 * i]!, positions[3 * i + 1]!, positions[3 * i + 2]!);
        const mk = new oc.BRepBuilderAPI_MakeVertex(p);
        v = vertices[i] = mk.Vertex();
        mk.delete();
        p.delete();
      }
      return v;
    };
    const edges = new Map<number, any>();
    /** Arête a→b (partagée avec le triangle voisin, qui la parcourt en sens inverse). */
    const edge = (a: number, b: number) => {
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = lo * nv + hi;
      let e = edges.get(key);
      if (!e) {
        const mk = new oc.BRepBuilderAPI_MakeEdge_2(vertex(lo), vertex(hi));
        if (!mk.IsDone()) {
          mk.delete();
          return null;
        }
        e = mk.Edge();
        mk.delete();
        edges.set(key, e);
      }
      return a === lo ? e : oc.TopoDS.Edge_1(e.Reversed());
    };
    const builder = new oc.BRep_Builder();
    const shell = new oc.TopoDS_Shell();
    builder.MakeShell(shell);
    let skipped = 0;
    for (let t = 0; t < nt; t++) {
      const a = indices[3 * t]!, b = indices[3 * t + 1]!, c = indices[3 * t + 2]!;
      const e1 = edge(a, b), e2 = edge(b, c), e3 = edge(c, a);
      if (!e1 || !e2 || !e3) {
        skipped++;
        continue;
      }
      const w = new oc.BRepBuilderAPI_MakeWire_4(e1, e2, e3);
      if (!w.IsDone()) {
        w.delete();
        skipped++;
        continue;
      }
      const f = new oc.BRepBuilderAPI_MakeFace_15(w.Wire(), true);
      if (f.IsDone()) builder.Add(shell, f.Face());
      else skipped++;
      f.delete();
      w.delete();
    }
    vertices.length = 0;
    edges.clear();
    let shape: any = shell;
    if (closed && !skipped) {
      shell.Closed_2(true);
      const solid = new oc.TopoDS_Solid();
      builder.MakeSolid(solid);
      builder.Add(solid, shell);
      shape = solid;
    }
    const warnings: string[] = [];
    if (skipped) warnings.push(`${skipped} triangle(s) dégénéré(s) ignoré(s).`);
    if (merge) {
      const unify = new oc.ShapeUpgrade_UnifySameDomain_2(shape, true, true, false);
      const bb = this.bbox(shape);
      const diag = Math.hypot(bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z) || 1;
      unify.SetLinearTolerance(diag * 1e-6);
      unify.SetAngularTolerance(1e-4);
      unify.Build();
      shape = unify.Shape();
      unify.delete();
    }
    if (closed && this.solidCount(shape) > 0 && this.volumeOf(shape) < 0) shape = shape.Reversed();
    // construction directe, valide par construction : pas de contrôle (coûteux sur des milliers de faces)
    return this.finish(shape, warnings, undefined, true);
  }

  saveBrep(shapeId: string): Uint8Array {
    const oc = this.oc;
    const mb = this.meshes.get(shapeId);
    if (mb) return saveMeshBody(mb);
    const path = `/save_${Date.now()}.brep`;
    if (!oc.BinTools.Write_3(this.get(shapeId), path, this.progress())) throw new KernelError('Échec de la sérialisation BREP.');
    const data = oc.FS.readFile(path) as Uint8Array;
    oc.FS.unlink(path);
    return data;
  }

  loadBrep(data: Uint8Array): SolidResult {
    const oc = this.oc;
    if (isMeshData(data)) return this.storeMesh(loadMeshBody(data));
    const path = `/load_${Date.now()}.brep`;
    oc.FS.writeFile(path, data);
    const shape = new oc.TopoDS_Shape();
    const ok = oc.BinTools.Read_2(shape, path, this.progress());
    oc.FS.unlink(path);
    if (!ok) throw new KernelError('Solide illisible dans le fichier.');
    return this.finish(shape);
  }
}

// ---------------------------------------------------------------------------

function positive(v: number, name: string): void {
  if (!(v > 0)) throw new KernelError(`Le ${name} doit être strictement positif.`);
}

/** Base et hauteur positives (une hauteur négative descend depuis le centre). */
function signedHeight(center: Vec3, height: number, axis: Vec3 = { x: 0, y: 0, z: 1 }): { base: Vec3; h: number; dir: Vec3 } {
  if (Math.abs(height) < 1e-9) throw new KernelError('Hauteur nulle.');
  const d = normalize(axis);
  return height > 0
    ? { base: center, h: height, dir: d }
    : { base: { x: center.x + d.x * height, y: center.y + d.y * height, z: center.z + d.z * height }, h: -height, dir: d };
}

/** Milieu de l'arc d'un segment de polyligne à renflement. */
export function bulgeMidpoint(a: Vec3, b: Vec3, bulge: number): Vec3 {
  // flèche = renflement × demi-corde, du côté droit de a→b pour un renflement positif
  const dx = b.x - a.x, dy = b.y - a.y;
  const half = Math.hypot(dx, dy) / 2;
  const s = bulge * half;
  const ux = dx / (2 * half), uy = dy / (2 * half);
  return { x: (a.x + b.x) / 2 + uy * s, y: (a.y + b.y) / 2 - ux * s, z: (a.z + b.z) / 2 };
}

function dedupe(points: Vec3[], closed: boolean): Vec3[] {
  const out: Vec3[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) > 1e-9) out.push(p);
  }
  if (closed && out.length > 2) {
    const a = out[0]!, b = out[out.length - 1]!;
    if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 1e-9) out.pop();
  }
  return out;
}

function profileAnchor(p: ProfileDef): Vec3 {
  if (p.kind === 'circle' || p.kind === 'arc' || p.kind === 'helix') return p.center;
  const n = p.points.length;
  return p.points.reduce((s, q) => ({ x: s.x + q.x / n, y: s.y + q.y / n, z: s.z + q.z / n }), { x: 0, y: 0, z: 0 });
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

/** Matrice 3×4 de rotation propre (orthonormée, déterminant +1) + translation. */
export function isRigid(m: Affine): boolean {
  const c = [
    [m[0], m[4], m[8]],
    [m[1], m[5], m[9]],
    [m[2], m[6], m[10]],
  ];
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  for (let i = 0; i < 3; i++)
    for (let j = i; j < 3; j++) if (Math.abs(dot(c[i]!, c[j]!) - (i === j ? 1 : 0)) > 1e-9) return false;
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  return det > 0;
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}
