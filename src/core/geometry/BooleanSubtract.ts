/**
 * SOUSTRACTION (_SUBTRACT) : A − (B₁ ∪ B₂ ∪ …).
 *
 * Deux chemins, choisis selon la nature des corps :
 *
 *  1. B-rep exact (OpenCascade.js, BRepAlgoAPI_Cut) pour les solides natifs. Le résultat reste
 *     un vrai solide (faces analytiques, NURBS), donc congés, coques et cotes restent possibles
 *     après l'opération. Étapes : booléen « fuzzy » → fusion des faces coplanaires
 *     (UnifySameDomain) → contrôle BRepCheck → réparation ShapeFix si nécessaire.
 *
 *  2. Maillé (manifold-3d) pour les corps sans B-rep (STL/3MF importés, maillages issus
 *     de scans). manifold-3d garantit un résultat 2-variété par construction.
 *
 * Dans les deux cas, la sortie maillée passe par `cleanMesh` + `checkManifold`.
 *
 * Toutes les instances OCC vivent dans le tas WebAssembly : elles sont libérées par un
 * `OcScope` (sinon fuite mémoire à chaque opération). Ce module s'exécute dans le
 * Web Worker du noyau (voir src/workers/kernel.worker.ts), jamais sur le thread UI.
 */
import type {
  OpenCascadeInstance,
  TopoDS_Shape,
  TopoDS_Face,
} from 'opencascade.js';
import type { ManifoldToplevel, Manifold } from 'manifold-3d';
import type { IndexedMesh } from '../mesh/IndexedMesh';
import { cleanMesh, type CleanReport } from '../mesh/MeshCleaner';
import { checkManifold, type ManifoldReport } from '../mesh/ManifoldCheck';

// ---------------------------------------------------------------------------
// Gestion mémoire WASM
// ---------------------------------------------------------------------------

interface Deletable {
  delete(): void;
}

/** Libère en fin de portée tous les objets OCC enregistrés (ordre inverse de création). */
export class OcScope {
  private readonly items: Deletable[] = [];
  track<T extends Deletable>(obj: T): T {
    this.items.push(obj);
    return obj;
  }
  dispose(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      try {
        this.items[i]!.delete();
      } catch {
        /* déjà libéré */
      }
    }
    this.items.length = 0;
  }
}

// ---------------------------------------------------------------------------
// 1. Soustraction B-rep (OpenCascade)
// ---------------------------------------------------------------------------

export interface BRepBooleanOptions {
  /** Tolérance « fuzzy » : fusionne les entités quasi coïncidentes (faces affleurantes). */
  fuzzyValue?: number;
  /** Fusionne les faces/arêtes coplanaires issues du découpage. */
  unifySameDomain?: boolean;
  runParallel?: boolean;
}

export interface BRepBooleanResult {
  shape: TopoDS_Shape;
  volume: number;
  valid: boolean;
  repaired: boolean;
  warnings: string[];
}

export class BooleanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BooleanError';
  }
}

export function solidVolume(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  const props = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false);
    return props.Mass();
  } finally {
    props.delete();
  }
}

