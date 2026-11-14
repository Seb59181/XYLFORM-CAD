/**
 * Plans de coupe enregistrés dans le dessin :
 *   - PLANCOUPE : crée un plan nommé (X, Y, Z ou parallèle à une face), actif aussitôt ;
 *   - PLANSCOUPE : active, désactive, inverse, renomme ou supprime un plan ;
 *   - COUPE2D : pose à plat la section d'un plan (contours fermés + hachures) dans le dessin.
 * Le plan actif est sauvegardé avec le projet et réappliqué à l'ouverture.
 */
import type { CommandContext, Vec3 } from '../../core/commands';
import type { Entity, NewEntity, SectionPlaneDef } from '../../core/document/Document';
import { faceInfo } from '../../core/geometry/faces';
import type { SolidResult } from '../../kernel/protocol';
import type { AppHost } from '../AppHost';
import { planeLoops } from '../drawingExtra';
import { project } from '../drawing';
import { cmd, fmt, getDistance, getKeyword, getPoint, getString, isSolid, kw, pickEntity } from './helpers';
import { modelBox, planeRect } from './tools3d';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

const addS = (p: Vec3, u: Vec3, t: number): Vec3 => ({ x: p.x + u.x * t, y: p.y + u.y * t, z: p.z + u.z * t });
const along = (p: Vec3, o: Vec3, u: Vec3) => (p.x - o.x) * u.x + (p.y - o.y) * u.y + (p.z - o.z) * u.z;
const neg = (n: Vec3): Vec3 => ({ x: -n.x, y: -n.y, z: -n.z });

/** Premier nom libre « Coupe 1 », « Coupe 2 »… */
export function nextSectionName(planes: SectionPlaneDef[]): string {
  const used = new Set(planes.map((p) => p.name.toLowerCase()));
  for (let i = 1; ; i++) if (!used.has(`coupe ${i}`)) return `Coupe ${i}`;
}

/** Repère du plan pour la mise à plat : direction de vue = −normale, X horizontal si possible. */
export function planeFrame(normal: Vec3): { dir: Vec3; xDir: Vec3 } {
  const dir = neg(normal);
  const up = Math.abs(normal.z) > 0.9 ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
  // xDir = up × dir, de sorte que yDir = dir × xDir ≈ up
  let x = { x: up.y * dir.z - up.z * dir.y, y: up.z * dir.x - up.x * dir.z, z: up.x * dir.y - up.y * dir.x };
  const l = Math.hypot(x.x, x.y, x.z) || 1;
  x = { x: x.x / l, y: x.y / l, z: x.z / l };
  return { dir, xDir: x };
}

/** Contours de la section (repère 2D du plan), recentrés sur leur emprise. */
export function flatSection(loops: Vec3[][], normal: Vec3): [number, number][][] {
  const { dir, xDir } = planeFrame(normal);
  const flat = loops.map((l) => l.map((p) => project(p, dir, xDir)));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of flat) for (const [x, y] of l) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return flat.map((l) => l.map(([x, y]) => [x - cx, y - cy] as [number, number]));
}

/** Entités posées à plat : polylignes fermées et hachure ANSI31. */
export function section2dEntities(flat: [number, number][][], at: Vec3, hatchScale: number): NewEntity[] {
  const V = ([x, y]: [number, number]): Vec3 => ({ x: at.x + x, y: at.y + y, z: at.z });
  const out: NewEntity[] = flat.map((l) => ({ type: 'POLYLINE', points: l.map(V), closed: true }));
  if (flat.length) out.push({ type: 'HATCH', boundaries: flat.map((l) => l.map(V)), pattern: 'ANSI31', scale: hatchScale, angle: 0 });
  return out;
}

async function pickPlane(app: AppHost, ctx: CommandContext, msg: string): Promise<SectionPlaneDef | null> {
  const planes = app.doc.sectionPlanes;
  if (!planes.length) {
    ctx.print('Aucun plan de coupe : créez-en un avec PLANCOUPE.');
    return null;
  }
  if (planes.length === 1) return planes[0]!;
  const def = app.doc.activeSectionPlane?.name ?? planes[0]!.name;
  const name = await getString(ctx, `${msg} (${planes.map((p) => p.name).join(', ')})`, def);
  if (name === null) return null;
  const p = planes.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  if (!p) ctx.print(`Plan « ${name} » introuvable.`);
  return p ?? null;
}

