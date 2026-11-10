/**
 * Corps maillés (STL, 3MF importés) dans le noyau : stockés tels quels (triangles), affichés,
 * déplacés, coupés et combinés par booléens avec manifold-3d — rapide même sur des centaines de
 * milliers de triangles, là où une conversion B-rep prendrait des minutes. Un booléen entre un
 * corps maillé et un solide B-rep tessèle le solide puis donne un corps maillé.
 *
 * CONVSOLIDE convertit un corps maillé en vrai solide B-rep (faces coplanaires fusionnées) pour
 * les opérations qui demandent des faces exactes (raccords, coque, appuyer/tirer).
 */
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { signedVolume, type IndexedMesh } from '../core/mesh/IndexedMesh';
import { cleanMesh } from '../core/mesh/MeshCleaner';
import type { Affine, DisplayMesh } from './protocol';

export interface MeshBody {
  mesh: IndexedMesh;
  /** Fermé (étanche) : solide ; sinon surface. */
  closed: boolean;
}

/** Message des opérations qui exigent un solide B-rep. */
export const MESH_ONLY = 'Corps maillé (STL/3MF) : convertissez-le d’abord en solide avec CONVSOLIDE.';

export function transformMeshBody(b: MeshBody, m: Affine): MeshBody {
  const p = b.mesh.positions, out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    out[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
    out[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    out[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
  const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
  let indices = b.mesh.indices;
  if (det < 0) {
    // symétrie : on retourne les triangles pour garder les normales sortantes
    indices = Uint32Array.from(indices);
    for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2]!, indices[i + 1]!];
  }
  return { mesh: { positions: out, indices }, closed: b.closed };
}

// ---------------------------------------------------------------------------
// Affichage
// ---------------------------------------------------------------------------

/** Arêtes vives affichées : angle dièdre au-delà duquel une arête est tracée. */
const FEATURE_COS = Math.cos((25 * Math.PI) / 180);
/** Triangles d'une même « face » plane : écart de normale toléré. */
const PLANAR_COS = Math.cos((0.5 * Math.PI) / 180);

function normals(m: IndexedMesh): Float64Array {
  const p = m.positions, ix = m.indices, n = new Float64Array(ix.length);
  for (let t = 0; t < ix.length; t += 3) {
    const a = 3 * ix[t]!, b = 3 * ix[t + 1]!, c = 3 * ix[t + 2]!;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    const l = Math.hypot(x, y, z) || 1;
    x /= l, y /= l, z /= l;
    n[t] = x, n[t + 1] = y, n[t + 2] = z;
  }
  return n;
}

/** Arête (a,b) non orientée → triangles adjacents. */
function edgeMap(ix: Uint32Array, nv: number): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (let t = 0; t < ix.length / 3; t++)
    for (let k = 0; k < 3; k++) {
      const a = ix[3 * t + k]!, b = ix[3 * t + ((k + 1) % 3)]!;
      const key = Math.min(a, b) * nv + Math.max(a, b);
      const l = map.get(key);
      if (l) l.push(t);
      else map.set(key, [t]);
    }
  return map;
}

export function meshDisplay(b: MeshBody): DisplayMesh {
  const m = b.mesh, p = m.positions, ix = m.indices;
  const nt = ix.length / 3, nv = p.length / 3;
  const nrm = normals(m);
  const edges = edgeMap(ix, nv);

  // régions planes (faces) : croissance sur les arêtes entre triangles de même normale
  const faceOf = new Int32Array(nt).fill(-1);
  const adj: number[][] = Array.from({ length: nt }, () => []);
  for (const tris of edges.values()) if (tris.length === 2) adj[tris[0]!]!.push(tris[1]!), adj[tris[1]!]!.push(tris[0]!);
  const dot = (s: number, t: number) => nrm[3 * s]! * nrm[3 * t]! + nrm[3 * s + 1]! * nrm[3 * t + 1]! + nrm[3 * s + 2]! * nrm[3 * t + 2]!;
  let faces = 0;
  for (let s = 0; s < nt; s++) {
    if (faceOf[s]! >= 0) continue;
    const f = faces++;
    faceOf[s] = f;
    const stack = [s];
    while (stack.length) {
      const t = stack.pop()!;
      for (const u of adj[t]!) if (faceOf[u]! < 0 && dot(s, u) > PLANAR_COS) (faceOf[u] = f), stack.push(u);
    }
  }

  // sommets non soudés (ombrage plat, arêtes vives nettes)
  const positions = new Float32Array(nt * 9);
  const indices = new Uint32Array(nt * 3);
  for (let t = 0; t < nt; t++)
    for (let k = 0; k < 3; k++) {
      const v = ix[3 * t + k]!;
      positions.set([p[3 * v]!, p[3 * v + 1]!, p[3 * v + 2]!], 9 * t + 3 * k);
      indices[3 * t + k] = 3 * t + k;
    }

  // arêtes affichées : bords libres et arêtes vives
  const edgePts: number[] = [];
  const offsets: number[] = [];
  for (const [key, tris] of edges) {
    const sharp = tris.length !== 2 || (faceOf[tris[0]!] !== faceOf[tris[1]!] && dot(tris[0]!, tris[1]!) < FEATURE_COS);
    if (!sharp) continue;
    const a = Math.floor(key / nv), c = key % nv;
    offsets.push(edgePts.length / 3);
    edgePts.push(p[3 * a]!, p[3 * a + 1]!, p[3 * a + 2]!, p[3 * c]!, p[3 * c + 1]!, p[3 * c + 2]!);
  }
  offsets.push(edgePts.length / 3);

  let area = 0;
  for (let t = 0; t < nt; t++) {
    const a = 3 * ix[3 * t]!, bb = 3 * ix[3 * t + 1]!, c = 3 * ix[3 * t + 2]!;
    const ux = p[bb]! - p[a]!, uy = p[bb + 1]! - p[a + 1]!, uz = p[bb + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < p.length; i += 3) {
    min.x = Math.min(min.x, p[i]!), min.y = Math.min(min.y, p[i + 1]!), min.z = Math.min(min.z, p[i + 2]!);
    max.x = Math.max(max.x, p[i]!), max.y = Math.max(max.y, p[i + 1]!), max.z = Math.max(max.z, p[i + 2]!);
  }
  return {
    positions,
    indices,
    faceIds: Uint32Array.from(faceOf),
    edgePoints: new Float32Array(edgePts),
    edgeOffsets: new Uint32Array(offsets),
    volume: b.closed ? Math.abs(signedVolume(m)) : 0,
    area,
    bbox: { min, max },
    faceCount: faces,
    edgeCount: offsets.length - 1,
    solidCount: b.closed ? 1 : 0,
    meshTriangles: nt,
  };
}

// ---------------------------------------------------------------------------
// Booléens et coupe (manifold-3d)
// ---------------------------------------------------------------------------

export function toManifold(wasm: ManifoldToplevel, m: IndexedMesh): Manifold {
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(m.positions), triVerts: new Uint32Array(m.indices) });
  mesh.merge();
  const solid = new wasm.Manifold(mesh);
  const status = solid.status();
  if (status !== 'NoError') {
    solid.delete();
    throw new Error(`Corps maillé non étanche ou auto-sécant (${status}) : opération impossible.`);
  }
  return solid;
}

