import { describe, expect, it } from 'vitest';
import {
  CommandProcessor,
  createDefaultRegistry,
  evaluateAngle,
  evaluateNumber,
  formatPrompt,
  matchKeyword,
  parseInput,
  parsePoint,
  type Keyword,
} from '../src/core/commands';

const tick = () => new Promise((r) => setTimeout(r, 0));
const env = { lastPoint: { x: 10, y: 10, z: 0 } };

describe('InputParser', () => {
  it('lit les points absolus, relatifs, polaires et sphériques', () => {
    expect(parsePoint('3,4', env)).toEqual({ x: 3, y: 4, z: 0 });
    expect(parsePoint('3,4,5', env)).toEqual({ x: 3, y: 4, z: 5 });
    expect(parsePoint('@5,0', env)).toEqual({ x: 15, y: 10, z: 0 });
    const polar = parsePoint('@10<90', env)!;
    expect(polar.x).toBeCloseTo(10);
    expect(polar.y).toBeCloseTo(20);
    const sph = parsePoint('10<0<90', env)!;
    expect(sph.z).toBeCloseTo(10);
    expect(parsePoint('#1,2', { ...env, dynamicRelative: true })).toEqual({ x: 1, y: 2, z: 0 });
    expect(parsePoint('1,2', { ...env, dynamicRelative: true })).toEqual({ x: 11, y: 12, z: 0 });
    expect(parsePoint('abc', env)).toBeNull();
  });

  it('évalue les expressions et les angles', () => {
    expect(evaluateNumber('2*(10+5)/3')).toBe(10);
    expect(evaluateNumber('2+')).toBeNull();
    expect(evaluateAngle('180')).toBeCloseTo(Math.PI);
    expect(evaluateAngle('1r')).toBe(1);
    expect(evaluateAngle('200g')).toBeCloseTo(Math.PI);
  });

  it('reconnaît les options par raccourci, nom, préfixe et nom global', () => {
    const kws: Keyword[] = [
      { global: 'Center', local: 'Centre' },
      { global: '2P', local: '2P' },
      { global: '3P', local: '3P' },
      { global: 'TTR', local: 'Ttr', alias: 'T' },
    ];
    expect(matchKeyword('c', kws)).toMatchObject({ global: 'Center' });
    expect(matchKeyword('cent', kws)).toMatchObject({ global: 'Center' });
    expect(matchKeyword('2p', kws)).toMatchObject({ global: '2P' });
    expect(matchKeyword('t', kws)).toMatchObject({ global: 'TTR' });
    expect(matchKeyword('_TTR', kws)).toMatchObject({ global: 'TTR' });
    // un nombre n'est jamais pris pour le préfixe de "3P"
    expect(matchKeyword('3', kws)).toBeNull();
  });

  it('applique valeur par défaut, contrôles et entrée directe de distance', () => {
    const spec = { kind: 'distance' as const, message: 'Rayon', defaultValue: 5, allowZero: false };
    expect(parseInput('', spec, env)).toEqual({ kind: 'number', value: 5 });
    expect(parseInput('0', spec, env)).toMatchObject({ kind: 'error' });
    expect(parseInput('-2', spec, env)).toMatchObject({ kind: 'error' });
    const direct = parseInput(
      '25',
      { kind: 'point', message: 'Point suivant', basePoint: { x: 0, y: 0, z: 0 } },
      { ...env, cursorDirection: { x: 0, y: 1, z: 0 } },
    );
    expect(direct).toEqual({ kind: 'point', value: { x: 0, y: 25, z: 0 } });
  });

  it('formate le prompt avec ses options', () => {
    expect(
      formatPrompt({
        kind: 'distance',
        message: 'Spécifiez le rayon du cercle',
        keywords: [{ global: 'Diameter', local: 'Diamètre' }],
        defaultValue: 10,
      }),
    ).toBe('Spécifiez le rayon du cercle ou [Diamètre] <10.0000>: ');
  });
});

function setup() {
  const entities: unknown[] = [];
  const lines: string[] = [];
  const prompts: string[] = [];
  const doc = {
    sysvars: { CIRCLERAD: 0 },
    addEntity: (e: unknown) => (entities.push(e), String(entities.length - 1)),
    removeEntity: (id: string) => entities.splice(Number(id), 1),
  };
  const cp = new CommandProcessor(createDefaultRegistry(), doc, {
    print: (l) => lines.push(l),
    prompt: (_s, text) => prompts.push(text),
  });
  return { cp, entities, lines, prompts, doc };
}

