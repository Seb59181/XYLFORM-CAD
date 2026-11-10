/**
 * Onglets Solides, Surfaces et Outils 3D : primitives, extrusion, révolution, balayage,
 * lissage, hélice, booléens, congés/chanfreins d'arêtes, coque, transformations 3D, coupe,
 * surfaces et épaississement. Toute la géométrie est calculée par le noyau OpenCascade.
 */
import type { CommandContext, CommandDefinition, Vec3 } from '../../core/commands';
import { featureId, type Entity, type PrimitiveOp } from '../../core/document/Document';
import { booleanStep, createStep, extend, modifyStep } from '../history';
import { arcPoints, circleFromThreePoints, curvePoints, helixPoints, isClosedProfile, profileOf } from '../../core/entities/geometry';
import { add, cross, dist, dot, lerp, norm, scale, sub, translation, type Affine } from '../../core/math/affine';
import type { ProfileDef } from '../../kernel/protocol';
import type { AppHost } from '../AppHost';
import { cmd, DEG, fmt, getAngle, getDistance, getKeyword, getNumber, getPoint, getPointOrKeyword, is, isBody, isSolid, isSurface, kw, outlines, pickEntity, pickRequired, selectObjects } from './helpers';

const TAU = Math.PI * 2;
const Z: Vec3 = { x: 0, y: 0, z: 1 };
let lastHeight = 10;
let lastRadius = 5;

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

// ---------------------------------------------------------------------------
// Aperçus filaires
// ---------------------------------------------------------------------------

const circ = (c: Vec3, r: number, n = 64) => arcPoints(c, r, 0, TAU, n);
const up = (p: Vec3, h: number) => ({ ...p, z: p.z + h });

function boxWire(a: Vec3, b: Vec3, h: number): Vec3[][] {
  const q = [a, { x: b.x, y: a.y, z: a.z }, { x: b.x, y: b.y, z: a.z }, { x: a.x, y: b.y, z: a.z }];
  const top = q.map((p) => up(p, h));
  return [[...q, q[0]!], [...top, top[0]!], ...q.map((p, i) => [p, top[i]!])];
}

function cylWire(c: Vec3, r1: number, r2: number, h: number, axis: Vec3 = Z): Vec3[][] {
  const w = norm(axis);
  const u = norm(cross(Math.abs(w.z) < 0.9 ? Z : { x: 1, y: 0, z: 0 }, w));
  const v = cross(w, u);
  const ring = (r: number, o: Vec3) => Array.from({ length: 65 }, (_, i) => add(o, add(scale(u, r * Math.cos((TAU * i) / 64)), scale(v, r * Math.sin((TAU * i) / 64)))));
  const top = add(c, scale(w, h));
  const lines = [0, 1, 2, 3].map((k) => {
    const a = (k * Math.PI) / 2;
    const d = add(scale(u, Math.cos(a)), scale(v, Math.sin(a)));
    return [add(c, scale(d, r1)), add(top, scale(d, r2))];
  });
  return [ring(r1, c), ...(r2 > 1e-9 ? [ring(r2, top)] : []), ...lines];
}

function sphereWire(c: Vec3, r: number): Vec3[][] {
  const n = 64;
  const ring = (f: (t: number) => Vec3) => Array.from({ length: n + 1 }, (_, i) => f((TAU * i) / n));
  return [
    ring((t) => ({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t), z: c.z })),
    ring((t) => ({ x: c.x + r * Math.cos(t), y: c.y, z: c.z + r * Math.sin(t) })),
    ring((t) => ({ x: c.x, y: c.y + r * Math.cos(t), z: c.z + r * Math.sin(t) })),
  ];
}

function polygonRing(c: Vec3, n: number, r: number, rot: number): Vec3[] {
  return Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + r * Math.cos(rot + (TAU * i) / n), y: c.y + r * Math.sin(rot + (TAU * i) / n), z: c.z }));
}

function profileOutline(p: ProfileDef): Vec3[] {
  switch (p.kind) {
    case 'circle':
      return circ(p.center, p.radius);
    case 'poly':
      return curvePoints({ type: 'POLYLINE', handle: '', layer: '', points: p.points, closed: p.closed, bulges: p.bulges } as Entity)[0]!;
    case 'arc':
      return curvePoints({ type: 'ARC', handle: '', layer: '', center: p.center, radius: p.radius, startAngle: p.startAngle, endAngle: p.endAngle } as Entity)[0]!;
    case 'helix':
      return helixPoints({ type: 'HELIX', handle: '', layer: '', ...p } as Extract<Entity, { type: 'HELIX' }>, 24);
  }
}

// ---------------------------------------------------------------------------
// Matrices 3D
// ---------------------------------------------------------------------------

