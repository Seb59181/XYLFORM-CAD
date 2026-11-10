/**
 * Tôlerie : TOLE (tôle de base tirée d'un contour fermé, bords pliés sur les arêtes cliquées,
 * aussi pour modifier une tôle existante) et DEPLIER (mise à plat : contour développé, lignes
 * de pliage, perçages reportés, export DXF pour la découpe laser). Les cotes de la tôle
 * (épaisseur, rayon, facteur K, angle et longueur de chaque bord) restent modifiables dans
 * l'historique (Propriétés).
 */
import type { CommandContext, CommandDefinition, Vec3 } from '../../core/commands';
import type { Entity, Feature, NewEntity } from '../../core/document/Document';
import { cleanContour, flangeFrame, flangeProfile, flatPattern, SHEET_DEFAULTS, sheetLayout, unfoldPoint, type SheetMetalDef } from '../../core/geometry/sheetmetal';
import { apply, multiply, IDENTITY, type Affine } from '../../core/math/affine';
import { writeDxf } from '../../io/dxf';
import { saveFile } from '../../io/fileAccess';
import type { AppHost } from '../AppHost';
import { createStep } from '../history';
import { cmd, fmt, getDistance, getKeyword, getNumber, getPointOrKeyword, kw, pickEntity } from './helpers';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

/** Réglages mémorisés d'une tôle à l'autre. */
const last = { ...SHEET_DEFAULTS, inside: true, up: true };

export function sheetDefOf(e: Entity | undefined): SheetMetalDef | null {
  if (e?.type !== '3DSOLID') return null;
  const f = e.history?.[0];
  return f?.kind === 'create' && f.op.op === 'sheetMetal' ? f.op.def : null;
}

function closedContour(e: Entity): Vec3[] | null {
  if (e.type !== 'POLYLINE' || e.bulges?.some((b) => Math.abs(b) > 1e-9)) return null;
  const pts = cleanContour(e.points);
  const closed = e.closed || (e.points.length > 3 && Math.hypot(e.points[0]!.x - e.points[e.points.length - 1]!.x, e.points[0]!.y - e.points[e.points.length - 1]!.y) < 1e-9);
  if (!closed || pts.length < 3) return null;
  const z = pts[0]!.z;
  return pts.some((p) => Math.abs(p.z - z) > 1e-6) ? null : pts;
}

/** Arête du contour la plus proche d'un point (dans le plan). */
function nearestEdge(pts: Vec3[], p: Vec3): { i: number; d: number } {
  let best = { i: -1, d: Infinity };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!, b = pts[(i + 1) % pts.length]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    const d = Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    if (d < best.d) best = { i, d };
  }
  return best;
}

/** Contours d'aperçu de la tôle (profils de pli aux deux bouts de chaque bord). */
function previewOf(def: SheetMetalDef): Vec3[][] {
  const out: Vec3[][] = [];
  const pts = cleanContour(def.points);
  out.push([...pts, pts[0]!]);
  try {
    const L = sheetLayout(def);
    const z = L.z0 + def.thickness;
    out.push([...L.base, L.base[0]!].map((p) => ({ ...p, z })));
    for (const fl of L.flanges) {
      const prof = flangeProfile(def, fl);
      const fr = flangeFrame(def, fl, L.z0);
      const m = fr.matrix as Affine;
      const at = (q: Vec3, s: number) => apply(m, { x: q.x, y: q.y, z: s });
      const ring = (s: number) => [...prof.points, prof.points[0]!].map((q) => at(q, s));
      out.push(ring(0), ring(fr.length));
      for (const q of prof.points) out.push([at(q, 0), at(q, fr.length)]);
    }
  } catch {
    // définition momentanément impossible (bord trop court…) : contour seul
  }
  return out;
}

