/**
 * Lecture des maillages d'impression 3D : STL (binaire ou texte) et 3MF (paquet ZIP + XML).
 *
 * Le résultat est un maillage indexé soudé et réorienté (normales sortantes), prêt à être
 * converti en solide B-rep par le noyau (op `meshToSolid`), ce qui le rend modifiable comme
 * n'importe quel solide du dessin (déplacer, booléens, coupe, appuyer/tirer sur les faces planes…).
 */
import { strFromU8, unzipSync } from 'fflate';
import type { IndexedMesh } from '../core/mesh/IndexedMesh';
import { cleanMesh } from '../core/mesh/MeshCleaner';
import { checkManifold, repairOrientation } from '../core/mesh/ManifoldCheck';

export interface ImportedMesh {
  name: string;
  mesh: IndexedMesh;
  /** Couleur sRGB (#RRGGBB) lue dans le 3MF. */
  color?: string;
  /** Maillage fermé (étanche) : devient un solide, sinon une surface. */
  closed: boolean;
  triangles: number;
  warnings: string[];
}

/** Facteur vers le millimètre des unités 3MF. */
const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, meter: 1000, inch: 25.4, foot: 304.8 };

export function isMeshFile(name: string): boolean {
  return /\.(stl|3mf)$/i.test(name);
}

/** Lit un fichier STL ou 3MF : un maillage par objet. `scale` : facteur vers le mm (STL : unité supposée). */
export function readMeshFile(name: string, bytes: Uint8Array, scale = 1): ImportedMesh[] {
  const base = name.replace(/\.[^.]+$/, '').replace(/^.*[\\/]/, '');
  if (/\.3mf$/i.test(name)) return readThreeMf(bytes, base);
  return [finalize(base, readStl(bytes), scale)];
}

// ---------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------

/** Triangles bruts (non soudés) d'un STL binaire ou texte. */
export function readStl(bytes: Uint8Array): IndexedMesh {
  if (isBinaryStl(bytes)) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = dv.getUint32(80, true);
    const positions = new Float64Array(n * 9);
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12; // normale ignorée (recalculée)
      for (let k = 0; k < 9; k++) positions[t * 9 + k] = dv.getFloat32(o + 4 * k, true);
    }
    return { positions, indices: Uint32Array.from({ length: n * 3 }, (_, i) => i) };
  }
  const text = strFromU8(bytes);
  const coords: number[] = [];
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) coords.push(+m[1]!, +m[2]!, +m[3]!);
  if (coords.length < 9) throw new Error('Fichier STL vide ou illisible.');
  const n = Math.floor(coords.length / 9);
  return { positions: Float64Array.from(coords.slice(0, n * 9)), indices: Uint32Array.from({ length: n * 3 }, (_, i) => i) };
}

function isBinaryStl(b: Uint8Array): boolean {
  if (b.length < 84) return false;
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
  if (84 + n * 50 === b.length) return true;
  // texte : commence par « solid » et contient « facet »
  const head = strFromU8(b.subarray(0, Math.min(b.length, 512)));
  return !(/^\s*solid/i.test(head) && /facet|endsolid/i.test(head + strFromU8(b.subarray(Math.max(0, b.length - 256)))));
}

// ---------------------------------------------------------------------------
// 3MF
// ---------------------------------------------------------------------------

interface MfObject {
  id: string;
  name?: string;
  mesh?: IndexedMesh;
  color?: string;
  components: { id: string; m: number[] }[];
}

const attr = (tag: string, a: string): string | undefined => new RegExp(`\\s${a}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];

function parseMatrix(s: string | undefined): number[] {
  if (!s) return [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
  const v = s.trim().split(/\s+/).map(Number);
  return v.length === 12 && v.every(Number.isFinite) ? v : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
}

/** Composition de matrices 3MF (vecteur ligne : p' = p·A puis ·B) → A puis B. */
function compose(a: number[], b: number[]): number[] {
  const r = new Array<number>(12);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]! + (i === 3 ? b[9 + j]! : 0);
    }
  return r;
}

function transformMesh(m: IndexedMesh, t: number[], scale: number): IndexedMesh {
  const p = m.positions, out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    for (let j = 0; j < 3; j++) out[i + j] = (x * t[j]! + y * t[3 + j]! + z * t[6 + j]! + t[9 + j]!) * scale;
  }
  // matrice à déterminant négatif (miroir) : on garde l'orientation des triangles
  const det = t[0]! * (t[4]! * t[8]! - t[5]! * t[7]!) - t[1]! * (t[3]! * t[8]! - t[5]! * t[6]!) + t[2]! * (t[3]! * t[7]! - t[4]! * t[6]!);
  if (det >= 0) return { positions: out, indices: m.indices };
  const ix = Uint32Array.from(m.indices);
  for (let i = 0; i < ix.length; i += 3) [ix[i + 1], ix[i + 2]] = [ix[i + 2]!, ix[i + 1]!];
  return { positions: out, indices: ix };
}

function srgb(c: string | undefined): string | undefined {
  const m = c && /^#([0-9a-f]{6})/i.exec(c);
  return m ? `#${m[1]!.toUpperCase()}` : undefined;
}