/** Rotation d'angle `a` autour de l'axe (o, d) — formule de Rodrigues. */
export function rotationAxis(o: Vec3, d: Vec3, a: number): Affine {
  const { x, y, z } = norm(d);
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const R = [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  const tr = (i: number) => o.x * 0 + [o.x, o.y, o.z][i]! - (R[3 * i]! * o.x + R[3 * i + 1]! * o.y + R[3 * i + 2]! * o.z);
  return [R[0]!, R[1]!, R[2]!, tr(0), R[3]!, R[4]!, R[5]!, tr(1), R[6]!, R[7]!, R[8]!, tr(2)];
}

/** Symétrie par rapport au plan (o, n). */
export function reflectPlane(o: Vec3, n0: Vec3): Affine {
  const n = norm(n0);
  const R = [1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, -2 * n.x * n.y, 1 - 2 * n.y * n.y, -2 * n.y * n.z, -2 * n.x * n.z, -2 * n.y * n.z, 1 - 2 * n.z * n.z];
  const tr = (i: number) => [o.x, o.y, o.z][i]! - (R[3 * i]! * o.x + R[3 * i + 1]! * o.y + R[3 * i + 2]! * o.z);
  return [R[0]!, R[1]!, R[2]!, tr(0), R[3]!, R[4]!, R[5]!, tr(1), R[6]!, R[7]!, R[8]!, tr(2)];
}

async function getPlane(ctx: CommandContext, message: string): Promise<{ origin: Vec3; normal: Vec3 }> {
  const r = await getPointOrKeyword(ctx, message, {
    keywords: [kw('XY', 'XY', 'XY', 'Plan horizontal'), kw('YZ', 'YZ', 'YZ', 'Plan vertical de face X'), kw('ZX', 'ZX', 'ZX', 'Plan vertical de face Y'), kw('3Points', '3points', '3', 'Trois points')],
    defaultValue: '3Points',
  });
  if (r.keyword && r.keyword !== '3Points') {
    const o = await getPoint(ctx, `Spécifiez un point sur le plan ${r.keyword}`, { defaultValue: { x: 0, y: 0, z: 0 } });
    return { origin: o, normal: r.keyword === 'XY' ? Z : r.keyword === 'YZ' ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 } };
  }
  const p1 = r.point ?? (await getPoint(ctx, 'Spécifiez le premier point du plan'));
  const p2 = await getPoint(ctx, 'Spécifiez le deuxième point du plan', { basePoint: p1 });
  const p3 = await getPoint(ctx, 'Spécifiez le troisième point du plan', { basePoint: p2 });
  let n = cross(sub(p2, p1), sub(p3, p1));
  // trois points d'un plan horizontal en vue de dessus : plan vertical passant par p1-p2
  if (Math.hypot(n.x, n.y, n.z) < 1e-9) n = cross(sub(p2, p1), Z);
  if (Math.hypot(n.x, n.y, n.z) < 1e-9) throw new Error('Les points ne définissent pas un plan.');
  return { origin: p1, normal: norm(n) };
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Crée une primitive en mémorisant ses cotes (modifiables ensuite dans la palette Propriétés). */
async function addPrimitive(ctx: CommandContext, app: AppHost, op: PrimitiveOp, name: string): Promise<string> {
  return app.addSolid(await app.solid(ctx, op), name, undefined, ctx, op);
}

async function height(ctx: CommandContext, base: Vec3, preview: (h: number) => Vec3[][], extra: Parameters<typeof getDistance>[2] = {}) {
  return getDistance(ctx, 'Spécifiez la hauteur', {
    basePoint: base,
    vertical: true,
    allowNegative: true,
    allowZero: false,
    defaultValue: lastHeight,
    preview: (p) => preview(p.z - base.z),
    ...extra,
  });
}

const box = cmd('BOX', 'BOITE', ['BO'], 'Crée un parallélépipède', async (ctx, app) => {
  const r = await getPointOrKeyword(ctx, 'Spécifiez le premier coin', { keywords: [kw('Center', 'Centre', 'C')] });
  let a: Vec3, b: Vec3;
  let cube: number | null = null;
  const rect = (p: Vec3, q: Vec3) => boxWire(p, q, 0).slice(0, 1);
  if (r.keyword === 'Center') {
    const c = await getPoint(ctx, 'Spécifiez le centre');
    const q = await getPointOrKeyword(ctx, 'Spécifiez un coin', { basePoint: c, keywords: [kw('Cube', 'Cube', 'C')], preview: (p) => rect(sub(scale(c, 2), p), p) });
    if (q.keyword) {
      const L = (await getDistance(ctx, 'Spécifiez la longueur', { allowZero: false, basePoint: c })) as number;
      a = sub(c, { x: L / 2, y: L / 2, z: L / 2 });
      b = add(a, { x: L, y: L, z: 0 });
      cube = L;
    } else {
      b = q.point!;
      a = { ...sub(scale(c, 2), b), z: c.z };
    }
  } else {
    a = r.point!;
    const q = await getPointOrKeyword(ctx, 'Spécifiez l’autre coin', {
      basePoint: a,
      noRubberBand: true,
      keywords: [kw('Cube', 'Cube', 'C'), kw('Length', 'Longueur', 'L')],
      preview: (p) => rect(a, p),
    });
    if (q.keyword === 'Cube') {
      cube = (await getDistance(ctx, 'Spécifiez la longueur', { allowZero: false, basePoint: a })) as number;
      b = add(a, { x: cube, y: cube, z: 0 });
    } else if (q.keyword === 'Length') {
      const L = (await getDistance(ctx, 'Spécifiez la longueur', { allowZero: false, allowNegative: true, basePoint: a })) as number;
      const W = (await getDistance(ctx, 'Spécifiez la largeur', { allowZero: false, allowNegative: true })) as number;
      b = add(a, { x: L, y: W, z: 0 });
    } else b = q.point!;
  }
  if (Math.abs(b.x - a.x) < 1e-9 || Math.abs(b.y - a.y) < 1e-9) throw new Error('La base de la boîte est de surface nulle.');
  let h = cube;
  if (h === null) {
    const r2 = await height(ctx, a, (hh) => boxWire(a, { ...b, z: a.z }, hh), { keywords: [kw('2Point', '2Point', '2P')] });
    if (r2 === '2Point') {
      const p1 = await getPoint(ctx, 'Spécifiez le premier point');
      const p2 = await getPoint(ctx, 'Spécifiez le deuxième point', { basePoint: p1 });
      h = dist(p1, p2);
    } else h = r2 as number;
  }
  lastHeight = h;
  await addPrimitive(ctx, app, { op: 'box', corner: { ...a, z: a.z }, size: { x: b.x - a.x, y: b.y - a.y, z: h } }, 'Boîte');
});

async function baseCircle(ctx: CommandContext, message: string): Promise<{ c: Vec3; r: number }> {
  const r = await getPointOrKeyword(ctx, message, { keywords: [kw('3P', '3P'), kw('2P', '2P')] });
  if (r.keyword === '3P') {
    const p1 = await getPoint(ctx, 'Spécifiez le premier point');
    const p2 = await getPoint(ctx, 'Spécifiez le deuxième point', { basePoint: p1 });
    const p3 = await getPoint(ctx, 'Spécifiez le troisième point', { noRubberBand: true, preview: (p) => { const k = circleFromThreePoints(p1, p2, p); return k ? [circ(k.center, k.radius)] : []; } });
    const k = circleFromThreePoints(p1, p2, p3);
    if (!k) throw new Error('Points alignés.');
    return { c: k.center, r: k.radius };
  }
  if (r.keyword === '2P') {
    const p1 = await getPoint(ctx, 'Spécifiez la première extrémité du diamètre');
    const p2 = await getPoint(ctx, 'Spécifiez la deuxième extrémité du diamètre', { basePoint: p1, preview: (p) => [circ(lerp(p1, p, 0.5), dist(p1, p) / 2)] });
    return { c: lerp(p1, p2, 0.5), r: dist(p1, p2) / 2 };
  }
  const c = r.point!;
  const rad = await getDistance(ctx, 'Spécifiez le rayon de la base', { basePoint: c, defaultValue: lastRadius, allowZero: false, keywords: [kw('Diameter', 'Diamètre', 'D')], preview: (p) => [circ(c, dist(c, p))] });
  if (rad === 'Diameter') {
    const d = (await getDistance(ctx, 'Spécifiez le diamètre', { basePoint: c, defaultValue: lastRadius * 2, allowZero: false, preview: (p) => [circ(c, dist(c, p) / 2)] })) as number;
    return { c, r: d / 2 };
  }
  return { c, r: rad as number };
}

const cylinder = cmd('CYLINDER', 'CYLINDRE', ['CYL'], 'Crée un cylindre', async (ctx, app) => {
  const { c, r } = await baseCircle(ctx, 'Spécifiez le centre de la base');
  lastRadius = r;
  const h = await height(ctx, c, (hh) => cylWire(c, r, r, hh), { keywords: [kw('AxisEndpoint', 'Extrémité d’axe', 'A')] });
  if (h === 'AxisEndpoint') {
    const e = await getPoint(ctx, 'Spécifiez l’extrémité de l’axe', { basePoint: c, preview: (p) => (dist(p, c) > 1e-9 ? cylWire(c, r, r, dist(c, p), sub(p, c)) : []) });
    const axis = sub(e, c);
    await addPrimitive(ctx, app, { op: 'cylinder', center: c, radius: r, height: dist(c, e), axis }, 'Cylindre');
    return;
  }
  lastHeight = h as number;
  await addPrimitive(ctx, app, { op: 'cylinder', center: c, radius: r, height: h as number }, 'Cylindre');
});

const cone = cmd('CONE', 'CONE', ['CON'], 'Crée un cône ou un tronc de cône', async (ctx, app) => {
  const { c, r } = await baseCircle(ctx, 'Spécifiez le centre de la base');
  lastRadius = r;
  let top = 0;
  for (;;) {
    const h = await height(ctx, c, (hh) => cylWire(c, r, top, hh), { keywords: [kw('AxisEndpoint', 'Extrémité d’axe', 'A'), kw('TopRadius', 'Rayon supérieur', 'R')] });
    if (h === 'TopRadius') {
      top = (await getDistance(ctx, 'Spécifiez le rayon supérieur', { defaultValue: 0, allowZero: true })) as number;
      continue;
    }
    if (h === 'AxisEndpoint') {
      const e = await getPoint(ctx, 'Spécifiez l’extrémité de l’axe', { basePoint: c, preview: (p) => (dist(p, c) > 1e-9 ? cylWire(c, r, top, dist(c, p), sub(p, c)) : []) });
      await addPrimitive(ctx, app, { op: 'cone', center: c, radius: r, topRadius: top, height: dist(c, e), axis: sub(e, c) }, 'Cône');
      return;
    }
    lastHeight = h as number;
    await addPrimitive(ctx, app, { op: 'cone', center: c, radius: r, topRadius: top, height: h as number }, 'Cône');
    return;
  }
});

const sphere = cmd('SPHERE', 'SPHERE', ['SPH'], 'Crée une sphère', async (ctx, app) => {
  const r = await getPointOrKeyword(ctx, 'Spécifiez le centre', { keywords: [kw('2P', '2P'), kw('3P', '3P')] });
  let c: Vec3, rad: number;
  if (r.keyword === '2P') {
    const p1 = await getPoint(ctx, 'Spécifiez la première extrémité du diamètre');
    const p2 = await getPoint(ctx, 'Spécifiez la deuxième extrémité du diamètre', { basePoint: p1, preview: (p) => sphereWire(lerp(p1, p, 0.5), dist(p1, p) / 2) });
    c = lerp(p1, p2, 0.5);
    rad = dist(p1, p2) / 2;
  } else if (r.keyword === '3P') {
    const k = await baseCircle(ctx, 'Spécifiez le premier point').catch(() => null);
    if (!k) return;
    c = k.c;
    rad = k.r;
  } else {
    c = r.point!;
    const d = await getDistance(ctx, 'Spécifiez le rayon', { basePoint: c, defaultValue: lastRadius, allowZero: false, keywords: [kw('Diameter', 'Diamètre', 'D')], preview: (p) => sphereWire(c, dist(c, p)) });
    rad = d === 'Diameter' ? ((await getDistance(ctx, 'Spécifiez le diamètre', { basePoint: c, allowZero: false, preview: (p) => sphereWire(c, dist(c, p) / 2) })) as number) / 2 : (d as number);
  }
  lastRadius = rad;
  await addPrimitive(ctx, app, { op: 'sphere', center: c, radius: rad }, 'Sphère');
});

const pyramid = cmd('PYRAMID', 'PYRAMIDE', ['PYR'], 'Crée une pyramide (ou un tronc de pyramide)', async (ctx, app) => {
  let sides = 4;
  let inscribed = false;
  let c: Vec3;
  for (;;) {
    ctx.print(`${sides} côtés, ${inscribed ? 'inscrit' : 'circonscrit'}`);
    const r = await getPointOrKeyword(ctx, 'Spécifiez le centre de la base', { keywords: [kw('Sides', 'Côtés', 'C'), kw('Inscribed', 'Inscrit', 'I'), kw('Circumscribed', 'Circonscrit', 'CI')] });
    if (r.keyword === 'Sides') sides = (await getNumber(ctx, 'Entrez le nombre de côtés', { integer: true, defaultValue: sides })) as number;
    else if (r.keyword === 'Inscribed') inscribed = true;
    else if (r.keyword === 'Circumscribed') inscribed = false;
    else {
      c = r.point!;
      break;
    }
  }
  const geom = (p: Vec3) => {
    const d = dist(c, p);
    const a = Math.atan2(p.y - c.y, p.x - c.x);
    return inscribed ? { R: d, rot: a } : { R: d / Math.cos(Math.PI / sides), rot: a + Math.PI / sides };
  };
  const bp = await getPoint(ctx, 'Spécifiez le rayon de la base', { basePoint: c, preview: (p) => [polygonRing(c, sides, geom(p).R, geom(p).rot)] });
  const { R, rot } = geom(bp);
  let top = 0;
  for (;;) {
    const h = await height(
      ctx,
      c,
      (hh) => {
        const base = polygonRing(c, sides, R, rot);
        const tp = top > 0 ? polygonRing(up(c, hh), sides, (top * R) / R, rot) : null;
        return [base, ...(tp ? [tp] : []), ...base.slice(0, -1).map((p, i) => [p, tp ? tp[i]! : up(c, hh)])];
      },
      { keywords: [kw('TopRadius', 'Rayon supérieur', 'R')] },
    );
    if (h === 'TopRadius') {
      top = (await getDistance(ctx, 'Spécifiez le rayon supérieur', { defaultValue: 0, allowZero: true })) as number;
      continue;
    }
    lastHeight = h as number;
    const topR = inscribed ? top : top / Math.cos(Math.PI / sides);
    await addPrimitive(ctx, app, { op: 'pyramid', center: c, sides, radius: R, topRadius: topR, height: h as number, rotation: rot }, 'Pyramide');
    return;
  }
});

const torus = cmd('TORUS', 'TORE', ['TOR'], 'Crée un tore', async (ctx, app) => {
  const c = await getPoint(ctx, 'Spécifiez le centre');
  const R = (await getDistance(ctx, 'Spécifiez le rayon', { basePoint: c, defaultValue: lastRadius * 2, allowZero: false, preview: (p) => [circ(c, dist(c, p))] })) as number;
  const tube = (await getDistance(ctx, 'Spécifiez le rayon du tube', {
    defaultValue: R / 4,
    allowZero: false,
    preview: (p) => {
      const t = Math.abs(dist(c, p) - R);
      return [circ(c, R - t), circ(c, R + t), circ(up(c, t), R), circ(up(c, -t), R)];
    },
  })) as number;
  await addPrimitive(ctx, app, { op: 'torus', center: c, radius: R, tubeRadius: tube }, 'Tore');
});

// ---------------------------------------------------------------------------
// Solides à partir de profils
// ---------------------------------------------------------------------------

const profileable = (e: Entity) => profileOf(e) !== null && e.type !== 'HELIX';
const closedOnly = (e: Entity) => profileable(e) && isClosedProfile(e);

function profilesOf(app: AppHost, hs: string[]): { e: Entity; p: ProfileDef; closed: boolean }[] {
  return hs.map((h) => app.doc.get(h)!).map((e) => ({ e, p: profileOf(e)!, closed: isClosedProfile(e) })).filter((x) => x.p);
}

async function extrudeFlow(ctx: CommandContext, app: AppHost, surfaceMode: boolean): Promise<void> {
  const hs = await selectObjects(ctx, surfaceMode ? 'Choisissez les courbes à extruder' : 'Choisissez les objets à extruder', surfaceMode ? profileable : profileable);
  const items = profilesOf(app, hs);
  if (!items.length) return;
  const outline = items.map((i) => profileOutline(i.p));
  let taper = 0;
  let direction: Vec3 | undefined;
  let h: number;
  for (;;) {
    const r = await getDistance(ctx, `Spécifiez la hauteur d’extrusion${taper ? ` (dépouille ${fmt(taper)}°)` : ''}`, {
      basePoint: items[0]!.p.kind === 'poly' ? items[0]!.p.points[0] : (items[0]!.p as { center: Vec3 }).center,
      vertical: true,
      allowNegative: true,
      allowZero: false,
      defaultValue: lastHeight,
      keywords: [kw('Direction', 'Direction', 'D'), kw('Path', 'Trajectoire', 'T'), kw('Taper', 'Angle de dépouille', 'A')],
      preview: (p) => {
        const base = items[0]!.p.kind === 'poly' ? (items[0]!.p as { points: Vec3[] }).points[0]! : (items[0]!.p as { center: Vec3 }).center;
        const hh = p.z - base.z;
        return outline.flatMap((pl) => [pl, pl.map((q) => up(q, hh)), ...[0, Math.floor(pl.length / 3), Math.floor((2 * pl.length) / 3)].map((k) => [pl[k]!, up(pl[k]!, hh)])]);
      },
    });
    if (r === 'Taper') {
      taper = (await getNumber(ctx, 'Spécifiez l’angle de dépouille (degrés)', { defaultValue: taper, allowNegative: true })) as number;
      continue;
    }
    if (r === 'Direction') {
      const p1 = await getPoint(ctx, 'Spécifiez le point de départ de la direction');
      const p2 = await getPoint(ctx, 'Spécifiez l’extrémité de la direction', { basePoint: p1, preview: (p) => outline.map((pl) => pl.map((q) => add(q, sub(p, p1)))) });
      direction = sub(p2, p1);
      h = dist(p1, p2);
      break;
    }
    if (r === 'Path') {
      const path = await pickRequired(ctx, 'Choisissez la trajectoire d’extrusion', (e) => profileOf(e) !== null && !hs.includes(e.handle));
      await sweepItems(ctx, app, items, profileOf(path.e)!, true, surfaceMode);
      return;
    }
    h = r as number;
    lastHeight = h;
    break;
  }
  const created: string[] = [];
  for (const it of items) {
    const surface = surfaceMode || !it.closed;
    const op = { op: 'extrude', profile: it.p, height: h, taperDeg: surface ? 0 : taper, surface, direction } as const;
    const res = await app.solid(ctx, op);
    const name = surface ? 'Surface extrudée' : 'Extrusion';
    created.push(app.addSolid(res, name, it.e, ctx, createStep(op, name)));
  }
  app.doc.transaction('Extrusion', () => items.forEach((i) => app.doc.removeEntity(i.e.handle)));
  ctx.print(`${created.length} ${surfaceMode || items.some((i) => !i.closed) ? 'objet(s)' : 'solide(s)'} créé(s).`);
}

async function sweepItems(ctx: CommandContext, app: AppHost, items: { e: Entity; p: ProfileDef; closed: boolean }[], path: ProfileDef, align: boolean, surfaceMode: boolean) {
  for (const it of items) {
    const surface = surfaceMode || !it.closed;
    const op = { op: 'sweep', profile: it.p, path, align, surface } as const;
    const res = await app.solid(ctx, op);
    const name = surface ? 'Surface balayée' : 'Balayage';
    app.addSolid(res, name, it.e, ctx, createStep(op, name));
  }
  app.doc.transaction('Balayage', () => items.forEach((i) => app.doc.removeEntity(i.e.handle)));
}

async function revolveFlow(ctx: CommandContext, app: AppHost, surfaceMode: boolean): Promise<void> {
  const hs = await selectObjects(ctx, 'Choisissez les objets à réviser', profileable);
  const items = profilesOf(app, hs);
  if (!items.length) return;
  const r = await getPointOrKeyword(ctx, 'Spécifiez le point de départ de l’axe ou définissez l’axe par', {
    keywords: [kw('Object', 'Objet', 'O'), kw('X', 'X'), kw('Y', 'Y'), kw('Z', 'Z')],
    defaultValue: 'Object',
  });
  let a: Vec3, b: Vec3;
  if (r.keyword === 'Object') {
    const { e } = await pickRequired(ctx, 'Choisissez un objet à utiliser comme axe', is('LINE', 'POLYLINE'));
    if (e.type === 'LINE') (a = e.start), (b = e.end);
    else (a = (e as Extract<Entity, { type: 'POLYLINE' }>).points[0]!), (b = (e as Extract<Entity, { type: 'POLYLINE' }>).points[(e as Extract<Entity, { type: 'POLYLINE' }>).points.length - 1]!);
  } else if (r.keyword) {
    a = { x: 0, y: 0, z: 0 };
    b = r.keyword === 'X' ? { x: 1, y: 0, z: 0 } : r.keyword === 'Y' ? { x: 0, y: 1, z: 0 } : Z;
  } else {
    a = r.point!;
    b = await getPoint(ctx, 'Spécifiez l’extrémité de l’axe', { basePoint: a });
  }
  let start = 0;
  let reverse = false;
  for (;;) {
    const ang = await getAngle(ctx, 'Spécifiez l’angle de révolution', {
      defaultValue: TAU,
      keywords: [kw('Start', 'Angle de départ', 'D'), kw('Reverse', 'Inverser', 'I')],
    });
    if (ang === 'Start') {
      start = ((await getAngle(ctx, 'Spécifiez l’angle de départ', { defaultValue: 0 })) as number) / DEG;
      continue;
    }
    if (ang === 'Reverse') {
      reverse = !reverse;
      continue;
    }
    const deg = ((ang as number) / DEG) * (reverse ? -1 : 1);
    for (const it of items) {
      const surface = surfaceMode || !it.closed;
      const op = { op: 'revolve', profile: it.p, axisStart: a, axisEnd: b, angleDeg: deg, startDeg: start, surface } as const;
      const res = await app.solid(ctx, op);
      const name = surface ? 'Surface de révolution' : 'Révolution';
      app.addSolid(res, name, it.e, ctx, createStep(op, name));
    }
    app.doc.transaction('Révolution', () => items.forEach((i) => app.doc.removeEntity(i.e.handle)));
    return;
  }
}

async function sweepFlow(ctx: CommandContext, app: AppHost, surfaceMode: boolean): Promise<void> {
  const hs = await selectObjects(ctx, 'Choisissez les profils à balayer', profileable);
  const items = profilesOf(app, hs);
  if (!items.length) return;
  let align = true;
  for (;;) {
    ctx.print(`Alignement perpendiculaire à la trajectoire : ${align ? 'Oui' : 'Non'}`);
    const r = await pickEntity(ctx, 'Choisissez la trajectoire de balayage', {
      filter: (e) => profileOf(e) !== null && !hs.includes(e.handle),
      keywords: [kw('Alignment', 'Alignement', 'A')],
    });
    if (r === 'Alignment') {
      align = (await getKeyword(ctx, 'Aligner l’objet à balayer perpendiculairement à la trajectoire ?', [kw('Yes', 'Oui', 'O'), kw('No', 'Non', 'N')], align ? 'Yes' : 'No')) === 'Yes';
      continue;
    }
    if (!r || typeof r === 'string') continue;
    const path = profileOf(app.doc.get(r.handle)!)!;
    await sweepItems(ctx, app, items, path, align, surfaceMode);
    return;
  }
}

async function loftFlow(ctx: CommandContext, app: AppHost, surfaceMode: boolean): Promise<void> {
  const hs = await selectObjects(ctx, 'Choisissez les sections transversales dans l’ordre de lissage', profileable);
  let items = profilesOf(app, hs);
  if (items.length < 2) throw new Error('Il faut au moins deux sections.');
  const zs = items.map((i) => {
    const b = profileOutline(i.p);
    return b.reduce((s, p) => s + p.z, 0) / b.length;
  });
  let sections = items.map((i) => i.p);
  if (Math.max(...zs) - Math.min(...zs) < 1e-6) {
    // sections coplanaires : on les étage verticalement
    const gap = (await getDistance(ctx, 'Les sections sont dans le même plan. Spécifiez l’espacement vertical', { defaultValue: 10, allowZero: false, allowNegative: true })) as number;
    sections = sections.map((p, k) => liftProfile(p, k * gap));
  }
  const mode = await getKeyword(ctx, 'Entrez une option', [kw('Smooth', 'Lisse', 'L', 'Surface lisse'), kw('Ruled', 'Réglée', 'R', 'Raccords droits entre sections')], 'Smooth');
  const surface = surfaceMode || items.some((i) => !i.closed);
  const op = { op: 'loft', sections, ruled: mode === 'Ruled', surface } as const;
  const res = await app.solid(ctx, op);
  const name = surface ? 'Surface lissée' : 'Lissage';
  app.addSolid(res, name, items[0]!.e, ctx, createStep(op, name));
  app.doc.transaction('Lissage', () => items.forEach((i) => app.doc.removeEntity(i.e.handle)));
  items = [];
}

function liftProfile(p: ProfileDef, dz: number): ProfileDef {
  switch (p.kind) {
    case 'poly':
      return { ...p, points: p.points.map((q) => up(q, dz)) };
    default:
      return { ...p, center: up(p.center, dz) } as ProfileDef;
  }
}

const extrude = cmd('EXTRUDE', 'EXTRUSION', ['EXT'], 'Extrude des profils fermés (solides) ou ouverts (surfaces)', (ctx, app) => extrudeFlow(ctx, app, false));
const revolve = cmd('REVOLVE', 'REVOLUTION', ['REV'], 'Crée un solide par rotation d’un profil autour d’un axe', (ctx, app) => revolveFlow(ctx, app, false));
const sweep = cmd('SWEEP', 'BALAYAGE', ['BAL'], 'Balaye un profil le long d’une trajectoire', (ctx, app) => sweepFlow(ctx, app, false));
const loft = cmd('LOFT', 'LISSAGE', ['LIS'], 'Crée un solide entre plusieurs sections', (ctx, app) => loftFlow(ctx, app, false));
const surfExtrude = cmd('SURFEXTRUDE', 'SURFEXTRU', ['SEXT'], 'Surface extrudée à partir de courbes', (ctx, app) => extrudeFlow(ctx, app, true));
const surfRevolve = cmd('SURFREVOLVE', 'SURFREVOL', ['SREV'], 'Surface de révolution', (ctx, app) => revolveFlow(ctx, app, true));
const surfSweep = cmd('SURFSWEEP', 'SURFBALAYAGE', ['SBAL'], 'Surface balayée le long d’une trajectoire', (ctx, app) => sweepFlow(ctx, app, true));
const surfLoft = cmd('SURFLOFT', 'SURFLISSAGE', ['SLIS'], 'Surface lissée entre des courbes', (ctx, app) => loftFlow(ctx, app, true));

const helix = cmd('HELIX', 'HELICE', ['HEL'], 'Crée une hélice (trajectoire de balayage pour ressorts et filetages)', async (ctx, app) => {
  const c = await getPoint(ctx, 'Spécifiez le centre de la base');
  const rb0 = await getDistance(ctx, 'Spécifiez le rayon de la base', { basePoint: c, defaultValue: lastRadius, allowZero: false, keywords: [kw('Diameter', 'Diamètre', 'D')], preview: (p) => [circ(c, dist(c, p))] });
  const rb = rb0 === 'Diameter' ? ((await getDistance(ctx, 'Spécifiez le diamètre', { basePoint: c, allowZero: false })) as number) / 2 : (rb0 as number);
  const rt = (await getDistance(ctx, 'Spécifiez le rayon du sommet', { basePoint: c, defaultValue: rb, allowZero: true, preview: (p) => [circ(c, rb), circ(c, dist(c, p))] })) as number;
  let turns = 3;
  let pitch: number | null = null;
  let ccw = true;
  for (;;) {
    ctx.print(`Nombre de tours = ${fmt(turns)}, torsion = ${ccw ? 'trigonométrique' : 'horaire'}`);
    const h = await getDistance(ctx, 'Spécifiez la hauteur de l’hélice', {
      basePoint: c,
      vertical: true,
      allowNegative: true,
      allowZero: false,
      defaultValue: lastHeight,
      keywords: [kw('Turns', 'Tours', 'T'), kw('TurnHeight', 'Hauteur de spire', 'H'), kw('Twist', 'Torsion', 'O')],
      preview: (p) => {
        const hh = p.z - c.z;
        const t = pitch ? Math.max(0.1, Math.abs(hh) / pitch) : turns;
        return [helixPoints({ type: 'HELIX', handle: '', layer: '', center: c, baseRadius: rb, topRadius: rt, height: hh, turns: t, ccw } as Extract<Entity, { type: 'HELIX' }>, 48)];
      },
    });
    if (h === 'Turns') {
      turns = (await getNumber(ctx, 'Entrez le nombre de tours', { defaultValue: turns, allowZero: false })) as number;
      pitch = null;
      continue;
    }
    if (h === 'TurnHeight') {
      pitch = (await getDistance(ctx, 'Spécifiez la hauteur d’une spire (pas)', { defaultValue: 1, allowZero: false })) as number;
      continue;
    }
    if (h === 'Twist') {
      ccw = (await getKeyword(ctx, 'Sens de torsion', [kw('CW', 'Horaire', 'SH'), kw('CCW', 'Trigonométrique', 'SAH')], ccw ? 'CCW' : 'CW')) === 'CCW';
      continue;
    }
    const height = h as number;
    if (pitch) turns = Math.abs(height) / pitch;
    lastHeight = height;
    app.addEntity({ type: 'HELIX', center: c, baseRadius: rb, topRadius: rt, height, turns, ccw });
    return;
  }
});

// ---------------------------------------------------------------------------
// Booléens
// ---------------------------------------------------------------------------

const union = cmd('UNION', 'UNION', ['UNI'], 'Fusionne des solides', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les solides à unir', isSolid);
  if (hs.length < 2) throw new Error('Sélectionnez au moins deux solides.');
  const solids = hs.map((h) => app.doc.get(h) as Solid3D);
  const res = await app.solid(ctx, { op: 'boolean', kind: 'union', targets: solids.map((s) => s.shapeId), tools: [] });
  const history = extend(solids[0]!.history, booleanStep('union', solids.slice(1).map((s) => s.history), `Union (${solids.length - 1} corps)`));
  app.doc.transaction('Union', () => {
    hs.forEach((h) => app.doc.removeEntity(h));
    app.addSolid(res, 'Union', solids[0], ctx, history);
  });
});

