/**
 * LIGNE (_LINE, alias L) — boucle de saisie avec options contextuelles :
 * "annUler" apparaît dès le 2e point, "Clore" dès le 3e, Entrée à vide termine.
 */
import { ask } from '../CommandProcessor';
import type { CommandDefinition, Keyword, Vec3 } from '../types';

export interface LineEntity {
  type: 'LINE';
  start: Vec3;
  end: Vec3;
}

export interface LineHost {
  addEntity(e: LineEntity): string;
  removeEntity(id: string): void;
}

const KW_UNDO: Keyword = { global: 'Undo', local: 'annUler', alias: 'U' };
const KW_CLOSE: Keyword = { global: 'Close', local: 'Clore', alias: 'C' };

export const lineCommand: CommandDefinition = {
  name: 'LINE',
  localName: 'LIGNE',
  aliases: ['L'],
  description: 'Crée des segments de droite',

  async run(ctx) {
    const host = ctx.document as LineHost;
    const first = await ask(ctx, { kind: 'point', message: 'Spécifiez le premier point' });
    if (first.kind !== 'point') return;
    const points: Vec3[] = [first.value];
    const ids: string[] = [];

    for (;;) {
      const keywords = [...(points.length >= 3 ? [KW_CLOSE] : []), ...(points.length >= 2 ? [KW_UNDO] : [])];
      const prev = points[points.length - 1]!;
      const r = await ask(ctx, {
        kind: 'point',
        message: 'Spécifiez le point suivant',
        keywords,
        basePoint: prev,
        allowNone: true,
      });
      if (r.kind === 'none') return;
      if (r.kind === 'keyword' && r.value === 'Undo') {
        host.removeEntity(ids.pop()!);
        points.pop();
        continue;
      }
      if (r.kind === 'keyword' && r.value === 'Close') {
        host.addEntity({ type: 'LINE', start: prev, end: points[0]! });
        return;
      }
      if (r.kind === 'point') {
        ids.push(host.addEntity({ type: 'LINE', start: prev, end: r.value }));
        points.push(r.value);
      }
    }
  },
};
