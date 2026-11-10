import { describe, expect, it } from 'vitest';
import { basePlans, maxLevel, movePanel, orderPanels, planAt, type PanelShape } from '../src/ui/ribbonLayout';

const shapes: PanelShape[] = [
  { fixed: 4, small: 6, per: 3 },
  { fixed: 0, small: 15, per: 3, max: 12 },
  { fixed: 1, small: 4, per: 3 },
];

describe('ruban adaptatif', () => {
  it('respecte le maximum de petits boutons visibles', () => {
    expect(basePlans(shapes).map((p) => p.cols)).toEqual([2, 4, 2]);
  });
  it('retire d’abord les libellés des derniers groupes, puis des colonnes, puis replie', () => {
    expect(planAt(shapes, 1).map((p) => p.iconOnly)).toEqual([false, false, true]);
    // les deux premiers groupes gardent deux colonnes libellées avant de perdre leurs libellés
    expect(planAt(shapes, 3)[1]).toEqual({ cols: 2, iconOnly: false, collapsed: false });
    expect(planAt(shapes, 5).every((p) => p.iconOnly)).toBe(true);
    const last = planAt(shapes, maxLevel(shapes));
    expect(last.every((p) => p.collapsed)).toBe(true);
    // un groupe sans grand bouton garde au moins une colonne
    expect(last[1]!.cols).toBe(1);
    expect(last[0]!.cols).toBe(0);
  });
  it('ordre des groupes : déplacement et titres inconnus', () => {
    const ps = [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }];
    expect(orderPanels(ps, ['C', 'A']).map((p) => p.title)).toEqual(['C', 'A', 'B', 'D']);
    expect(movePanel(['A', 'B', 'C', 'D'], 'D', 'A', false)).toEqual(['D', 'A', 'B', 'C']);
    expect(movePanel(['A', 'B', 'C', 'D'], 'A', 'C', true)).toEqual(['B', 'C', 'A', 'D']);
  });
});