const subtract = cmd('SUBTRACT', 'SOUSTRACTION', ['SOUS', 'SU'], 'Soustrait des solides à d’autres', async (ctx, app) => {
  const targets = await selectObjects(ctx, 'Choisissez les solides dont vous voulez soustraire', isSolid);
  if (!targets.length) return;
  app.selection.clear();
  const tools = (await selectObjects(ctx, 'Choisissez les solides à soustraire', (e) => isSolid(e) && !targets.includes(e.handle))).filter((h) => !targets.includes(h));
  if (!tools.length) throw new Error('Aucun solide à soustraire.');
  const toolShapes = tools.map((h) => (app.doc.get(h) as Solid3D).shapeId);
  const toolSolids = tools.map((h) => app.doc.get(h) as Solid3D);
  const step = booleanStep('subtract', toolSolids.map((t) => t.history), `Soustraction : ${toolSolids.map((t) => t.name || t.handle).join(', ')}`);
  const results: { s: Solid3D; r: import('../../kernel/protocol').SolidResult }[] = [];
  for (const t of targets) {
    const s = app.doc.get(t) as Solid3D;
    results.push({ s, r: await app.solid(ctx, { op: 'boolean', kind: 'subtract', targets: [s.shapeId], tools: toolShapes }) });
  }
  app.doc.transaction('Soustraction', () => {
    for (const { s, r } of results) app.doc.replaceEntity(s.handle, { shapeId: r.shapeId, display: r.display, name: 'Soustraction', history: extend(s.history, step && { ...step, id: featureId() }) });
    tools.forEach((h) => app.doc.removeEntity(h));
  });
});

