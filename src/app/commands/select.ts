/**
 * Commandes du menu contextuel : ordre de tracé, sélection similaire, sélection
 * rapide, rechercher / remplacer, options ; et insertion des pièces de la bibliothèque.
 */
import type { CommandDefinition } from '../../core/commands';
import type { Entity } from '../../core/document/Document';
import { curvePoints, TYPE_LABEL } from '../../core/entities/geometry';
import type { AppHost } from '../AppHost';
import { applyMatrix, insertPart, partMatrix, type PartAxis, type PartDef, type PartValues } from '../parts';
import { cmd, getKeyword, getPointOrKeyword, kw, selectObjects } from './helpers';

// ---------------------------------------------------------------------------
// Ordre de tracé
// ---------------------------------------------------------------------------

const drawOrder = cmd('DRAWORDER', 'ORDRETRACE', ['DR', 'ORDRE'], 'Place les objets devant ou derrière les autres (remplissages, textes)', async (ctx, app) => {
  const hs = await selectObjects(ctx);
  if (!hs.length) return;
  const v = await getKeyword(ctx, 'Entrez l’option d’ordre des objets', [kw('Front', 'Premier plan', 'P'), kw('Back', 'Arrière-plan', 'A')], 'Arrière-plan');
  app.doc.reorder(hs, v === 'Front' ? 'front' : 'back');
  app.selection.set(hs);
  ctx.print(`${hs.length} objet(s) placé(s) ${v === 'Front' ? 'au premier plan' : 'à l’arrière-plan'}.`);
});

/** Raccourcis du sous-menu (sélection courante, sans question). */
export function reorderSelection(app: AppHost, where: 'front' | 'back'): void {
  const hs = app.selection.list();
  if (hs.length) app.doc.reorder(hs, where);
}

// ---------------------------------------------------------------------------
// Sélection similaire, sélection rapide
// ---------------------------------------------------------------------------

/** Même type, même calque (et même nom de fond de plan) que l'un des objets de référence. */
export function similarTo(app: AppHost, refs: Entity[]): string[] {
  const keys = new Set(refs.map((e) => `${e.type}|${e.layer}|${e.type === 'UNDERLAY' ? e.ref : ''}`));
  return app.doc
    .all()
    .filter((e) => app.doc.isPickable(e) && keys.has(`${e.type}|${e.layer}|${e.type === 'UNDERLAY' ? e.ref : ''}`))
    .map((e) => e.handle);
}

const selectSimilar = cmd('SELECTSIMILAR', 'SELECTSIMILAIRE', ['SELSIM'], 'Sélectionne tous les objets de même type et de même calque', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les objets de référence');
  const refs = hs.map((h) => app.doc.get(h)).filter((e): e is Entity => !!e);
  if (!refs.length) return;
  const out = similarTo(app, refs);
  app.selection.set(out);
  ctx.print(`${out.length} objet(s) similaire(s) sélectionné(s).`);
});