async function editFlanges(ctx: CommandContext, def: SheetMetalDef): Promise<SheetMetalDef | null> {
  const pts = cleanContour(def.points);
  for (;;) {
    let err = '';
    try {
      sheetLayout(def);
    } catch (e) {
      err = (e as Error).message;
    }
    ctx.print(`Tôle ép. ${fmt(def.thickness)}, Ri ${fmt(def.radius)}, K ${fmt(def.k)}, pli ${def.inside ? 'dans le contour' : 'hors contour'} ; prochain bord : ${fmt(last.angle)}° ${last.up ? 'vers le haut' : 'vers le bas'}, longueur ${fmt(last.length)}. ${def.flanges.length} bord(s).${err ? ` ⚠ ${err}` : ''}`);
    const r = await getPointOrKeyword(ctx, 'Cliquez une arête du contour à plier ou déplier (Entrée pour valider)', {
      keywords: [
        kw('All', 'Tous', 'TO', 'Plier toutes les arêtes (bac)'),
        kw('Angle', 'Angle', 'A', 'Angle des bords suivants'),
        kw('Length', 'Longueur', 'L', 'Longueur extérieure des bords suivants'),
        kw('Direction', 'Sens', 'S', 'Vers le haut ou vers le bas'),
        kw('Thickness', 'Epaisseur', 'E', 'Épaisseur de tôle'),
        kw('Radius', 'Rayon', 'R', 'Rayon intérieur de pliage'),
        kw('KFactor', 'FacteurK', 'K', 'Fibre neutre (0,44 pour l’acier)'),
        kw('Position', 'Position', 'P', 'Pli dans le contour ou ajouté'),
        ...(def.flanges.length ? [kw('Undo', 'Annuler', 'AN', 'Retire le dernier bord')] : []),
      ],
      allowNone: true,
      noRubberBand: true,
      preview: () => previewOf(def),
    });
    if (r.none) {
      if (err) {
        ctx.print(`Impossible de créer la tôle : ${err}`);
        continue;
      }
      return def;
    }
    if (r.point) {
      const { i, d } = nearestEdge(pts, r.point);
      if (i < 0) continue;
      const size = Math.max(...pts.map((p) => Math.hypot(p.x - pts[0]!.x, p.y - pts[0]!.y)));
      if (d > Math.max(size * 0.15, def.thickness * 3)) {
        ctx.print('Cliquez près d’une arête du contour.');
        continue;
      }
      const has = def.flanges.some((f) => f.edge === i);
      def = { ...def, flanges: has ? def.flanges.filter((f) => f.edge !== i) : [...def.flanges, { edge: i, angle: last.angle, length: last.length, up: last.up }] };
      continue;
    }
    switch (r.keyword) {
      case 'All':
        def = { ...def, flanges: pts.map((_, i) => def.flanges.find((f) => f.edge === i) ?? { edge: i, angle: last.angle, length: last.length, up: last.up }) };
        break;
      case 'Angle': {
        const a = (await getNumber(ctx, 'Angle de pliage (°)', { defaultValue: last.angle, allowZero: false })) as number;
        if (a > 0 && a <= 150) last.angle = a;
        else ctx.print('Angle entre 1 et 150°.');
        break;
      }
      case 'Length':
        last.length = (await getDistance(ctx, 'Longueur extérieure du bord', { defaultValue: last.length, allowZero: false })) as number;
        break;
      case 'Direction':
        last.up = (await getKeyword(ctx, 'Sens du pliage', [kw('Up', 'Haut', 'H'), kw('Down', 'Bas', 'B')], last.up ? 'Up' : 'Down')) === 'Up';
        break;
      case 'Thickness':
        last.thickness = (await getDistance(ctx, 'Épaisseur de tôle', { defaultValue: def.thickness, allowZero: false })) as number;
        def = { ...def, thickness: last.thickness };
        break;
      case 'Radius':
        last.radius = (await getDistance(ctx, 'Rayon intérieur de pliage', { defaultValue: def.radius, allowZero: true })) as number;
        def = { ...def, radius: last.radius };
        break;
      case 'KFactor': {
        const k = (await getNumber(ctx, 'Facteur K (0 à 1)', { defaultValue: def.k, allowZero: true })) as number;
        last.k = Math.max(0, Math.min(1, k));
        def = { ...def, k: last.k };
        break;
      }
      case 'Position':
        last.inside = (await getKeyword(ctx, 'Position du pli', [kw('Inside', 'Interieur', 'I', 'Le contour est l’encombrement extérieur'), kw('Outside', 'Exterieur', 'E', 'Les plis s’ajoutent au contour')], def.inside ? 'Inside' : 'Outside')) === 'Inside';
        def = { ...def, inside: last.inside };
        break;
      case 'Undo':
        def = { ...def, flanges: def.flanges.slice(0, -1) };
        break;
    }
  }
}