const intersect = cmd('INTERSECT', 'INTERSECT', ['IN'], 'Conserve le volume commun à plusieurs solides', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les solides à intersecter', isSolid);
  if (hs.length < 2) throw new Error('Sélectionnez au moins deux solides.');
  const solids = hs.map((h) => app.doc.get(h) as Solid3D);
  const res = await app.solid(ctx, { op: 'boolean', kind: 'intersect', targets: solids.map((s) => s.shapeId), tools: [] });
  const history = extend(solids[0]!.history, booleanStep('intersect', solids.slice(1).map((s) => s.history), `Intersection (${solids.length - 1} corps)`));
  app.doc.transaction('Intersection', () => {
    hs.forEach((h) => app.doc.removeEntity(h));
    app.addSolid(res, 'Intersection', solids[0], ctx, history);
  });
});

// ---------------------------------------------------------------------------
// Finitions : congés, chanfreins, coque
// ---------------------------------------------------------------------------

async function pickEdges(ctx: CommandContext, app: AppHost, handle: string | undefined, first: number | undefined, label: string, keywords: ReturnType<typeof kw>[], onKeyword: (k: string) => Promise<boolean>): Promise<{ handle: string; edges: number[] | 'all' } | null> {
  let h = handle;
  const edges: number[] = first !== undefined ? [first] : [];
  const show = () => app.setSubHighlight(h ? { handle: h, edges, faces: [] } : null);
  show();
  try {
    for (;;) {
      const r = await pickEntity(ctx, `${label} (${edges.length} arête(s), Entrée pour valider)`, {
        pickMode: 'edge',
        filter: (e) => isSolid(e) && (!h || e.handle === h),
        keywords: [...keywords, kw('All', 'Tout', 'TO', 'Toutes les arêtes')],
        allowNone: true,
      });
      if (r === null) return h && edges.length ? { handle: h, edges } : null;
      if (r === 'All') {
        if (!h) {
          const { e } = await pickRequired(ctx, 'Choisissez le solide', isSolid);
          h = e.handle;
        }
        return { handle: h, edges: 'all' };
      }
      if (typeof r === 'string') {
        await onKeyword(r);
        continue;
      }
      if (r.sub === undefined) continue;
      h = r.handle;
      const k = edges.indexOf(r.sub);
      if (k >= 0) edges.splice(k, 1);
      else edges.push(r.sub);
      show();
    }
  } finally {
    app.setSubHighlight(null);
  }
}

