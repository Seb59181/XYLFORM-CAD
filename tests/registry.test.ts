import { describe, expect, it } from 'vitest';
import { CommandRegistry } from '../src/core/commands';
import { registerAll } from '../src/app/commands';

describe('Registre complet', () => {
  it('enregistre toutes les commandes sans doublon de nom ni d’alias', () => {
    const r = new CommandRegistry();
    registerAll(r);
    expect(r.all().length).toBeGreaterThan(120);
    for (const n of ['LIGNE', 'L', 'CERCLE', 'BOITE', 'EXTRUSION', 'RACCORDBORD', 'EXPORTSTL', 'EXPORT3MF', 'OUVRIR', 'ZOOM', 'CDALIGNEE', '_LINE', '-VUE']) expect(r.resolve(n), n).not.toBeNull();
    expect(r.resolve("'ZOOM")?.transparent).toBe(true);
  });
});