const qselect = cmd('QSELECT', 'SELECTRAPIDE', ['QS', 'SELRAPIDE'], 'Sélection rapide par type, calque, couleur ou texte', async (ctx, app) => {
  const all = app.doc.all().filter((e) => app.doc.isPickable(e));
  const types = [...new Set(all.map((e) => e.type))].sort();
  const layers = [...new Set(all.map((e) => e.layer))].sort((a, b) => a.localeCompare(b));
  const colors = [...new Set(all.map((e) => app.doc.colorOf(e)))].sort();
  const v = await app.ui.form({
    title: 'Sélection rapide',
    intro: `${all.length} objet(s) sélectionnable(s) dans le dessin.`,
    ok: 'Sélectionner',
    fields: [
      { key: 'type', label: 'Type d’objet', type: 'select', value: '*', options: [{ value: '*', label: 'Multiple (tous)' }, ...types.map((t) => ({ value: t, label: TYPE_LABEL[t] }))] },
      { key: 'layer', label: 'Calque', type: 'select', value: '*', options: [{ value: '*', label: 'Tous' }, ...layers.map((l) => ({ value: l, label: l }))] },
      { key: 'color', label: 'Couleur', type: 'select', value: '*', options: [{ value: '*', label: 'Toutes' }, ...colors.map((c) => ({ value: c, label: c }))] },
      { key: 'text', label: 'Texte contenant', type: 'text', value: '', hint: 'Textes et cotes dont le contenu contient ce mot' },
      { key: 'mode', label: 'Résultat', type: 'select', value: 'new', options: [{ value: 'new', label: 'Nouvelle sélection' }, { value: 'add', label: 'Ajouter à la sélection' }, { value: 'exclude', label: 'Tout sauf ces objets' }] },
    ],
  });
  if (!v) return;
  const needle = String(v.text).trim().toLowerCase();
  const match = (e: Entity) =>
    (v.type === '*' || e.type === v.type) &&
    (v.layer === '*' || e.layer === v.layer) &&
    (v.color === '*' || app.doc.colorOf(e) === v.color) &&
    (!needle || (e.type === 'TEXT' && e.text.toLowerCase().includes(needle)) || (e.type === 'DIMENSION' && (e.textOverride ?? '').toLowerCase().includes(needle)));
  const hits = all.filter((e) => (v.mode === 'exclude' ? !match(e) : match(e))).map((e) => e.handle);
  if (v.mode === 'add') app.selection.add(hits);
  else app.selection.set(hits);
  ctx.print(`${hits.length} objet(s) trouvé(s).`);
});

// ---------------------------------------------------------------------------
// Rechercher / remplacer
// ---------------------------------------------------------------------------