const sectionPlaneCmd = cmd('SECTIONPLANE', 'PLANCOUPE', ['PCOUPE', 'SPLANE'], 'Crée un plan de coupe nommé, enregistré dans le dessin', async (ctx, app) => {
  const vp = app.viewport;
  if (!vp) return;
  if (app.settings.workspace === '2d') app.set('workspace', '3d');
  const box = modelBox(app);
  if (!box) return ctx.print('Aucun solide visible à couper.');
  const k = await getKeyword(
    ctx,
    'Orientation du plan',
    [kw('X', 'X', 'X', 'Perpendiculaire à X'), kw('Y', 'Y', 'Y', 'Perpendiculaire à Y'), kw('Z', 'Z', 'Z', 'Horizontal'), kw('Face', 'Face', 'F', 'Parallèle à une face plane')],
    'Z',
  );
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
  const keep = along(vp.viewDirection(), { x: 0, y: 0, z: 0 }, axis) > 0 ? neg(axis) : axis;
  const before = vp.section;
  try {
    const d = await getDistance(ctx, 'Position du plan (décalage, faites glisser)', {
      basePoint: o,
      axis,
      allowNegative: true,
      allowZero: true,
      defaultValue: 0,
      noRubberBand: true,
      preview: (p) => {
        const at = addS(o, axis, along(p, o, axis));
        vp.setSection({ origin: at, normal: keep }, true);
        return [planeRect(at, axis, size)];
      },
    });
    const origin = addS(o, axis, d as number);
    const name = (await getString(ctx, 'Nom du plan de coupe', nextSectionName(app.doc.sectionPlanes)))?.trim() || nextSectionName(app.doc.sectionPlanes);
    const existing = app.doc.sectionPlanes.find((p) => p.name.toLowerCase() === name.toLowerCase());
    app.doc.putSectionPlane({ id: existing?.id ?? `sp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, origin, normal: keep });
    app.syncSection(true);
    ctx.print(`Plan de coupe « ${name} » enregistré et actif (PLANSCOUPE pour le gérer, COUPE2D pour le poser à plat).`);
  } catch (err) {
    vp.setSection(before);
    throw err;
  }
});

const sectionPlanesCmd = cmd('SECTIONPLANES', 'PLANSCOUPE', ['GPLANCOUPE'], 'Gère les plans de coupe du dessin : activer, désactiver, inverser, renommer, supprimer', async (ctx, app) => {
  const doc = app.doc;
  if (!doc.sectionPlanes.length) return ctx.print('Aucun plan de coupe : créez-en un avec PLANCOUPE.');
  ctx.print(`Plans : ${doc.sectionPlanes.map((p) => (p.id === doc.activeSection ? `${p.name} (actif)` : p.name)).join(', ')}.`);
  const k = await getKeyword(
    ctx,
    'Action',
    [kw('Activate', 'Activer', 'A'), kw('Off', 'Désactiver', 'D'), kw('Flip', 'Inverser', 'I'), kw('Rename', 'Renommer', 'R'), kw('Delete', 'Supprimer', 'S')],
    doc.activeSection ? 'Off' : 'Activate',
  );
  if (k === 'Off') {
    if (app.settings.workspace !== '2d' && app.viewport) app.viewport.setSection(null);
    doc.setActiveSection(null);
    app.syncSection(true);
    return ctx.print('Plus aucun plan de coupe actif.');
  }
  const p = await pickPlane(app, ctx, k === 'Activate' ? 'Plan à activer' : 'Plan');
  if (!p) return;
  if (k === 'Activate') {
    if (app.settings.workspace === '2d') app.set('workspace', '3d');
    doc.setActiveSection(p.id);
    app.syncSection(true);
    return ctx.print(`« ${p.name} » actif.`);
  }
  if (k === 'Flip') {
    doc.putSectionPlane({ ...p, normal: neg(p.normal) }, doc.activeSection === p.id);
    app.syncSection(true);
    return ctx.print(`« ${p.name} » inversé.`);
  }
  if (k === 'Rename') {
    const name = (await getString(ctx, 'Nouveau nom', p.name))?.trim();
    if (!name || name === p.name) return;
    if (doc.sectionPlanes.some((x) => x.id !== p.id && x.name.toLowerCase() === name.toLowerCase())) return ctx.print(`« ${name} » existe déjà.`);
    doc.putSectionPlane({ ...p, name }, doc.activeSection === p.id);
    return ctx.print(`Plan renommé « ${name} ».`);
  }
  doc.deleteSectionPlane(p.id);
  app.syncSection(true);
  ctx.print(`« ${p.name} » supprimé.`);
});

const section2d = cmd('SECTION2D', 'COUPE2D', ['SECTIONPLATE', 'C2D'], 'Pose à plat dans le dessin la section des solides par un plan de coupe (contours + hachures)', async (ctx, app) => {
  const p = await pickPlane(app, ctx, 'Plan de coupe à poser à plat');
  if (!p) return;
  const solids = app.doc.all().filter((e): e is Solid3D => e.type === '3DSOLID' && app.doc.isVisible(e));
  if (!solids.length) return ctx.print('Aucun solide visible.');
  const parts: SolidResult[] = [];
  let loops: Vec3[][] = [];
  try {
    for (const s of solids) {
      try {
        parts.push(...(await app.kernel.call<SolidResult[]>({ op: 'slice', shapeId: s.shapeId, origin: p.origin, normal: p.normal, keep: 'positive' })));
      } catch {
        /* solide entièrement d'un côté du plan */
      }
    }
    const diag = solids.reduce((m, s) => Math.max(m, Math.hypot(s.display.bbox.max.x - s.display.bbox.min.x, s.display.bbox.max.y - s.display.bbox.min.y, s.display.bbox.max.z - s.display.bbox.min.z)), 1);
    loops = parts.flatMap((r) => planeLoops(r.display, p.origin, p.normal, Math.max(1e-5, diag * 1e-6)));
  } finally {
    if (parts.length) void app.kernel.call({ op: 'release', shapeIds: parts.map((r) => r.shapeId) }).catch(() => undefined);
  }
  if (!loops.length) return ctx.print(`« ${p.name} » ne coupe aucun solide.`);
  const flat = flatSection(loops, p.normal);
  let w = 0;
  for (const l of flat) for (const [x, y] of l) w = Math.max(w, Math.abs(x), Math.abs(y));
  const at = await getPoint(ctx, 'Point de placement de la section (centre)', {
    noRubberBand: true,
    preview: (c) => flat.map((l) => [...l, l[0]!].map(([x, y]) => ({ x: c.x + x, y: c.y + y, z: c.z }))),
  });
  const ents = section2dEntities(flat, { ...at, z: app.processor.elevation }, Math.max(0.25, Math.round((w / 40) * 4) / 4));
  app.doc.transaction('Coupe à plat', () => ents.forEach((e) => app.addEntity(e)));
  ctx.print(`Section « ${p.name} » posée : ${flat.length} contour(s), ${fmt(2 * w)} de large.`);
});

export const sectionPlaneCommands = [sectionPlaneCmd, sectionPlanesCmd, section2d];