const sheet = cmd('SHEETMETAL', 'TOLE', ['TOLERIE', 'TOLEBASE', 'BORDTOLE', 'SM'], 'Tôlerie : tôle de base depuis un contour fermé et bords pliés (angle, longueur, rayon, facteur K)', async (ctx, app) => {
  const pick = await pickEntity(ctx, 'Choisissez le contour fermé de la tôle (polyligne, rectangle) ou une tôle à modifier', { filter: (e) => !!closedContour(e) || !!sheetDefOf(e) });
  if (!pick || typeof pick === 'string') return;
  const e = app.doc.get(pick.handle);
  if (!e) return;
  const existing = sheetDefOf(e);
  if (existing) {
    const def = await editFlanges(ctx, existing);
    if (!def) return;
    const s = e as Solid3D;
    const h0 = s.history![0]!;
    await app.rebuildSolid(s.handle, [{ ...h0, op: { op: 'sheetMetal', def } } as Feature, ...s.history!.slice(1)], 'Modifier la tôle', ctx);
    ctx.print(`Tôle modifiée : ${def.flanges.length} bord(s).`);
    return;
  }
  const pts = closedContour(e)!;
  const def0: SheetMetalDef = { points: pts, thickness: last.thickness, radius: last.radius, k: last.k, inside: last.inside, flanges: [] };
  const def = await editFlanges(ctx, def0);
  if (!def) return;
  await app.ensureKernel(ctx);
  const op = { op: 'sheetMetal', def } as const;
  const res = await app.solid(ctx, op);
  app.addSolid(res, 'Tôle', e, ctx, createStep(op, 'Tôle'));
  app.doc.transaction('Tôle', () => app.doc.removeEntity(e.handle));
  ctx.print(`Tôle créée : épaisseur ${fmt(def.thickness)}, ${def.flanges.length} bord(s), volume ${fmt(res.display.volume)} mm³. DEPLIER pour la mise à plat.`);
});

/** Inverse d'un déplacement rigide (rotation + translation, échelle uniforme tolérée). */
function invertRigid(m: Affine): Affine {
  const s2 = m[0] * m[0] + m[4] * m[4] + m[8] * m[8] || 1;
  const r = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]].map((v) => v / s2);
  const t = { x: m[3], y: m[7], z: m[11] };
  return [r[0]!, r[1]!, r[2]!, -(r[0]! * t.x + r[1]! * t.y + r[2]! * t.z), r[3]!, r[4]!, r[5]!, -(r[3]! * t.x + r[4]! * t.y + r[5]! * t.z), r[6]!, r[7]!, r[8]!, -(r[6]! * t.x + r[7]! * t.y + r[8]! * t.z)];
}

const SHEET_LAYERS = [
  { name: 'TOLE-Contour', color: '#ffffff', lineweight: 0.35 },
  { name: 'TOLE-Plis', color: '#e2a847', lineweight: 0.18, linetype: 'CENTER' as const },
  { name: 'TOLE-Zones', color: '#7d8896', lineweight: 0.13, linetype: 'HIDDEN' as const },
];

