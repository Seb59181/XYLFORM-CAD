/** Xylform CAD 1.5.0 : rendu par lancer de rayons (calculs purs, matériaux, commande). */
import { describe, expect, it } from 'vitest';
import { remainingMs, tilesFor } from '../src/render/raytraceMath';
import { MATERIALS, materialById } from '../src/core/materials';
import { renderCommands, raytraceDefaults } from '../src/app/commands/render';
import { RT_QUALITY, RT_SIZES } from '../src/ui/RaytraceDialog';

describe('lancer de rayons', () => {
  it('découpe les grandes images en tuiles', () => {
    expect(tilesFor(800, 600)).toBe(1);
    expect(tilesFor(1920, 1080)).toBe(2);
    expect(tilesFor(3840, 2160)).toBe(3);
    expect(tilesFor(20000, 20000)).toBe(4);
  });

  it('estime la durée restante', () => {
    expect(remainingMs(0, 100, 0)).toBeNull();
    expect(remainingMs(10, 0, 5000)).toBeNull(); // sans fin
    expect(remainingMs(25, 100, 10000)).toBe(30000);
    expect(remainingMs(100, 100, 40000)).toBe(0);
  });

  it('matériaux transparents et lumineux', () => {
    const glass = materialById('glass')!;
    expect(glass.transmission).toBe(1);
    expect(glass.ior).toBeCloseTo(1.5);
    expect(materialById('frosted')!.roughness).toBeGreaterThan(glass.roughness);
    expect(materialById('petg')!.transmission).toBeGreaterThan(0);
    expect(materialById('emissive')!.emissive).toBeGreaterThan(0);
    for (const m of MATERIALS) {
      if (m.transmission !== undefined) {
        expect(m.transmission).toBeGreaterThan(0);
        expect(m.transmission).toBeLessThanOrEqual(1);
        expect(m.ior ?? 1.5).toBeGreaterThan(1);
      }
    }
    expect(new Set(MATERIALS.map((m) => m.id)).size).toBe(MATERIALS.length);
  });

  it('commande RAYONS et réglages de départ', () => {
    const c = renderCommands.find((x) => x.name === 'RAYTRACE');
    expect(c).toBeTruthy();
    const fake = { viewport: { viewSize: () => ({ w: 1000, h: 600 }) }, doc: { renderEnv: { background: 'environment', ground: true, exposure: 120 } } };
    const d = raytraceDefaults(fake as never, { width: 1920, height: 1080 });
    expect(d).toMatchObject({ width: 1920, height: 1080, background: 'environment', floor: 'studio', exposure: 120, bounces: 5 });
    expect(d.maxSamples).toBeGreaterThan(0);
    const d2 = raytraceDefaults({ ...fake, doc: { renderEnv: { background: 'screen', ground: false, exposure: 100 } } } as never);
    expect(d2).toMatchObject({ width: 1000, height: 600, background: 'screen', floor: 'none' });
    expect(RT_SIZES.find((s) => s.value === 'uhd')!.size).toEqual([3840, 2160]);
    expect(RT_QUALITY.some((q) => q.value === 0)).toBe(true);
  });
});
