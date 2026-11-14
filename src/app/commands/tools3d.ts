/**
 * Espaces de travail et outils 3D :
 *   - ESPACETRAVAIL (2D léger / 3D), CLICDROIT (durée du clic droit long) ;
 *   - APPUYERTIRER : tirer ou pousser une face plane d'un solide, ou extruder un contour fermé
 *     (joint au corps qu'il touche ou enlevé de celui-ci) ;
 *   - ESQUISSE / ELEV : dessiner sur une face horizontale (plan de travail à sa hauteur) ;
 *   - ANALYSECOUPE : coupe de visualisation par un plan X, Y, Z ou parallèle à une face ;
 *   - MASQUEROBJETS, ISOLER, AFFICHERTOUT (œil du Navigateur).
 */
import type { CommandContext, CommandDefinition, Vec3 } from '../../core/commands';
import type { Entity } from '../../core/document/Document';
import { faceInfo, type FaceInfo } from '../../core/geometry/faces';
import { curvePoints, isClosedProfile, profileOf } from '../../core/entities/geometry';
import type { AppHost } from '../AppHost';
import { booleanStep, createStep, extend, modifyStep } from '../history';
import { cmd, fmt, getDistance, getKeyword, getNumber, isSolid, kw, pickEntity, selectObjects } from './helpers';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

const addS = (p: Vec3, u: Vec3, t: number): Vec3 => ({ x: p.x + u.x * t, y: p.y + u.y * t, z: p.z + u.z * t });
const along = (p: Vec3, o: Vec3, u: Vec3) => (p.x - o.x) * u.x + (p.y - o.y) * u.y + (p.z - o.z) * u.z;

// ---------------------------------------------------------------------------
// Espaces de travail, clic droit
// ---------------------------------------------------------------------------

const workspace = cmd('WSCURRENT', 'ESPACETRAVAIL', ['ESPACE', 'WS'], 'Espace de travail : dessin 2D (léger) ou modélisation 3D', async (ctx, app) => {
  const v = await getKeyword(
    ctx,
    'Espace de travail',
    [kw('2D', '2D', '2', 'Dessin 2D : vue de dessus, sans orbite, noyau 3D non chargé'), kw('3D', '3D', '3', 'Modélisation 3D : solides, cube de vue, orbite')],
    app.settings.workspace === '2d' ? '3D' : '2D',
  );
  const ws = v === '2D' ? '2d' : '3d';
  app.set('workspace', ws);
  ctx.print(ws === '2d' ? 'Espace Dessin 2D : vue de dessus, onglets 3D masqués, noyau 3D chargé seulement si une commande 3D le demande.' : 'Espace Modélisation 3D : cube de vue en haut à droite, Maj + molette = orbite.');
});

const rightClick = cmd('SHORTCUTMENUDURATION', 'CLICDROIT', ['RIGHTCLICK', 'DUREEMENU'], 'Clic droit court = Entrée, appui long = menu contextuel : durée de l’appui long', async (ctx, app) => {
  const v = await getNumber(ctx, 'Durée d’appui du clic droit pour afficher le menu, en ms (0 = toujours le menu)', { integer: true, defaultValue: app.settings.rightClickDelay, allowZero: true });
  if (typeof v !== 'number') return;
  const ms = Math.max(0, Math.min(3000, Math.round(v)));
  app.set('rightClickDelay', ms);
  ctx.print(ms ? `Clic droit : court = Entrée, maintenu ${ms} ms = menu.` : 'Clic droit : menu contextuel immédiat.');
});

// ---------------------------------------------------------------------------
// Appuyer / tirer
// ---------------------------------------------------------------------------

let lastPull = 10;

