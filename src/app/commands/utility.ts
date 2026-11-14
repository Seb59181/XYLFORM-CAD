/**
 * Vues et navigation (ZOOM, VUE, STYLEVISUEL…), requêtes (DIST, AIRE, ID, LISTE, PROPMASSE),
 * presse-papiers, réglages de dessin (ACCROBJ, GRILLE, ORTHO…), calques et utilitaires.
 */
import { ask, type CommandContext, type CommandDefinition, type Vec3 } from '../../core/commands';
import { placeHistory, placePrimitive, type Entity, type LayerDef, type NewEntity } from '../../core/document/Document';
import { arcSweep, curvePoints, entityArea, entityBBox, entityLabel, entityLength, polygonArea, polylineLength, SNAP_LABEL, transformEntity, type SnapKind } from '../../core/entities/geometry';
import { add, angleXY, dist, sub, translation } from '../../core/math/affine';
import type { StandardView } from '../../render/CadViewport';
import type { AppHost, VisualStyle } from '../AppHost';
import { cmd, DEG, fmt, fmtPt, getKeyword, getPoint, getPointOrKeyword, getString, isBody, kw, pickEntity, pickRequired, selectObjects } from './helpers';

type Solid3D = Extract<Entity, { type: '3DSOLID' }>;

// ---------------------------------------------------------------------------
// Vues
// ---------------------------------------------------------------------------

const zoom = cmd(
  'ZOOM',
  'ZOOM',
  ['Z'],
  'Agrandit ou réduit la vue (Étendu, Fenêtre, facteur)',
  async (ctx, app) => {
    const r = await getPointOrKeyword(ctx, 'Spécifiez le coin de la fenêtre', {
      keywords: [kw('Extents', 'Étendu', 'E', 'Cadre tout le dessin'), kw('Window', 'Fenêtre', 'F'), kw('In', 'Avant', 'AV', 'Zoom ×2'), kw('Out', 'Arrière', 'AR', 'Zoom ×0,5')],
      defaultValue: 'Extents',
      noRubberBand: true,
    });
    const vp = app.viewport;
    if (!vp) return;
    if (r.keyword === 'Extents' || r.none) return vp.zoomExtents();
    if (r.keyword === 'In') return vp.zoomFactor(2);
    if (r.keyword === 'Out') return vp.zoomFactor(0.5);
    const a = r.point ?? (await getPoint(ctx, 'Spécifiez le premier coin', { noRubberBand: true }));
    const b = await getPoint(ctx, 'Spécifiez le coin opposé', {
      noRubberBand: true,
      preview: (p) => [[a, { x: p.x, y: a.y, z: a.z }, { x: p.x, y: p.y, z: a.z }, { x: a.x, y: p.y, z: a.z }, a]],
    });
    vp.zoomWindow(a, b);
  },
  { transparent: true },
);

const pan = cmd('PAN', 'PAN', ['P'], 'Panoramique', async (ctx) => ctx.print('Panoramique : maintenez le bouton central (molette) enfoncé et déplacez la souris. Maj + molette enfoncée = orbite.'), { transparent: true });

const VIEWS: [StandardView, string, string, string][] = [
  ['TOP', 'Dessus', 'DE', 'Vue de dessus (plan)'],
  ['BOTTOM', 'Dessous', 'DS', 'Vue de dessous'],
  ['FRONT', 'Face', 'FA', 'Vue de face'],
  ['BACK', 'Arrière', 'AR', 'Vue arrière'],
  ['LEFT', 'Gauche', 'GA', 'Vue de gauche'],
  ['RIGHT', 'Droite', 'DR', 'Vue de droite'],
  ['SWISO', 'ISOSO', 'SO', 'Isométrique sud-ouest'],
  ['SEISO', 'ISOSE', 'SE', 'Isométrique sud-est'],
  ['NEISO', 'ISONE', 'NE', 'Isométrique nord-est'],
  ['NWISO', 'ISONO', 'NO', 'Isométrique nord-ouest'],
];

export const VIEW_LABEL: Record<StandardView, string> = {
  TOP: 'Dessus',
  BOTTOM: 'Dessous',
  FRONT: 'Face',
  BACK: 'Arrière',
  LEFT: 'Gauche',
  RIGHT: 'Droite',
  SWISO: 'Isométrique SO',
  SEISO: 'Isométrique SE',
  NEISO: 'Isométrique NE',
  NWISO: 'Isométrique NO',
};

const view = cmd(
  'VIEW',
  'VUE',
  ['V', '-VUE'],
  'Vues prédéfinies (dessus, face, isométriques…)',
  async (ctx, app) => {
    const v = await getKeyword(ctx, 'Choisissez une vue', VIEWS.map(([g, l, a, d]) => kw(g, l, a, d)), 'SWISO');
    app.viewport?.setView(v as StandardView);
  },
  { transparent: true },
);