export async function filletSolidEdges(ctx: CommandContext, app: AppHost, handle?: string, firstEdge?: number): Promise<void> {
  const sv = app.sysvars;
  let r2: number | undefined;
  ctx.print(`Rayon = ${fmt(sv.FILLETRAD3D)}`);
  const sel = await pickEdges(ctx, app, handle, firstEdge, 'Choisissez une arête', [kw('Radius', 'Rayon', 'R'), kw('Variable', 'Variable', 'V', 'Rayon variable le long de l’arête')], async (k) => {
    if (k === 'Radius') sv.FILLETRAD3D = (await getDistance(ctx, 'Entrez le rayon du raccord', { defaultValue: sv.FILLETRAD3D, allowZero: false })) as number;
    if (k === 'Variable') {
      sv.FILLETRAD3D = (await getDistance(ctx, 'Rayon au début de l’arête', { defaultValue: sv.FILLETRAD3D, allowZero: false })) as number;
      r2 = (await getDistance(ctx, 'Rayon à la fin de l’arête', { defaultValue: sv.FILLETRAD3D * 2, allowZero: false })) as number;
    }
    return true;
  });
  if (!sel) return;
  const s = app.doc.get(sel.handle) as Solid3D;
  const op = { op: 'fillet', shapeId: s.shapeId, edges: sel.edges, radius: sv.FILLETRAD3D, radius2: r2 } as const;
  const res = await app.solid(ctx, op);
  app.doc.replaceEntity(s.handle, { shapeId: res.shapeId, display: res.display, history: extend(s.history, modifyStep(op, 'Congé')) });
  ctx.print(`${sel.edges === 'all' ? 'Toutes les' : sel.edges.length} arête(s) raccordée(s).`);
}