function solidUnder(app: AppHost, p: Vec3, exclude?: string): Solid3D | null {
  const tol = 1e-6;
  for (const e of app.doc.all()) {
    if (e.type !== '3DSOLID' || e.handle === exclude || !isSolid(e) || !app.doc.isVisible(e)) continue;
    const b = e.display.bbox;
    const t = tol * Math.max(1, b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
    if (p.x >= b.min.x - t && p.x <= b.max.x + t && p.y >= b.min.y - t && p.y <= b.max.y + t && p.z >= b.min.z - t && p.z <= b.max.z + t) return e;
  }
  return null;
}

async function pullFace(ctx: CommandContext, app: AppHost, s: Solid3D, face: number, info: FaceInfo): Promise<void> {
  const o = info.centroid, n = info.normal;
  const loops = info.boundary;
  app.setSubHighlight({ handle: s.handle, edges: [], faces: [face] });
  let d: number;
  try {
    const r = await getDistance(ctx, 'Distance (positive = tirer, négative = pousser dans la matière)', {
      basePoint: o,
      axis: n,
      allowNegative: true,
      allowZero: false,
      defaultValue: lastPull,
      noRubberBand: true,
      preview: (p) => {
        const t = along(p, o, n);
        const moved = loops.map((l) => l.map((q) => addS(q, n, t)));
        const step = Math.max(1, Math.floor((loops[0]?.length ?? 1) / 6));
        const ribs = loops.flatMap((l) => l.filter((_, i) => i % step === 0).map((q) => [q, addS(q, n, t)]));
        return [...moved, ...ribs, [o, addS(o, n, t)]];
      },
    });
    d = r as number;
  } finally {
    app.setSubHighlight(null);
  }
  const op = { op: 'pressPull', shapeId: s.shapeId, face, distance: d } as const;
  const res = await app.solid(ctx, op);
  app.doc.replaceEntity(s.handle, { shapeId: res.shapeId, display: res.display, history: extend(s.history, modifyStep(op, d > 0 ? 'Tirer' : 'Pousser')) });
  lastPull = Math.abs(d);
  ctx.print(`${d > 0 ? 'Face tirée' : 'Face poussée'} de ${fmt(Math.abs(d))} — volume ${fmt(res.display.volume, 3)}.`);
}

async function pullProfile(ctx: CommandContext, app: AppHost, e: Entity): Promise<void> {
  const profile = profileOf(e)!;
  const outline = curvePoints(e);
  const base = outline[0]?.[0] ?? { x: 0, y: 0, z: 0 };
  let mode: 'auto' | 'new' = 'auto';
  let h: number;
  for (;;) {
    const r = await getDistance(ctx, `Hauteur (${mode === 'new' ? 'nouveau corps' : 'joint ou enlève le corps touché'})`, {
      basePoint: base,
      vertical: true,
      allowNegative: true,
      allowZero: false,
      defaultValue: lastPull,
      noRubberBand: true,
      keywords: [kw('New', 'Nouveau', 'N', 'Créer un corps séparé'), kw('Auto', 'Auto', 'A', 'Joindre ou couper le corps touché')],
      preview: (p) => {
        const hh = p.z - base.z;
        return outline.flatMap((pl) => [pl, pl.map((q) => ({ ...q, z: q.z + hh })), ...[0, Math.floor(pl.length / 3), Math.floor((2 * pl.length) / 3)].map((k) => [pl[k]!, { ...pl[k]!, z: pl[k]!.z + hh }])]);
      },
    });
    if (r === 'New') mode = 'new';
    else if (r === 'Auto') mode = 'auto';
    else {
      h = r as number;
      break;
    }
  }
  lastPull = Math.abs(h);
  const exOp = { op: 'extrude', profile, height: h, taperDeg: 0 } as const;
  const res = await app.solid(ctx, exOp);
  const tool = createStep(exOp, 'Extrusion');
  // corps touché : extrusion vers l'intérieur = enlèvement, vers l'extérieur = ajout
  const target = mode === 'auto' ? solidUnder(app, base) : null;
  if (!target) {
    app.doc.transaction('Appuyer/tirer', () => {
      app.addSolid(res, 'Extrusion', e, ctx, tool);
      app.doc.removeEntity(e.handle);
    });
    ctx.print(`Nouveau corps extrudé de ${fmt(h)}.`);
    return;
  }
  const mid = { ...base, z: base.z + h / 2 };
  const cut = !!solidUnder(app, mid) && solidUnder(app, mid)!.handle === target.handle;
  const merged = await app.solid(ctx, { op: 'boolean', kind: cut ? 'subtract' : 'union', targets: [target.shapeId], tools: [res.shapeId] });
  app.doc.transaction('Appuyer/tirer', () => {
    app.doc.replaceEntity(target.handle, { shapeId: merged.shapeId, display: merged.display, history: extend(target.history, booleanStep(cut ? 'subtract' : 'union', [tool], cut ? 'Poche (appuyer)' : 'Bossage (tirer)')) });
    app.doc.removeEntity(e.handle);
  });
  ctx.print(`${cut ? 'Enlevé de' : 'Joint à'} « ${target.name} » (${fmt(Math.abs(h))}).`);
}

const pressPull = cmd('PRESSPULL', 'APPUYERTIRER', ['PP', 'APPUYER', 'TIRER', 'PRESSPULL'], 'Tire ou pousse une face plane d’un solide, ou extrude un contour fermé', async (ctx, app) => {
  for (let first = true; ; first = false) {
    const r = await pickEntity(ctx, first ? 'Choisissez une face plane d’un solide ou un contour fermé' : 'Autre face ou contour (Entrée pour terminer)', {
      pickMode: 'face',
      filter: (e) => isSolid(e) || (isClosedProfile(e) && profileOf(e) !== null),
      allowNone: !first,
    });
    if (r === null || typeof r === 'string') return;
    const e = app.doc.get(r.handle);
    if (!e) continue;
    if (e.type === '3DSOLID') {
      if (r.sub === undefined) continue;
      const info = faceInfo(e.display, r.sub);
      if (!info?.planar) {
        ctx.print('Cette face n’est pas plane : choisissez une face plane (dessus, côté, fond de poche…).');
        continue;
      }
      await pullFace(ctx, app, e, r.sub, info);
    } else await pullProfile(ctx, app, e);
  }
});

// ---------------------------------------------------------------------------
// Esquisse sur une face, élévation
// ---------------------------------------------------------------------------

const sketch = cmd('SKETCH', 'ESQUISSE', ['ESQ', 'SKETCHONFACE'], 'Dessine sur une face plane horizontale (le plan de travail prend sa hauteur)', async (ctx, app) => {
  const r = await pickEntity(ctx, 'Choisissez une face plane horizontale d’un solide', {
    pickMode: 'face',
    filter: isSolid,
    keywords: [kw('Ground', 'Sol', 'S', 'Revenir au plan XY (Z = 0)')],
  });
  if (r === null) return;
  if (r === 'Ground') {
    app.setElevation(0);
    ctx.print('Esquisse sur le plan XY (Z = 0).');
    return;
  }
  if (typeof r === 'string') return;
  const e = app.doc.get(r.handle);
  if (e?.type !== '3DSOLID' || r.sub === undefined) return;
  const info = faceInfo(e.display, r.sub);
  if (!info?.planar || Math.abs(info.normal.z) < 0.9999) {
    ctx.print('Choisissez une face plane horizontale (dessus ou dessous du solide).');
    return;
  }
  const z = info.centroid.z;
  app.setElevation(z);
  app.viewport?.setView('TOP');
  ctx.print(`Esquisse sur la face à Z = ${fmt(z)} : dessinez vos contours, puis APPUYERTIRER pour les joindre ou les enlever du corps. ESQUISSE > Sol pour revenir à Z = 0.`);
});

const elev = cmd('ELEV', 'ELEV', ['ELEVATION'], 'Élévation du plan de travail (Z des nouveaux objets 2D)', async (ctx, app) => {
  const v = await getNumber(ctx, 'Nouvelle élévation par défaut', { defaultValue: app.processor.elevation, allowNegative: true, allowZero: true });
  if (typeof v !== 'number') return;
  app.setElevation(v);
  ctx.print(`Élévation : ${fmt(v)}.`);
});

// ---------------------------------------------------------------------------
// Analyse de coupe
// ---------------------------------------------------------------------------

export function modelBox(app: AppHost): { min: Vec3; max: Vec3 } | null {
  let box: { min: Vec3; max: Vec3 } | null = null;
  for (const e of app.doc.all()) {
    if (e.type !== '3DSOLID' || !app.doc.isVisible(e)) continue;
    const b = e.display.bbox;
    box = box
      ? { min: { x: Math.min(box.min.x, b.min.x), y: Math.min(box.min.y, b.min.y), z: Math.min(box.min.z, b.min.z) }, max: { x: Math.max(box.max.x, b.max.x), y: Math.max(box.max.y, b.max.y), z: Math.max(box.max.z, b.max.z) } }
      : { min: { ...b.min }, max: { ...b.max } };
  }
  return box;
}

/** Rectangle du plan de coupe dans l'emprise du modèle (aperçu). */
export function planeRect(o: Vec3, n: Vec3, size: number): Vec3[] {
  const a = Math.abs(n.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  let u = { x: n.y * a.z - n.z * a.y, y: n.z * a.x - n.x * a.z, z: n.x * a.y - n.y * a.x };
  const l = Math.hypot(u.x, u.y, u.z) || 1;
  u = { x: u.x / l, y: u.y / l, z: u.z / l };
  const v = { x: n.y * u.z - n.z * u.y, y: n.z * u.x - n.x * u.z, z: n.x * u.y - n.y * u.x };
  const h = size / 2;
  const c = (s: number, t: number) => ({ x: o.x + u.x * s * h + v.x * t * h, y: o.y + u.y * s * h + v.y * t * h, z: o.z + u.z * s * h + v.z * t * h });
  return [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1), c(-1, -1)];
}

const sectionAnalysis = cmd('SECTIONANALYSIS', 'ANALYSECOUPE', ['SECTION', 'COUPEVUE', 'ANACOUPE'], 'Coupe de visualisation des solides par un plan (sans les modifier)', async (ctx, app) => {
  const vp = app.viewport;
  if (!vp) return;
  if (app.settings.workspace === '2d') app.set('workspace', '3d');
  const box = modelBox(app);
  if (!box) return ctx.print('Aucun solide visible à couper.');
  const active = vp.section;
  const keys = [kw('X', 'X', 'X', 'Plan perpendiculaire à X'), kw('Y', 'Y', 'Y', 'Plan perpendiculaire à Y'), kw('Z', 'Z', 'Z', 'Plan horizontal'), kw('Face', 'Face', 'F', 'Parallèle à une face plane')];
  if (active) keys.push(kw('Flip', 'Inverser', 'I', 'Montrer l’autre moitié'), kw('Off', 'Arrêt', 'A', 'Supprimer la coupe'));
  const k = await getKeyword(ctx, 'Plan de coupe', keys, active ? 'Off' : 'Z');
  if (k === 'Off') {
    vp.setSection(null);
    return ctx.print('Analyse de coupe désactivée.');
  }
  if (k === 'Flip' && active) {
    const n = active.normal;
    vp.setSection({ origin: active.origin, normal: { x: -n.x, y: -n.y, z: -n.z } });
    return ctx.print('Coupe inversée.');
  }
  const center = { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 };
  const size = Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) * 1.1 || 10;
  let o = center;
  let axis: Vec3 = k === 'X' ? { x: 1, y: 0, z: 0 } : k === 'Y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  if (k === 'Face') {
    const r = await pickEntity(ctx, 'Choisissez une face plane', { pickMode: 'face', filter: isSolid });
    if (r === null || typeof r === 'string') return;
    const e = app.doc.get(r.handle);
    const info = e?.type === '3DSOLID' && r.sub !== undefined ? faceInfo(e.display, r.sub) : null;
    if (!info?.planar) return ctx.print('Cette face n’est pas plane.');
    o = info.centroid;
    axis = info.normal;
  }
  // côté conservé : celui dont la face coupée est tournée vers la caméra
  const eye = vp.viewDirection();
  const keep = along(eye, { x: 0, y: 0, z: 0 }, axis) > 0 ? { x: -axis.x, y: -axis.y, z: -axis.z } : axis;
  const extentAlong = Math.abs((box.max.x - box.min.x) * axis.x) + Math.abs((box.max.y - box.min.y) * axis.y) + Math.abs((box.max.z - box.min.z) * axis.z);
  try {
    const d = await getDistance(ctx, 'Position du plan (décalage, faites glisser)', {
      basePoint: o,
      axis,
      allowNegative: true,
      allowZero: true,
      defaultValue: k === 'Face' ? -extentAlong / 2 : 0,
      noRubberBand: true,
      preview: (p) => {
        const t = along(p, o, axis);
        const at = addS(o, axis, t);
        vp.setSection({ origin: at, normal: keep }, true);
        return [planeRect(at, axis, size)];
      },
    });
    const at = addS(o, axis, d as number);
    vp.setSection({ origin: at, normal: keep });
    ctx.print(`Coupe ${k === 'Face' ? 'parallèle à la face' : `perpendiculaire à ${k}`} active (ANALYSECOUPE > Inverser / Arrêt).`);
  } catch (err) {
    vp.setSection(active);
    throw err;
  }
});