export const STYLE_LABEL: Record<VisualStyle, string> = { realistic: 'Réaliste', render: 'Rendu', shaded: 'Ombré', wireframe: 'Filaire', xray: 'Rayons X', technical: 'Technique' };

/** Rappelle une vue nommée (cadrage, projection, style visuel). */
export function restoreNamedView(app: AppHost, name: string): boolean {
  const v = app.doc.namedView(name);
  if (!v || !app.viewport) return false;
  if (v.workspace && v.workspace !== app.settings.workspace) app.set('workspace', v.workspace);
  if (v.style && v.style in STYLE_LABEL && v.style !== app.settings.visualStyle) app.set('visualStyle', v.style as VisualStyle);
  if (app.settings.workspace === '3d' && v.view.projection !== app.settings.projection) app.set('projection', v.view.projection);
  app.viewport.setViewState(v.view);
  return true;
}

/** Enregistre la vue courante sous ce nom (remplace une vue du même nom). */
export function saveNamedView(app: AppHost, name: string): boolean {
  if (!app.viewport || !name.trim()) return false;
  app.doc.putNamedView({ name: name.trim(), view: app.viewport.getViewState(), style: app.settings.visualStyle, workspace: app.settings.workspace });
  return true;
}

/**
 * VUESNOMMEES (scènes) : enregistrer le cadrage courant sous un nom,
 * le rappeler (avec sa projection et son style visuel), supprimer, lister. Enregistrées dans le dessin.
 */
const namedViews = cmd(
  'NAMEDVIEWS',
  'VUESNOMMEES',
  ['VN', 'SCENES', 'SCENE'],
  'Vues nommées : enregistre et rappelle un cadrage avec sa projection et son style visuel',
  async (ctx, app) => {
    const names = () => app.doc.namedViews.map((v) => v.name);
    for (;;) {
      const has = names().length > 0;
      const k = await getKeyword(
        ctx,
        has ? `Vues nommées (${names().join(', ')})` : 'Aucune vue nommée',
        [kw('Save', 'Enregistrer', 'E', 'Vue courante'), ...(has ? [kw('Restore', 'Restaurer', 'R'), kw('Delete', 'Supprimer', 'S'), kw('List', 'Liste', 'L')] : []), kw('Exit', 'Quitter', 'Q')],
        has ? 'Restore' : 'Save',
      );
      if (k === 'Exit') return;
      if (k === 'List') {
        for (const v of app.doc.namedViews) ctx.print(`  ${v.name} : ${v.view.projection === 'perspective' ? 'perspective' : 'parallèle'}${v.style ? `, ${STYLE_LABEL[v.style as VisualStyle] ?? v.style}` : ''}`);
        continue;
      }
      if (k === 'Save') {
        let i = app.doc.namedViews.length + 1;
        while (app.doc.namedView(`Vue${i}`)) i++;
        const name = await getString(ctx, 'Nom de la vue', `Vue${i}`);
        if (!name?.trim()) continue;
        const replaced = !!app.doc.namedView(name);
        saveNamedView(app, name);
        ctx.print(`Vue « ${name.trim()} » ${replaced ? 'remplacée' : 'enregistrée'}.`);
        return;
      }
      const v = await getKeyword(ctx, k === 'Restore' ? 'Vue à restaurer' : 'Vue à supprimer', app.doc.namedViews.map((n, i) => kw(`V${i}`, n.name.replace(/\s+/g, '_'), String(i + 1))));
      const view = app.doc.namedViews[parseInt(v.slice(1))];
      if (!view) continue;
      if (k === 'Delete') {
        app.doc.deleteNamedView(view.name);
        ctx.print(`Vue « ${view.name} » supprimée.`);
        continue;
      }
      restoreNamedView(app, view.name);
      ctx.print(`Vue « ${view.name} » restaurée.`);
      return;
    }
  },
  { transparent: true },
);

const visualStyle = cmd('VSCURRENT', 'STYLEVISUEL', ['SV', 'VS'], 'Style visuel du viewport', async (ctx, app) => {
  const v = await getKeyword(
    ctx,
    'Choisissez un style visuel',
    [kw('realistic', 'Réaliste', 'R', 'Faces ombrées et arêtes'), kw('render', 'Rendu', 'RE', 'Matériaux, reflets et ombres portées'), kw('shaded', 'Ombré', 'O', 'Faces ombrées sans arêtes'), kw('wireframe', 'Filaire', 'F', 'Arêtes seules'), kw('xray', 'RayonsX', 'X', 'Faces transparentes'), kw('technical', 'Technique', 'T', 'Dessin au trait sur fond blanc : arêtes cachées en tirets, contours apparents')],
    app.settings.visualStyle,
  );
  app.set('visualStyle', v as VisualStyle);
});

