/**
 * Bibliothèque de matériaux de rendu (style visuel Réaliste et Rendu) : métaux, plastiques
 * d'impression 3D, bois, verre… Les plastiques prennent la couleur de l'objet (calque ou
 * couleur propre) ; les autres ont leur teinte propre.
 */
export interface RenderMaterial {
  id: string;
  label: string;
  group: 'Métaux' | 'Plastiques' | 'Autres';
  /** Couleur propre ; absente = couleur de l'objet. */
  color?: string;
  metalness: number;
  roughness: number;
  clearcoat?: number;
  opacity?: number;
  /**
   * Lancer de rayons : part de lumière qui traverse la matière (verre, plastique translucide),
   * indice de réfraction et distance d'atténuation (en rayons du modèle : plus petit = teinte
   * plus soutenue dans les parties épaisses).
   */
  transmission?: number;
  ior?: number;
  attenuation?: number;
  /** Matière qui émet de la lumière (intensité ; couleur de l'objet). */
  emissive?: number;
}

export const MATERIALS: RenderMaterial[] = [
  { id: 'steel', label: 'Acier', group: 'Métaux', color: '#8a8f96', metalness: 1, roughness: 0.35 },
  { id: 'stainless', label: 'Acier inoxydable brossé', group: 'Métaux', color: '#c3c7cc', metalness: 1, roughness: 0.22 },
  { id: 'aluminium', label: 'Aluminium', group: 'Métaux', color: '#d4d7db', metalness: 1, roughness: 0.3 },
  { id: 'anodized', label: 'Aluminium anodisé noir', group: 'Métaux', color: '#2a2c31', metalness: 0.8, roughness: 0.4 },
  { id: 'brass', label: 'Laiton', group: 'Métaux', color: '#c9a94e', metalness: 1, roughness: 0.25 },
  { id: 'copper', label: 'Cuivre', group: 'Métaux', color: '#c27045', metalness: 1, roughness: 0.28 },
  { id: 'gold', label: 'Or', group: 'Métaux', color: '#e6c050', metalness: 1, roughness: 0.18 },
  { id: 'chrome', label: 'Chrome', group: 'Métaux', color: '#f2f4f6', metalness: 1, roughness: 0.05 },
  { id: 'castiron', label: 'Fonte', group: 'Métaux', color: '#4a4c50', metalness: 0.8, roughness: 0.7 },
  { id: 'pla', label: 'Plastique mat (PLA)', group: 'Plastiques', metalness: 0, roughness: 0.6 },
  { id: 'abs', label: 'Plastique brillant (ABS)', group: 'Plastiques', metalness: 0, roughness: 0.25, clearcoat: 0.5 },
  { id: 'petg', label: 'PETG translucide', group: 'Plastiques', metalness: 0, roughness: 0.12, clearcoat: 0.8, opacity: 0.6, transmission: 0.9, ior: 1.57, attenuation: 0.6 },
  { id: 'resin', label: 'Résine', group: 'Plastiques', metalness: 0, roughness: 0.3, clearcoat: 1 },
  { id: 'rubber', label: 'Caoutchouc', group: 'Plastiques', color: '#1d1f22', metalness: 0, roughness: 0.95 },
  { id: 'glass', label: 'Verre', group: 'Autres', color: '#dff0ff', metalness: 0, roughness: 0.02, clearcoat: 1, opacity: 0.25, transmission: 1, ior: 1.5, attenuation: 3 },
  { id: 'frosted', label: 'Verre dépoli', group: 'Autres', color: '#eef4f8', metalness: 0, roughness: 0.3, opacity: 0.45, transmission: 1, ior: 1.5, attenuation: 3 },
  { id: 'emissive', label: 'Matière lumineuse (LED, néon)', group: 'Autres', metalness: 0, roughness: 0.5, emissive: 4 },
  { id: 'woodlight', label: 'Bois clair', group: 'Autres', color: '#c49a6c', metalness: 0, roughness: 0.75 },
  { id: 'wooddark', label: 'Bois foncé', group: 'Autres', color: '#6b4528', metalness: 0, roughness: 0.7 },
  { id: 'concrete', label: 'Béton', group: 'Autres', color: '#9a9893', metalness: 0, roughness: 0.95 },
  { id: 'ceramic', label: 'Céramique blanche', group: 'Autres', color: '#f2efe8', metalness: 0, roughness: 0.2, clearcoat: 0.6 },
];

export const materialById = (id: string | undefined): RenderMaterial | undefined => (id ? MATERIALS.find((m) => m.id === id) : undefined);
