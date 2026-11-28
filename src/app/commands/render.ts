/**
 * Rendu réaliste : MATERIAU attribue un matériau (acier, laiton, PLA, verre…) aux solides ;
 * TEXTURE plaque une image sur leurs faces (taille du motif réglable) ; LUMIERE pose une
 * ampoule, un projecteur ou un soleil ; LUMIERES règle lumières et ambiance avec aperçu en
 * direct ; RENDU produit une image PNG haute définition (styles Rendu et Photoréaliste) ;
 * RAYONS calcule une image photoréaliste par lancer de rayons (lumière globale, reflets et
 * réfractions physiques, ombres douces), qui s'affine passe après passe.
 */
import type { CommandContext, CommandDefinition, Vec3 } from '../../core/commands';
import type { Entity } from '../../core/document/Document';
import { MATERIALS } from '../../core/materials';
import { defaultLight, LIGHT_PRESETS, newTextureId, sanitizeLight, type LightKind, type TextureMapping } from '../../core/render';
import { baseName, saveFile } from '../../io/fileAccess';
import type { AppHost, RaytraceSettings } from '../AppHost';
import { cmd, fmt, getAngle, getDistance, getKeyword, getPoint, isBody, kw, selectObjects } from './helpers';

type Solid = Extract<Entity, { type: '3DSOLID' }>;

/** Boîte des solides visibles (placement des lumières, taille de motif proposée). */
function solidsBox(app: AppHost, handles?: string[]): { min: Vec3; max: Vec3 } | null {
  const list = (handles ? handles.map((h) => app.doc.get(h)) : app.doc.all()).filter((e): e is Solid => !!e && e.type === '3DSOLID' && !e.hidden);
  if (!list.length) return null;
  const bs = list.map((e) => e.display.bbox);
  return {
    min: { x: Math.min(...bs.map((b) => b.min.x)), y: Math.min(...bs.map((b) => b.min.y)), z: Math.min(...bs.map((b) => b.min.z)) },
    max: { x: Math.max(...bs.map((b) => b.max.x)), y: Math.max(...bs.map((b) => b.max.y)), z: Math.max(...bs.map((b) => b.max.z)) },
  };
}

/** Passe au style Photoréaliste si la vue n'est pas déjà dans un style à ombres. */
function ensureRenderStyle(app: AppHost, ctx: CommandContext): void {
  if (app.settings.workspace !== '3d') return;
  const s = app.settings.visualStyle;
  if (s !== 'render' && s !== 'photo') {
    app.set('visualStyle', 'photo');
    ctx.print('Style visuel : Photoréaliste.');
  }
}

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

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.bmp,.gif';
const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' };

/** Ajoute une image au dessin (dimensions lues pour garder les proportions du motif). */
async function importTexture(app: AppHost, file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  const mime = file.type || IMAGE_MIME[ext] || 'image/png';
  const data = new Uint8Array(await file.arrayBuffer());
  let width: number | undefined, height: number | undefined;
  try {
    const bmp = await createImageBitmap(new Blob([data], { type: mime }));
    width = bmp.width;
    height = bmp.height;
    bmp.close();
  } catch {
    throw new Error(`« ${file.name} » n’est pas une image lisible (PNG, JPEG, WebP, BMP ou GIF).`);
  }
  const id = newTextureId(app.doc.textures);
  app.doc.addTexture({ id, name: file.name, mime, data, width, height }, 'Texture');
  return id;
}