const perspective = cmd('PERSPECTIVE', 'PERSPECTIVE', ['PERS'], 'Bascule projection perspective / parallèle', async (ctx, app) => {
  const v = await getKeyword(ctx, 'Projection', [kw('perspective', 'Perspective', 'P'), kw('orthographic', 'Parallèle', 'A')], app.settings.projection === 'perspective' ? 'orthographic' : 'perspective');
  app.set('projection', v as 'perspective' | 'orthographic');
});

const regen = cmd('REGEN', 'REGEN', ['RE', 'REGENALL'], 'Régénère l’affichage', async (ctx, app) => {
  app.viewport?.rebuild();
  ctx.print('Régénération du modèle.');
});

// ---------------------------------------------------------------------------
// Annuler / rétablir
// ---------------------------------------------------------------------------

const undo = cmd('UNDO', 'ANNULER', ['U'], 'Annule la dernière commande', async (ctx, app) => {
  const l = app.doc.undo();
  ctx.print(l ? `Annuler : ${l}` : 'Rien à annuler.');
});

const redo = cmd('REDO', 'RETABLIR', ['RET'], 'Rétablit la commande annulée', async (ctx, app) => {
  const l = app.doc.redo();
  ctx.print(l ? `Rétablir : ${l}` : 'Rien à rétablir.');
});

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------

const layer = cmd('LAYER', 'CALQUE', ['LA', 'CA'], 'Gestionnaire des propriétés des calques', async (_ctx, app) => app.set('panel', 'layers'), { transparent: true });
const properties = cmd('PROPERTIES', 'PROPRIETES', ['PROPS', 'CH', 'MO'], 'Palette des propriétés', async (_ctx, app) => app.set('panel', 'properties'), { transparent: true });
const customize = cmd('CUSTOMIZE', 'PERSONNALISER', ['CUI', 'RACCOURCIS', 'PERSO'], 'Personnaliser : raccourcis clavier et onglet du ruban sur mesure', async (_ctx, app) => app.ui.customize(), { transparent: true });

const help = cmd('HELP', 'AIDE', ['?'], 'Aide et liste des commandes', async (_ctx, app) => app.ui.showHelp(), { transparent: true });

const layerCurrent = cmd('LAYMCUR', 'CALCOURANT', ['LAYMCUR'], 'Rend courant le calque de l’objet désigné', async (ctx, app) => {
  const { e } = await pickRequired(ctx, 'Choisissez un objet dont le calque deviendra courant');
  app.doc.setCurrentLayer(e.layer);
  ctx.print(`Le calque courant est "${e.layer}".`);
});

const purge = cmd('PURGE', 'PURGER', ['PU'], 'Supprime les calques vides', async (ctx, app) => {
  const used = new Set(app.doc.all().map((e) => e.layer));
  const empty = app.doc.layers.filter((l) => l.name !== '0' && l.name !== app.doc.currentLayer && !used.has(l.name));
  for (const l of empty) app.doc.removeLayer(l.name);
  ctx.print(empty.length ? `${empty.length} calque(s) purgé(s) : ${empty.map((l) => l.name).join(', ')}` : 'Aucun calque à purger.');
});

// ---------------------------------------------------------------------------
// Réglages de dessin
// ---------------------------------------------------------------------------

const SNAP_KEYS: [SnapKind, string, string][] = [
  ['END', 'EXTrémité', 'EXT'],
  ['MID', 'MILieu', 'MIL'],
  ['CEN', 'CENtre', 'CEN'],
  ['QUA', 'QUAdrant', 'QUA'],
  ['INT', 'INTersection', 'INT'],
  ['NOD', 'NODal', 'NOD'],
  ['INS', 'INSertion', 'INS'],
  ['PER', 'PERpendiculaire', 'PER'],
  ['TAN', 'TANgente', 'TAN'],
  ['NEA', 'PROche', 'PRO'],
];

