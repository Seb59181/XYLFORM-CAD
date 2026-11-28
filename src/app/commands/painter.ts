/**
 * Pinceau de propriétés (PINCEAU) : copie les propriétés d'un objet source vers d'autres
 * objets. Le choix des propriétés copiées (option Paramètres) est mémorisé.
 *
 *   - toutes les entités : calque, couleur ;
 *   - solides : matériau de rendu, texture ;
 *   - textes : hauteur, facteur de largeur, interligne, rotation ;
 *   - cotes : style de cote, hauteur du texte, tolérance ;
 *   - hachures : motif, échelle, angle, seconde couleur du dégradé.
 *
 * Seules les propriétés qui existent à la fois sur la source et la destination sont copiées
 * (un cercle ne reçoit pas de matériau, une cote ne reçoit pas de motif de hachures).
 */
import type { CommandDefinition } from '../../core/commands';
import type { Entity } from '../../core/document/Document';
import { ask } from '../../core/commands';
import { cmd, kw, pickRequired } from './helpers';
import type { AppHost } from '../AppHost';
import { materialById } from '../../core/materials';

export type PaintProp = 'layer' | 'color' | 'material' | 'texture' | 'text' | 'dimension' | 'hatch';

export const PAINT_PROPS: { id: PaintProp; label: string }[] = [
  { id: 'layer', label: 'Calque' },
  { id: 'color', label: 'Couleur' },
  { id: 'material', label: 'Matériau (solides)' },
  { id: 'texture', label: 'Texture (solides)' },
  { id: 'text', label: 'Texte : hauteur, largeur, interligne, rotation' },
  { id: 'dimension', label: 'Cotes : style, hauteur du texte, tolérance' },
  { id: 'hatch', label: 'Hachures : motif, échelle, angle' },
];

const ALL: PaintProp[] = PAINT_PROPS.map((p) => p.id);
const STORE = 'xylform.painter';

export function loadPaintProps(): PaintProp[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? 'null') as unknown;
    if (Array.isArray(v)) return v.filter((x): x is PaintProp => ALL.includes(x as PaintProp));
  } catch {
    /* stockage indisponible */
  }
  return [...ALL];
}

function savePaintProps(p: PaintProp[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(p));
  } catch {
    /* stockage indisponible */
  }
}

/**
 * Modifications à apporter à `dst` pour qu'il prenne les propriétés choisies de `src`
 * (objet vide si rien ne change). `layerOk` : le calque de la source existe dans le dessin.
 */
export function paintPatch(src: Entity, dst: Entity, props: readonly PaintProp[]): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const has = (x: PaintProp) => props.includes(x);
  if (src.handle === dst.handle) return p;
  if (has('layer') && dst.layer !== src.layer) p.layer = src.layer;
  if (has('color') && dst.color !== src.color) p.color = src.color;
  if (src.type === '3DSOLID' && dst.type === '3DSOLID') {
    if (has('material') && dst.material !== src.material) p.material = src.material;
    if (has('texture') && JSON.stringify(dst.texture) !== JSON.stringify(src.texture)) p.texture = src.texture ? { ...src.texture } : undefined;
  }
  if (src.type === 'TEXT' && dst.type === 'TEXT' && has('text')) {
    for (const k of ['height', 'widthFactor', 'lineSpacing', 'rotation'] as const) if (dst[k] !== src[k]) p[k] = src[k];
  }
  if (src.type === 'DIMENSION' && dst.type === 'DIMENSION' && has('dimension')) {
    for (const k of ['dimStyle', 'textHeight', 'tol', 'tolPlus', 'tolMinus'] as const) if (dst[k] !== src[k]) p[k] = src[k];
  }
  if (src.type === 'HATCH' && dst.type === 'HATCH' && has('hatch')) {
    for (const k of ['pattern', 'scale', 'angle', 'color2'] as const) if (dst[k] !== src[k]) p[k] = src[k];
  }
  return p;
}

/** Applique le pinceau sur des objets ; renvoie le nombre d'objets modifiés. */
export function paintObjects(app: AppHost, src: Entity, handles: string[], props: readonly PaintProp[]): number {
  let n = 0;
  app.doc.transaction('Pinceau', () => {
    for (const h of handles) {
      const dst = app.doc.get(h);
      if (!dst) continue;
      const patch = paintPatch(src, dst, props);
      if (!Object.keys(patch).length) continue;
      app.doc.replaceEntity(h, patch as Partial<Entity>);
      n++;
    }
  });
  return n;
}

function describe(src: Entity, props: readonly PaintProp[]): string {
  const out: string[] = [];
  if (props.includes('layer')) out.push(`calque « ${src.layer} »`);
  if (props.includes('color')) out.push(`couleur ${src.color ?? 'DuCalque'}`);
  if (src.type === '3DSOLID') {
    if (props.includes('material')) out.push(`matériau ${materialById(src.material)?.label ?? 'aucun'}`);
    if (props.includes('texture')) out.push(src.texture ? `texture ${src.texture.size} mm` : 'sans texture');
  }
  if (src.type === 'TEXT' && props.includes('text')) out.push(`texte ${src.height}`);
  if (src.type === 'DIMENSION' && props.includes('dimension')) out.push(`style de cote ${src.dimStyle ?? 'Standard'}`);
  if (src.type === 'HATCH' && props.includes('hatch')) out.push(`motif ${src.pattern}`);
  return out.join(', ') || 'aucune propriété choisie';
}

const KW_SETTINGS = kw('Settings', 'Paramètres', 'P', 'Choisir les propriétés copiées');

export const painter = cmd(
  'MATCHPROP',
  'PINCEAU',
  ['CORRESPROP', 'MA', 'CP2', 'COPIERPROPRIETES', 'PINCEAUPROP'],
  'Pinceau : copie le calque, la couleur, le matériau, la texture, le style de texte, de cote ou de hachures d’un objet vers d’autres',
  async (ctx, app) => {
    let props = loadPaintProps();
    // un objet présélectionné sert de source
    const pre = app.takePreselection();
    let src: Entity | undefined = pre.length === 1 ? app.doc.get(pre[0]!) : undefined;
    if (!src) src = (await pickRequired(ctx, 'Choisissez l’objet source')).e;
    app.selection.clear();
    ctx.print(`Propriétés copiées : ${describe(src, props)}.`);
    let total = 0;
    for (;;) {
      const r = await ask(ctx, { kind: 'selection', message: 'Choisissez les objets de destination (clic ou fenêtre, Entrée pour terminer)', keywords: [KW_SETTINGS], allowNone: true });
      if (r.kind === 'keyword' && r.value === 'Settings') {
        const v = await app.ui.form({
          title: 'Pinceau : propriétés copiées',
          intro: 'Seules les propriétés présentes à la fois sur la source et sur la destination sont copiées.',
          fields: PAINT_PROPS.map((p) => ({ key: p.id, label: p.label, type: 'checkbox' as const, value: props.includes(p.id) })),
        });
        if (v) {
          props = ALL.filter((id) => !!v[id]);
          savePaintProps(props);
          ctx.print(`Propriétés copiées : ${describe(src, props)}.`);
        }
        continue;
      }
      if (r.kind !== 'selection' || !r.value.length) break;
      const n = paintObjects(app, src, r.value, props);
      total += n;
      app.selection.clear();
      ctx.print(n ? `${n} objet(s) modifié(s).` : 'Aucune propriété à changer sur ces objets.');
    }
    if (total) ctx.print(`Pinceau : ${total} objet(s) modifié(s) au total.`);
  },
);

export const painterCommands: CommandDefinition[] = [painter];