export async function chamferSolidEdges(ctx: CommandContext, app: AppHost, handle?: string, firstEdge?: number): Promise<void> {
  const sv = app.sysvars;
  if (!sv.CHAMFERA) sv.CHAMFERA = 1;
  ctx.print(`Distance = ${fmt(sv.CHAMFERA)}`);
  const sel = await pickEdges(ctx, app, handle, firstEdge, 'Choisissez une arête', [kw('Distance', 'Distance', 'D')], async () => {
    sv.CHAMFERA = (await getDistance(ctx, 'Entrez la distance du chanfrein', { defaultValue: sv.CHAMFERA, allowZero: false })) as number;
    return true;
  });
  if (!sel) return;
  const s = app.doc.get(sel.handle) as Solid3D;
  const op = { op: 'chamfer', shapeId: s.shapeId, edges: sel.edges, distance: sv.CHAMFERA } as const;
  const res = await app.solid(ctx, op);
  app.doc.replaceEntity(s.handle, { shapeId: res.shapeId, display: res.display, history: extend(s.history, modifyStep(op, 'Chanfrein')) });
}

const filletEdge = cmd('FILLETEDGE', 'RACCORDBORD', ['RB', 'CONGE'], 'Congé sur les arêtes d’un solide (rayon constant ou variable)', (ctx, app) => filletSolidEdges(ctx, app));
const chamferEdge = cmd('CHAMFEREDGE', 'CHANFREINBORD', ['CB3', 'CHB'], 'Chanfrein sur les arêtes d’un solide', (ctx, app) => chamferSolidEdges(ctx, app));