const find = cmd('FIND', 'RECHERCHER', ['CHERCHER', 'REMPLACER'], 'Recherche (et remplace) du texte dans les textes et les cotes', async (ctx, app) => {
  const v = await app.ui.form({
    title: 'Rechercher et remplacer',
    ok: 'Rechercher',
    fields: [
      { key: 'find', label: 'Rechercher', type: 'text', value: '' },
      { key: 'replace', label: 'Remplacer par (vide = rechercher seulement)', type: 'text', value: '' },
      { key: 'case', label: 'Respecter la casse', type: 'checkbox', value: false },
      { key: 'whole', label: 'Mot entier', type: 'checkbox', value: false },
    ],
  });
  if (!v || !String(v.find)) return;
  const esc = String(v.find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(v.whole ? `\\b${esc}\\b` : esc, v.case ? 'g' : 'gi');
  const hits = app.doc.all().filter((e) => app.doc.isPickable(e) && ((e.type === 'TEXT' && re.test(e.text)) || (e.type === 'DIMENSION' && !!e.textOverride && re.test(e.textOverride))));
  re.lastIndex = 0;
  if (!hits.length) return ctx.print(`« ${v.find} » introuvable.`);
  const rep = String(v.replace);
  if (rep) {
    app.doc.transaction('Remplacer', () => {
      for (const e of hits) {
        if (e.type === 'TEXT') app.doc.replaceEntity(e.handle, { text: e.text.replace(re, rep) });
        else if (e.type === 'DIMENSION') app.doc.replaceEntity(e.handle, { textOverride: e.textOverride!.replace(re, rep) });
      }
    });
    ctx.print(`${hits.length} texte(s) modifié(s).`);
  } else ctx.print(`${hits.length} texte(s) trouvé(s) et sélectionné(s).`);
  app.selection.set(hits.map((e) => e.handle));
  app.viewport?.zoomToPoints(hits.flatMap((e) => curvePoints(e).flat()));
});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

const options = cmd('OPTIONS', 'OPTIONS', ['OP', 'PREFERENCES'], 'Options de l’application (clic droit, repérage, ligne de commande…)', async (ctx, app) => {
  const s = app.settings;
  const v = await app.ui.form({
    title: 'Options',
    fields: [
      { key: 'rightClickDelay', label: 'Clic droit long = menu après (ms)', type: 'number', value: s.rightClickDelay, min: 0, max: 3000, step: 50, hint: 'Plus court : Entrée. 0 : toujours le menu.' },
      { key: 'polarIncrement', label: 'Incrément polaire (°)', type: 'number', value: s.polarIncrement, min: 1, max: 90 },
      { key: 'historyLines', label: 'Lignes d’historique de commande', type: 'number', value: s.historyLines, min: 1, max: 20 },
      { key: 'dyn', label: 'Saisie dynamique près du curseur (F12)', type: 'checkbox', value: s.dyn },
      { key: 'showConstraints', label: 'Afficher les contraintes', type: 'checkbox', value: s.showConstraints },
      { key: 'holeComp', label: 'Compensation des trous imprimés (mm sur le Ø)', type: 'number', value: s.holeComp ?? 0, min: 0, max: 2, step: 0.05, hint: 'Agrandit les nouveaux trous de passage et ceux des pièces (plaquette de calibration : Ø nominal − Ø mesuré).' },
      { key: 'threadExport', label: 'Filetages réels : aperçu cosmétique, filet exact à l’export', type: 'checkbox', value: s.threadMode !== 'always' },
    ],
  });
  if (!v) return;
  app.set('rightClickDelay', Math.max(0, Math.min(3000, Math.round(Number(v.rightClickDelay) || 0))));
  if (Number(v.polarIncrement) > 0) app.set('polarIncrement', Number(v.polarIncrement));
  app.set('historyLines', Math.max(1, Math.min(20, Math.round(Number(v.historyLines) || 3))));
  app.set('dyn', !!v.dyn);
  app.set('showConstraints', !!v.showConstraints);
  app.set('holeComp', Math.max(0, Math.min(2, Number(v.holeComp) || 0)));
  app.set('threadMode', v.threadExport ? 'export' : 'always');
  ctx.print('Options enregistrées.');
});

// ---------------------------------------------------------------------------
// Bibliothèque de pièces
// ---------------------------------------------------------------------------

let pending: { def: PartDef; values: PartValues; axis: PartAxis } | null = null;

/** Lance l'insertion d'une pièce réglée dans la palette (point d'insertion demandé). */
export function requestPart(app: AppHost, def: PartDef, values: PartValues, axis: PartAxis): void {
  pending = { def, values, axis };
  app.run('INSERERPIECE');
}

const library = cmd('PARTS', 'PIECES', ['BIB', 'BIBLIOTHEQUE', 'PIECE'], 'Bibliothèque de pièces : visserie, tubes, profilés, boîtes', async (_ctx, app) => {
  if (app.settings.panel !== 'parts') app.showPanel('parts');
});

const insertPartCmd = cmd('INSERTPART', 'INSERERPIECE', [], 'Insère la pièce réglée dans la bibliothèque', async (ctx, app) => {
  const p = pending;
  if (!p) return ctx.print('Choisissez une pièce dans la palette Pièces (commande PIECES).');
  const outline = p.def.preview(p.values);
  let count = 0;
  for (;;) {
    const r = await getPointOrKeyword(ctx, count ? 'Point d’insertion suivant (Entrée pour terminer)' : `Point d’insertion de « ${p.def.title(p.values)} »`, {
      noRubberBand: true,
      allowNone: count > 0,
      preview: (c) => {
        const m = partMatrix(p.axis, c);
        return outline.map((pl) => pl.map((q) => applyMatrix(m, q)));
      },
    });
    const at = r.point;
    if (!at) break;
    try {
      await insertPart(app, ctx, p.def, p.values, p.axis, at);
      count++;
    } catch (e) {
      ctx.print(`Pièce non construite : ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
  }
});

export const selectCommands: CommandDefinition[] = [drawOrder, selectSimilar, qselect, find, options, library, insertPartCmd];