export function subtractBRep(
  oc: OpenCascadeInstance,
  target: TopoDS_Shape,
  tools: readonly TopoDS_Shape[],
  opts: BRepBooleanOptions = {},
): BRepBooleanResult {
  if (!tools.length) throw new BooleanError('Aucun solide à soustraire.');
  const scope = new OcScope();
  const warnings: string[] = [];
  try {
    const args = scope.track(new oc.TopTools_ListOfShape_1());
    args.Append_1(target);
    const toolList = scope.track(new oc.TopTools_ListOfShape_1());
    for (const t of tools) toolList.Append_1(t);

    const cut = scope.track(new oc.BRepAlgoAPI_Cut_1());
    cut.SetArguments(args);
    cut.SetTools(toolList);
    cut.SetFuzzyValue(opts.fuzzyValue ?? 1e-6);
    cut.SetRunParallel(opts.runParallel ?? true);
    cut.SetNonDestructive(true); // ne modifie pas les arguments (annuler/rétablir)
    cut.SetUseOBB(true); // pré-filtrage par boîtes orientées : bien plus rapide
    cut.SetCheckInverted(true);
    cut.Build(scope.track(new oc.Message_ProgressRange_1()));

    if (cut.HasErrors()) throw new BooleanError('Échec de la soustraction (intersection non calculable).');
    if (cut.HasWarnings()) warnings.push('Avertissements du noyau pendant la soustraction.');

    let shape = cut.Shape();
    if (shape.IsNull()) throw new BooleanError('Le résultat de la soustraction est vide.');

    // Nettoyage topologique : fusionne les faces coplanaires créées par le découpage
    // (sinon un perçage traversant laisse des faces fragmentées et des arêtes parasites).
    if (opts.unifySameDomain ?? true) {
      const unify = new oc.ShapeUpgrade_UnifySameDomain_2(shape, true, true, false);
      unify.SetLinearTolerance(1e-6);
      unify.SetAngularTolerance(1e-4);
      unify.AllowInternalEdges(false);
      unify.Build();
      shape = unify.Shape();
      unify.delete();
    }

    // Contrôle de validité, réparation si nécessaire
    let valid = isValid(oc, shape);
    let repaired = false;
    if (!valid) {
      const fix = new oc.ShapeFix_Shape_2(shape);
      fix.SetPrecision(1e-6);
      fix.Perform(scope.track(new oc.Message_ProgressRange_1()));
      shape = fix.Shape();
      fix.delete();
      repaired = true;
      valid = isValid(oc, shape);
      warnings.push(valid ? 'Solide réparé par ShapeFix.' : 'Solide invalide après réparation.');
    }

    // Garde-fou physique : A − B ne peut pas être plus volumineux que A.
    const volume = solidVolume(oc, shape);
    const before = solidVolume(oc, target);
    if (volume > before * (1 + 1e-6)) warnings.push('Volume résultant supérieur à l’original : vérifier l’orientation des outils.');
    if (volume <= 0) throw new BooleanError('La soustraction a supprimé tout le solide.');

    return { shape, volume, valid, repaired, warnings };
  } finally {
    scope.dispose();
  }
}

function isValid(oc: OpenCascadeInstance, shape: TopoDS_Shape): boolean {
  const analyzer = new oc.BRepCheck_Analyzer(shape, true, false);
  try {
    return analyzer.IsValid_2();
  } finally {
    analyzer.delete();
  }
}

// ---------------------------------------------------------------------------
// Tessellation paramétrique B-rep → maillage (rendu et export)
// ---------------------------------------------------------------------------

export interface TessellationOptions {
  /** Flèche maximale (chordal deviation), en unités du dessin. Défaut 0,01 mm. */
  linearDeflection?: number;
  /** Écart angulaire maximal entre normales voisines, en radians. Défaut 0,5° ≈ 0,0087. */
  angularDeflection?: number;
  /** Flèche relative à la taille de chaque arête plutôt qu'absolue. */
  relative?: boolean;
}

export interface TessellationResult {
  mesh: IndexedMesh;
  clean: CleanReport;
  manifold: ManifoldReport;
  facesWithoutTriangulation: number;
}

export function tessellate(oc: OpenCascadeInstance, shape: TopoDS_Shape, opts: TessellationOptions = {}): TessellationResult {
  const scope = new OcScope();
  try {
    // BRepMesh discrétise d'abord les ARÊTES puis les faces : deux faces adjacentes
    // partagent donc exactement les mêmes nœuds sur l'arête commune → maillage étanche
    // après simple soudure des sommets.
    scope.track(
      new oc.BRepMesh_IncrementalMesh_2(
        shape,
        opts.linearDeflection ?? 0.01,
        opts.relative ?? false,
        opts.angularDeflection ?? (0.5 * Math.PI) / 180,
        true,
      ),
    );

    const positions: number[] = [];
    const indices: number[] = [];
    let missing = 0;

    const explorer = scope.track(
      new oc.TopExp_Explorer_2(shape, oc.TopAbs_ShapeEnum.TopAbs_FACE as never, oc.TopAbs_ShapeEnum.TopAbs_SHAPE as never),
    );
    for (; explorer.More(); explorer.Next()) {
      const face: TopoDS_Face = oc.TopoDS.Face_1(explorer.Current());
      const location = new oc.TopLoc_Location_1();
      const handle = oc.BRep_Tool.Triangulation(face, location, 0 as never /* Poly_MeshPurpose_NONE */);
      if (handle.IsNull()) {
        missing++;
        location.delete();
        continue;
      }
      const tri = handle.get();
      const trsf = location.Transformation();
      const base = positions.length / 3;
      for (let i = 1; i <= tri.NbNodes(); i++) {
        const p = tri.Node(i).Transformed(trsf);
        positions.push(p.X(), p.Y(), p.Z());
        p.delete();
      }
      // Une face REVERSED a sa triangulation dans le sens de la surface sous-jacente :
      // on inverse l'ordre pour obtenir des normales sortantes du solide.
      const reversed = face.Orientation_1() === (oc.TopAbs_Orientation.TopAbs_REVERSED as unknown);
      for (let t = 1; t <= tri.NbTriangles(); t++) {
        const triangle = tri.Triangle(t);
        const n1 = triangle.Value(1) - 1 + base;
        const n2 = triangle.Value(2) - 1 + base;
        const n3 = triangle.Value(3) - 1 + base;
        if (reversed) indices.push(n1, n3, n2);
        else indices.push(n1, n2, n3);
      }
      handle.delete();
      location.delete();
    }

    const raw: IndexedMesh = { positions: new Float64Array(positions), indices: new Uint32Array(indices) };
    const { mesh, report } = cleanMesh(raw);
    return { mesh, clean: report, manifold: checkManifold(mesh), facesWithoutTriangulation: missing };
  } finally {
    scope.dispose();
  }
}