const texture = cmd('TEXTURE', 'TEXTURE', ['TEXTURES', 'PLAQUER'], 'Plaque une image (bois, métal brossé, logo…) sur les faces des solides, avec la taille du motif réglable', async (ctx, app) => {
  const hs = await selectObjects(ctx, 'Choisissez les solides à texturer', isBody);
  if (!hs.length) return;
  const first = app.doc.get(hs[0]!) as Solid;
  const cur = first.texture;
  const box = solidsBox(app, hs);
  const span = box ? Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) : 100;
  const known = Object.values(app.doc.textures);
  const v = await app.ui.form({
    title: 'Texture',
    intro: `${hs.length} solide(s). L’image est projetée sur chaque face selon son orientation (dessus, côtés, avant) et répétée en mosaïque. Visible dans les styles Réaliste, Rendu et Photoréaliste.`,
    fields: [
      {
        key: 'image',
        label: 'Image',
        type: 'select',
        value: cur && app.doc.textures[cur.ref] ? cur.ref : '+new',
        options: [{ value: '+new', label: 'Choisir une image sur le disque…' }, ...known.map((t) => ({ value: t.id, label: t.name })), ...(cur ? [{ value: '+none', label: 'Retirer la texture' }] : [])],
      },
      { key: 'size', label: 'Taille du motif (mm)', type: 'number', value: cur?.size ?? Math.max(1, Math.round(span / 2)), min: 0.01, hint: 'Largeur d’une image sur la pièce : plus petit = motif plus serré' },
      { key: 'angle', label: 'Rotation du motif (°)', type: 'number', value: cur?.angle ?? 0 },
      { key: 'offsetU', label: 'Décalage horizontal (mm)', type: 'number', value: cur?.offsetU ?? 0 },
      { key: 'offsetV', label: 'Décalage vertical (mm)', type: 'number', value: cur?.offsetV ?? 0 },
      { key: 'photo', label: 'Passer au style Photoréaliste', type: 'checkbox', value: app.settings.visualStyle !== 'photo' && app.settings.visualStyle !== 'render' && app.settings.visualStyle !== 'realistic' },
    ],
    ok: 'Appliquer',
  });
  if (!v) return;
  if (v.image === '+none') {
    app.doc.transaction('Retirer la texture', () => hs.forEach((h) => app.doc.replaceEntity(h, { texture: undefined })));
    ctx.print(`Texture retirée de ${hs.length} solide(s).`);
    return;
  }
  const size = Number(v.size);
  if (!(size > 0)) return ctx.print('Taille du motif invalide.');
  app.doc.beginGroup('Texture');
  try {
    let ref = String(v.image);
    if (ref === '+new') {
      const file = await app.ui.openFile(IMAGE_ACCEPT);
      if (!file) return;
      ref = await importTexture(app, file);
    }
    const mapping: TextureMapping = { ref, size, ...(Number(v.angle) ? { angle: Number(v.angle) } : {}), ...(Number(v.offsetU) ? { offsetU: Number(v.offsetU) } : {}), ...(Number(v.offsetV) ? { offsetV: Number(v.offsetV) } : {}) };
    app.doc.transaction('Texture', () => hs.forEach((h) => app.doc.replaceEntity(h, { texture: mapping })));
    const def = app.doc.textures[ref]!;
    ctx.print(`Texture « ${def.name} » sur ${hs.length} solide(s), motif de ${fmt(size)} mm${def.width && def.height ? ` × ${fmt((size * def.height) / def.width)} mm` : ''}.`);
  } finally {
    app.doc.endGroup();
  }
  if (v.photo) app.set('visualStyle', 'photo');
  else if (app.settings.visualStyle !== 'photo' && app.settings.visualStyle !== 'render' && app.settings.visualStyle !== 'realistic') ctx.print('La texture se voit dans les styles Réaliste, Rendu et Photoréaliste.');
});

const KIND_KW: Record<string, LightKind> = { Point: 'point', Spot: 'spot', Sun: 'directional' };