export function fromManifold(r: Manifold): MeshBody {
  const out = r.getMesh();
  const positions = new Float64Array(out.numVert * 3);
  for (let i = 0; i < out.numVert; i++) for (let k = 0; k < 3; k++) positions[3 * i + k] = out.vertProperties[i * out.numProp + k]!;
  const { mesh } = cleanMesh({ positions, indices: new Uint32Array(out.triVerts) });
  return { mesh, closed: true };
}

export function meshBoolean(wasm: ManifoldToplevel, kind: 'union' | 'subtract' | 'intersect', args: IndexedMesh[], tools: IndexedMesh[]): MeshBody {
  const owned: Manifold[] = [];
  const own = (m: Manifold) => (owned.push(m), m);
  try {
    const symmetric = kind !== 'subtract';
    const all = [...args, ...tools].map((m) => own(toManifold(wasm, m)));
    let result: Manifold;
    if (kind === 'union') result = own(wasm.Manifold.union(all));
    else if (kind === 'intersect') result = all.slice(1).reduce((acc, m) => own(acc.intersect(m)), all[0]!);
    else {
      const a = symmetric ? all : all.slice(0, args.length);
      const target = a.length > 1 ? own(wasm.Manifold.union(a)) : a[0]!;
      const cutters = all.slice(args.length);
      result = cutters.length ? own(target.subtract(cutters.length > 1 ? own(wasm.Manifold.union(cutters)) : cutters[0]!)) : target;
    }
    if (result.isEmpty()) throw new Error(kind === 'intersect' ? 'Les solides ne se recoupent pas.' : 'Le résultat est vide.');
    return fromManifold(result);
  } finally {
    for (const m of new Set(owned)) m.delete();
  }
}

/** Coupe par un plan : morceau côté normale puis côté opposé (vides omis). */
export function meshSlice(wasm: ManifoldToplevel, m: IndexedMesh, origin: { x: number; y: number; z: number }, normal: { x: number; y: number; z: number }): [MeshBody | null, MeshBody | null] {
  const l = Math.hypot(normal.x, normal.y, normal.z);
  const n: [number, number, number] = [normal.x / l, normal.y / l, normal.z / l];
  const offset = n[0] * origin.x + n[1] * origin.y + n[2] * origin.z;
  const src = toManifold(wasm, m);
  const [pos, neg] = src.splitByPlane(n, offset);
  try {
    return [pos.isEmpty() ? null : fromManifold(pos), neg.isEmpty() ? null : fromManifold(neg)];
  } finally {
    src.delete(), pos.delete(), neg.delete();
  }
}

// ---------------------------------------------------------------------------
// Enregistrement (dans le .xcad, à la place du BREP)
// ---------------------------------------------------------------------------

const MAGIC = [0x53, 0x43, 0x4d, 0x45, 0x53, 0x48, 0x31, 0x00]; // « SCMESH1\0 »

export function isMeshData(d: Uint8Array): boolean {
  return d.length >= 16 && MAGIC.every((b, i) => d[i] === b);
}

export function saveMeshBody(b: MeshBody): Uint8Array {
  const nv = b.mesh.positions.length / 3, nt = b.mesh.indices.length / 3;
  const out = new Uint8Array(16 + nv * 24 + nt * 12);
  out.set(MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(8, nv, true);
  dv.setUint32(12, (nt & 0x7fffffff) | (b.closed ? 0x80000000 : 0), true);
  new Float64Array(out.buffer, 16, nv * 3).set(b.mesh.positions);
  new Uint8Array(out.buffer, 16 + nv * 24, nt * 12).set(new Uint8Array(b.mesh.indices.buffer, b.mesh.indices.byteOffset, nt * 12));
  return out;
}

export function loadMeshBody(d: Uint8Array): MeshBody {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const nv = dv.getUint32(8, true), w = dv.getUint32(12, true);
  const nt = w & 0x7fffffff;
  const copy = d.slice(16); // alignement des tableaux typés
  return {
    mesh: { positions: new Float64Array(copy.buffer, 0, nv * 3).slice(), indices: new Uint32Array(copy.buffer.slice(nv * 24, nv * 24 + nt * 12)) },
    closed: (w & 0x80000000) !== 0,
  };
}
