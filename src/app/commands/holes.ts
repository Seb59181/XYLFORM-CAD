/**
 * PERCAGE : assistant de perçage — trous de passage, lamés,
 * fraisés, taraudés (filetage réel en option) ou logements d'inserts à chaud, de M3 à M20,
 * posés sur une face plane, borgnes ou débouchants. Plusieurs trous à la fois (accrochages
 * aux centres, milieux…). L'étape est enregistrée dans l'historique du corps : taille, type
 * et profondeur restent modifiables ensuite (Propriétés ou Navigateur).
 */
import type { CommandDefinition, Vec3 } from '../../core/commands';
import { featureId, type Entity, type Feature } from '../../core/document/Document';
import { HOLE_LABEL, holeTitle, INSERTS, SIZES, sizeLabel, standardHole, type HoleSpec, type HoleType } from '../../core/geometry/holes';
import { maxThreadGap } from '../../core/geometry/threads';
import { add, cross, dot, norm, scale, sub } from '../../core/math/affine';
import { cmd, fmt, getDistance, getKeyword, getPointOrKeyword, kw, pickEntity, selectObjects } from './helpers';
import { hasRealThread } from '../history';
import { faceNormalAt } from './measure';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

/** Réglages mémorisés d'un perçage à l'autre. */
const last = { type: 'counterbore' as HoleType, size: 'M6', depth: 0, thread: false, gap: 0.2 };

const TYPES: { key: string; type: HoleType; local: string; short: string }[] = [
  { key: 'Simple', type: 'simple', local: 'Passage', short: 'PA' },
  { key: 'Counterbore', type: 'counterbore', local: 'Lame', short: 'L' },
  { key: 'Countersink', type: 'countersink', local: 'Fraise', short: 'F' },
  { key: 'Tapped', type: 'tapped', local: 'Taraude', short: 'TA' },
  { key: 'Insert', type: 'insert', local: 'Insert', short: 'I' },
];

