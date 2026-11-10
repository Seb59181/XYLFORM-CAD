/**
 * Rendu réaliste : MATERIAU attribue un matériau (acier, laiton, PLA, verre…) aux solides ;
 * RENDU produit une image PNG haute définition avec matériaux, reflets et ombres portées
 * (style visuel « Rendu »), sur fond studio, uni ou transparent.
 */
import type { CommandDefinition } from '../../core/commands';
import type { Entity } from '../../core/document/Document';
import { MATERIALS } from '../../core/materials';
import { baseName, saveFile } from '../../io/fileAccess';
import { cmd, fmt, isBody, selectObjects } from './helpers';

const material = cmd('MATERIAL', 'MATERIAU', ['MATERIAUX', 'MAT'], 'Attribue un matériau de rendu aux solides (métaux, plastiques, bois, verre…)', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les solides', isBody);
  if (!hs.length) return;
  const first = app.doc.get(hs[0]!) as Extract<Entity, { type: '3DSOLID' }>;
  const v = await app.ui.form({
    title: 'Matériau',
    intro: `${hs.length} solide(s). Les plastiques gardent la couleur de l’objet ; visible dans les styles Réaliste et Rendu.`,
    fields: [
      {
        key: 'material',
        label: 'Matériau',
        type: 'select',
        value: first.material ?? '',
        options: [{ value: '', label: 'Aucun (couleur seule)' }, ...MATERIALS.map((m) => ({ value: m.id, label: `${m.group} — ${m.label}` }))],
      },
      { key: 'render', label: 'Passer au style Rendu (ombres)', type: 'checkbox', value: app.settings.visualStyle !== 'render' },
    ],
    ok: 'Appliquer',
  });
  if (!v) return;
  const id = String(v.material) || undefined;
  app.doc.transaction('Matériau', () => hs.forEach((h) => app.doc.replaceEntity(h, { material: id })));
  if (v.render) app.set('visualStyle', 'render');
  ctx.print(`${hs.length} solide(s) : ${MATERIALS.find((m) => m.id === id)?.label ?? 'sans matériau'}.`);
});

const SIZES: Record<string, [number, number] | null> = {
  view: null,
  hd: [1920, 1080],
  qhd: [2560, 1440],
  uhd: [3840, 2160],
  square: [2048, 2048],
};

const render = cmd('RENDER', 'RENDU', ['REN', 'IMAGERENDU'], 'Image de rendu réaliste (matériaux, reflets, ombres) en PNG haute définition', async (ctx, app) => {
  const vp = app.viewport;
  if (!vp) return ctx.print('Aucune vue 3D.');
  if (app.settings.workspace !== '3d') return ctx.print('Le rendu se fait dans l’espace 3D (bouton 3D de la barre de titre).');
  const view = vp.viewSize();
  const v = await app.ui.form({
    title: 'Image de rendu',
    intro: 'Cadrez la vue souhaitée avant de lancer le rendu. Les matériaux s’attribuent avec MATERIAU.',
    fields: [
      {
        key: 'size',
        label: 'Taille',
        type: 'select',
        value: 'hd',
        options: [
          { value: 'view', label: `Vue actuelle (${view.w} × ${view.h})` },
          { value: 'hd', label: 'Full HD 1920 × 1080' },
          { value: 'qhd', label: '2560 × 1440' },
          { value: 'uhd', label: '4K 3840 × 2160' },
          { value: 'square', label: 'Carré 2048 × 2048' },
        ],
      },
      {
        key: 'bg',
        label: 'Fond',
        type: 'select',
        value: 'studio',
        options: [
          { value: 'studio', label: 'Studio (dégradé clair)' },
          { value: '#ffffff', label: 'Blanc' },
          { value: '#212830', label: 'Sombre (comme l’écran)' },
          { value: 'none', label: 'Transparent' },
        ],
      },
      { key: 'shadows', label: 'Ombres portées', type: 'checkbox', value: true },
      { key: 'aa', label: 'Lissage maximal (plus lent)', type: 'checkbox', value: true },
    ],
    ok: 'Rendre',
  });
  if (!v) return;
  const size = SIZES[String(v.size)] ?? [view.w, view.h];
  const prev = app.settings.visualStyle;
  const want = v.shadows ? 'render' : 'realistic';
  const selection = app.selection.list();
  app.selection.clear();
  if (prev !== want) app.set('visualStyle', want);
  ctx.print(`Rendu ${size[0]} × ${size[1]}…`);
  await new Promise((r) => setTimeout(r, 80)); // reconstruction des matériaux
  let blob: Blob | null;
  try {
    const bg = String(v.bg);
    blob = await vp.renderImage(size[0], size[1], bg === 'none' ? null : bg, v.aa ? 2 : 1);
  } finally {
    if (prev !== want) app.set('visualStyle', prev);
    app.selection.set(selection);
  }
  if (!blob) return ctx.print('Le rendu a échoué.');
  const data = new Uint8Array(await blob.arrayBuffer());
  const t = await saveFile(data, { name: `${baseName(app.doc.fileName)}-rendu.png`, mime: 'image/png', description: 'Image PNG', extensions: ['.png'] });
  if (t) {
    ctx.print(`Image de rendu enregistrée : ${t.name} (${fmt(data.length / 1024, 0)} Ko).`);
    app.ui.toast(`Rendu enregistré : ${t.name}`, 'success');
  }
});

export const renderCommands: CommandDefinition[] = [material, render];
