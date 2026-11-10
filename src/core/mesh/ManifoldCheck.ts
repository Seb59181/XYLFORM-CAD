/**
 * Vérification et réparation topologique d'un maillage avant impression 3D.
 *
 * Un maillage est imprimable (« watertight ») si :
 *   - chaque arête est partagée par exactement 2 triangles (pas de bord, pas d'arête en T) ;
 *   - chaque sommet a un voisinage en disque (pas de sommet « nœud papillon ») ;
 *   - les deux triangles d'une arête la parcourent en sens opposés (orientation cohérente) ;
 *   - chaque coque externe a un volume signé positif, chaque cavité un volume négatif.
 *
 * `repairOrientation` corrige les deux derniers points (inversion des normales retournées),
 * y compris pour les cavités internes (coques imbriquées, détectées par lancer de rayon).
 */
import { signedVolume, triangleCount, type IndexedMesh } from './IndexedMesh';

export interface ManifoldReport {
  vertices: number;
  triangles: number;
  edges: number;
  /** Arêtes n'appartenant qu'à un triangle (trous). */
  boundaryEdges: number;
  /** Arêtes partagées par plus de 2 triangles. */
  nonManifoldEdges: number;
  /** Arêtes à 2 triangles parcourues dans le même sens (normales incohérentes). */
  inconsistentEdges: number;
  /** Sommets dont le voisinage n'est pas un disque unique. */
  nonManifoldVertices: number;
  /** Composantes connexes (coques). */
  shells: number;
  /** Caractéristique d'Euler V − E + F (2 par coque fermée de genre 0). */
  eulerCharacteristic: number;
  /** Genre total (nombre de « trous de tore »), valable si fermé et manifold. */
  genus: number | null;
  volume: number;
  isManifold: boolean;
  isOriented: boolean;
  isWatertight: boolean;
}

interface EdgeInfo {
  /** triangles incidents */
  tris: number[];
  /** nombre de parcours dans le sens a→b avec a<b */
  forward: number;
}

/** Clé d'arête non orientée, exacte tant que nv² < 2^53 (≈ 94 millions de sommets). */
const edgeKey = (a: number, b: number, nv: number) => (a < b ? a * nv + b : b * nv + a);

function buildEdges(m: IndexedMesh): Map<number, EdgeInfo> {
  const edges = new Map<number, EdgeInfo>();
  const ix = m.indices;
  const nv = m.positions.length / 3;
  for (let t = 0; t < ix.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const a = ix[3 * t + k]!, b = ix[3 * t + ((k + 1) % 3)]!;
      const key = edgeKey(a, b, nv);
      let e = edges.get(key);
      if (!e) edges.set(key, (e = { tris: [], forward: 0 }));
      e.tris.push(t);
      if (a < b) e.forward++;
    }
  }
  return edges;
}

/** Union-find sur les triangles reliés par une arête manifold. */
function shellsOf(m: IndexedMesh, edges: Map<number, EdgeInfo>): number[][] {
  const n = triangleCount(m);
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  for (const e of edges.values()) {
    for (let i = 1; i < e.tris.length; i++) {
      const ra = find(e.tris[0]!), rb = find(e.tris[i]!);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < n; t++) {
    const r = find(t);
    const g = groups.get(r);
    if (g) g.push(t);
    else groups.set(r, [t]);
  }
  return [...groups.values()];
}

function countNonManifoldVertices(m: IndexedMesh): number {
  // Pour chaque sommet, on relie les triangles incidents qui partagent une arête contenant
  // ce sommet ; plus d'un groupe = deux cônes qui se touchent en un point.
  const ix = m.indices;
  const nv = m.positions.length / 3;
  const incident: number[][] = Array.from({ length: nv }, () => []);
  for (let t = 0; t < ix.length / 3; t++) for (let k = 0; k < 3; k++) incident[ix[3 * t + k]!]!.push(t);

  let bad = 0;
  for (let v = 0; v < nv; v++) {
    const tris = incident[v]!;
    if (tris.length < 2) continue;
    // arêtes "rayons" v–w : relient les triangles qui les partagent
    const spoke = new Map<number, number[]>();
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const w = ix[3 * t + k]!;
        if (w === v) continue;
        const list = spoke.get(w);
        if (list) list.push(t);
        else spoke.set(w, [t]);
      }
    }
    const parent = new Map<number, number>(tris.map((t) => [t, t]));
    const find = (i: number): number => {
      while (parent.get(i) !== i) i = parent.get(i)!;
      return i;
    };
    for (const list of spoke.values()) for (let i = 1; i < list.length; i++) parent.set(find(list[0]!), find(list[i]!));
    const roots = new Set(tris.map(find));
    if (roots.size > 1) bad++;
  }
  return bad;
}

export function checkManifold(m: IndexedMesh): ManifoldReport {
  const edges = buildEdges(m);
  let boundary = 0, nonManifold = 0, inconsistent = 0;
  for (const e of edges.values()) {
    if (e.tris.length === 1) boundary++;
    else if (e.tris.length > 2) nonManifold++;
    else if (e.forward !== 1) inconsistent++;
  }
  const nonManifoldVertices = countNonManifoldVertices(m);
  const shells = shellsOf(m, edges).length;
  const V = new Set(m.indices).size;
  const E = edges.size;
  const F = triangleCount(m);
  const chi = V - E + F;
  const isManifold = boundary === 0 && nonManifold === 0 && nonManifoldVertices === 0;
  const isOriented = inconsistent === 0;
  return {
    vertices: V,
    triangles: F,
    edges: E,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    inconsistentEdges: inconsistent,
    nonManifoldVertices,
    shells,
    eulerCharacteristic: chi,
    genus: isManifold ? (2 * shells - chi) / 2 : null,
    volume: signedVolume(m),
    isManifold,
    isOriented,
    isWatertight: isManifold && isOriented && F > 0,
  };
}