// ---------------------------------------------------------------------------
// 2. Soustraction maillée (manifold-3d) pour les corps sans B-rep
// ---------------------------------------------------------------------------

function toManifold(wasm: ManifoldToplevel, m: IndexedMesh): Manifold {
  const mesh = new wasm.Mesh({
    numProp: 3,
    vertProperties: Float32Array.from(m.positions),
    triVerts: new Uint32Array(m.indices),
  });
  mesh.merge(); // recolle les sommets dupliqués aux coutures
  const solid = new wasm.Manifold(mesh);
  const status = solid.status();
  if (status !== 'NoError') {
    solid.delete();
    throw new BooleanError(`Corps maillé non valide pour un booléen (${status}). Réparez-le d’abord.`);
  }
  return solid;
}

export interface MeshBooleanResult {
  mesh: IndexedMesh;
  clean: CleanReport;
  manifold: ManifoldReport;
  volume: number;
}

export function subtractMesh(wasm: ManifoldToplevel, target: IndexedMesh, tools: readonly IndexedMesh[]): MeshBooleanResult {
  const owned: Manifold[] = [];
  try {
    const a = toManifold(wasm, target);
    owned.push(a);
    let result = a;
    for (const t of tools) {
      const b = toManifold(wasm, t);
      owned.push(b);
      result = result.subtract(b);
      owned.push(result);
    }
    if (result.isEmpty()) throw new BooleanError('La soustraction a supprimé tout le solide.');
    const out = result.getMesh();
    const raw: IndexedMesh = {
      positions: Float64Array.from(
        { length: out.numVert * 3 },
        (_, i) => out.vertProperties[Math.floor(i / 3) * out.numProp + (i % 3)]!,
      ),
      indices: new Uint32Array(out.triVerts),
    };
    const { mesh, report } = cleanMesh(raw);
    return { mesh, clean: report, manifold: checkManifold(mesh), volume: result.volume() };
  } finally {
    for (const m of new Set(owned)) m.delete();
  }
}

// ---------------------------------------------------------------------------
// Façade utilisée par la commande SOUSTRACTION
// ---------------------------------------------------------------------------

/** Corps du document : B-rep natif, ou maillage seul (import STL/3MF). */
export type Body = { kind: 'brep'; shape: TopoDS_Shape } | { kind: 'mesh'; mesh: IndexedMesh };

export interface KernelHandles {
  oc: OpenCascadeInstance;
  manifold: ManifoldToplevel;
}

export type SubtractOutcome =
  | { kind: 'brep'; result: BRepBooleanResult; preview: TessellationResult }
  | { kind: 'mesh'; result: MeshBooleanResult };

export function subtract(k: KernelHandles, target: Body, tools: readonly Body[], tess?: TessellationOptions): SubtractOutcome {
  const allBRep = target.kind === 'brep' && tools.every((t) => t.kind === 'brep');
  if (allBRep) {
    try {
      const result = subtractBRep(
        k.oc,
        target.shape,
        tools.map((t) => (t as { shape: TopoDS_Shape }).shape),
      );
      return { kind: 'brep', result, preview: tessellate(k.oc, result.shape, tess) };
    } catch (e) {
      if (!(e instanceof BooleanError)) throw e;
      // Repli : on retente sur les maillages (perd le B-rep mais l'utilisateur obtient un résultat).
    }
  }
  const asMesh = (b: Body) => (b.kind === 'mesh' ? b.mesh : tessellate(k.oc, b.shape, tess).mesh);
  return { kind: 'mesh', result: subtractMesh(k.manifold, asMesh(target), tools.map(asMesh)) };
}