const osnap = cmd(
  'OSNAP',
  'ACCROBJ',
  ['OS', 'AC'],
  'Modes d’accrochage aux objets',
  async (ctx, app) => {
    for (;;) {
      const on = new Set(app.settings.osnapModes);
      ctx.print(`Modes actifs : ${[...on].map((k) => SNAP_LABEL[k]).join(', ') || 'aucun'}`);
      const r = await getPointOrKeyword(ctx, 'Activez/désactivez un mode (Entrée pour terminer)', {
        keywords: [...SNAP_KEYS.map(([g, l, a]) => kw(g, l, a)), kw('All', 'Tous', 'TO'), kw('None', 'Aucun', 'AU')],
        allowNone: true,
        noRubberBand: true,
      });
      if (!r.keyword) return;
      if (r.keyword === 'All') app.set('osnapModes', SNAP_KEYS.map(([k]) => k).filter((k) => k !== 'NEA'));
      else if (r.keyword === 'None') app.set('osnapModes', []);
      else {
        const k = r.keyword as SnapKind;
        on.has(k) ? on.delete(k) : on.add(k);
        app.set('osnapModes', [...on]);
      }
      if (!app.settings.osnap) app.set('osnap', true);
    }
  },
  { transparent: true },
);

const toggleCmd = (name: string, local: string, aliases: string[], key: Parameters<import('../AppHost').AppHost['toggle']>[0], description: string) =>
  cmd(name, local, aliases, description, async (_ctx, app) => app.toggle(key), { transparent: true });

/**
 * GRILLE / RESOL : Entrée bascule ; un nombre fixe le pas ;
 * « Adaptatif » (grille) ou « Grille » (résolution) revient au pas qui suit le zoom.
 */
const stepCmd = (name: string, local: string, aliases: string[], kind: 'grid' | 'snap', description: string) =>
  cmd(
    name,
    local,
    aliases,
    description,
    async (ctx, app) => {
      const s = app.settings;
      const key = kind === 'grid' ? 'gridUnit' : 'snapUnit';
      const cur = s[key];
      const now = cur > 0 ? fmt(cur) : kind === 'grid' ? 'adaptatif' : s.gridUnit > 0 ? `grille (${fmt(s.gridUnit)})` : 'grille adaptative';
      const res = await ask(ctx, {
        kind: 'real',
        message: `Pas ${kind === 'grid' ? 'de la grille' : 'de la résolution'} (actuel : ${now}) ou Entrée pour ${s[kind] ? 'désactiver' : 'activer'}`,
        allowNone: true,
        allowZero: false,
        keywords: [kw('On', 'Actif', 'AC'), kw('Off', 'Inactif', 'I'), kind === 'grid' ? kw('Auto', 'Adaptatif', 'AD', 'Le pas suit le zoom') : kw('Auto', 'Grille', 'G', 'Même pas que la grille')],
      });
      if (res.kind === 'none') return app.toggle(kind);
      const r = res.kind === 'number' || res.kind === 'keyword' ? res.value : null;
      if (r === null) return;
      if (r === 'On' || r === 'Off') {
        if (s[kind] !== (r === 'On')) app.toggle(kind);
        return;
      }
      if (r === 'Auto') {
        app.set(key, 0);
        return ctx.print(kind === 'grid' ? 'Grille adaptative : le pas suit le zoom.' : 'Résolution : pas de la grille.');
      }
      app.set(key, r as number);
      if (!app.settings[kind]) app.toggle(kind);
      ctx.print(`Pas ${kind === 'grid' ? 'de la grille' : 'de la résolution'} : ${fmt(r as number)}.`);
    },
    { transparent: true },
  );

const grid = stepCmd('GRID', 'GRILLE', ['GR'], 'grid', 'Grille (F7) : affiche, masque ou règle le pas');
const snap = stepCmd('SNAP', 'RESOL', ['SN'], 'snap', 'Accrochage à la grille (F9) : active ou règle le pas');
const ortho = toggleCmd('ORTHO', 'ORTHO', ['OR'], 'ortho', 'Mode orthogonal (F8)');
const polar = toggleCmd('POLAR', 'POLAIRE', ['POLA'], 'polar', 'Repérage polaire (F10)');
const dyn = toggleCmd('DYNMODE', 'SAISIEDYN', ['DYN'], 'dyn', 'Saisie dynamique au curseur (F12)');
const dynCoords = cmd(
  'DYNPICOORDS',
  'COORDSDYN',
  [],
  'Saisie dynamique : coordonnées des points suivants relatives (par défaut) ou absolues',
  async (ctx, app) => {
    const v = await getKeyword(ctx, 'Coordonnées tapées au curseur', [kw('Relative', 'Relatives', 'R', 'Depuis le point précédent ; # pour l’absolu'), kw('Absolute', 'Absolues', 'A', 'Depuis l’origine ; @ pour le relatif')], app.settings.dynRelative ? 'Relative' : 'Absolute');
    app.set('dynRelative', v === 'Relative');
    ctx.print(v === 'Relative' ? 'Saisie dynamique : coordonnées relatives (« # » pour l’absolu).' : 'Saisie dynamique : coordonnées absolues (« @ » pour le relatif).');
  },
  { transparent: true },
);
const lwt = toggleCmd('LWDISPLAY', 'AFFEPAIS', ['LWT', 'LWDISP'], 'lwt', 'Affiche les épaisseurs de ligne');