export interface OrientationRepair {
  mesh: IndexedMesh;
  flippedTriangles: number;
  flippedShells: number;
}

/**
 * Rend l'orientation cohérente (parcours en largeur sur chaque coque) puis oriente
 * chaque coque vers l'extérieur : profondeur d'imbrication paire → volume positif,
 * impaire (cavité) → volume négatif. Nécessite un maillage manifold.
 */
export function repairOrientation(input: IndexedMesh): OrientationRepair {
  const ix = new Uint32Array(input.indices);
  const m: IndexedMesh = { positions: input.positions, indices: ix };
  const edges = buildEdges(m);
  const n = triangleCount(m);
  const nv = m.positions.length / 3;
  const visited = new Uint8Array(n);
  let flipped = 0;

  const flip = (t: number) => {
    const b = ix[3 * t + 1]!;
    ix[3 * t + 1] = ix[3 * t + 2]!;
    ix[3 * t + 2] = b;
  };
  /** +1 si le triangle t parcourt l'arête (a,b) dans le sens a→b, -1 sinon. */
  const dirIn = (t: number, a: number, b: number) => {
    for (let k = 0; k < 3; k++) {
      if (ix[3 * t + k] === a && ix[3 * t + ((k + 1) % 3)] === b) return 1;
      if (ix[3 * t + k] === b && ix[3 * t + ((k + 1) % 3)] === a) return -1;
    }
    return 0;
  };

  for (let seed = 0; seed < n; seed++) {
    if (visited[seed]) continue;
    visited[seed] = 1;
    const queue = [seed];
    while (queue.length) {
      const t = queue.pop()!;
      for (let k = 0; k < 3; k++) {
        const a = ix[3 * t + k]!, b = ix[3 * t + ((k + 1) % 3)]!;
        const e = edges.get(edgeKey(a, b, nv))!;
        if (e.tris.length !== 2) continue;
        const u = e.tris[0] === t ? e.tris[1]! : e.tris[0]!;
        if (visited[u]) continue;
        // le voisin doit parcourir l'arête en sens inverse
        if (dirIn(u, a, b) === 1) {
          flip(u);
          flipped++;
        }
        visited[u] = 1;
        queue.push(u);
      }
    }
  }

  // Orientation globale de chaque coque
  const shells = shellsOf(m, edges);
  let flippedShells = 0;
  for (const shell of shells) {
    const depth = nestingDepth(m, shell, shells);
    const vol = signedVolume(m, shell);
    const wantPositive = depth % 2 === 0;
    if ((vol < 0 && wantPositive) || (vol > 0 && !wantPositive)) {
      for (const t of shell) flip(t);
      flipped += shell.length;
      flippedShells++;
    }
  }
  return { mesh: m, flippedTriangles: flipped, flippedShells };
}

/** Nombre de coques qui contiennent `shell` (parité du nombre d'intersections d'un rayon). */
function nestingDepth(m: IndexedMesh, shell: number[], shells: number[][]): number {
  const ix = m.indices;
  const p = m.positions;
  const t0 = shell[0]!;
  // point d'essai : centre du premier triangle de la coque
  const o = [0, 1, 2].map((k) => (p[3 * ix[3 * t0]! + k]! + p[3 * ix[3 * t0 + 1]! + k]! + p[3 * ix[3 * t0 + 2]! + k]!) / 3) as [
    number,
    number,
    number,
  ];
  // direction "irrationnelle" pour éviter de passer exactement par une arête
  const d: [number, number, number] = [0.5773502691896258, 0.5773502691896257 + 1e-4, 0.5773502691896259 - 2e-4];
  let depth = 0;
  for (const other of shells) {
    if (other === shell) continue;
    let hits = 0;
    for (const t of other) if (rayHits(o, d, p, ix, t)) hits++;
    if (hits % 2 === 1) depth++;
  }
  return depth;
}

/** Möller–Trumbore, t > 0. */
function rayHits(o: number[], d: number[], p: Float64Array, ix: Uint32Array, t: number): boolean {
  const a = 3 * ix[3 * t]!, b = 3 * ix[3 * t + 1]!, c = 3 * ix[3 * t + 2]!;
  const e1 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
  const e2 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
  const h = [d[1]! * e2[2]! - d[2]! * e2[1]!, d[2]! * e2[0]! - d[0]! * e2[2]!, d[0]! * e2[1]! - d[1]! * e2[0]!];
  const det = e1[0]! * h[0]! + e1[1]! * h[1]! + e1[2]! * h[2]!;
  if (Math.abs(det) < 1e-18) return false;
  const f = 1 / det;
  const s = [o[0]! - p[a]!, o[1]! - p[a + 1]!, o[2]! - p[a + 2]!];
  const u = f * (s[0]! * h[0]! + s[1]! * h[1]! + s[2]! * h[2]!);
  if (u < 0 || u > 1) return false;
  const q = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
  const v = f * (d[0]! * q[0]! + d[1]! * q[1]! + d[2]! * q[2]!);
  if (v < 0 || u + v > 1) return false;
  return f * (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) > 1e-12;
}

export class NonManifoldError extends Error {
  constructor(readonly report: ManifoldReport) {
    super(
      `Maillage non étanche : ${report.boundaryEdges} arête(s) de bord, ${report.nonManifoldEdges} arête(s) non-manifold, ` +
        `${report.nonManifoldVertices} sommet(s) non-manifold.`,
    );
    this.name = 'NonManifoldError';
  }
}
