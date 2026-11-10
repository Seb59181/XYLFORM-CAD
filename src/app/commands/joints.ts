/**
 * Assemblages : LIAISON crée un pivot ou une glissière entre des corps et
 * leur axe ; PILOTER les fait bouger (valeur, glisser à la souris, animation) ; INTERFERENCE
 * détecte les corps qui se chevauchent (pièces imprimées assemblées, charnières…).
 * Les liaisons se pilotent aussi dans le Navigateur (curseurs).
 */
import type { CommandContext, CommandDefinition, Vec3 } from '../../core/commands';
import type { Entity, Joint } from '../../core/document/Document';
import { apply, dist, norm, sub } from '../../core/math/affine';
import type { SolidResult } from '../../kernel/protocol';
import type { AppHost } from '../AppHost';
import { cmd, fmt, getKeyword, getNumber, getPoint, getPointOrKeyword, getString, isBody, kw, selectObjects } from './helpers';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

const unit = (j: Joint) => (j.type === 'revolute' ? '°' : '');

/** Animation des pièces d'une liaison de min à max et retour (aperçu, sans modifier le dessin). */
export function animateJoint(app: AppHost, j: Joint, duration = 2400): Promise<void> {
  return new Promise((resolve) => {
    const vp = app.viewport;
    if (!vp) return resolve();
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      // aller-retour adouci : min → max → valeur de départ
      const phase = t < 0.5 ? t * 2 : 2 - t * 2;
      const eased = (1 - Math.cos(Math.PI * phase)) / 2;
      const target = t < 0.5 ? j.min + (j.max - j.min) * eased : j.value + (j.max - j.value) * eased;
      vp.setLiveTransform(j.parts, app.jointMatrix(j, target - j.value));
      if (t < 1) requestAnimationFrame(step);
      else {
        vp.setLiveTransform(j.parts, null);
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

const joint = cmd(
  'JOINT',
  'LIAISON',
  ['JNT', 'ASSEMBLER'],
  'Assemblage : liaison pivot ou glissière entre des corps (charnière, couvercle, tiroir…)',
  async (ctx, app) => {
    const type = (await getKeyword(ctx, 'Type de liaison', [kw('Revolute', 'Pivot', 'P', 'Rotation autour d’un axe'), kw('Slider', 'Glissiere', 'G', 'Translation le long d’un axe')], 'Revolute')) === 'Revolute' ? 'revolute' : 'slider';
    const parts = await selectObjects(ctx, 'Choisissez les corps qui bougent', isBody);
    if (!parts.length) return;
    const o = await getPoint(ctx, type === 'revolute' ? 'Point de l’axe de rotation (centre d’une arête circulaire, extrémité…)' : 'Point de départ de la glissière');
    const r = await getPointOrKeyword(ctx, 'Second point de l’axe', {
      basePoint: o,
      keywords: [kw('X', 'X', 'X'), kw('Y', 'Y', 'Y'), kw('Z', 'Z', 'Z')],
      defaultValue: 'Z',
      allowNone: true,
    });
    let axis: Vec3 = { x: 0, y: 0, z: 1 };
    if (r.keyword === 'X') axis = { x: 1, y: 0, z: 0 };
    else if (r.keyword === 'Y') axis = { x: 0, y: 1, z: 0 };
    else if (r.point && dist(r.point, o) > 1e-9) axis = norm(sub(r.point, o));
    const min = (await getNumber(ctx, type === 'revolute' ? 'Angle minimal (degrés)' : 'Course minimale', { defaultValue: 0, allowNegative: true, allowZero: true })) as number;
    const max = (await getNumber(ctx, type === 'revolute' ? 'Angle maximal (degrés)' : 'Course maximale', { defaultValue: type === 'revolute' ? 180 : 50, allowNegative: true, allowZero: true })) as number;
    if (!(max > min)) return ctx.print('La borne maximale doit être supérieure à la borne minimale.');
    const n = app.doc.joints.filter((j) => j.type === type).length + 1;
    const name = (await getString(ctx, 'Nom de la liaison', `${type === 'revolute' ? 'Pivot' : 'Glissière'} ${n}`))?.trim() || `${type === 'revolute' ? 'Pivot' : 'Glissière'} ${n}`;
    if (type === 'revolute') {
      // sens positif choisi pour que l'ouverture monte (couvercle, abattant) : sinon l'axe est retourné
      const ss = parts.map((h) => app.doc.get(h)).filter((e): e is Solid3D => e?.type === '3DSOLID');
      if (ss.length) {
        const bb = ss.map((e) => e.display.bbox);
        const c = {
          x: (Math.min(...bb.map((b) => b.min.x)) + Math.max(...bb.map((b) => b.max.x))) / 2,
          y: (Math.min(...bb.map((b) => b.min.y)) + Math.max(...bb.map((b) => b.max.y))) / 2,
          z: (Math.min(...bb.map((b) => b.min.z)) + Math.max(...bb.map((b) => b.max.z))) / 2,
        };
        const probe = { name: '', type, parts, origin: o, axis, value: 0, min, max, id: '' } as Joint;
        const up = apply(app.jointMatrix(probe, 10), c).z, down = apply(app.jointMatrix(probe, -10), c).z;
        if (down > up + 1e-9) axis = { x: -axis.x, y: -axis.y, z: -axis.z };
      }
    }
    const value = Math.max(min, Math.min(max, 0));
    const j = app.doc.addJoint({ name, type, parts, origin: o, axis, value, min, max });
    ctx.print(`Liaison « ${j.name} » créée (${parts.length} corps, ${fmt(min)}${unit(j)} à ${fmt(max)}${unit(j)}). Pilotez-la avec PILOTER ou dans le Navigateur.`);
  },
);

async function chooseJoint(ctx: CommandContext, app: AppHost): Promise<Joint | null> {
  const js = app.doc.joints;
  if (!js.length) {
    ctx.print('Aucune liaison : créez-en une avec LIAISON.');
    return null;
  }
  if (js.length === 1) return js[0]!;
  ctx.print(js.map((j, i) => `${i + 1}. ${j.name} (${fmt(j.value)}${unit(j)})`).join('   '));
  const k = (await getNumber(ctx, 'Numéro de la liaison', { integer: true, defaultValue: js.length })) as number;
  return js[Math.round(k) - 1] ?? null;
}

const drive = cmd('DRIVEJOINT', 'PILOTER', ['PIL', 'ANIMER'], 'Fait bouger une liaison d’assemblage (valeur, bornes, animation)', async (ctx, app) => {
  const j0 = await chooseJoint(ctx, app);
  if (!j0) return;
  const id = j0.id;
  for (;;) {
    const j = app.doc.joint(id);
    if (!j) return;
    const r = await getNumber(ctx, `${j.name} (${fmt(j.min)} à ${fmt(j.max)}${unit(j)}) : nouvelle valeur`, {
      keywords: [kw('Animate', 'Animer', 'A'), kw('Min', 'Min', 'MI'), kw('Max', 'Max', 'MA'), kw('Exit', 'Quitter', 'Q')],
      defaultValue: j.value,
      allowNegative: true,
      allowZero: true,
      allowNone: true,
    }).catch(() => null);
    if (r === null || r === 'Exit') return;
    if (r === 'Animate') {
      await animateJoint(app, j);
      continue;
    }
    const v = r === 'Min' ? j.min : r === 'Max' ? j.max : (r as number);
    if (Math.abs(v - j.value) < 1e-9) return;
    if (v < j.min || v > j.max) ctx.print(`Valeur ramenée dans les bornes (${fmt(j.min)} à ${fmt(j.max)}${unit(j)}).`);
    await app.driveJoint(id, v, ctx);
  }
});

const interference = cmd('INTERFERE', 'INTERFERENCE', ['INF', 'COLLISION'], 'Détecte les corps qui se chevauchent (volumes communs)', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les corps à contrôler', (e) => e.type === '3DSOLID' && e.display.solidCount > 0);
  if (hs.length < 2) return ctx.print('Choisissez au moins deux corps.');
  const ss = hs.map((h) => app.doc.get(h) as Solid3D);
  await app.ensureKernel(ctx);
  const overlaps = (a: Solid3D, b: Solid3D) => {
    const A = a.display.bbox, B = b.display.bbox;
    return A.min.x <= B.max.x && B.min.x <= A.max.x && A.min.y <= B.max.y && B.min.y <= A.max.y && A.min.z <= B.max.z && B.min.z <= A.max.z;
  };
  const found: { a: Solid3D; b: Solid3D; r: SolidResult }[] = [];
  for (let i = 0; i < ss.length; i++)
    for (let k = i + 1; k < ss.length; k++) {
      const a = ss[i]!, b = ss[k]!;
      if (!overlaps(a, b)) continue;
      try {
        const r = await app.kernel.solid({ op: 'boolean', kind: 'intersect', targets: [a.shapeId], tools: [b.shapeId] });
        if (r.display.volume > 1e-6) found.push({ a, b, r });
        else void app.kernel.call({ op: 'release', shapeIds: [r.shapeId] });
      } catch {
        /* pas de volume commun */
      }
    }
  if (!found.length) {
    ctx.print(`Aucune interférence entre les ${ss.length} corps.`);
    app.ui.toast('Aucune interférence', 'success');
    return;
  }
  for (const f of found) ctx.print(`${f.a.name || f.a.handle} ↔ ${f.b.name || f.b.handle} : ${fmt(f.r.display.volume, 3)} mm³ en commun.`);
  const k = await getKeyword(ctx, `${found.length} interférence(s). Créer les volumes communs en rouge`, [kw('Yes', 'Oui', 'O'), kw('No', 'Non', 'N')], 'Yes');
  if (k === 'Yes') {
    const made: string[] = [];
    app.doc.transaction('Interférences', () => {
      for (const f of found) made.push(app.doc.addEntity({ type: '3DSOLID', name: `Interférence ${f.a.name || f.a.handle} / ${f.b.name || f.b.handle}`, shapeId: f.r.shapeId, display: f.r.display, color: '#ff3b30' }));
    });
    app.selection.set(made);
  } else void app.kernel.call({ op: 'release', shapeIds: found.map((f) => f.r.shapeId) });
});

export const jointCommands: CommandDefinition[] = [joint, drive, interference];