const setvar = cmd(
  'SETVAR',
  'MODIFVAR',
  ['SET'],
  'Consulte ou modifie une variable système',
  async (ctx, app) => {
    const sv = app.sysvars as unknown as Record<string, unknown>;
    const name = (await getString(ctx, `Nom de la variable (${Object.keys(sv).join(', ')})`))?.toUpperCase();
    if (!name) return;
    if (!(name in sv)) return ctx.print(`Variable inconnue : ${name}`);
    const cur = sv[name];
    const v = await getString(ctx, `Nouvelle valeur de ${name}`, String(cur));
    if (v === null || v === '') return;
    sv[name] = typeof cur === 'number' ? Number(v.replace(',', '.')) : v;
    app.doc.changed();
    ctx.print(`${name} = ${String(sv[name])}`);
  },
  { transparent: true },
);

// ---------------------------------------------------------------------------
// Requêtes
// ---------------------------------------------------------------------------

const distance = cmd(
  'DIST',
  'DIST',
  ['DI', 'MESURER'],
  'Mesure la distance et l’angle entre deux points',
  async (ctx) => {
    const a = await getPoint(ctx, 'Spécifiez le premier point');
    const b = await getPoint(ctx, 'Spécifiez le deuxième point', { basePoint: a });
    const d = sub(b, a);
    const ang = angleXY(a, b) / DEG;
    const elev = (Math.atan2(d.z, Math.hypot(d.x, d.y)) / DEG);
    ctx.print(`Distance = ${fmt(dist(a, b))},  Angle dans le plan XY = ${fmt((ang + 360) % 360, 2)}°,  Angle depuis le plan XY = ${fmt(elev, 2)}°`);
    ctx.print(`Delta X = ${fmt(d.x)},  Delta Y = ${fmt(d.y)},  Delta Z = ${fmt(d.z)}`);
  },
  { transparent: true },
);

const area = cmd('AREA', 'AIRE', ['AA'], 'Calcule l’aire et le périmètre', async (ctx, app) => {
  const r = await getPointOrKeyword(ctx, 'Spécifiez le premier point du contour', { keywords: [kw('Object', 'Objet', 'O', 'Aire d’un objet fermé')], defaultValue: 'Object' });
  if (r.keyword === 'Object' || r.none) {
    const { e } = await pickRequired(ctx, 'Choisissez un objet');
    if (e.type === '3DSOLID') return ctx.print(`Aire de surface = ${fmt(e.display.area, 3)}`);
    const a = entityArea(e);
    const l = entityLength(e);
    if (a === null) return ctx.print('Cet objet ne délimite pas d’aire.');
    ctx.print(`Aire = ${fmt(a, 4)},  ${e.type === 'CIRCLE' ? 'Circonférence' : 'Périmètre'} = ${fmt(l ?? 0, 4)}`);
    return;
  }
  const pts: Vec3[] = [r.point!];
  for (;;) {
    const p = await getPointOrKeyword(ctx, 'Spécifiez le point suivant ou Entrée pour terminer', {
      basePoint: pts[pts.length - 1],
      allowNone: true,
      preview: (c) => [[...pts, c, pts[0]!]],
    });
    if (!p.point) break;
    pts.push(p.point);
  }
  if (pts.length < 3) return ctx.print('Il faut au moins trois points.');
  ctx.print(`Aire = ${fmt(Math.abs(polygonArea(pts)), 4)},  Périmètre = ${fmt(polylineLength([...pts, pts[0]!]), 4)}`);
});

const idPoint = cmd('ID', 'ID', ['IDPOINT'], 'Affiche les coordonnées d’un point', async (ctx) => {
  const p = await getPoint(ctx, 'Spécifiez le point');
  ctx.print(`X = ${fmt(p.x)}   Y = ${fmt(p.y)}   Z = ${fmt(p.z)}`);
}, { transparent: true });

