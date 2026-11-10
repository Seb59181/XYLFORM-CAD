import { describe, expect, it } from 'vitest';
import { DrawingDocument, type Entity } from '../src/core/document/Document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { aciToHex, hexToAci } from '../src/io/aci';
import { curvePoints } from '../src/core/entities/geometry';

describe('DXF', () => {
  it('couleurs ACI', () => {
    expect(aciToHex(1)).toBe('#ff0000');
    expect(aciToHex(7)).toBe('#ffffff');
    expect(hexToAci('#ff0000')).toBe(1);
    expect(hexToAci('#00ff00')).toBe(3);
  });

  it('aller-retour R12 : lignes, cercles, arcs, polylignes à arcs, textes, calques', () => {
    const doc = new DrawingDocument();
    doc.addEntity({ type: 'LINE', start: { x: 0, y: 0, z: 0 }, end: { x: 10, y: 5, z: 0 }, layer: 'Contours' });
    doc.addEntity({ type: 'CIRCLE', center: { x: 5, y: 5, z: 0 }, radius: 3, color: '#ff0000' });
    doc.addEntity({ type: 'ARC', center: { x: 0, y: 0, z: 0 }, radius: 4, startAngle: 0, endAngle: Math.PI / 2 });
    doc.addEntity({ type: 'POLYLINE', points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }], closed: true, bulges: [0, 0.5, 0] });
    doc.addEntity({ type: 'TEXT', position: { x: 1, y: 2, z: 0 }, height: 2.5, text: 'Ø20 ±0.1', rotation: 0 });
    const text = writeDxf(doc.all(), doc.layers);
    expect(text).toContain('AC1009');
    const r = readDxf(text);
    const types = r.entities.map((e) => e.type).sort();
    expect(types).toEqual(['ARC', 'CIRCLE', 'LINE', 'POLYLINE', 'TEXT']);
    const pl = r.entities.find((e) => e.type === 'POLYLINE') as Extract<Entity, { type: 'POLYLINE' }>;
    expect(pl.closed).toBe(true);
    expect(pl.bulges?.[1]).toBeCloseTo(0.5);
    const c = r.entities.find((e) => e.type === 'CIRCLE') as Extract<Entity, { type: 'CIRCLE' }>;
    expect(c.color).toBe('#ff0000');
    expect(r.entities.find((e) => e.type === 'LINE')!.layer).toBe('Contours');
    expect((r.entities.find((e) => e.type === 'TEXT') as Extract<Entity, { type: 'TEXT' }>).text).toBe('Ø20 ±0.1');
    expect(r.layers.map((l) => l.name)).toContain('Contours');
  });

  it('lit LWPOLYLINE, blocs insérés, MTEXT et HATCH (format 2018)', () => {
    const dxf = [
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '8', '0', '2', 'CARRE', '70', '0', '10', '0', '20', '0', '30', '0',
      '0', 'LWPOLYLINE', '8', '0', '90', '4', '70', '1', '10', '0', '20', '0', '10', '1', '20', '0', '10', '1', '20', '1', '10', '0', '20', '1',
      '0', 'ENDBLK',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'INSERT', '8', 'Pieces', '2', 'CARRE', '10', '10', '20', '20', '30', '0', '41', '2', '42', '2', '50', '90',
      '0', 'MTEXT', '8', '0', '10', '0', '20', '0', '40', '3', '1', '{\\fArial|b0;Ligne 1\\PLigne 2}',
      '0', 'HATCH', '8', 'H', '2', 'SOLID', '70', '1', '91', '1', '92', '2', '72', '0', '73', '1', '93', '3', '10', '0', '20', '0', '10', '5', '20', '0', '10', '0', '20', '5', '97', '0',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const r = readDxf(dxf);
    const pl = r.entities.find((e) => e.type === 'POLYLINE') as Extract<Entity, { type: 'POLYLINE' }>;
    expect(pl.layer).toBe('Pieces');
    // carré unité ×2 tourné de 90° autour de (10,20)
    expect(pl.points[1]!.x).toBeCloseTo(10);
    expect(pl.points[1]!.y).toBeCloseTo(22);
    const texts = r.entities.filter((e) => e.type === 'TEXT') as Extract<Entity, { type: 'TEXT' }>[];
    expect(texts.map((t) => t.text)).toEqual(['Ligne 1\nLigne 2']);
    expect(texts[0]!.valign).toBe('top');
    const h = r.entities.find((e) => e.type === 'HATCH') as Extract<Entity, { type: 'HATCH' }>;
    expect(h.pattern).toBe('SOLID');
    expect(h.boundaries[0]!.length).toBe(3);
  });

  it('respecte la justification des TEXT, MTEXT et attributs', () => {
    const dxf = [
      '0', 'SECTION', '2', 'TABLES',
      '0', 'STYLE', '2', 'ETROIT', '70', '0', '40', '0', '41', '0.8',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      // TEXT centré milieu : le point d'accroche est le second point (11)
      '0', 'TEXT', '8', '0', '10', '0', '20', '0', '40', '2.5', '1', 'ADOUCISSEUR', '7', 'ETROIT', '72', '1', '11', '50', '21', '10', '73', '2',
      // MTEXT attaché au milieu-centre (5), cadre de 12 de large : retour à la ligne
      '0', 'MTEXT', '8', '0', '10', '100', '20', '50', '40', '2.5', '41', '12', '71', '5', '1', 'ECHANGEUR RUBIS EVOSIS', '101', 'Embedded Object', '10', '0', '20', '0', '40', '0',
      // attribut visible justifié à droite, attribut invisible ignoré
      '0', 'ATTRIB', '8', '0', '10', '0', '20', '0', '40', '2', '1', '12', '2', 'NUM', '70', '0', '72', '2', '11', '5', '21', '5',
      '0', 'ATTRIB', '8', '0', '10', '0', '20', '0', '40', '2', '1', 'cache', '2', 'X', '70', '1',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const r = readDxf(dxf);
    const t = r.entities.filter((e) => e.type === 'TEXT') as Extract<Entity, { type: 'TEXT' }>[];
    expect(t.length).toBe(3);
    expect(t[0]).toMatchObject({ position: { x: 50, y: 10 }, align: 'center', valign: 'middle', widthFactor: 0.8 });
    expect(t[1]).toMatchObject({ position: { x: 100, y: 50 }, align: 'center', valign: 'middle' });
    expect(t[1]!.text.split('\n').length).toBeGreaterThan(1);
    expect(t[2]).toMatchObject({ text: '12', position: { x: 5, y: 5 }, align: 'right' });
    // emprise centrée sur le point d'accroche
    const box = curvePoints(t[0] as Entity)[0]!;
    const cx = (Math.min(...box.map((p) => p.x)) + Math.max(...box.map((p) => p.x))) / 2;
    expect(cx).toBeCloseTo(50, 5);
  });

  it('lit les multilignes de repère (texte, ligne de repère, flèche)', () => {
    const dxf = [
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'MULTILEADER', '8', 'Repères', '300', 'CONTEXT_DATA{', '40', '1.0', '10', '50', '20', '20', '30', '0', '41', '3.5', '140', '2.5',
      '304', 'VANNE\\PGAZ', '12', '52', '22', '22', '32', '0', '13', '1', '23', '0', '33', '0', '171', '1',
      '302', 'LEADER{', '10', '50', '20', '20', '30', '0', '11', '1', '21', '0', '31', '0', '40', '2',
      '304', 'LEADER_LINE{', '10', '0', '20', '0', '30', '0', '305', '}', '303', '}', '301', '}',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const r = readDxf(dxf);
    const t = r.entities.find((e) => e.type === 'TEXT') as Extract<Entity, { type: 'TEXT' }>;
    expect(t).toMatchObject({ text: 'VANNE\nGAZ', position: { x: 52, y: 22 }, height: 3.5, valign: 'top' });
    const pl = r.entities.find((e) => e.type === 'POLYLINE') as Extract<Entity, { type: 'POLYLINE' }>;
    expect(pl.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [50, 20],
    ]);
    expect(r.entities.some((e) => e.type === 'HATCH')).toBe(true);
    expect(r.entities.some((e) => e.type === 'LINE')).toBe(true);
  });
});