const light = cmd('LIGHT', 'LUMIERE', ['LAMPE', 'NOUVELLELUMIERE'], 'Pose une source de lumière (ampoule, projecteur ou soleil) réglable en couleur et en intensité', async (ctx, app) => {
  if (app.settings.workspace !== '3d') return ctx.print('Les lumières se posent dans l’espace 3D (bouton 3D de la barre de titre).');
  const k = await getKeyword(ctx, 'Type de lumière', [kw('Point', 'Ampoule', 'A', 'Lampe ponctuelle qui éclaire dans toutes les directions'), kw('Spot', 'Projecteur', 'P', 'Cône de lumière dirigé vers un point'), kw('Sun', 'Soleil', 'S', 'Lumière parallèle venant de très loin')], 'Point');
  const kind = KIND_KW[k] ?? 'point';
  const box = solidsBox(app);
  const c: Vec3 = box ? { x: (box.min.x + box.max.x) / 2, y: (box.min.y + box.max.y) / 2, z: (box.min.z + box.max.z) / 2 } : { x: 0, y: 0, z: 0 };
  const r = box ? Math.max(1, Math.hypot(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) / 2) : 50;
  let position: Vec3, target: Vec3 = { ...c };
  if (kind === 'directional') {
    const az = await getAngle(ctx, 'Direction d’où vient le soleil, vue de dessus (azimut, 0° = +X)', { defaultValue: (225 * Math.PI) / 180, basePoint: c });
    const el = await getAngle(ctx, 'Hauteur du soleil au-dessus de l’horizon', { defaultValue: (50 * Math.PI) / 180 });
    const a = typeof az === 'number' ? az : (225 * Math.PI) / 180, e = typeof el === 'number' ? el : (50 * Math.PI) / 180;
    position = { x: c.x + r * 3 * Math.cos(e) * Math.cos(a), y: c.y + r * 3 * Math.cos(e) * Math.sin(a), z: c.z + r * 3 * Math.sin(e) };
  } else {
    const p = await getPoint(ctx, 'Spécifiez l’emplacement de la lampe (vue de dessus, ou x,y,z)');
    const h = await getDistance(ctx, 'Hauteur de la lampe (z)', { defaultValue: Math.round(Math.max(p.z, (box?.max.z ?? 0) + r)) });
    position = { x: p.x, y: p.y, z: typeof h === 'number' ? h : p.z };
    if (kind === 'spot') target = await getPoint(ctx, 'Point visé par le projecteur', { defaultValue: { x: Math.round(c.x), y: Math.round(c.y), z: Math.round(box?.min.z ?? 0) }, basePoint: position });
  }
  const l = defaultLight(app.doc.lights, kind, position, target);
  const v = await app.ui.form({
    title: l.name,
    intro: 'Couleur et intensité (100 % = éclairage de référence au centre du modèle). Réglages fins et aperçu en direct : LUMIERES.',
    fields: [
      { key: 'color', label: 'Couleur', type: 'color', value: l.color, options: LIGHT_PRESETS.map((p) => ({ value: p.color, label: p.label })) },
      { key: 'intensity', label: 'Intensité (%)', type: 'number', value: 100, min: 0, max: 2000, step: 5 },
      ...(kind === 'spot' ? [{ key: 'angle', label: 'Ouverture du cône (°)', type: 'number' as const, value: 30, min: 1, max: 89 }] : []),
    ],
    ok: 'Poser',
  });
  if (!v) return;
  const def = sanitizeLight({ ...l, color: String(v.color), intensity: Number(v.intensity), shadows: !!v.shadows, ...(kind === 'spot' ? { angle: Number(v.angle) } : {}) });
  app.doc.setRender({ lights: [...app.doc.lights, def] }, 'Lumière');
  ensureRenderStyle(app, ctx);
  ctx.print(`${def.name} posée (${Math.round(def.intensity)} %). LUMIERES pour la régler, l’éteindre ou la supprimer.`);
});

const lights = cmd('LIGHTLIST', 'LUMIERES', ['AMBIANCE', 'ECLAIRAGE', 'GESTLUMIERES'], 'Lumières et ambiance du rendu réaliste : couleur, intensité, environnement, exposition, aperçu en direct', async (ctx, app) => {
  if (app.settings.workspace !== '3d') return ctx.print('Les lumières se règlent dans l’espace 3D (bouton 3D de la barre de titre).');
  const prev = app.settings.visualStyle;
  ensureRenderStyle(app, ctx);
  const r = await app.ui.renderPanel({ lights: app.doc.lights, env: app.doc.renderEnv });
  app.viewport?.previewRender(null);
  if (!r) {
    if (prev !== app.settings.visualStyle) app.set('visualStyle', prev);
    return;
  }
  app.doc.setRender({ lights: r.lights, env: r.env }, 'Lumières et ambiance');
  const on = r.lights.filter((l) => l.on).length;
  ctx.print(`${r.lights.length} lumière(s) dont ${on} allumée(s).`);
});

