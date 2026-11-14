/**
 * DXF : lecture (R12 à 2018 : LINE, CIRCLE, ARC, LWPOLYLINE, POLYLINE, POINT, TEXT, MTEXT,
 * ELLIPSE, SPLINE, HATCH, SOLID, 3DFACE, INSERT/blocs, DIMENSION via leur bloc, calques et couleurs)
 * et écriture au format R12 (AC1009), lu par tous les logiciels de CAO.
 *
 * Les solides 3D sont écrits en 3DFACE (maillage) : le B-rep exact s'échange en STEP.
 */
import { LINETYPE_IDS, LINETYPES, linetypeFromDxf } from '../core/linetypes';
import type { Vec3 } from '../core/commands/types';
import type { Entity, HatchPattern, LayerDef, NewEntity, TextAlign, TextVAlign } from '../core/document/Document';
import { dimensionGeometry, dimensionLabel, ellipsePoints, hatchSegments, splineFit, splinePoints, textLayout, textWidth, transformEntity } from '../core/entities/geometry';
import { polylineSamples } from '../core/entities/bulge';
import { multiply, rotationZ, scaling, translation, type Affine } from '../core/math/affine';
import { aciToHex, hexToAci, trueColorToHex } from './aci';

// ===========================================================================
// Lecture
// ===========================================================================

interface Pair {
  code: number;
  value: string;
}

export interface DxfImport {
  entities: NewEntity[];
  layers: LayerDef[];
  skipped: Record<string, number>;
  insunits: number;
}

function pairsOf(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i]!.trim(), 10);
    if (Number.isNaN(code)) {
      i -= 1; // ligne parasite : on se resynchronise
      continue;
    }
    out.push({ code, value: lines[i + 1]!.trim() });
  }
  return out;
}

/** Groupe d'une entité : paires jusqu'au prochain code 0. */
interface Raw {
  type: string;
  pairs: Pair[];
}

function f(r: Raw, code: number, dflt = 0): number {
  const p = r.pairs.find((q) => q.code === code);
  return p ? parseFloat(p.value) : dflt;
}

function s(r: Raw, code: number, dflt = ''): string {
  return r.pairs.find((q) => q.code === code)?.value ?? dflt;
}

function all(r: Raw, code: number): number[] {
  return r.pairs.filter((q) => q.code === code).map((q) => parseFloat(q.value));
}

const P = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

function colorOf(r: Raw): string | undefined {
  const tc = r.pairs.find((q) => q.code === 420);
  if (tc) return trueColorToHex(parseInt(tc.value, 10));
  const aci = r.pairs.find((q) => q.code === 62);
  if (!aci) return undefined;
  const v = parseInt(aci.value, 10);
  if (v === 256 || v === 0) return undefined; // DuCalque / DuBloc
  return aciToHex(v);
}

function splitEntities(pairs: Pair[], start: number, end: number): Raw[] {
  const out: Raw[] = [];
  let cur: Raw | null = null;
  for (let i = start; i < end; i++) {
    const p = pairs[i]!;
    if (p.code === 0) {
      cur = { type: p.value, pairs: [] };
      out.push(cur);
    } else cur?.pairs.push(p);
  }
  return out;
}

/** Évaluation d'une B-spline (de Boor), rationnelle si des poids sont fournis. */
function bspline(ctrl: Vec3[], knots: number[], degree: number, weights: number[] | null, samples: number): Vec3[] {
  const n = ctrl.length;
  if (n < 2 || knots.length < n + degree + 1) return ctrl;
  const lo = knots[degree]!, hi = knots[n]!;
  const out: Vec3[] = [];
  for (let k = 0; k <= samples; k++) {
    const u = lo + ((hi - lo) * k) / samples;
    let span = degree;
    while (span < n - 1 && u >= knots[span + 1]!) span++;
    const d: { x: number; y: number; z: number; w: number }[] = [];
    for (let j = 0; j <= degree; j++) {
      const c = ctrl[span - degree + j]!;
      const w = weights?.[span - degree + j] ?? 1;
      d.push({ x: c.x * w, y: c.y * w, z: c.z * w, w });
    }
    for (let r = 1; r <= degree; r++)
      for (let j = degree; j >= r; j--) {
        const i = span - degree + j;
        const den = knots[i + degree - r + 1]! - knots[i]!;
        const a = den === 0 ? 0 : (u - knots[i]!) / den;
        const A = d[j - 1]!, B = d[j]!;
        d[j] = { x: (1 - a) * A.x + a * B.x, y: (1 - a) * A.y + a * B.y, z: (1 - a) * A.z + a * B.z, w: (1 - a) * A.w + a * B.w };
      }
    const q = d[degree]!;
    out.push({ x: q.x / q.w, y: q.y / q.w, z: q.z / q.w });
  }
  return out;
}