/** Cercle de rayon r dans le plan de normale n (aperçu). */
function circle(c: Vec3, n: Vec3, r: number, seg = 40): Vec3[] {
  const ref = Math.abs(n.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const u = norm(cross(ref, n)), v = cross(n, u);
  return Array.from({ length: seg + 1 }, (_, i) => {
    const a = (i / seg) * Math.PI * 2;
    return add(c, add(scale(u, r * Math.cos(a)), scale(v, r * Math.sin(a))));
  });
}

function holeOutline(spec: HoleSpec, c: Vec3, n: Vec3): Vec3[][] {
  const out = [circle(c, n, spec.diameter / 2)];
  const outer = spec.cbDiameter ?? spec.csDiameter;
  if (outer) out.push(circle(c, n, outer / 2));
  const d = spec.depth > 0 ? spec.depth : spec.diameter * 2;
  out.push([c, add(c, scale(n, -d))]);
  return out;
}

const hole = cmd('HOLE', 'PERCAGE', ['TROU', 'PERCER', 'TARAUDAGE'], 'Assistant de perçage : trous de passage, lamés, fraisés, taraudés, inserts (M3 à M20)', async (ctx, app) => {
  const pick = await pickEntity(ctx, 'Cliquez la face plane à percer', { filter: (e) => e.type === '3DSOLID', pickMode: 'face' });
  if (!pick || typeof pick === 'string' || pick.sub === undefined) return;
  const target = app.doc.get(pick.handle) as Solid3D | undefined;
  if (!target) return;
  const n = faceNormalAt(target, pick.sub, pick.point);
  if (!n) return ctx.print('Face introuvable.');
  const p0 = pick.point;
  const onFace = (p: Vec3) => sub(p, scale(n, dot(sub(p, p0), n)));
  const makeSpec = () => {
    // pas d'insert normalisé au-delà de M8 : on retombe sur un passage
    if (last.type === 'insert' && !INSERTS[last.size]) last.size = 'M5';
    return standardHole(last.type, last.size, last.depth, last.thread, last.gap, app.settings.holeComp ?? 0);
  };
  let spec = makeSpec();
  let customD: number | null = null;
  const at: Vec3[] = [];
  for (;;) {
    if (customD !== null) spec = { ...spec, diameter: customD };
    ctx.print(`${HOLE_LABEL[spec.type]} : ${holeTitle(spec)}${spec.cbDiameter ? `, lamage Ø${fmt(spec.cbDiameter)} × ${fmt(spec.cbDepth!)}` : ''}${spec.csDiameter ? `, fraisure Ø${fmt(spec.csDiameter)} à 90°` : ''}. ${at.length} trou(s) placé(s).`);
    const r = await getPointOrKeyword(ctx, at.length ? 'Centre du trou suivant (Entrée pour percer)' : 'Centre du trou (Entrée = point cliqué)', {
      keywords: [
        kw('Type', 'Type', 'T', 'Passage, lamé, fraisé, taraudé ou insert'),
        kw('Size', 'Taille', 'TA', 'M3 à M20'),
        kw('Depth', 'Profondeur', 'P', '0 = débouchant'),
        kw('Through', 'Debouchant', 'D', 'Traverse toute la pièce'),
        kw('Diameter', 'Diametre', 'DI', 'Diamètre de perçage libre'),
        ...(spec.type === 'tapped' ? [kw('Thread', 'Filetage', 'F', 'Filetage réel (plus lent) ou simple avant-trou')] : []),
        ...(spec.type === 'tapped' && spec.thread ? [kw('Clearance', 'Jeu', 'J', 'Jeu d’impression par côté, perpendiculaire aux flancs du filet')] : []),
        ...(at.length ? [kw('Undo', 'Annuler', 'A', 'Retire le dernier trou')] : []),
      ],
      allowNone: true,
      noRubberBand: true,
      preview: (p) => [...at.flatMap((c) => holeOutline(spec, c, n)), ...holeOutline(spec, onFace(p), n)],
    });
    if (r.none) {
      if (!at.length) at.push(p0);
      break;
    }
    if (r.point) {
      at.push(onFace(r.point));
      continue;
    }
    switch (r.keyword) {
      case 'Type': {
        const cur = TYPES.find((t) => t.type === last.type)!.key;
        const k = await getKeyword(ctx, 'Type de trou', TYPES.map((t) => kw(t.key, t.local, t.short, HOLE_LABEL[t.type])), cur);
        last.type = TYPES.find((t) => t.key === k)?.type ?? last.type;
        customD = null;
        break;
      }
      case 'Size': {
        const sizes = last.type === 'insert' ? Object.keys(INSERTS) : SIZES;
        const k = await getKeyword(ctx, 'Taille', sizes.map((z) => kw(z, sizeLabel(z), z)), sizes.includes(last.size) ? last.size : sizes[0]);
        last.size = k;
        customD = null;
        break;
      }
      case 'Depth':
        last.depth = (await getDistance(ctx, 'Profondeur utile (0 = débouchant)', { defaultValue: last.depth, allowZero: true })) as number;
        break;
      case 'Through':
        last.depth = 0;
        break;
      case 'Diameter':
        customD = (await getDistance(ctx, 'Diamètre de perçage', { defaultValue: spec.diameter, allowZero: false })) as number;
        break;
      case 'Thread':
        last.thread = !last.thread;
        ctx.print(last.thread ? 'Filetage réel : le filet est modélisé (compter quelques secondes par trou).' : 'Filetage simple : avant-trou de taraudage seulement.');
        break;
      case 'Clearance': {
        last.gap = (await getDistance(ctx, 'Jeu d’impression par côté (0 = cotes exactes)', { defaultValue: last.gap, allowZero: true })) as number;
        const max = spec.pitch ? maxThreadGap(spec.pitch) : Infinity;
        if (last.gap > max) ctx.print(`Pour un pas de ${fmt(spec.pitch!)}, le jeu est plafonné à ${fmt(max)} mm (au-delà, le filet du trou disparaît).`);
        break;
      }
      case 'Undo':
        at.pop();
        break;
    }
    spec = makeSpec();
  }
  if (customD !== null) spec = { ...spec, diameter: customD, size: spec.type === 'simple' ? 'Ø' : spec.size };
  const f: Feature = { kind: 'hole', spec, at, normal: n, id: featureId(), name: HOLE_LABEL[spec.type] };
  ctx.print(`Perçage de ${at.length} trou(s)${spec.type === 'tapped' && spec.thread ? ' avec filetage réel' : ''}…`);
  await app.applyStep(target.handle, f, 'Perçage', ctx);
  ctx.print(`${at.length} trou(s) ${holeTitle(spec)} dans ${target.name || 'le solide'}${target.history ? ' (modifiable dans l’historique)' : ''}.`);
});

/** Corps dont le filetage réel n'est encore qu'un aperçu cosmétique. */
const isPreview = (e: Entity) => e.type === '3DSOLID' && !!e.history && !e.threadsReal && hasRealThread(e.history);

const realThreads = cmd('REALTHREADS', 'FILETAGEREEL', ['FILREEL'], 'Calcule tout de suite le filet exact des corps à filetage réel (aperçu cosmétique)', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les corps à fileter (Entrée = tous les aperçus)', isPreview, true);
  const list = (hs.length ? hs : app.doc.all().filter(isPreview).map((e) => e.handle)).map((h) => app.doc.get(h) as Solid3D);
  if (!list.length) return ctx.print('Aucun corps en aperçu cosmétique : les filetages sont déjà exacts.');
  for (const s of list) {
    ctx.print(`« ${s.name || s.handle} » : calcul du filet exact…`);
    const r = await app.replay(s.history!, ctx, undefined, true);
    app.doc.transaction('Filetage réel', () => app.doc.replaceEntity(s.handle, { shapeId: r.shapeId, display: r.display, threadsReal: true }));
  }
  ctx.print(`${list.length} corps à filetage exact.`);
});

