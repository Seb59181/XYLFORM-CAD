/** Xylform CAD 1.0.0 : notes de version (« Quoi de neuf ») et cohérence des versions. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareVersions, notesBetween, releases } from '../src/app/changelog';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; productName: string; license: string };
const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

describe('Quoi de neuf', () => {
  it('le CHANGELOG a une section pour la version du package.json, en tête', () => {
    const all = releases(changelog);
    expect(all[0]?.version).toBe(pkg.version);
    expect(all[0]?.body).toContain('Xylform CAD');
    // l'historique SebCad n'est pas pris pour des versions publiées
    expect(all.every((r) => !r.body.includes('### SebCad'))).toBe(true);
    expect(pkg.productName).toBe('Xylform CAD');
    expect(pkg.license).toBe('MIT');
  });

  it('notes depuis une version donnée', () => {
    const text = '# T\n\n## 1.2.0 — c\n\n- trois\n\n## 1.1.0 — b\n\n- deux\n\n## 1.0.0 — a\n\n- un\n\n---\n\n### SebCad 9.9.9\n- vieux\n';
    expect(releases(text).map((r) => r.version)).toEqual(['1.2.0', '1.1.0', '1.0.0']);
    expect(releases(text)[2]!.body).toBe('- un');
    expect(notesBetween('1.0.0', '1.2.0', text).map((r) => r.version)).toEqual(['1.2.0', '1.1.0']);
    expect(notesBetween(null, '1.1.0', text).map((r) => r.version)).toEqual(['1.1.0']);
    // ancienne version SebCad 2.0.0 mémorisée (plus « récente » en numéro) : on montre la version actuelle
    expect(notesBetween('2.0.0', '1.2.0', text).map((r) => r.version)).toEqual(['1.2.0']);
    expect(compareVersions('1.10.0', '1.9.5')).toBeGreaterThan(0);
  });
});
