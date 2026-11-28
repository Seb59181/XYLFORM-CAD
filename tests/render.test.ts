/** Xylform CAD 1.4.0 : lumières, textures, ambiance du rendu réaliste et pinceau de propriétés. */
import { describe, expect, it } from 'vitest';
import { DrawingDocument, type Entity } from '../src/core/document/Document';
import { boxUVs, defaultLight, DEFAULT_RENDER_ENV, newLightId, newTextureId, pointIntensity, sanitizeEnv, sanitizeLight } from '../src/core/render';
import { paintPatch, PAINT_PROPS } from '../src/app/commands/painter';

const o = { x: 0, y: 0, z: 0 };

/** Solide factice (affichage minimal) : suffisant pour le document et le pinceau. */
function solid(doc: DrawingDocument, extra: Record<string, unknown> = {}): string {
  return doc.addEntity({
    type: '3DSOLID',
    name: 'Solide',
    shapeId: 's1',
    display: { positions: new Float32Array(), indices: new Uint32Array(), edgePoints: new Float32Array(), edgeOffsets: new Uint32Array([0]), bbox: { min: o, max: o }, solidCount: 1, volume: 0, area: 0 },
    ...extra,
  } as never);
}

describe('lumières', () => {
  it('identifiants et lumière par défaut', () => {
    const a = defaultLight([], 'spot', { x: 0, y: 0, z: 100 }, o);
    expect(a.id).toBe('L1');
    expect(a.name).toBe('Projecteur 1');
    expect(a.angle).toBe(30);
    expect(newLightId([a])).toBe('L2');
    expect(defaultLight([a], 'point', o, o).angle).toBeUndefined();
  });

  it('valeurs bornées à la lecture', () => {
    const l = sanitizeLight({ ...defaultLight([], 'spot', o, o), intensity: -5, color: 'rouge', angle: 120, penumbra: 3 });
    expect(l.intensity).toBe(0);
    expect(l.color).toBe('#ffffff');
    expect(l.angle).toBe(89);
    expect(l.penumbra).toBe(1);
    const e = sanitizeEnv({ environment: 'lune' as never, exposure: 1 });
    expect(e.environment).toBe('studio');
    expect(e.exposure).toBe(10);
    expect(e.ambientOcclusion).toBe(true);
  });

  it('100 % = même éclairement au centre du modèle, quelle que soit la distance de la lampe', () => {
    // décroissance en 1/d² : intensité × 1/d² constante au point de référence
    for (const d of [10, 250, 4000]) expect(pointIntensity(100, d) / (d * d)).toBeCloseTo(2.4);
    expect(pointIntensity(50, 100)).toBeCloseTo(pointIntensity(100, 100) / 2);
  });

  it('lumières et ambiance dans le document : une étape d’annulation', () => {
    const doc = new DrawingDocument();
    const v0 = doc.renderVersion;
    doc.setRender({ lights: [defaultLight([], 'point', o, o)], env: { ...DEFAULT_RENDER_ENV, environment: 'night' } });
    expect(doc.lights).toHaveLength(1);
    expect(doc.renderVersion).toBeGreaterThan(v0);
    doc.undo();
    expect(doc.lights).toHaveLength(0);
    expect(doc.renderEnv.environment).toBe('studio');
    doc.redo();
    expect(doc.renderEnv.environment).toBe('night');
  });
});

describe('textures', () => {
  it('projection cubique : dessus en XY, côtés en XZ / YZ, motif en mm', () => {
    // un point sur le dessus, un sur la face avant (normale -Y), un sur le côté droit (+X)
    const pos = [30, 15, 10, 30, 0, 5, 60, 15, 5];
    const nor = [0, 0, 1, 0, -1, 0, 1, 0, 0];
    const uv = boxUVs(pos, nor, { size: 10 });
    expect([...uv]).toEqual([3, 1.5, 3, 0.5, 1.5, 0.5].map((v) => expect.closeTo(v, 6)));
    // image deux fois plus large que haute : le motif fait 10 × 5 mm
    const uv2 = boxUVs(pos, nor, { size: 10 }, 0.5);
    expect(uv2[1]).toBeCloseTo(3);
    // rotation de 90° et décalage
    const uv3 = boxUVs([10, 0, 0], [0, 0, 1], { size: 10, angle: 90, offsetV: 0 });
    expect(uv3[0]).toBeCloseTo(0);
    expect(uv3[1]).toBeCloseTo(1);
    const uv4 = boxUVs([10, 0, 0], [0, 0, 1], { size: 10, offsetU: 5 });
    expect(uv4[0]).toBeCloseTo(0.5);
  });

  it('images du dessin : ajout annulable, seules les images utilisées sont enregistrées', () => {
    const doc = new DrawingDocument();
    const h = solid(doc);
    const id = newTextureId(doc.textures);
    expect(id).toBe('T1');
    doc.addTexture({ id, name: 'bois.png', mime: 'image/png', data: new Uint8Array([1, 2, 3]), width: 2, height: 1 });
    expect(newTextureId(doc.textures)).toBe('T2');
    expect(Object.keys(doc.usedTextures())).toEqual([]);
    doc.replaceEntity(h, { texture: { ref: id, size: 50 } } as Partial<Entity>);
    expect(Object.keys(doc.usedTextures())).toEqual(['T1']);
    doc.undo();
    doc.undo();
    expect(doc.textures).toEqual({});
  });
});

describe('pinceau', () => {
  it('copie calque, couleur, matériau et texture entre solides', () => {
    const doc = new DrawingDocument();
    doc.addLayer('Pièces', '#ffffff');
    const a = doc.get(solid(doc, { layer: 'Pièces', color: '#ff0000', material: 'brass', texture: { ref: 'T1', size: 20 } }))!;
    const b = doc.get(solid(doc))!;
    const all = PAINT_PROPS.map((p) => p.id);
    expect(paintPatch(a, b, all)).toEqual({ layer: a.layer, color: '#ff0000', material: 'brass', texture: { ref: 'T1', size: 20 } });
    expect(paintPatch(a, b, ['color'])).toEqual({ color: '#ff0000' });
    // rien à copier sur l'objet lui-même
    expect(paintPatch(a, a, all)).toEqual({});
  });

  it('ne copie que les propriétés communes aux deux objets', () => {
    const doc = new DrawingDocument();
    const t1 = doc.get(doc.addEntity({ type: 'TEXT', position: o, height: 5, text: 'A', rotation: 0.5, widthFactor: 0.8 }))!;
    const t2 = doc.get(doc.addEntity({ type: 'TEXT', position: o, height: 2.5, text: 'B', rotation: 0 }))!;
    const c = doc.get(doc.addEntity({ type: 'CIRCLE', center: o, radius: 3, color: '#00ff00' }))!;
    expect(paintPatch(t1, t2, ['text'])).toEqual({ height: 5, rotation: 0.5, widthFactor: 0.8 });
    // un cercle ne reçoit ni hauteur de texte ni matériau
    expect(paintPatch(t1, c, ['text', 'material', 'color'])).toEqual({ color: undefined });
    const h1 = doc.get(doc.addEntity({ type: 'HATCH', boundaries: [], pattern: 'NET', scale: 2, angle: 45 }))!;
    const h2 = doc.get(doc.addEntity({ type: 'HATCH', boundaries: [], pattern: 'ANSI31', scale: 1, angle: 0 }))!;
    expect(paintPatch(h1, h2, ['hatch'])).toEqual({ pattern: 'NET', scale: 2, angle: 45 });
  });
});