const shell = cmd('SHELL', 'COQUE', ['GAINE'], 'Évide un solide avec une épaisseur de paroi (faces ouvertes en option)', async (ctx, app) => {
  const { e } = await pickRequired(ctx, 'Choisissez un solide 3D', isSolid);
  const faces: number[] = [];
  const show = () => app.setSubHighlight({ handle: e.handle, edges: [], faces });
  show();
  try {
    for (;;) {
      const r = await pickEntity(ctx, `Supprimer des faces (ouvertures) : ${faces.length} face(s). Entrée pour continuer`, { pickMode: 'face', filter: (x) => x.handle === e.handle, allowNone: true });
      if (r === null) break;
      if (typeof r === 'string' || r.sub === undefined) continue;
      const k = faces.indexOf(r.sub);
      if (k >= 0) faces.splice(k, 1);
      else faces.push(r.sub);
      show();
    }
  } finally {
    app.setSubHighlight(null);
  }
  const t = (await getDistance(ctx, 'Entrez la distance de décalage de la coque (épaisseur)', { defaultValue: 1, allowZero: false })) as number;
  const s = e as Solid3D;
  const op = { op: 'shell', shapeId: s.shapeId, faces, thickness: t } as const;
  const res = await app.solid(ctx, op);
  app.doc.replaceEntity(s.handle, { shapeId: res.shapeId, display: res.display, name: 'Coque', history: extend(s.history, modifyStep(op, 'Coque')) });
  ctx.print(faces.length ? `Coque créée avec ${faces.length} ouverture(s).` : 'Solide évidé (cavité fermée).');
});

// ---------------------------------------------------------------------------
// Outils 3D
// ---------------------------------------------------------------------------

const rotate3d = cmd('3DROTATE', 'ROTATION3D', ['3R', 'ROT3D'], 'Rotation autour d’un axe X, Y, Z ou quelconque', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  const polys = outlines(app, hs);
  const base = await getPoint(ctx, 'Spécifiez le point de base');
  const ax = await getKeyword(ctx, 'Choisissez l’axe de rotation', [kw('X', 'X'), kw('Y', 'Y'), kw('Z', 'Z'), kw('2Points', '2Points', '2')], 'Z');
  let dir: Vec3 = ax === 'X' ? { x: 1, y: 0, z: 0 } : ax === 'Y' ? { x: 0, y: 1, z: 0 } : Z;
  let o = base;
  if (ax === '2Points') {
    o = await getPoint(ctx, 'Spécifiez le premier point de l’axe', { defaultValue: base });
    const p2 = await getPoint(ctx, 'Spécifiez le deuxième point de l’axe', { basePoint: o });
    dir = sub(p2, o);
  }
  const ang = (await getAngle(ctx, 'Spécifiez l’angle de rotation', { defaultValue: Math.PI / 2 })) as number;
  void polys;
  await app.transformEntities(hs, rotationAxis(o, dir, ang), { label: 'Rotation 3D', ctx });
});

const mirror3d = cmd('MIRROR3D', 'MIROIR3D', ['MI3D'], 'Symétrie par rapport à un plan', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  const { origin, normal } = await getPlane(ctx, 'Spécifiez le premier point du plan de symétrie');
  const del = await getKeyword(ctx, 'Effacer les objets sources ?', [kw('Yes', 'Oui', 'O'), kw('No', 'Non', 'N')], 'No');
  await app.transformEntities(hs, reflectPlane(origin, normal), { copy: del === 'No', label: 'Miroir 3D', ctx });
});

const move3d = cmd('3DMOVE', 'DEPLACER3D', ['3DM'], 'Déplace des objets en 3D (x, y, z)', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  const polys = outlines(app, hs);
  const base = await getPoint(ctx, 'Spécifiez le point de base');
  const p2 = await getPoint(ctx, 'Spécifiez le deuxième point (ex. @0,0,10)', { basePoint: base, preview: (p) => polys.map((pl) => pl.map((q) => add(q, sub(p, base)))) });
  await app.transformEntities(hs, translation(sub(p2, base)), { label: 'Déplacer 3D', ctx });
});