function describe(e: Entity): string[] {
  const out = [`${entityLabel(e)}   Calque : "${e.layer}"   Handle = ${e.handle}`, `   Couleur : ${e.color ?? 'DuCalque'}`];
  const P = (label: string, p: Vec3) => out.push(`   ${label} : X=${fmt(p.x)}  Y=${fmt(p.y)}  Z=${fmt(p.z)}`);
  switch (e.type) {
    case 'LINE':
      P('Du point', e.start);
      P('Au point', e.end);
      out.push(`   Longueur = ${fmt(dist(e.start, e.end))},  Angle dans le plan XY = ${fmt((((angleXY(e.start, e.end) / DEG) % 360) + 360) % 360, 2)}°`);
      break;
    case 'CIRCLE':
      P('Centre', e.center);
      out.push(`   Rayon = ${fmt(e.radius)},  Circonférence = ${fmt(2 * Math.PI * e.radius)},  Aire = ${fmt(Math.PI * e.radius ** 2)}`);
      break;
    case 'ARC':
      P('Centre', e.center);
      out.push(`   Rayon = ${fmt(e.radius)},  Angle de départ = ${fmt(e.startAngle / DEG, 2)}°,  Angle de fin = ${fmt(e.endAngle / DEG, 2)}°,  Longueur = ${fmt(e.radius * arcSweep(e.startAngle, e.endAngle))}`);
      break;
    case 'POLYLINE':
      out.push(`   ${e.points.length} sommets, ${e.closed ? 'fermée' : 'ouverte'},  Longueur = ${fmt(entityLength(e) ?? 0)}${e.closed ? `,  Aire = ${fmt(entityArea(e) ?? 0)}` : ''}`);
      e.points.slice(0, 50).forEach((p, i) => P(`Sommet ${i + 1}`, p));
      break;
    case 'TEXT':
      P('Point d’insertion', e.position);
      out.push(`   Texte : "${e.text}",  Hauteur = ${fmt(e.height)},  Rotation = ${fmt(e.rotation / DEG, 2)}°`);
      break;
    case '3DSOLID': {
      const d = e.display;
      out.push(`   ${e.name} : ${d.faceCount} faces, ${d.edgeCount} arêtes,  Volume = ${fmt(d.volume, 3)},  Aire = ${fmt(d.area, 3)}`);
      P('Boîte min', d.bbox.min);
      P('Boîte max', d.bbox.max);
      break;
    }
    default: {
      const bb = entityBBox(e);
      if (bb) P('Boîte min', bb.min), P('Boîte max', bb.max);
      const l = entityLength(e);
      if (l !== null) out.push(`   Longueur = ${fmt(l)}`);
    }
  }
  return out;
}

const list = cmd('LIST', 'LISTE', ['LI', 'LS'], 'Affiche les propriétés des objets', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  for (const h of hs) {
    const e = app.doc.get(h);
    if (e) describe(e).forEach((l) => ctx.print(l));
  }
});

/** Centre de gravité et moments d'un maillage fermé (décomposition en tétraèdres). */
function massProperties(s: Solid3D): { volume: number; centroid: Vec3; inertia: [number, number, number] } {
  const d = s.display;
  let V = 0, cx = 0, cy = 0, cz = 0, ixx = 0, iyy = 0, izz = 0;
  const p = d.positions;
  for (let t = 0; t + 2 < d.indices.length; t += 3) {
    const a = 3 * d.indices[t]!, b = 3 * d.indices[t + 1]!, c = 3 * d.indices[t + 2]!;
    const x1 = p[a]!, y1 = p[a + 1]!, z1 = p[a + 2]!, x2 = p[b]!, y2 = p[b + 1]!, z2 = p[b + 2]!, x3 = p[c]!, y3 = p[c + 1]!, z3 = p[c + 2]!;
    const v = (x1 * (y2 * z3 - y3 * z2) - y1 * (x2 * z3 - x3 * z2) + z1 * (x2 * y3 - x3 * y2)) / 6;
    V += v;
    cx += (v * (x1 + x2 + x3)) / 4;
    cy += (v * (y1 + y2 + y3)) / 4;
    cz += (v * (z1 + z2 + z3)) / 4;
    const sq = (u1: number, u2: number, u3: number) => (u1 * u1 + u2 * u2 + u3 * u3 + u1 * u2 + u2 * u3 + u1 * u3) / 10;
    const X = v * sq(x1, x2, x3), Y = v * sq(y1, y2, y3), Zs = v * sq(z1, z2, z3);
    ixx += Y + Zs;
    iyy += X + Zs;
    izz += X + Y;
  }
  const centroid = Math.abs(V) > 1e-12 ? { x: cx / V, y: cy / V, z: cz / V } : { x: 0, y: 0, z: 0 };
  return { volume: Math.abs(V), centroid, inertia: [Math.abs(ixx), Math.abs(iyy), Math.abs(izz)] };
}