describe('CommandProcessor', () => {
  it('CERCLE centre + rayon via alias', async () => {
    const { cp, entities, prompts } = setup();
    cp.submit('c');
    await tick();
    expect(prompts.at(-1)).toBe('Spécifiez le centre du cercle ou [3P/2P/Ttr]: ');
    cp.submit('0,0');
    await tick();
    cp.submit('12.5');
    await tick();
    expect(entities).toEqual([{ type: 'CIRCLE', center: { x: 0, y: 0, z: 0 }, radius: 12.5 }]);
    expect(cp.isIdle).toBe(true);
  });

  it('CERCLE option Diamètre puis rayon par défaut au second appel (Entrée = répéter)', async () => {
    const { cp, entities, prompts } = setup();
    cp.submit('CERCLE');
    await tick();
    cp.submit('5,5');
    await tick();
    cp.submit('d');
    await tick();
    cp.submit('20');
    await tick();
    expect(entities[0]).toMatchObject({ radius: 10 });
    cp.submit(''); // relance CERCLE
    await tick();
    cp.submit('0,0');
    await tick();
    expect(prompts.at(-1)).toContain('<10.0000>');
    cp.submit('');
    await tick();
    expect(entities[1]).toMatchObject({ radius: 10 });
  });

  it('CERCLE 3P et 2P', async () => {
    const { cp, entities } = setup();
    for (const s of ['_CIRCLE', '3p', '1,0', '0,1', '-1,0']) {
      cp.submit(s);
      await tick();
    }
    expect((entities[0] as { radius: number }).radius).toBeCloseTo(1);
    for (const s of ['c', '2P', '0,0', '10,0']) {
      cp.submit(s);
      await tick();
    }
    expect(entities[1]).toMatchObject({ center: { x: 5, y: 0, z: 0 }, radius: 5 });
  });

  it('erreur de saisie : message et prompt redemandé, sans quitter la commande', async () => {
    const { cp, lines } = setup();
    cp.submit('c');
    await tick();
    cp.submit('n_importe_quoi');
    await tick();
    expect(lines.at(-1)).toMatch(/Point incorrect/);
    expect(cp.isIdle).toBe(false);
    cp.cancel();
    await tick();
    expect(lines.at(-1)).toBe('*Annuler*');
    expect(cp.isIdle).toBe(true);
  });

  it('LIGNE avec relatif, annUler et Clore', async () => {
    const { cp, entities } = setup();
    for (const s of ['L', '0,0', '@10,0', '@0,10', '@5,5', 'u', 'c']) {
      cp.submit(s);
      await tick();
    }
    expect(entities).toHaveLength(3);
    expect(entities[2]).toMatchObject({ start: { x: 10, y: 10 }, end: { x: 0, y: 0 } });
    expect(cp.isIdle).toBe(true);
  });

  it('clics viewport acceptés comme points', async () => {
    const { cp, entities } = setup();
    cp.submit('c');
    await tick();
    cp.pick({ x: 1, y: 1, z: 0 });
    await tick();
    cp.pick({ x: 4, y: 5, z: 0 }); // distance au centre = 5
    await tick();
    expect(entities[0]).toMatchObject({ radius: 5 });
  });

  it('autocomplétion et historique', async () => {
    const { cp } = setup();
    expect(cp.suggest('CER')[0]?.insert).toBe('CERCLE');
    expect(cp.suggest('L')[0]?.insert).toBe('LIGNE');
    cp.submit('LIGNE');
    await tick();
    cp.cancel();
    await tick();
    cp.submit('CERCLE');
    await tick();
    expect(cp.suggest('').map((s) => s.insert)).toEqual(['3P', '2P', 'Ttr']);
    cp.cancel();
    expect(cp.history.previous()).toBe('CERCLE');
    expect(cp.history.previous()).toBe('LIGNE');
    expect(cp.history.next()).toBe('CERCLE');
  });

  it('commande inconnue', () => {
    const { cp, lines } = setup();
    cp.submit('FOO');
    expect(lines.at(-1)).toMatch(/Commande inconnue "FOO"/);
  });
});