const threadMode = cmd('THREADMODE', 'MODEFILETAGE', ['FILETAGES'], 'Filetages réels : aperçu cosmétique pendant le dessin et filet exact à l’export, ou exact tout de suite', async (ctx, app) => {
  const cur = app.settings.threadMode === 'always' ? 'Always' : 'Export';
  const k = await getKeyword(
    ctx,
    `Filetages réels (actuel : ${cur === 'Export' ? 'exacts à l’export' : 'toujours exacts'})`,
    [kw('Export', 'Export', 'E', 'Aperçu cosmétique rapide, filet exact calculé à l’export'), kw('Always', 'Toujours', 'T', 'Filet exact dès la création (lent)')],
    cur,
  );
  app.set('threadMode', k === 'Always' ? 'always' : 'export');
  ctx.print(k === 'Always' ? 'Filetages réels construits exacts dès leur création.' : 'Filetages réels en aperçu cosmétique ; filet exact à l’export STL/3MF/STEP (FILETAGEREEL pour le calculer avant).');
});

const holeCompCmd = cmd('HOLECOMP', 'COMPTROU', ['COMPENSATION'], 'Compensation des trous imprimés : agrandit les nouveaux trous de passage (Ø)', async (ctx, app) => {
  const v = (await getDistance(ctx, 'Compensation des trous imprimés, en mm sur le Ø (0 = cotes exactes)', { defaultValue: app.settings.holeComp ?? 0, allowZero: true })) as number;
  app.set('holeComp', Math.max(0, Math.min(2, v)));
  ctx.print(v > 0 ? `Les nouveaux trous de passage, lamés, fraisés et ceux des pièces seront agrandis de ${fmt(v)} mm sur le Ø (modifiable ensuite dans l’historique).` : 'Compensation des trous désactivée.');
});

export const holeCommands: CommandDefinition[] = [hole, realThreads, threadMode, holeCompCmd];