// ---------------------------------------------------------------------------
// Masquer / isoler / tout afficher
// ---------------------------------------------------------------------------

function setHidden(app: AppHost, ents: Entity[], hidden: boolean, label: string): number {
  const targets = ents.filter((e) => !!e.hidden !== hidden);
  if (targets.length) app.doc.transaction(label, () => targets.forEach((e) => app.doc.replaceEntity(e.handle, { hidden: hidden || undefined })));
  return targets.length;
}

const hideObjects = cmd('HIDEOBJECTS', 'MASQUEROBJETS', ['MASQUER', 'HIDE'], 'Masque les objets choisis (œil du Navigateur)', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les objets à masquer');
  const n = setHidden(app, hs.map((h) => app.doc.get(h)!).filter(Boolean), true, 'Masquer');
  ctx.print(`${n} objet(s) masqué(s). AFFICHERTOUT pour les réafficher.`);
});

const isolate = cmd('ISOLATEOBJECTS', 'ISOLER', ['ISOLATE', 'ISO'], 'N’affiche que les objets choisis', async (ctx, app) => {
  const hs = new Set(await selectObjects(ctx, 'Choisissez les objets à isoler'));
  if (!hs.size) return;
  const n = setHidden(app, app.doc.all().filter((e) => !hs.has(e.handle) && e.type !== 'UNDERLAY'), true, 'Isoler');
  ctx.print(`${hs.size} objet(s) isolé(s), ${n} masqué(s). AFFICHERTOUT pour tout réafficher.`);
});

const unhide = cmd('UNISOLATEOBJECTS', 'AFFICHERTOUT', ['UNHIDE', 'UNISOLATE', 'AFFICHER'], 'Réaffiche les objets masqués ou isolés', async (ctx, app) => {
  const n = setHidden(app, app.doc.all(), false, 'Tout afficher');
  ctx.print(n ? `${n} objet(s) réaffiché(s).` : 'Aucun objet masqué.');
});

export const tools3dCommands: CommandDefinition[] = [workspace, rightClick, pressPull, sketch, elev, sectionAnalysis, hideObjects, isolate, unhide];