const massprop = cmd('MASSPROP', 'PROPMASSE', ['PM'], 'Propriétés de masse des solides', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les solides', isBody);
  const density = 7.85e-6; // acier, kg/mm³ (indication)
  for (const h of hs) {
    const s = app.doc.get(h) as Solid3D;
    const m = massProperties(s);
    const d = s.display;
    ctx.print(`----------------   ${s.name} [${h}]   ----------------`);
    ctx.print(`Volume : ${fmt(d.volume || m.volume, 3)} mm³    Aire : ${fmt(d.area, 3)} mm²    Masse (acier 7,85) : ${fmt((d.volume || m.volume) * density, 4)} kg`);
    ctx.print(`Boîte englobante : X ${fmt(d.bbox.min.x, 3)} — ${fmt(d.bbox.max.x, 3)}   Y ${fmt(d.bbox.min.y, 3)} — ${fmt(d.bbox.max.y, 3)}   Z ${fmt(d.bbox.min.z, 3)} — ${fmt(d.bbox.max.z, 3)}`);
    ctx.print(`Centre de gravité : ${fmtPt(m.centroid)}`);
    ctx.print(`Moments d’inertie (origine, densité 1) : X ${m.inertia[0].toExponential(4)}   Y ${m.inertia[1].toExponential(4)}   Z ${m.inertia[2].toExponential(4)}`);
  }
});

// ---------------------------------------------------------------------------
// Propriétés et presse-papiers
// ---------------------------------------------------------------------------

const matchprop = cmd('MATCHPROP', 'CORRESPROP', ['MA', 'CP2'], 'Copie le calque et la couleur d’un objet vers d’autres', async (ctx, app) => {
  const { e: src } = await pickRequired(ctx, 'Choisissez l’objet source');
  ctx.print(`Paramètres courants : Calque "${src.layer}", Couleur ${src.color ?? 'DuCalque'}`);
  for (;;) {
    const r = await pickEntity(ctx, 'Choisissez l’objet de destination (Entrée pour terminer)', { allowNone: true });
    if (!r || typeof r === 'string') return;
    app.doc.replaceEntity(r.handle, { layer: src.layer, color: src.color });
  }
});

let clipboard: { entities: Entity[]; base: Vec3; layers: LayerDef[] } | null = null;

/** Met des objets dans le presse-papiers, avec leurs calques (collage dans un autre dessin). */
function setClip(app: AppHost, entities: Entity[], base: Vec3): void {
  const names = [...new Set(entities.map((e) => e.layer))];
  clipboard = { entities, base, layers: names.map((n) => app.doc.layer(n)).filter((l): l is LayerDef => !!l) };
}

/** Formes du noyau tenues par le presse-papiers (à garder quand on ferme un dessin). */
export function clipboardShapeIds(): string[] {
  return clipboard ? clipboard.entities.flatMap((e) => (e.type === '3DSOLID' ? [e.shapeId] : [])) : [];
}

function strip(e: Entity): NewEntity {
  const { handle: _h, ...rest } = e;
  return rest as NewEntity;
}

function bboxOf(es: Entity[]): { min: Vec3; max: Vec3 } | null {
  let min: Vec3 | null = null, max: Vec3 | null = null;
  for (const e of es) {
    const b = e.type === '3DSOLID' ? e.display.bbox : entityBBox(e);
    if (!b) continue;
    min = min ? { x: Math.min(min.x, b.min.x), y: Math.min(min.y, b.min.y), z: Math.min(min.z, b.min.z) } : { ...b.min };
    max = max ? { x: Math.max(max.x, b.max.x), y: Math.max(max.y, b.max.y), z: Math.max(max.z, b.max.z) } : { ...b.max };
  }
  return min && max ? { min, max } : null;
}

const copyClip = cmd('COPYCLIP', 'COPIERPP', ['CTRLC'], 'Copie les objets dans le presse-papiers (Ctrl+C)', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  const es = hs.map((h) => app.doc.get(h)).filter((e): e is Entity => !!e);
  if (!es.length) return;
  setClip(app, es, bboxOf(es)?.min ?? { x: 0, y: 0, z: 0 });
  ctx.print(`${es.length} objet(s) copié(s) dans le presse-papiers.`);
});

const cutClip = cmd('CUTCLIP', 'COUPERPP', ['CTRLX'], 'Coupe les objets vers le presse-papiers (Ctrl+X)', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  const es = hs.map((h) => app.doc.get(h)).filter((e): e is Entity => !!e);
  if (!es.length) return;
  setClip(app, es, bboxOf(es)?.min ?? { x: 0, y: 0, z: 0 });
  app.doc.transaction('Couper', () => hs.forEach((h) => app.doc.removeEntity(h)));
  ctx.print(`${es.length} objet(s) coupé(s).`);
});