const unfold = cmd('FLATPATTERN', 'DEPLIER', ['MISEAPLAT', 'DEVELOPPE', 'FLAT', 'DEPLIAGE'], 'Mise à plat d’une tôle : contour développé, lignes de pliage, perçages, export DXF pour la découpe', async (ctx, app) => {
  const pick = await pickEntity(ctx, 'Choisissez la tôle à mettre à plat', { filter: (e) => !!sheetDefOf(e) });
  if (!pick || typeof pick === 'string') return;
  const s = app.doc.get(pick.handle) as Solid3D | undefined;
  const def = sheetDefOf(s);
  if (!s || !def) return;
  const fp = flatPattern(def);
  // perçages de l'historique, ramenés dans le repère de la tôle puis dépliés
  const holes: { c: Vec3; r: number }[] = [];
  let lost = 0;
  let m: Affine = IDENTITY;
  for (const f of s.history ?? []) {
    if (f.off) continue;
    if (f.kind === 'transform') m = multiply(f.matrix, m);
    if (f.kind === 'hole') {
      const inv = invertRigid(m);
      for (const p of f.at) {
        const q = unfoldPoint(def, fp.layout, apply(inv, p), def.thickness * 0.6 + 1e-3);
        if (q) holes.push({ c: q, r: f.spec.diameter / 2 });
        else lost++;
      }
    }
  }
  if (s.history?.some((f) => !f.off && (f.kind === 'boolean' || f.kind === 'modify'))) ctx.print('Remarque : les opérations booléennes, congés ou chanfreins faits après la tôle ne sont pas reportés sur le développé.');
  if (lost) ctx.print(`${lost} perçage(s) dans une zone de pli non reporté(s).`);
  // emprise et placement
  const xs = fp.outline.map((p) => p.x), ys = fp.outline.map((p) => p.y);
  const min = { x: Math.min(...xs), y: Math.min(...ys) }, W = Math.max(...xs) - min.x, H = Math.max(...ys) - min.y;
  const bb = s.display.bbox;
  const def0 = { x: bb.max.x + 20, y: bb.min.y, z: 0 };
  const shifted = (p: Vec3, o: Vec3): Vec3 => ({ x: p.x - min.x + o.x, y: p.y - min.y + o.y, z: o.z });
  const r = await getPointOrKeyword(ctx, 'Coin inférieur gauche du développé (Entrée = à côté de la tôle)', {
    allowNone: true,
    noRubberBand: true,
    preview: (p) => [[...fp.outline, fp.outline[0]!].map((q) => shifted(q, p)), ...fp.bends.map((b) => [shifted(b.a, p), shifted(b.b, p)])],
  });
  const o = r.point ? { ...r.point, z: 0 } : def0;
  for (const l of SHEET_LAYERS)
    if (!app.doc.layer(l.name)) {
      app.doc.addLayer(l.name, l.color);
      app.doc.updateLayer(l.name, { lineweight: l.lineweight, ...('linetype' in l ? { linetype: l.linetype } : {}) });
    }
  const th = Math.max(2.5, Math.min(W, H) / 40);
  const ents: NewEntity[] = [{ type: 'POLYLINE', layer: 'TOLE-Contour', points: fp.outline.map((p) => shifted(p, o)), closed: true }];
  for (const h of holes) ents.push({ type: 'CIRCLE', layer: 'TOLE-Contour', center: shifted(h.c, o), radius: h.r });
  for (const b of fp.bends) {
    const a = shifted(b.a, o), c = shifted(b.b, o);
    ents.push({ type: 'LINE', layer: 'TOLE-Plis', start: a, end: c });
    let ang = Math.atan2(c.y - a.y, c.x - a.x);
    if (ang > Math.PI / 2 + 1e-6 || ang < -Math.PI / 2 - 1e-6) ang += Math.PI;
    const mid = { x: (a.x + c.x) / 2 - Math.sin(ang) * th * 0.6, y: (a.y + c.y) / 2 + Math.cos(ang) * th * 0.6, z: 0 };
    ents.push({ type: 'TEXT', layer: 'TOLE-Plis', position: mid, height: th, text: b.label, rotation: ang, align: 'center' });
  }
  for (const [a, b] of fp.zones) ents.push({ type: 'LINE', layer: 'TOLE-Zones', start: shifted(a, o), end: shifted(b, o) });
  const handles: string[] = [];
  app.doc.transaction('Mise à plat', () => ents.forEach((e) => handles.push(app.doc.addEntity(e))));
  const ba = fp.layout.flanges.map((f) => fmt(f.ba));
  ctx.print(`Développé : flan ${fmt(W)} × ${fmt(H)} mm, ${fp.bends.length} pli(s)${ba.length ? ` (longueur développée par pli : ${[...new Set(ba)].join(' / ')})` : ''}, ${holes.length} perçage(s).`);
  const ex = await getKeyword(ctx, 'Exporter le développé en DXF pour la découpe ?', [kw('Yes', 'Oui', 'O'), kw('No', 'Non', 'N')], 'No');
  if (ex === 'Yes') {
    const es = handles.map((h) => app.doc.get(h)).filter((e): e is Entity => !!e);
    const t = await saveFile(writeDxf(es, app.doc.layers.filter((l) => l.name.startsWith('TOLE-')), app.sysvars.INSUNITS), { name: `${s.name || 'Tole'}-developpe.dxf`, mime: 'application/dxf', description: 'Dessin DXF', extensions: ['.dxf'] });
    if (t) ctx.print(`Développé exporté : ${t.name} (calque TOLE-Contour = découpe, TOLE-Plis = pliage).`);
  }
});

export const sheetMetalCommands: CommandDefinition[] = [sheet, unfold];
