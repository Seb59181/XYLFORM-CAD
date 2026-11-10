/**
 * CERCLE (_CIRCLE, alias C) — exemple complet de commande à sous-options :
 *
 *   Spécifiez le centre du cercle ou [3P/2P/Ttr (tangente tangente rayon)]:
 *   Spécifiez le rayon du cercle ou [Diamètre] <10.0000>:
 *
 * La commande ne dépend que du `CommandContext` : elle fonctionne à l'identique au
 * clavier, à la souris, en saisie dynamique ou rejouée depuis un script (.scr).
 */
import { ask } from '../CommandProcessor';
import type { CommandContext, CommandDefinition, Keyword, Vec3 } from '../types';

export interface CircleEntity {
  type: 'CIRCLE';
  center: Vec3;
  radius: number;
}

/** Sous-ensemble du document utilisé par la commande (implémenté par core/document). */
export interface CircleHost {
  addEntity(e: CircleEntity): void;
  /** Variable système CIRCLERAD : dernier rayon utilisé. */
  sysvars: { CIRCLERAD: number };
  /** Résolution TTR déléguée au moteur de contraintes 2D (tangences aux entités pointées). */
  solveTangentTangentRadius?(pick1: Vec3, pick2: Vec3, radius: number): { center: Vec3; radius: number } | null;
}

const KW_3P: Keyword = { global: '3P', local: '3P', description: 'Cercle passant par trois points' };
const KW_2P: Keyword = { global: '2P', local: '2P', description: 'Deux extrémités du diamètre' };
const KW_TTR: Keyword = { global: 'TTR', local: 'Ttr', alias: 'T', description: 'Tangente, tangente, rayon' };
const KW_DIAM: Keyword = { global: 'Diameter', local: 'Diamètre', alias: 'D' };

/** Centre du cercle circonscrit (dans le plan XY du SCU, z du premier point). */
export function circumcircle(a: Vec3, b: Vec3, c: Vec3): { center: Vec3; radius: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null; // points alignés
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const center = {
    x: (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d,
    y: (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d,
    z: a.z,
  };
  return { center, radius: Math.hypot(a.x - center.x, a.y - center.y) };
}

async function getPoint(ctx: CommandContext, message: string, basePoint?: Vec3): Promise<Vec3> {
  const r = await ask(ctx, { kind: 'point', message, basePoint });
  if (r.kind !== 'point') throw new Error('Point attendu');
  return r.value;
}

export const circleCommand: CommandDefinition = {
  name: 'CIRCLE',
  localName: 'CERCLE',
  aliases: ['C'],
  description: 'Crée un cercle',

  async run(ctx) {
    const host = ctx.document as CircleHost;

    const first = await ask(ctx, {
      kind: 'point',
      message: 'Spécifiez le centre du cercle',
      keywords: [KW_3P, KW_2P, KW_TTR],
    });

    if (first.kind === 'keyword') {
      switch (first.value) {
        case '3P': {
          const p1 = await getPoint(ctx, 'Spécifiez le premier point du cercle');
          const p2 = await getPoint(ctx, 'Spécifiez le deuxième point du cercle', p1);
          const p3 = await getPoint(ctx, 'Spécifiez le troisième point du cercle', p2);
          const c = circumcircle(p1, p2, p3);
          if (!c) throw new Error('Les trois points sont alignés.');
          return emit(host, c.center, c.radius);
        }
        case '2P': {
          const p1 = await getPoint(ctx, 'Spécifiez la première extrémité du diamètre du cercle');
          const p2 = await getPoint(ctx, 'Spécifiez la deuxième extrémité du diamètre du cercle', p1);
          const center = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, z: (p1.z + p2.z) / 2 };
          return emit(host, center, Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z) / 2);
        }
        case 'TTR': {
          // Le viewport active l'accrochage TANgent pendant ces deux prompts.
          const t1 = await getPoint(ctx, 'Spécifiez un point sur l\'objet pour la première tangente du cercle');
          const t2 = await getPoint(ctx, 'Spécifiez un point sur l\'objet pour la deuxième tangente du cercle');
          const r = await ask(ctx, {
            kind: 'distance',
            message: 'Spécifiez le rayon du cercle',
            defaultValue: host.sysvars.CIRCLERAD,
            allowZero: false,
          });
          if (r.kind !== 'number') throw new Error('Rayon attendu');
          const sol = host.solveTangentTangentRadius?.(t1, t2, r.value);
          if (!sol) {
            ctx.print("Le cercle n'existe pas.");
            return;
          }
          return emit(host, sol.center, sol.radius);
        }
      }
      return;
    }
    if (first.kind !== 'point') return;
    const center = first.value;

    // Rayon, ou option Diamètre ; la valeur par défaut est le dernier rayon (CIRCLERAD).
    const dflt = host.sysvars.CIRCLERAD > 0 ? host.sysvars.CIRCLERAD : undefined;
    let r = await ask(ctx, {
      kind: 'distance',
      message: 'Spécifiez le rayon du cercle',
      keywords: [KW_DIAM],
      basePoint: center,
      defaultValue: dflt,
      allowZero: false,
    });
    let radius: number;
    if (r.kind === 'keyword') {
      r = await ask(ctx, {
        kind: 'distance',
        message: 'Spécifiez le diamètre du cercle',
        basePoint: center,
        defaultValue: dflt !== undefined ? dflt * 2 : undefined,
        allowZero: false,
      });
      if (r.kind !== 'number') return;
      radius = r.value / 2;
    } else if (r.kind === 'number') {
      radius = r.value;
    } else return;

    emit(host, center, radius);
  },
};

function emit(host: CircleHost, center: Vec3, radius: number): void {
  host.sysvars.CIRCLERAD = radius;
  host.addEntity({ type: 'CIRCLE', center, radius });
}