const slice = cmd('SLICE', 'COUPE', ['CP3D', 'SL'], 'Coupe des solides par un plan', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les solides à couper', isSolid);
  if (!hs.length) return;
  const { origin, normal } = await getPlane(ctx, 'Spécifiez le premier point du plan de coupe');
  const r = await getPointOrKeyword(ctx, 'Spécifiez un point du côté à conserver', { keywords: [kw('Both', 'conserver les Deux côtés', 'D')], defaultValue: 'Both' });
  const keep = r.point ? (dot(sub(r.point, origin), normal) >= 0 ? 'positive' : 'negative') : 'both';
  for (const h of hs) {
    const s = app.doc.get(h) as Solid3D;
    await app.ensureKernel(ctx);
    const parts = await app.kernel.call<import('../../kernel/protocol').SolidResult[]>({ op: 'slice', shapeId: s.shapeId, origin, normal, keep });
    app.doc.transaction('Coupe', () => {
      app.doc.removeEntity(h);
      parts.forEach((p) => app.addSolid(p, s.name, s, ctx));
    });
  }
});

const thicken = cmd('THICKEN', 'EPAISSIR', ['EP'], 'Transforme une surface en solide d’épaisseur donnée', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les surfaces à épaissir', isSurface);
  if (!hs.length) return;
  const t = (await getDistance(ctx, 'Spécifiez l’épaisseur', { defaultValue: 1, allowZero: false, allowNegative: true })) as number;
  for (const h of hs) {
    const s = app.doc.get(h) as Solid3D;
    const op = { op: 'thicken', shapeId: s.shapeId, thickness: t } as const;
    const res = await app.solid(ctx, op);
    app.doc.replaceEntity(h, { shapeId: res.shapeId, display: res.display, name: 'Surface épaissie', history: extend(s.history, modifyStep(op, 'Épaissir')) });
  }
});

/** Corps maillé importé (STL/3MF). */
export const isMeshBody = (e: Entity) => e.type === '3DSOLID' && e.display.meshTriangles !== undefined;

const convToSolid = cmd('CONVTOSOLID', 'CONVSOLIDE', ['CVS', 'CONVSOL'], 'Convertit un corps maillé (STL/3MF) en solide B-rep modifiable (raccords, coque, appuyer/tirer)', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les corps maillés à convertir', isMeshBody);
  if (!hs.length) return ctx.print('Aucun corps maillé sélectionné.');
  const tris = hs.reduce((n, h) => n + ((app.doc.get(h) as Solid3D).display.meshTriangles ?? 0), 0);
  // ≈ 2 ms par triangle (construction + fusion des faces coplanaires)
  if (tris > 20000 && !(await app.ui.confirm(`${tris} triangles : la conversion peut prendre environ ${Math.ceil((tris * 2.2) / 60000)} min et rendre le dessin lent. Continuer ?`, 'Conversion en solide'))) return;
  for (const h of hs) {
    const s = app.doc.get(h) as Solid3D;
    ctx.print(`Conversion de ${s.name || h} (${s.display.meshTriangles} triangles)…`);
    const res = await app.solid(ctx, { op: 'convertToSolid', shapeId: s.shapeId, merge: true });
    app.doc.replaceEntity(h, { shapeId: res.shapeId, display: res.display });
    ctx.print(`${s.name || h} : solide de ${res.display.faceCount} face(s).`);
  }
});

const planeSurf = cmd('PLANESURF', 'SURFPLANE', ['SP'], 'Surface plane (rectangle ou contour fermé)', async (ctx, app) => {
  const r = await getPointOrKeyword(ctx, 'Spécifiez le premier coin', { keywords: [kw('Object', 'Objet', 'O')], defaultValue: 'Object' });
  if (r.point) {
    const a = r.point;
    const b = await getPoint(ctx, 'Spécifiez l’autre coin', { noRubberBand: true, preview: (p) => boxWire(a, p, 0).slice(0, 1) });
    const pts = boxWire(a, { ...b, z: a.z }, 0)[0]!.slice(0, 4);
    app.addSolid(await app.solid(ctx, { op: 'planeSurface', profile: { kind: 'poly', points: pts, closed: true } }), 'Surface plane', undefined, ctx);
    return;
  }
  const hs = await selectObjects(ctx, 'Choisissez les contours fermés', closedOnly);
  for (const it of profilesOf(app, hs)) app.addSolid(await app.solid(ctx, { op: 'planeSurface', profile: it.p }), 'Surface plane', it.e, ctx);
  app.doc.transaction('Surface plane', () => hs.forEach((h) => app.doc.removeEntity(h)));
});

const surfNetwork = cmd('SURFNETWORK', 'SURFRESEAU', ['SR', 'SURFCARREAU'], 'Surface tendue sur un contour de courbes (même gauches)', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les courbes du contour (boucle fermée)', (e) => profileable(e));
  if (!hs.length) return;
  const edges = profilesOf(app, hs).map((i) => i.p);
  app.addSolid(await app.solid(ctx, { op: 'patch', edges }), 'Surface réseau', app.doc.get(hs[0]!), ctx);
});

const checkSolid = cmd('SOLIDCHECK', 'VERIFSOLIDE', ['VS3D', 'CHECKSOLID'], 'Vérifie la validité et l’étanchéité d’un solide', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les solides à vérifier', isBody);
  await app.ensureKernel(ctx);
  for (const h of hs) {
    const s = app.doc.get(h) as Solid3D;
    const r = await app.kernel.call<import('../../kernel/protocol').CheckReport>({ op: 'check', shapeId: s.shapeId });
    const tight = r.freeEdges === 0 && r.solids > 0;
    ctx.print(`${s.name} [${h}] : ${r.valid ? 'B-rep valide' : 'B-rep INVALIDE'}, ${r.solids} solide(s), ${r.faces} faces, ${r.edges} arêtes, ${r.freeEdges} arête(s) libre(s) → ${tight ? 'étanche (imprimable)' : 'non étanche'}, volume ${fmt(r.volume, 3)} mm³`);
    app.ui.toast(`${s.name} : ${r.valid && tight ? 'solide valide et étanche' : 'problème détecté (voir la ligne de commande)'}`, r.valid && tight ? 'success' : 'error');
  }
});

export const solidCommands: CommandDefinition[] = [
  convToSolid,
  box,
  cylinder,
  cone,
  sphere,
  pyramid,
  torus,
  extrude,
  revolve,
  sweep,
  loft,
  helix,
  union,
  subtract,
  intersect,
  filletEdge,
  chamferEdge,
  shell,
  rotate3d,
  mirror3d,
  move3d,
  slice,
  thicken,
  planeSurf,
  surfExtrude,
  surfRevolve,
  surfSweep,
  surfLoft,
  surfNetwork,
  checkSolid,
];