const render = cmd('RENDER', 'RENDU', ['REN', 'IMAGERENDU'], 'Image de rendu réaliste (matériaux, reflets, ombres) en PNG haute définition', async (ctx, app) => {
  const vp = app.viewport;
  if (!vp) return ctx.print('Aucune vue 3D.');
  if (app.settings.workspace !== '3d') return ctx.print('Le rendu se fait dans l’espace 3D (bouton 3D de la barre de titre).');
  const view = vp.viewSize();
  const v = await app.ui.form({
    title: 'Image de rendu',
    intro: 'Cadrez la vue souhaitée avant de lancer le rendu. Matériaux : MATERIAU ; images sur les faces : TEXTURE ; lumières et ambiance : LUMIERES.',
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
        key: 'quality',
        label: 'Rendu',
        type: 'select',
        value: app.settings.visualStyle === 'render' ? 'render' : 'photo',
        options: [
          { value: 'raytrace', label: 'Lancer de rayons (qualité photo : lumière globale, verre, ombres exactes)' },
          { value: 'photo', label: 'Photoréaliste (lumières, ambiance, textures)' },
          { value: 'render', label: 'Rendu (ombres portées)' },
          { value: 'realistic', label: 'Réaliste (sans ombres)' },
        ],
      },
      {
        key: 'bg',
        label: 'Fond',
        type: 'select',
        value: app.settings.visualStyle === 'photo' && app.doc.renderEnv.background === 'environment' ? 'environment' : 'studio',
        options: [
          { value: 'environment', label: 'Environnement (style Photoréaliste)' },
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
  if (v.quality === 'raytrace') {
    const bg = String(v.bg);
    return openRaytrace(ctx, app, { width: size[0], height: size[1], background: bg === 'none' ? 'transparent' : bg === '#ffffff' ? 'white' : bg === '#212830' ? 'screen' : bg === 'studio' ? 'studio' : 'environment' });
  }
  const prev = app.settings.visualStyle;
  const want = v.quality === 'render' ? 'render' : v.quality === 'realistic' ? 'realistic' : 'photo';
  const selection = app.selection.list();
  app.selection.clear();
  if (prev !== want) app.set('visualStyle', want);
  ctx.print(`Rendu ${size[0]} × ${size[1]}…`);
  await new Promise((r) => setTimeout(r, 80)); // reconstruction des matériaux
  let blob: Blob | null;
  try {
    const bg = String(v.bg);
    blob = await vp.renderImage(size[0], size[1], bg === 'none' ? null : bg === 'environment' && want !== 'photo' ? 'studio' : bg, v.aa ? 2 : 1);
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

/** Réglages de départ du lancer de rayons, tirés de l'ambiance du dessin. */
export function raytraceDefaults(app: AppHost, p: Partial<RaytraceSettings> = {}): RaytraceSettings {
  const view = app.viewport?.viewSize() ?? { w: 1280, h: 720 };
  const env = app.doc.renderEnv;
  return {
    width: view.w,
    height: view.h,
    maxSamples: 128,
    bounces: 5,
    background: env.background === 'environment' ? 'environment' : 'screen',
    floor: env.ground ? 'studio' : 'none',
    softness: 35,
    denoise: true,
    exposure: env.exposure,
    ...p,
  };
}

async function openRaytrace(ctx: CommandContext, app: AppHost, p: Partial<RaytraceSettings> = {}): Promise<void> {
  const vp = app.viewport;
  if (!vp?.raytrace) return ctx.print('Le lancer de rayons demande une vue 3D.');
  if (app.settings.workspace !== '3d') return ctx.print('Le rendu se fait dans l’espace 3D (bouton 3D de la barre de titre).');
  const prev = app.settings.visualStyle;
  const selection = app.selection.list();
  app.selection.clear();
  // les matériaux et textures de la vue Photoréaliste servent de base au lancer de rayons
  if (prev !== 'photo') app.set('visualStyle', 'photo');
  await new Promise((r) => setTimeout(r, 80));
  ctx.print('Lancer de rayons : l’image s’affine passe après passe ; Enregistrer l’image… à tout moment.');
  try {
    await app.ui.raytracePanel(raytraceDefaults(app, p));
  } finally {
    if (prev !== 'photo') app.set('visualStyle', prev);
    app.selection.set(selection);
  }
}

const raytrace = cmd('RAYTRACE', 'RAYONS', ['LANCERRAYONS', 'RENDUPHOTO', 'RENDURAYONS', 'PATHTRACE'], 'Rendu photoréaliste par lancer de rayons : lumière globale, reflets et réfractions physiques, ombres douces, image qui s’affine', async (ctx, app) => {
  await openRaytrace(ctx, app);
});

export const renderCommands: CommandDefinition[] = [material, texture, light, lights, render, raytrace];