export function readThreeMf(bytes: Uint8Array, baseName = 'Objet'): ImportedMesh[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('Fichier 3MF illisible (archive ZIP invalide).');
  }
  const modelPath = Object.keys(files).find((k) => /^\/?3D\/[^/]+\.model$/i.test(k)) ?? Object.keys(files).find((k) => /\.model$/i.test(k));
  if (!modelPath) throw new Error('Fichier 3MF sans modèle 3D.');
  const xml = strFromU8(files[modelPath]!);
  const unit = attr(/<model\b[^>]*>/.exec(xml)?.[0] ?? '', 'unit') ?? 'millimeter';
  const scale = UNIT_MM[unit] ?? 1;

  // couleurs : basematerials et colorgroup
  const palette = new Map<string, string[]>();
  for (const g of xml.matchAll(/<(?:\w+:)?(basematerials|colorgroup)\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?\1>/g)) {
    const id = attr(g[2]!, 'id');
    if (!id) continue;
    const cols = [...g[3]!.matchAll(/<(?:\w+:)?(?:base|color)\b([^>]*)\/?>/g)].map((m) => srgb(attr(m[1]!, 'displaycolor') ?? attr(m[1]!, 'color')) ?? '');
    palette.set(id, cols);
  }

  const objects = new Map<string, MfObject>();
  for (const o of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
    const head = o[1]!, body = o[2]!;
    const id = attr(head, 'id');
    if (!id) continue;
    const pid = attr(head, 'pid'), pindex = Number(attr(head, 'pindex') ?? 0);
    const obj: MfObject = { id, name: attr(head, 'name'), components: [], color: pid ? palette.get(pid)?.[pindex] || undefined : undefined };
    const vtx = /<vertices>([\s\S]*?)<\/vertices>/.exec(body);
    if (vtx) {
      const coords: number[] = [];
      for (const v of vtx[1]!.matchAll(/<vertex\b([^>]*)\/?>/g)) coords.push(Number(attr(v[1]!, 'x')), Number(attr(v[1]!, 'y')), Number(attr(v[1]!, 'z')));
      const idx: number[] = [];
      const tri = /<triangles>([\s\S]*?)<\/triangles>/.exec(body);
      for (const t of tri?.[1]!.matchAll(/<triangle\b([^>]*)\/?>/g) ?? []) idx.push(Number(attr(t[1]!, 'v1')), Number(attr(t[1]!, 'v2')), Number(attr(t[1]!, 'v3')));
      if (!obj.color) {
        const t0 = /<triangle\b([^>]*)\/?>/.exec(tri?.[1] ?? '');
        const tp = t0 && attr(t0[1]!, 'pid');
        if (tp) obj.color = palette.get(tp)?.[Number(attr(t0[1]!, 'p1') ?? 0)] || undefined;
      }
      obj.mesh = { positions: Float64Array.from(coords), indices: Uint32Array.from(idx) };
    }
    for (const c of body.matchAll(/<component\b([^>]*)\/?>/g)) {
      const oid = attr(c[1]!, 'objectid');
      if (oid) obj.components.push({ id: oid, m: parseMatrix(attr(c[1]!, 'transform')) });
    }
    objects.set(id, obj);
  }

  // aplatit les composants récursivement
  const flatten = (id: string, m: number[], depth = 0): { mesh: IndexedMesh; color?: string }[] => {
    const o = objects.get(id);
    if (!o || depth > 16) return [];
    const out: { mesh: IndexedMesh; color?: string }[] = [];
    if (o.mesh && o.mesh.indices.length) out.push({ mesh: transformMesh(o.mesh, m, 1), color: o.color });
    for (const c of o.components) out.push(...flatten(c.id, compose(c.m, m), depth + 1).map((p) => ({ ...p, color: p.color ?? o.color })));
    return out;
  };

  const result: ImportedMesh[] = [];
  const items = [...xml.matchAll(/<item\b([^>]*)\/?>/g)].map((m) => ({ id: attr(m[1]!, 'objectid')!, m: parseMatrix(attr(m[1]!, 'transform')) }));
  const roots = items.length ? items : [...objects.values()].filter((o) => o.mesh).map((o) => ({ id: o.id, m: parseMatrix(undefined) }));
  roots.forEach((it, i) => {
    const parts = flatten(it.id, it.m);
    if (!parts.length) return;
    const o = objects.get(it.id)!;
    const name = o.name || (roots.length > 1 ? `${baseName} ${i + 1}` : baseName);
    // les composants d'un même objet forment autant de corps (pièces d'un assemblage imprimé)
    parts.forEach((p, k) => result.push({ ...finalize(parts.length > 1 ? `${name} ${k + 1}` : name, p.mesh, scale), color: p.color }));
  });
  if (!result.length) throw new Error('Le fichier 3MF ne contient aucun maillage.');
  return result;
}

// ---------------------------------------------------------------------------

/** Soudure, retrait des triangles dégénérés, réorientation et mise à l'échelle. */
function finalize(name: string, raw: IndexedMesh, scale: number): ImportedMesh {
  const warnings: string[] = [];
  let m = raw;
  if (scale !== 1) m = { positions: raw.positions.map((v) => v * scale), indices: raw.indices };
  const { mesh: cleaned } = cleanMesh(m);
  if (!cleaned.indices.length) throw new Error(`« ${name} » : aucun triangle valide.`);
  let mesh = cleaned;
  let report = checkManifold(mesh);
  if (report.isManifold) {
    const fixed = repairOrientation(mesh);
    if (fixed.flippedTriangles) warnings.push(`${fixed.flippedTriangles} triangle(s) réorienté(s).`);
    mesh = fixed.mesh;
    report = checkManifold(mesh);
  }
  const closed = report.isWatertight && report.isManifold;
  if (!closed) warnings.push('Maillage non étanche : importé comme surface (EPAISSIR pour en faire un solide).');
  return { name, mesh, closed, triangles: mesh.indices.length / 3, warnings };
}
