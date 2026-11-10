/**
 * Outils communs aux commandes : saisies typées, sélection (PICKFIRST), mots-clés.
 */
import { ask, CommandCancelled, type CommandContext, type CommandDefinition, type EntityPick, type Keyword, type PickMode, type PromptSpec, type Vec3 } from '../../core/commands';
import type { Entity } from '../../core/document/Document';
import { curvePoints } from '../../core/entities/geometry';
import type { AppHost } from '../AppHost';

export const host = (ctx: CommandContext): AppHost => ctx.document as AppHost;

export const kw = (global: string, local: string, alias?: string, description?: string): Keyword => ({ global, local, alias, description });

export function cmd(name: string, localName: string, aliases: string[], description: string, run: (ctx: CommandContext, app: AppHost) => Promise<void>, extra: Partial<CommandDefinition> = {}): CommandDefinition {
  return { name, localName, aliases, description, run: (ctx) => run(ctx, host(ctx)), ...extra };
}

type Opt = Partial<Omit<PromptSpec, 'kind' | 'message'>>;

/** Point obligatoire (ou mot-clé si `keywords`). */
export async function getPoint(ctx: CommandContext, message: string, opts: Opt = {}): Promise<Vec3> {
  const r = await ask(ctx, { kind: 'point', message, ...opts });
  if (r.kind !== 'point') throw new CommandCancelled();
  return r.value;
}

export async function getPointOrKeyword(ctx: CommandContext, message: string, opts: Opt = {}): Promise<{ point?: Vec3; keyword?: string; none?: boolean }> {
  const r = await ask(ctx, { kind: 'point', message, ...opts });
  if (r.kind === 'point') return { point: r.value };
  if (r.kind === 'keyword') return { keyword: r.value };
  if (r.kind === 'number' && opts.basePoint) return { point: opts.basePoint };
  return { none: true };
}

export async function getDistance(ctx: CommandContext, message: string, opts: Opt = {}): Promise<number | string> {
  const r = await ask(ctx, { kind: 'distance', message, ...opts });
  if (r.kind === 'number') return r.value;
  if (r.kind === 'keyword') return r.value;
  throw new CommandCancelled();
}

export async function getNumber(ctx: CommandContext, message: string, opts: Opt & { integer?: boolean } = {}): Promise<number | string> {
  const { integer, ...rest } = opts;
  const r = await ask(ctx, { kind: integer ? 'integer' : 'real', message, ...rest });
  if (r.kind === 'number') return r.value;
  if (r.kind === 'keyword') return r.value;
  throw new CommandCancelled();
}

/** Angle en radians. */
export async function getAngle(ctx: CommandContext, message: string, opts: Opt = {}): Promise<number | string> {
  const r = await ask(ctx, { kind: 'angle', message, allowNegative: true, ...opts });
  if (r.kind === 'number') return r.value;
  if (r.kind === 'keyword') return r.value;
  throw new CommandCancelled();
}

export async function getKeyword(ctx: CommandContext, message: string, keywords: Keyword[], defaultValue?: string): Promise<string> {
  const r = await ask(ctx, { kind: 'keyword', message, keywords, defaultValue });
  if (r.kind === 'keyword') return r.value;
  throw new CommandCancelled();
}

export async function getString(ctx: CommandContext, message: string, defaultValue?: string): Promise<string | null> {
  const r = await ask(ctx, { kind: 'string', message, defaultValue, allowNone: true });
  if (r.kind === 'string') return r.value;
  return null;
}

const KW_ALL = kw('All', 'Tout', 'TO', 'Tous les objets visibles');

/**
 * Sélection d'objets : présélection (PICKFIRST) sinon prompt « Choisissez les objets »
 * (clics, fenêtre, capture), validé par Entrée.
 */
export async function selectObjects(ctx: CommandContext, message = 'Choisissez les objets', filter?: (e: Entity) => boolean, allowNone = false): Promise<string[]> {
  const app = host(ctx);
  const f = filter ? (h: string) => { const e = app.doc.get(h); return !!e && filter(e); } : undefined;
  const pre = app.takePreselection(f);
  if (pre.length) {
    ctx.print(`${pre.length} objet(s) présélectionné(s)`);
    return pre;
  }
  app.selection.clear();
  for (;;) {
    const r = await ask(ctx, { kind: 'selection', message, keywords: [KW_ALL], filter: f, allowNone });
    if (r.kind === 'selection') return r.value;
    if (r.kind === 'keyword' && r.value === 'All') {
      const all = app.doc.all().filter((e) => app.doc.isPickable(e) && (!filter || filter(e))).map((e) => e.handle);
      ctx.print(`${all.length} trouvé(s)`);
      return all;
    }
    if (r.kind === 'none') return [];
  }
}

/** Désignation d'un objet unique (ou d'une arête / face de solide). */
export async function pickEntity(ctx: CommandContext, message: string, opts: { filter?: (e: Entity) => boolean; pickMode?: PickMode; keywords?: Keyword[]; allowNone?: boolean } = {}): Promise<EntityPick | string | null> {
  const app = host(ctx);
  const f = opts.filter ? (h: string) => { const e = app.doc.get(h); return !!e && opts.filter!(e); } : undefined;
  const r = await ask(ctx, { kind: 'entity', message, filter: f, pickMode: opts.pickMode, keywords: opts.keywords, allowNone: opts.allowNone });
  if (r.kind === 'entity') return r.value;
  if (r.kind === 'keyword') return r.value;
  if (r.kind === 'none') return null;
  throw new CommandCancelled();
}

export async function pickRequired(ctx: CommandContext, message: string, filter?: (e: Entity) => boolean, pickMode?: PickMode): Promise<{ e: Entity; pick: EntityPick }> {
  const app = host(ctx);
  for (;;) {
    const r = await pickEntity(ctx, message, { filter, pickMode });
    if (r && typeof r === 'object') {
      const e = app.doc.get(r.handle);
      if (e) return { e, pick: r };
    }
  }
}

export const is = (...types: Entity['type'][]) => (e: Entity) => types.includes(e.type);

export const isSolid = (e: Entity) => e.type === '3DSOLID' && e.display.solidCount > 0;
export const isSurface = (e: Entity) => e.type === '3DSOLID' && e.display.solidCount === 0;
export const isBody = (e: Entity) => e.type === '3DSOLID';

export const fmt = (v: number, p = 4) => {
  const s = v.toFixed(p);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

export const fmtPt = (p: Vec3) => `${fmt(p.x)},${fmt(p.y)},${fmt(p.z)}`;

export const DEG = Math.PI / 180;

/** Contours (polylignes) des entités, pour les aperçus de transformation. */
export function outlines(app: AppHost, handles: string[], budget = 40000): Vec3[][] {
  const out: Vec3[][] = [];
  let count = 0;
  for (const h of handles) {
    const e = app.doc.get(h);
    if (!e) continue;
    if (e.type === '3DSOLID') {
      const d = e.display;
      for (let i = 0; i + 1 < d.edgeOffsets.length && count < budget; i++) {
        const pts: Vec3[] = [];
        for (let k = d.edgeOffsets[i]!; k < d.edgeOffsets[i + 1]!; k++) pts.push({ x: d.edgePoints[3 * k]!, y: d.edgePoints[3 * k + 1]!, z: d.edgePoints[3 * k + 2]! });
        if (pts.length > 1) out.push(pts), (count += pts.length);
      }
    } else
      for (const pl of curvePoints(e)) {
        out.push(pl);
        count += pl.length;
      }
    if (count > budget) break;
  }
  return out;
}