function hatchFromRaw(r: Raw, layer: string, color?: string): NewEntity | null {
  const pairs = r.pairs;
  let i = pairs.findIndex((p) => p.code === 91);
  if (i < 0) return null;
  const nPaths = parseInt(pairs[i]!.value, 10);
  i++;
  const loops: Vec3[][] = [];
  const num = () => parseFloat(pairs[i++]!.value);
  const expect = (code: number) => {
    while (i < pairs.length && pairs[i]!.code !== code) i++;
  };
  const z = f(r, 30);
  for (let pIdx = 0; pIdx < nPaths && i < pairs.length; pIdx++) {
    expect(92);
    const flags = parseInt(pairs[i++]!.value, 10);
    const pts: Vec3[] = [];
    if (flags & 2) {
      // polyligne
      expect(72);
      const hasBulge = parseInt(pairs[i++]!.value, 10) !== 0;
      expect(73);
      i++;
      expect(93);
      const n = parseInt(pairs[i++]!.value, 10);
      const verts: Vec3[] = [];
      const bulges: number[] = [];
      for (let k = 0; k < n; k++) {
        expect(10);
        const x = num();
        const y = num();
        verts.push(P(x, y, z));
        if (hasBulge && pairs[i]?.code === 42) bulges.push(num());
        else bulges.push(0);
      }
      pts.push(...polylineSamples(verts, true, bulges).pts.slice(0, -1));
    } else {
      expect(93);
      const nEdges = parseInt(pairs[i++]!.value, 10);
      for (let k = 0; k < nEdges; k++) {
        expect(72);
        const type = parseInt(pairs[i++]!.value, 10);
        if (type === 1) {
          expect(10);
          const x1 = num(), y1 = num();
          expect(11);
          const x2 = num(), y2 = num();
          pts.push(P(x1, y1, z), P(x2, y2, z));
        } else if (type === 2) {
          expect(10);
          const cx = num(), cy = num();
          expect(40);
          const rad = num();
          const a0 = num(), a1 = num();
          const ccw = pairs[i]?.code === 73 ? num() !== 0 : true;
          let sweep = ((a1 - a0) * Math.PI) / 180;
          if (sweep <= 0) sweep += Math.PI * 2;
          const n = Math.max(8, Math.ceil((sweep / (2 * Math.PI)) * 64));
          for (let q = 0; q <= n; q++) {
            const a = ((ccw ? a0 : -a0) * Math.PI) / 180 + ((ccw ? 1 : -1) * sweep * q) / n;
            pts.push(P(cx + rad * Math.cos(a), cy + rad * Math.sin(a), z));
          }
        } else if (type === 3) {
          expect(10);
          const cx = num(), cy = num();
          expect(11);
          const mx = num(), my = num();
          expect(40);
          const ratio = num();
          const t0 = (num() * Math.PI) / 180, t1 = (num() * Math.PI) / 180;
          pts.push(...ellipsePoints(P(cx, cy, z), P(mx, my), ratio, 48, t0, t1 <= t0 ? t1 + 2 * Math.PI : t1));
        } else if (type === 4) {
          // spline : on lit les points de contrôle
          expect(94);
          const degree = parseInt(pairs[i++]!.value, 10);
          expect(95);
          const nk = parseInt(pairs[i++]!.value, 10);
          const nc = parseInt(pairs[i++]!.value, 10);
          const knots: number[] = [];
          for (let q = 0; q < nk; q++) expect(40), knots.push(num());
          const ctrl: Vec3[] = [];
          for (let q = 0; q < nc; q++) {
            expect(10);
            ctrl.push(P(num(), num(), z));
          }
          pts.push(...bspline(ctrl, knots, degree, null, Math.max(16, nc * 8)));
        }
      }
    }
    const clean = pts.filter((p, k) => k === 0 || Math.hypot(p.x - pts[k - 1]!.x, p.y - pts[k - 1]!.y) > 1e-9);
    if (clean.length >= 3) loops.push(clean);
  }
  if (!loops.length) return null;
  const name = s(r, 2, 'SOLID').toUpperCase();
  const solid = f(r, 70) === 1;
  const gradient = r.pairs.some((p) => p.code === 450 && p.value.trim() === '1');
  const pattern: HatchPattern = gradient ? 'GRADIENT' : solid || name === 'SOLID' ? 'SOLID' : name === 'ANSI37' ? 'ANSI37' : name === 'NET' ? 'NET' : 'ANSI31';
  return {
    type: 'HATCH',
    boundaries: loops,
    pattern,
    scale: f(r, 41, 1) || 1,
    angle: (f(r, 52) * Math.PI) / 180,
    layer,
    color,
    color2: gradient ? '#1d3557' : undefined,
  };
}

