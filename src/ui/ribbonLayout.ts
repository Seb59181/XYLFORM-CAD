/**
 * Mise en page adaptative du ruban (sans barre de défilement) et ordre des groupes.
 *
 * Quand les groupes d'un onglet ne tiennent pas dans la largeur, on les réduit pas à pas,
 * D'abord petits boutons sans libellé (de droite à gauche, les deux premiers
 * groupes en dernier), puis moins de colonnes (les commandes masquées passent dans le menu ▾ du
 * titre), enfin groupes repliés en un seul bouton qui ouvre le groupe complet.
 */

/** Forme d'un groupe utile au calcul (indépendante de React). */
export interface PanelShape {
  /** Grands boutons et contrôles intégrés (toujours visibles tant que le groupe n'est pas replié). */
  fixed: number;
  /** Nombre de petits boutons. */
  small: number;
  /** Petits boutons par colonne. */
  per: number;
  /** Petits boutons visibles au plus (le reste dans le menu ▾). */
  max?: number;
  /** Groupe déjà en icônes seules. */
  compact?: boolean;
}

export interface PanelPlan {
  /** Colonnes de petits boutons affichées. */
  cols: number;
  /** Petits boutons sans libellé. */
  iconOnly: boolean;
  /** Groupe replié en un seul bouton. */
  collapsed: boolean;
}

/** Nombre de groupes de tête qui gardent leurs libellés le plus longtemps. */
const LEAD = 2;

type Step = { panel: number; kind: 'col' | 'icons' | 'collapse' };

export function basePlans(shapes: PanelShape[]): PanelPlan[] {
  return shapes.map((s) => ({ cols: Math.ceil(Math.min(s.small, s.max ?? Infinity) / s.per), iconOnly: !!s.compact, collapsed: false }));
}

/** Colonnes minimales : une, sauf si le groupe a d'autres boutons (alors tout peut passer sous ▾). */
const minCols = (s: PanelShape) => (s.small === 0 ? 0 : s.fixed > 0 ? 0 : 1);

/** Suite ordonnée des réductions possibles pour cette rangée de groupes. */
export function reductionSteps(shapes: PanelShape[]): Step[] {
  const plans = basePlans(shapes);
  const steps: Step[] = [];
  // colonne retirée au groupe le plus large (le plus à droite en cas d'égalité)
  const shrinkCols = (floor: (i: number) => number) => {
    for (;;) {
      let best = -1;
      plans.forEach((p, i) => {
        if (p.cols > floor(i) && (best < 0 || p.cols >= plans[best]!.cols)) best = i;
      });
      if (best < 0) return;
      plans[best]!.cols--;
      steps.push({ panel: best, kind: 'col' });
    }
  };
  const icons = (keepLabels: (i: number) => boolean) => {
    for (let i = plans.length - 1; i >= 0; i--) {
      if (!keepLabels(i) && !plans[i]!.iconOnly && plans[i]!.cols > 0) {
        plans[i]!.iconOnly = true;
        steps.push({ panel: i, kind: 'icons' });
      }
    }
  };
  // Les deux premiers groupes (les plus utilisés ; l'utilisateur peut réordonner les groupes)
  // gardent leurs libellés le plus longtemps.
  const lead = (i: number) => i < LEAD;
  // 1. petits boutons sans libellé dans les autres groupes, de droite à gauche
  icons(lead);
  // 2. premiers groupes : pas plus de deux colonnes libellées, le reste sous ▾
  shrinkCols((i) => (lead(i) ? Math.max(2, minCols(shapes[i]!)) : Infinity));
  // 3. premiers groupes sans libellé
  icons(() => false);
  // 4. moins de colonnes partout (commandes masquées dans le menu ▾ du titre)
  shrinkCols((i) => minCols(shapes[i]!));
  // 5. groupes repliés, de droite à gauche
  for (let i = plans.length - 1; i >= 0; i--) steps.push({ panel: i, kind: 'collapse' });
  return steps;
}

/** Plan de chaque groupe après `level` réductions. */
export function planAt(shapes: PanelShape[], level: number): PanelPlan[] {
  const plans = basePlans(shapes);
  for (const s of reductionSteps(shapes).slice(0, Math.max(0, level))) {
    const p = plans[s.panel]!;
    if (s.kind === 'col') p.cols--;
    else if (s.kind === 'icons') p.iconOnly = true;
    else p.collapsed = true;
  }
  return plans;
}

export const maxLevel = (shapes: PanelShape[]) => reductionSteps(shapes).length;

/** Groupes dans l'ordre choisi par l'utilisateur ; les groupes inconnus de l'ordre gardent leur place d'origine à la suite. */
export function orderPanels<T extends { title: string }>(panels: T[], order: string[] | undefined): T[] {
  if (!order?.length) return panels;
  const rank = (t: T, i: number) => {
    const k = order.indexOf(t.title);
    return k >= 0 ? k : order.length + i;
  };
  return panels.map((p, i) => ({ p, r: rank(p, i) })).sort((a, b) => a.r - b.r).map((x) => x.p);
}

/** Nouvel ordre des titres après avoir déposé `from` avant (ou après) `to`. */
export function movePanel(titles: string[], from: string, to: string, after: boolean): string[] {
  if (from === to) return titles;
  const rest = titles.filter((t) => t !== from);
  const k = rest.indexOf(to);
  if (k < 0) return titles;
  rest.splice(after ? k + 1 : k, 0, from);
  return rest;
}