const copyBase = cmd('COPYBASE', 'COPIERBASE', ['CTRLMAJC'], 'Copie avec point de base dans le presse-papiers (Ctrl+Maj+C)', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  const es = hs.map((h) => app.doc.get(h)).filter((e): e is Entity => !!e);
  if (!es.length) return;
  const base = await getPoint(ctx, 'Spécifiez le point de base');
  setClip(app, es, base);
  ctx.print(`${es.length} objet(s) copié(s) avec point de base.`);
});

async function paste(ctx: CommandContext, app: AppHost, clip: { entities: Entity[]; base: Vec3; layers: LayerDef[] }, at: Vec3): Promise<void> {
  const m = translation(sub(at, clip.base));
  // collage dans un autre dessin : ses calques manquants sont créés, les fonds de plan absents ignorés
  const missing = clip.layers.filter((l) => !app.doc.layer(l.name));
  if (missing.length) app.doc.layers = [...app.doc.layers, ...missing.map((l) => ({ ...l, frozen: false, locked: false }))];
  clip = { ...clip, entities: clip.entities.filter((e) => e.type !== 'UNDERLAY' || !!app.doc.underlays[e.ref]) };
  const solids = clip.entities.filter((e): e is Solid3D => e.type === '3DSOLID');
  if (solids.length) await app.ensureKernel(ctx);
  const moved = await Promise.all(solids.map((s) => app.kernel.solid({ op: 'transform', shapeId: s.shapeId, matrix: m })));
  const out: string[] = [];
  app.doc.transaction('Coller', () => {
    for (const e of clip.entities) {
      if (e.type === '3DSOLID') {
        const r = moved[solids.indexOf(e)]!;
        out.push(app.doc.addEntity({ ...strip(e), shapeId: r.shapeId, display: r.display, primitive: placePrimitive(e.primitive, m), history: placeHistory(e.history, m) } as NewEntity));
      } else out.push(app.doc.addEntity({ ...strip(e), ...transformEntity(e, m) } as NewEntity));
    }
  });
  app.selection.set(out);
  ctx.print(`${out.length} objet(s) collé(s).`);
}

const pasteClip = cmd('PASTECLIP', 'COLLERPP', ['CTRLV'], 'Colle le presse-papiers (Ctrl+V)', async (ctx, app) => {
  const clip = clipboard;
  if (!clip) return ctx.print('Le presse-papiers est vide.');
  const polys = clip.entities.flatMap((e) => (e.type === '3DSOLID' ? outlinesOfSolid(e) : curvePoints(e)));
  const p = await getPoint(ctx, 'Spécifiez le point d’insertion', {
    noRubberBand: true,
    preview: (c) => polys.map((pl) => pl.map((q) => add(q, sub(c, clip.base)))),
  });
  await paste(ctx, app, clip, p);
});

const pasteOrig = cmd('PASTEORIG', 'COLLERORIG', [], 'Colle le presse-papiers aux coordonnées d’origine', async (ctx, app) => {
  const clip = clipboard;
  if (!clip) return ctx.print('Le presse-papiers est vide.');
  await paste(ctx, app, clip, clip.base);
});

function outlinesOfSolid(s: Solid3D): Vec3[][] {
  const d = s.display;
  const out: Vec3[][] = [];
  for (let i = 0; i + 1 < d.edgeOffsets.length; i++) {
    const pts: Vec3[] = [];
    for (let k = d.edgeOffsets[i]!; k < d.edgeOffsets[i + 1]!; k++) pts.push({ x: d.edgePoints[3 * k]!, y: d.edgePoints[3 * k + 1]!, z: d.edgePoints[3 * k + 2]! });
    out.push(pts);
  }
  return out;
}

const selectAll = cmd('SELECTALL', 'TOUTSEL', ['TS', 'AI_SELALL'], 'Sélectionne tous les objets (Ctrl+A)', async (ctx, app) => {
  const hs = app.doc.all().filter((e) => app.doc.isPickable(e)).map((e) => e.handle);
  app.selection.set(hs);
  ctx.print(`${hs.length} objet(s) sélectionné(s).`);
}, { transparent: true });

export const utilityCommands: CommandDefinition[] = [
  customize,
  zoom,
  pan,
  view,
  visualStyle,
  perspective,
  regen,
  undo,
  redo,
  layer,
  properties,
  help,
  layerCurrent,
  purge,
  osnap,
  grid,
  snap,
  ortho,
  polar,
  dyn,
  dynCoords,
  namedViews,
  lwt,
  setvar,
  distance,
  area,
  idPoint,
  list,
  massprop,
  matchprop,
  copyClip,
  copyBase,
  pasteOrig,
  cutClip,
  pasteClip,
  selectAll,
];