function convert(r: Raw, blocks: Map<string, { base: Vec3; raws: Raw[] }>, depth: number, skipped: Record<string, number>): NewEntity[] {
  const layer = s(r, 8, '0');
  const color = colorOf(r);
  const base = { layer, color };
  const z = f(r, 30);
  switch (r.type) {
    case 'LINE':
      return [{ ...base, type: 'LINE', start: P(f(r, 10), f(r, 20), f(r, 30)), end: P(f(r, 11), f(r, 21), f(r, 31)) }];
    case 'CIRCLE':
      return [{ ...base, type: 'CIRCLE', center: P(f(r, 10), f(r, 20), z), radius: f(r, 40) }];
    case 'ARC':
      return [{ ...base, type: 'ARC', center: P(f(r, 10), f(r, 20), z), radius: f(r, 40), startAngle: (f(r, 50) * Math.PI) / 180, endAngle: (f(r, 51) * Math.PI) / 180 }];
    case 'POINT':
      return [{ ...base, type: 'POINT', position: P(f(r, 10), f(r, 20), z) }];
    case 'SOLID':
    case 'TRACE': {
      // remplissage 2D : sommets dans l'ordre 1, 2, 4, 3
      const q = [P(f(r, 10), f(r, 20), z), P(f(r, 11), f(r, 21), z), P(f(r, 13, f(r, 12)), f(r, 23, f(r, 22)), z), P(f(r, 12), f(r, 22), z)];
      const loop = q.filter((p, i) => i === 0 || Math.hypot(p.x - q[i - 1]!.x, p.y - q[i - 1]!.y) > 1e-12);
      return loop.length >= 3 ? [{ ...base, type: 'HATCH', boundaries: [loop], pattern: 'SOLID', scale: 1, angle: 0 }] : [];
    }
    case '3DFACE': {
      const q = [P(f(r, 10), f(r, 20), f(r, 30)), P(f(r, 11), f(r, 21), f(r, 31)), P(f(r, 12), f(r, 22), f(r, 32)), P(f(r, 13), f(r, 23), f(r, 33))];
      const pts = q.filter((p, i) => i === 0 || Math.hypot(p.x - q[i - 1]!.x, p.y - q[i - 1]!.y, p.z - q[i - 1]!.z) > 1e-12);
      return pts.length >= 3 ? [{ ...base, type: 'POLYLINE', points: pts, closed: true }] : [];
    }
    case 'LWPOLYLINE': {
      const pts: Vec3[] = [];
      const bulges: number[] = [];
      const elev = f(r, 38);
      for (const p of r.pairs) {
        if (p.code === 10) pts.push(P(parseFloat(p.value), 0, elev)), bulges.push(0);
        else if (p.code === 20 && pts.length) pts[pts.length - 1]!.y = parseFloat(p.value);
        else if (p.code === 42 && pts.length) bulges[pts.length - 1] = parseFloat(p.value);
      }
      if (pts.length < 2) return [];
      return [{ ...base, type: 'POLYLINE', points: pts, closed: (f(r, 70) & 1) === 1, bulges: bulges.some((b) => b !== 0) ? bulges : undefined }];
    }
    case 'TEXT':
    case 'ATTRIB': {
      if (r.type === 'ATTRIB' && f(r, 70) & 1) return []; // attribut invisible
      return [{ ...base, ...textFromRaw(r, z) }];
    }
    case 'MTEXT':
      return [{ ...base, ...mtextFromRaw(r, z) }];
    case 'MULTILEADER':
    case 'MLEADER':
      return multileader(r, base);
    case 'IMAGE': {
      // image raster externe : seul son cadre est repris (ATTACHER pour la recharger en fond de plan)
      const o = P(f(r, 10), f(r, 20), z), u = P(f(r, 11), f(r, 21)), v = P(f(r, 12), f(r, 22));
      const w = f(r, 13), h = f(r, 23);
      if (!(w > 0 && h > 0)) return [];
      const at = (a: number, b: number) => P(o.x + u.x * a + v.x * b, o.y + u.y * a + v.y * b, z);
      skipped['IMAGE (cadre seul)'] = (skipped['IMAGE (cadre seul)'] ?? 0) + 1;
      return [{ ...base, type: 'POLYLINE', points: [at(0, 0), at(w, 0), at(w, h), at(0, h)], closed: true }];
    }
    case 'ELLIPSE': {
      const c = P(f(r, 10), f(r, 20), z);
      const major = P(f(r, 11), f(r, 21), 0);
      const ratio = f(r, 40, 1);
      const t0 = f(r, 41, 0), t1 = f(r, 42, Math.PI * 2);
      if (Math.abs(t1 - t0 - Math.PI * 2) < 1e-6 || Math.abs(t1 - t0) < 1e-9) return [{ ...base, type: 'ELLIPSE', center: c, majorAxis: major, ratio }];
      return [{ ...base, type: 'POLYLINE', points: ellipsePoints(c, major, ratio, 64, t0, t1 < t0 ? t1 + Math.PI * 2 : t1), closed: false }];
    }
    case 'SPLINE': {
      const closed = (f(r, 70) & 1) === 1;
      const fit: Vec3[] = [];
      const ctrl: Vec3[] = [];
      let curFit: Vec3 | null = null, curCtrl: Vec3 | null = null;
      for (const p of r.pairs) {
        const v = parseFloat(p.value);
        if (p.code === 10) ctrl.push((curCtrl = P(v, 0, 0)));
        else if (p.code === 20 && curCtrl) curCtrl.y = v;
        else if (p.code === 30 && curCtrl) curCtrl.z = v;
        else if (p.code === 11) fit.push((curFit = P(v, 0, 0)));
        else if (p.code === 21 && curFit) curFit.y = v;
        else if (p.code === 31 && curFit) curFit.z = v;
      }
      if (fit.length >= 2) return [{ ...base, type: 'SPLINE', fitPoints: fit, closed }];
      const knots = all(r, 40);
      const w = all(r, 41);
      const pts = bspline(ctrl, knots, f(r, 71, 3), w.length === ctrl.length ? w : null, Math.max(32, ctrl.length * 10));
      return pts.length >= 2 ? [{ ...base, type: 'POLYLINE', points: closed ? pts.slice(0, -1) : pts, closed }] : [];
    }
    case 'HATCH': {
      const h = hatchFromRaw(r, layer, color);
      return h ? [h] : [];
    }
    case 'INSERT':
    case 'ACAD_TABLE':
    case 'DIMENSION': {
      if (depth > 8) return [];
      const name = s(r, 2);
      const blk = blocks.get(name);
      if (!blk) {
        skipped[r.type] = (skipped[r.type] ?? 0) + 1;
        return [];
      }
      let m: Affine;
      if (r.type === 'DIMENSION') m = translation({ x: 0, y: 0, z: 0 });
      else {
        const ins = P(f(r, 10), f(r, 20), f(r, 30));
        const sx = f(r, 41, 1), sy = f(r, 42, sx), rot = (f(r, 50) * Math.PI) / 180;
        // échelle non uniforme approchée par sa moyenne (les cercles restent des cercles)
        const sc = (Math.abs(sx) + Math.abs(sy)) / 2;
        m = multiply(translation(ins), multiply(rotationZ(P(0, 0), rot), multiply(scaling(P(0, 0), sc), translation({ x: -blk.base.x, y: -blk.base.y, z: -blk.base.z }))));
        if (sx < 0 !== sy < 0) m = multiply(m, [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
      }
      const out: NewEntity[] = [];
      for (const e of parseEntities(blk.raws, blocks, skipped, depth + 1)) {
        // les points de définition des cotes (calque DEFPOINTS) ne sont pas des objets visibles
        if (r.type === 'DIMENSION' && e.type === 'POINT') continue;
        // calque 0 dans un bloc = calque de l'insertion (règle DXF)
        const ent = { ...e, layer: e.layer === '0' ? layer : e.layer, color: e.color ?? color } as NewEntity;
        out.push({ ...ent, ...transformEntity({ ...ent, handle: '' } as Entity, m) } as NewEntity);
      }
      return out;
    }
    case 'POLYLINE':
      return []; // traité avec ses VERTEX dans parseEntities
    default:
      skipped[r.type] = (skipped[r.type] ?? 0) + 1;
      return [];
  }
}

/** Styles de texte du fichier (table STYLE) : facteur de largeur. */
let textStyles = new Map<string, { widthFactor: number; height: number }>();

const H_ALIGN: TextAlign[] = ['left', 'center', 'right'];

/** TEXT / ATTRIB : justification (codes 72, 73 et second point 11), facteur de largeur. */
function textFromRaw(r: Raw, z: number) {
  const style = textStyles.get(s(r, 7, 'Standard').toUpperCase());
  const text = decodeText(s(r, 1));
  let height = f(r, 40, 0) || style?.height || 2.5;
  let rotation = (f(r, 50) * Math.PI) / 180;
  let widthFactor = f(r, 41, 0) || style?.widthFactor || 1;
  const hj = f(r, 72), vj = f(r, r.type === 'ATTRIB' ? 74 : 73);
  const p10 = P(f(r, 10), f(r, 20), z);
  const has11 = r.pairs.some((q) => q.code === 11);
  const p11 = has11 ? P(f(r, 11), f(r, 21), z) : p10;
  let position = p10, align: TextAlign = 'left', valign: TextVAlign = 'baseline';
  if (hj === 3 || hj === 5) {
    // aligné / ajusté : le texte remplit l'intervalle entre les deux points
    const L = Math.hypot(p11.x - p10.x, p11.y - p10.y);
    if (L > 1e-9) {
      rotation = Math.atan2(p11.y - p10.y, p11.x - p10.x);
      const natural = textWidth(text, height, widthFactor);
      if (hj === 3) height *= L / natural;
      else widthFactor *= L / natural;
    }
  } else if (hj || vj) {
    position = p11;
    if (hj === 4) {
      align = 'center';
      valign = 'middle';
    } else {
      align = H_ALIGN[hj] ?? 'left';
      valign = (['baseline', 'bottom', 'middle', 'top'] as const)[vj] ?? 'baseline';
    }
  }
  return {
    type: 'TEXT' as const,
    position,
    height,
    text,
    rotation,
    ...(align !== 'left' && { align }),
    ...(valign !== 'baseline' && { valign }),
    ...(Math.abs(widthFactor - 1) > 1e-6 && { widthFactor }),
  };
}

/**
 * MTEXT : point d'attache (71 : 1-9 = haut/milieu/bas × gauche/centre/droite), retour à la ligne
 * automatique sur la largeur du cadre (41), interligne (44), hauteur et largeur imposées en ligne.
 */
function mtextFromRaw(r: Raw, z: number) {
  // la partie « Embedded Object » (codes 101 et suivants) répète des codes avec un autre sens
  const cut = r.pairs.findIndex((q) => q.code === 101);
  const own: Raw = cut >= 0 ? { type: r.type, pairs: r.pairs.slice(0, cut) } : r;
  const style = textStyles.get(s(own, 7, 'Standard').toUpperCase());
  const raw = own.pairs.filter((p) => p.code === 3).map((p) => p.value).join('') + s(own, 1);
  let height = f(own, 40, 0) || style?.height || 2.5;
  let widthFactor = style?.widthFactor || 1;
  // hauteur / largeur imposées en tête de texte (\H2.5; \W0.8;), les plus courantes
  const hm = /\\H([0-9.]+)(x?);/.exec(raw);
  if (hm) height = hm[2] ? height * parseFloat(hm[1]!) : parseFloat(hm[1]!) || height;
  const wm = /\\W([0-9.]+);/.exec(raw);
  if (wm) widthFactor = parseFloat(wm[1]!) || widthFactor;
  const has11 = own.pairs.some((p) => p.code === 11);
  const rotation = has11 ? Math.atan2(f(own, 21), f(own, 11, 1)) : f(own, 50); // 50 : radians pour MTEXT
  const attach = Math.min(9, Math.max(1, f(own, 71, 1)));
  const align = H_ALIGN[(attach - 1) % 3]!;
  const valign = (['top', 'middle', 'bottom'] as const)[Math.floor((attach - 1) / 3)]!;
  const box = f(own, 41);
  let lines = decodeMText(raw).split('\n');
  if (box > 0) lines = lines.flatMap((l) => wrapLine(l, box, height, widthFactor));
  const lineSpacing = f(own, 44, 1) || 1;
  return {
    type: 'TEXT' as const,
    position: P(f(own, 10), f(own, 20), z),
    height,
    text: lines.join('\n'),
    rotation,
    ...(align !== 'left' && { align }),
    valign,
    ...(Math.abs(widthFactor - 1) > 1e-6 && { widthFactor }),
    ...(Math.abs(lineSpacing - 1) > 1e-6 && { lineSpacing }),
  };
}

/** Multiligne de repère : texte (contenu MTEXT), lignes de repère, palier et flèche. */
function multileader(r: Raw, base: { layer: string; color?: string }): NewEntity[] {
  const out: NewEntity[] = [];
  const ps = r.pairs;
  const start = ps.findIndex((q) => q.code === 300 && q.value.startsWith('CONTEXT_DATA'));
  if (start < 0) return out;
  const num = (i: number) => parseFloat(ps[i]!.value);
  let scale = 1, arrow = 2.5, textH = 2.5;
  let text: string | null = null, at: Vec3 | null = null, dir = P(1, 0), attach = 1;
  let landing: Vec3 | null = null, dogDir = P(1, 0), dogLen = 0;
  let line: Vec3[] | null = null;
  let depth = 0;
  for (let i = start + 1; i < ps.length; i++) {
    const { code, value } = ps[i]!;
    if (code === 302 && value.startsWith('LEADER{')) (depth = 1), (landing = null), (dogLen = 0);
    else if (code === 304 && value.startsWith('LEADER_LINE{')) (depth = 2), (line = []);
    else if (code === 305 && depth === 2) {
      depth = 1;
      if (line && line.length && landing) {
        const pts = [...line, landing];
        out.push({ ...base, type: 'POLYLINE', points: pts, closed: false });
        // flèche pleine au premier sommet
        const a = pts[0]!, b = pts[1]!;
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        if (L > 1e-9) {
          const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L, s = arrow * scale;
          const q = P(a.x + ux * s, a.y + uy * s, a.z);
          out.push({ ...base, type: 'HATCH', pattern: 'SOLID', scale: 1, angle: 0, boundaries: [[a, P(q.x - uy * s * 0.18, q.y + ux * s * 0.18, a.z), P(q.x + uy * s * 0.18, q.y - ux * s * 0.18, a.z)]] });
        }
      }
      line = null;
    } else if (code === 303 && depth === 1) {
      depth = 0;
      if (landing && dogLen > 0) out.push({ ...base, type: 'LINE', start: landing, end: P(landing.x + dogDir.x * dogLen, landing.y + dogDir.y * dogLen, landing.z) });
    } else if (code === 301 && depth === 0) break;
    else if (depth === 2 && code === 10) line?.push(P(num(i), num(i + 1), ps[i + 2]?.code === 30 ? num(i + 2) : 0));
    else if (depth === 1 && code === 10) landing = P(num(i), num(i + 1), ps[i + 2]?.code === 30 ? num(i + 2) : 0);
    else if (depth === 1 && code === 11) dogDir = P(num(i), num(i + 1));
    else if (depth === 1 && code === 40) dogLen = num(i);
    else if (depth === 0) {
      if (code === 40) scale = num(i) || 1;
      else if (code === 140) arrow = num(i) || arrow;
      else if (code === 41) textH = num(i) || textH;
      else if (code === 304) text = value;
      else if (code === 12) at = P(num(i), num(i + 1), ps[i + 2]?.code === 32 ? num(i + 2) : 0);
      else if (code === 13) dir = P(num(i), num(i + 1));
      else if (code === 171) attach = parseInt(value, 10) || 1;
    }
  }
  if (text && at) {
    attach = Math.min(9, Math.max(1, attach));
    out.push({
      ...base,
      type: 'TEXT',
      position: at,
      height: textH,
      text: decodeMText(text),
      rotation: Math.atan2(dir.y, dir.x),
      ...(attach % 3 !== 1 && { align: H_ALIGN[(attach - 1) % 3] }),
      valign: (['top', 'middle', 'bottom'] as const)[Math.floor((attach - 1) / 3)]!,
    });
  }
  return out;
}

/** Coupe une ligne aux espaces pour tenir dans `width` (mots trop longs laissés entiers). */
function wrapLine(line: string, width: number, height: number, wf: number): string[] {
  if (textWidth(line, height, wf) <= width * 1.02) return [line];
  const out: string[] = [];
  let cur = '';
  for (const word of line.split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (cur && textWidth(next, height, wf) > width * 1.02) {
      out.push(cur);
      cur = word;
    } else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

function decodeText(t: string): string {
  return t.replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeMText(t: string): string {
  return decodeText(t)
    .replace(/\\[PNX]/g, '\n')
    .replace(/\\[ACcFfHhQTWp][^;]*;/g, '')
    .replace(/\\[LlOoKk]/g, '')
    .replace(/\\S([^;^#/]*)[\^#/]([^;]*);/g, (_, a: string, b: string) => (a.trim() && b.trim() ? `${a.trim()}/${b.trim()}` : a.trim() || b.trim()))
    .replace(/[{}]/g, '')
    .replace(/\\~/g, ' ')
    .replace(/\\\\/g, '\\');
}

/** Regroupe POLYLINE/VERTEX/SEQEND puis convertit. */
function parseEntities(raws: Raw[], blocks: Map<string, { base: Vec3; raws: Raw[] }>, skipped: Record<string, number>, depth = 0): NewEntity[] {
  const out: NewEntity[] = [];
  for (let i = 0; i < raws.length; i++) {
    const r = raws[i]!;
    if (r.type === 'POLYLINE') {
      const flags = f(r, 70);
      const verts: Vec3[] = [];
      const bulges: number[] = [];
      let j = i + 1;
      for (; j < raws.length && raws[j]!.type === 'VERTEX'; j++) {
        const v = raws[j]!;
        if (f(v, 70) & 16) continue; // points de contrôle de lissage
        verts.push(P(f(v, 10), f(v, 20), f(v, 30)));
        bulges.push(f(v, 42));
      }
      i = j; // saute SEQEND
      if (flags & (16 | 64)) {
        skipped['MAILLAGE'] = (skipped['MAILLAGE'] ?? 0) + 1;
        continue;
      }
      if (verts.length >= 2)
        out.push({ type: 'POLYLINE', points: verts, closed: (flags & 1) === 1, bulges: bulges.some((b) => b !== 0) ? bulges : undefined, layer: s(r, 8, '0'), color: colorOf(r) });
      continue;
    }
    if (r.type === 'VERTEX' || r.type === 'SEQEND') continue;
    out.push(...convert(r, blocks, depth, skipped));
  }
  return out;
}

export function readDxf(text: string): DxfImport {
  const pairs = pairsOf(text);
  const layers: LayerDef[] = [];
  const blocks = new Map<string, { base: Vec3; raws: Raw[] }>();
  const skipped: Record<string, number> = {};
  let insunits = 4;
  let entities: NewEntity[] = [];
  textStyles = new Map();
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i]!;
    if (p.code !== 0 || p.value !== 'SECTION') continue;
    const name = pairs[i + 1]?.value;
    let end = i + 2;
    while (end < pairs.length && !(pairs[end]!.code === 0 && pairs[end]!.value === 'ENDSEC')) end++;
    if (name === 'HEADER') {
      for (let k = i; k < end; k++) if (pairs[k]!.code === 9 && pairs[k]!.value === '$INSUNITS') insunits = parseInt(pairs[k + 1]!.value, 10) || 4;
    } else if (name === 'TABLES') {
      for (const r of splitEntities(pairs, i + 2, end)) {
        if (r.type === 'STYLE') textStyles.set(s(r, 2).toUpperCase(), { widthFactor: f(r, 41, 1) || 1, height: f(r, 40) });
        if (r.type !== 'LAYER') continue;
        const lname = s(r, 2);
        if (!lname) continue;
        const aci = parseInt(s(r, 62, '7'), 10);
        const tc = r.pairs.find((q) => q.code === 420);
        const lw = f(r, 370, -3);
        const flags = f(r, 70);
        layers.push({
          name: lname,
          color: tc ? trueColorToHex(parseInt(tc.value, 10)) : aciToHex(Math.abs(aci) || 7),
          lineweight: lw > 0 ? lw / 100 : 0.25,
          ...(linetypeFromDxf(s(r, 6)) ? { linetype: linetypeFromDxf(s(r, 6)) } : {}),
          visible: aci >= 0,
          frozen: (flags & 1) === 1,
          locked: (flags & 4) === 4,
        });
      }
    } else if (name === 'BLOCKS') {
      const raws = splitEntities(pairs, i + 2, end);
      let cur: { name: string; base: Vec3; raws: Raw[] } | null = null;
      for (const r of raws) {
        if (r.type === 'BLOCK') cur = { name: s(r, 2), base: P(f(r, 10), f(r, 20), f(r, 30)), raws: [] };
        else if (r.type === 'ENDBLK') {
          if (cur) blocks.set(cur.name, { base: cur.base, raws: cur.raws });
          cur = null;
        } else cur?.raws.push(r);
      }
    } else if (name === 'ENTITIES') {
      const raws = splitEntities(pairs, i + 2, end).filter((r) => !s(r, 67) || s(r, 67) === '0'); // espace objet uniquement
      entities = parseEntities(raws, blocks, skipped);
    }
    i = end;
  }
  return { entities, layers, skipped, insunits };
}

// ===========================================================================
// Écriture R12
// ===========================================================================

class Writer {
  private readonly out: string[] = [];
  pair(code: number, value: string | number): void {
    this.out.push(String(code), typeof value === 'number' ? fmt(value) : value);
  }
  text(): string {
    return this.out.join('\r\n') + '\r\n';
  }
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const r = Math.abs(v) < 1e-12 ? 0 : v;
  return Number.isInteger(r) ? r.toFixed(1) : r.toPrecision(15).replace(/0+$/, '').replace(/\.$/, '.0');
}

export function writeDxf(entities: Entity[], layers: LayerDef[], insunits = 4, ltscale = 1): string {
  const w = new Writer();
  w.pair(0, 'SECTION');
  w.pair(2, 'HEADER');
  w.pair(9, '$ACADVER');
  w.pair(1, 'AC1009');
  w.pair(9, '$INSUNITS');
  w.pair(70, String(insunits));
  w.pair(9, '$LTSCALE');
  w.pair(40, ltscale);
  w.pair(0, 'ENDSEC');

  w.pair(0, 'SECTION');
  w.pair(2, 'TABLES');
  w.pair(0, 'TABLE');
  w.pair(2, 'LTYPE');
  w.pair(70, String(LINETYPE_IDS.length));
  for (const id of LINETYPE_IDS) {
    const lt = LINETYPES[id];
    w.pair(0, 'LTYPE');
    w.pair(2, lt.dxf);
    w.pair(70, '0');
    w.pair(3, lt.description);
    w.pair(72, '65');
    w.pair(73, String(lt.pattern.length));
    w.pair(40, lt.pattern.reduce((a, x) => a + Math.abs(x), 0));
    for (const x of lt.pattern) w.pair(49, x);
  }
  w.pair(0, 'ENDTAB');
  w.pair(0, 'TABLE');
  w.pair(2, 'LAYER');
  w.pair(70, String(layers.length));
  for (const l of layers) {
    w.pair(0, 'LAYER');
    w.pair(2, l.name);
    w.pair(70, String((l.frozen ? 1 : 0) | (l.locked ? 4 : 0)));
    const aci = hexToAci(l.color);
    w.pair(62, String(l.visible ? aci : -aci));
    w.pair(6, LINETYPES[l.linetype ?? 'CONTINUOUS'].dxf);
  }
  w.pair(0, 'ENDTAB');
  w.pair(0, 'TABLE');
  w.pair(2, 'STYLE');
  w.pair(70, '1');
  w.pair(0, 'STYLE');
  w.pair(2, 'STANDARD');
  w.pair(70, '0');
  w.pair(40, 0);
  w.pair(41, 1);
  w.pair(50, 0);
  w.pair(71, '0');
  w.pair(42, 2.5);
  w.pair(3, 'txt');
  w.pair(4, '');
  w.pair(0, 'ENDTAB');
  w.pair(0, 'ENDSEC');

  w.pair(0, 'SECTION');
  w.pair(2, 'ENTITIES');
  for (const e of entities) writeEntity(w, e);
  w.pair(0, 'ENDSEC');
  w.pair(0, 'EOF');
  return w.text();
}

const DEG = 180 / Math.PI;

function head(w: Writer, type: string, e: { layer: string; color?: string }): void {
  w.pair(0, type);
  w.pair(8, e.layer);
  if (e.color) w.pair(62, String(hexToAci(e.color)));
}

function xyz(w: Writer, base: number, p: Vec3): void {
  w.pair(base, p.x);
  w.pair(base + 10, p.y);
  w.pair(base + 20, p.z);
}

function polyline(w: Writer, e: { layer: string; color?: string }, points: Vec3[], closed: boolean, bulges?: number[], is3d = false): void {
  head(w, 'POLYLINE', e);
  w.pair(66, '1');
  xyz(w, 10, { x: 0, y: 0, z: is3d ? 0 : (points[0]?.z ?? 0) });
  w.pair(70, String((closed ? 1 : 0) | (is3d ? 8 : 0)));
  points.forEach((p, i) => {
    head(w, 'VERTEX', e);
    xyz(w, 10, p);
    if (bulges?.[i]) w.pair(42, bulges[i]!);
    if (is3d) w.pair(70, '32');
  });
  head(w, 'SEQEND', e);
}

function writeEntity(w: Writer, e: Entity): void {
  switch (e.type) {
    case 'LINE':
      head(w, 'LINE', e);
      xyz(w, 10, e.start);
      xyz(w, 11, e.end);
      return;
    case 'CIRCLE':
      head(w, 'CIRCLE', e);
      xyz(w, 10, e.center);
      w.pair(40, e.radius);
      return;
    case 'ARC':
      head(w, 'ARC', e);
      xyz(w, 10, e.center);
      w.pair(40, e.radius);
      w.pair(50, e.startAngle * DEG);
      w.pair(51, e.endAngle * DEG);
      return;
    case 'POLYLINE':
      return polyline(w, e, e.points, e.closed, e.bulges);
    case 'POINT':
      head(w, 'POINT', e);
      xyz(w, 10, e.position);
      return;
    case 'TEXT': {
      // R12 n'a pas de MTEXT : une entité TEXT par ligne, avec sa justification
      const L = textLayout(e);
      const u = { x: Math.cos(e.rotation), y: Math.sin(e.rotation) }, v = { x: -u.y, y: u.x };
      const hj = e.align === 'center' ? 1 : e.align === 'right' ? 2 : 0;
      L.lines.forEach((line, k) => {
        const y = L.base0 - k * L.pitch;
        const p = { x: e.position.x + v.x * y, y: e.position.y + v.y * y, z: e.position.z };
        head(w, 'TEXT', e);
        xyz(w, 10, p);
        w.pair(40, e.height);
        w.pair(1, line.replace(/Ø/g, '%%c').replace(/°/g, '%%d').replace(/±/g, '%%p'));
        if (e.rotation) w.pair(50, e.rotation * DEG);
        if (e.widthFactor && e.widthFactor !== 1) w.pair(41, e.widthFactor);
        if (hj) {
          w.pair(72, String(hj));
          xyz(w, 11, p);
        }
      });
      return;
    }
    case 'ELLIPSE':
      return polyline(w, e, ellipsePoints(e.center, e.majorAxis, e.ratio, 96).slice(0, -1), true);
    case 'SPLINE': {
      const k = splineFit(e);
      const pts = splinePoints(k.fit, k.closed, 16);
      return polyline(w, e, k.closed ? pts.slice(0, -1) : pts, k.closed);
    }
    case 'HELIX': {
      const n = Math.max(16, Math.ceil(e.turns * 48));
      const pts = Array.from({ length: n + 1 }, (_, i) => {
        const t = i / n;
        const r = e.baseRadius + (e.topRadius - e.baseRadius) * t;
        const a = (e.ccw ? 1 : -1) * 2 * Math.PI * e.turns * t;
        return { x: e.center.x + r * Math.cos(a), y: e.center.y + r * Math.sin(a), z: e.center.z + e.height * t };
      });
      return polyline(w, e, pts, false, undefined, true);
    }
    case 'HATCH': {
      for (const b of e.boundaries) polyline(w, e, b, true);
      if (e.pattern !== 'SOLID' && e.pattern !== 'GRADIENT')
        for (const [a, b] of hatchSegments(e.boundaries, e.pattern, e.scale, e.angle) as [Vec3, Vec3][]) {
          head(w, 'LINE', e);
          xyz(w, 10, a);
          xyz(w, 11, b);
        }
      return;
    }
    case 'DIMENSION': {
      const g = dimensionGeometry(e);
      const lab = dimensionLabel(e, e.textHeight ?? 2.5);
      for (const l of [...g.lines, ...lab.lines]) for (let i = 0; i + 1 < l.length; i++) {
        head(w, 'LINE', e);
        xyz(w, 10, l[i]!);
        xyz(w, 11, l[i + 1]!);
      }
      for (const t of lab.texts) {
        head(w, 'TEXT', e);
        xyz(w, 10, t.at);
        w.pair(40, t.height);
        w.pair(1, t.text.replace(/Ø/g, '%%c').replace(/°/g, '%%d').replace(/±/g, '%%p'));
        w.pair(50, lab.angle * DEG);
        w.pair(72, '1');
        xyz(w, 11, t.at);
      }
      return;
    }
    case '3DSOLID': {
      const d = e.display;
      const v = (i: number): Vec3 => ({ x: d.positions[3 * i]!, y: d.positions[3 * i + 1]!, z: d.positions[3 * i + 2]! });
      for (let t = 0; t + 2 < d.indices.length; t += 3) {
        const a = v(d.indices[t]!), b = v(d.indices[t + 1]!), c = v(d.indices[t + 2]!);
        head(w, '3DFACE', e);
        xyz(w, 10, a);
        xyz(w, 11, b);
        xyz(w, 12, c);
        xyz(w, 13, c);
      }
      return;
    }
  }
}

