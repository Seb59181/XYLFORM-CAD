/**
 * Ruban à onglets (Début, Insertion, Annoter, Paramétrique, Vue, Solides, Surfaces, Outils 3D, Sortie).
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';
import type { AppHost, VisualStyle, Workspace } from '../app/AppHost';
import type { StandardView } from '../render/CadViewport';
import type { HatchPattern } from '../core/document/Document';
import { useApp, useHost, useInteraction } from './context';
import { Icon } from './icons';
import { maxLevel, movePanel, orderPanels, planAt, type PanelPlan, type PanelShape } from './ribbonLayout';

interface Btn {
  label: string;
  icon: string;
  /** Commande (ou séquence commande + options). */
  cmd?: string | string[];
  action?: (app: AppHost) => void;
  active?: (app: AppHost) => boolean;
  tip?: string;
  menu?: { label: string; icon: string; cmd: string | string[] }[];
  /** Bouton propre à un espace de travail. */
  only?: Workspace;
}

type Item = Btn | { custom: () => ReactNode };
interface Panel {
  title: string;
  large?: Btn[];
  small?: Btn[];
  items?: Item[];
  /** Petites icônes sans libellé (grille compacte). */
  compact?: boolean;
  /** Nombre de petits boutons visibles au plus ; les suivants vont dans le menu ▾ du titre. */
  max?: number;
  only?: Workspace;
}
interface Tab {
  id: string;
  label: string;
  panels: Panel[];
  /** Onglets 3D masqués dans l'espace 2D (ruban plus léger). */
  only?: Workspace;
}

const ws = (w: Workspace) => ({ action: (app: AppHost) => app.set('workspace', w), active: (app: AppHost) => app.settings.workspace === w });

const view = (v: StandardView) => (app: AppHost) => app.viewport?.setView(v);
const style = (s: VisualStyle) => ({ action: (app: AppHost) => app.set('visualStyle', s), active: (app: AppHost) => app.settings.visualStyle === s });

const TABS: Tab[] = [
  {
    id: 'home',
    label: 'Début',
    panels: [
      {
        title: 'Dessin',
        large: [
          { label: 'Ligne', icon: 'line', cmd: 'LIGNE' },
          { label: 'Polyligne', icon: 'pline', cmd: 'POLYLIGNE' },
          {
            label: 'Cercle',
            icon: 'circle',
            cmd: 'CERCLE',
            menu: [
              { label: 'Centre, Rayon', icon: 'circle', cmd: 'CERCLE' },
              { label: '2 points', icon: 'circle-2p', cmd: ['CERCLE', '2P'] },
              { label: '3 points', icon: 'circle-3p', cmd: ['CERCLE', '3P'] },
              { label: 'Tangent, Tangent, Rayon', icon: 'circle-ttr', cmd: ['CERCLE', 'T'] },
            ],
          },
          {
            label: 'Arc',
            icon: 'arc',
            cmd: 'ARC',
            menu: [
              { label: '3 points', icon: 'arc', cmd: 'ARC' },
              { label: 'Centre, Début, Fin', icon: 'arc', cmd: ['ARC', 'CE'] },
            ],
          },
        ],
        small: [
          { label: 'Rectangle', icon: 'rectangle', cmd: 'RECTANGLE' },
          { label: 'Polygone', icon: 'polygon', cmd: 'POLYGONE' },
          { label: 'Ellipse', icon: 'ellipse', cmd: 'ELLIPSE' },
          { label: 'Spline', icon: 'spline', cmd: 'SPLINE' },
          { label: 'Hachures', icon: 'hatch', cmd: 'HACHURES' },
          { label: 'Point', icon: 'point', cmd: 'POINT' },
        ],
      },
      {
        title: 'Modification',
        // Les commandes les plus utilisées visibles, variantes sous ▾ (bouton
        // scindé), le reste dans le menu ▾ du titre du groupe.
        max: 12,
        small: [
          { label: 'Déplacer', icon: 'move', cmd: 'DEPLACER' },
          { label: 'Copier', icon: 'copy', cmd: 'COPIER' },
          { label: 'Étirer', icon: 'stretch', cmd: 'ETIRER' },
          { label: 'Rotation', icon: 'rotate', cmd: 'ROTATION' },
          { label: 'Miroir', icon: 'mirror', cmd: 'MIROIR' },
          { label: 'Échelle', icon: 'scale', cmd: 'ECHELLE' },
          {
            label: 'Ajuster',
            icon: 'trim',
            cmd: 'AJUSTER',
            menu: [
              { label: 'Ajuster', icon: 'trim', cmd: 'AJUSTER' },
              { label: 'Prolonger', icon: 'extend', cmd: 'PROLONGER' },
            ],
          },
          {
            label: 'Raccord',
            icon: 'fillet',
            cmd: 'RACCORD',
            menu: [
              { label: 'Raccord', icon: 'fillet', cmd: 'RACCORD' },
              { label: 'Chanfrein', icon: 'chamfer', cmd: 'CHANFREIN' },
            ],
          },
          {
            label: 'Réseau',
            icon: 'arrayrect',
            cmd: 'RESEAURECT',
            menu: [
              { label: 'Réseau rectangulaire', icon: 'arrayrect', cmd: 'RESEAURECT' },
              { label: 'Réseau polaire', icon: 'arraypolar', cmd: 'RESEAUPOLAIRE' },
            ],
          },
          { label: 'Effacer', icon: 'erase', cmd: 'EFFACER' },
          { label: 'Décaler', icon: 'offset', cmd: 'DECALER' },
          { label: 'Décomposer', icon: 'explode', cmd: 'DECOMPOS' },
          { label: 'Coupure', icon: 'break', cmd: 'COUPURE' },
          { label: 'Joindre', icon: 'join', cmd: 'JOINDRE' },
          { label: 'Diviser', icon: 'divide', cmd: 'DIVISER' },
        ],
      },
      {
        title: 'Annotation',
        large: [{ label: 'Texte', icon: 'text', cmd: 'TEXTE' }],
        small: [
          { label: 'Alignée', icon: 'dimaligned', cmd: 'COTALI' },
          { label: 'Linéaire', icon: 'dimlinear', cmd: 'COTLIN' },
          { label: 'Rayon', icon: 'dimradius', cmd: 'COTRAYON' },
          { label: 'Diamètre', icon: 'dimdiameter', cmd: 'COTDIA' },
        ],
      },
      {
        title: 'Calques',
        items: [{ custom: () => <LayerCombo /> }],
        small: [
          { label: 'Propriétés des calques', icon: 'layers', action: (app) => app.set('panel', 'layers') },
          { label: 'Calque de l’objet courant', icon: 'laycur', cmd: 'CALCOURANT' },
        ],
      },
      {
        title: 'Propriétés',
        small: [
          { label: 'Correspondance', icon: 'matchprop', cmd: 'CORRESPROP' },
          { label: 'Palette Propriétés', icon: 'pal-props', action: (app) => app.set('panel', 'properties') },
          { label: 'Liste', icon: 'list', cmd: 'LISTE' },
        ],
      },
      {
        title: 'Utilitaires',
        large: [{ label: 'Mesurer', icon: 'dist', cmd: 'DIST' }],
        small: [
          { label: 'Aire', icon: 'area', cmd: 'AIRE' },
          { label: 'Coordonnées', icon: 'id', cmd: 'ID' },
          { label: 'Tout sélectionner', icon: 'selectall', cmd: 'TOUTSEL' },
        ],
      },
      {
        title: 'Presse-papiers',
        large: [{ label: 'Coller', icon: 'paste', cmd: 'COLLERPP' }],
        small: [
          { label: 'Copier', icon: 'copyclip', cmd: 'COPIERPP' },
          { label: 'Couper', icon: 'cut', cmd: 'COUPERPP' },
        ],
      },
    ],
  },
  {
    id: 'insert',
    label: 'Insertion',
    panels: [
      {
        title: 'Importer',
        large: [
          { label: 'Importer', icon: 'import', cmd: 'IMPORTER', tip: 'Insère un DWG, DXF, STEP, STL ou 3MF dans le dessin courant (les modèles STL/3MF restent modifiables : déplacer, booléens, coupe, export)' },
          { label: 'Ouvrir', icon: 'open', cmd: 'OUVRIR' },
        ],
      },
      {
        title: 'Fonds de plan',
        large: [
          { label: 'Attacher', icon: 'xref-attach', cmd: 'ATTACHER', tip: 'Attache un plan DWG/DXF, un PDF ou une image comme fond de plan estompé, non modifiable et accrochable (ATTACHER)' },
          { label: 'Fonds de plan', icon: 'xref-palette', action: (app) => app.showPanel('underlays'), active: (app) => app.settings.panel === 'underlays', tip: 'Palette de gestion : charger, décharger, recharger, estomper, lier, détacher (REFEXT)' },
        ],
        small: [{ label: 'Estompage', icon: 'xref', cmd: 'ESTOMPAGE', tip: 'Estompage de tous les fonds de plan, 0 à 90 % (XDWGFADECTL)' }],
      },
      {
        title: 'Formats pris en charge',
        items: [
          {
            custom: () => (
              <div className="rb-info">
                <div>
                  <Icon name="dwg" size={20} /> DWG — versions R13 à 2018+ (lecture)
                </div>
                <div>
                  <Icon name="dxf" size={20} /> DXF — R12 à 2018 (lecture / écriture)
                </div>
                <div>
                  <Icon name="step" size={20} /> STEP — AP203 / AP214 (lecture / écriture)
                </div>
                <div>
                  <Icon name="stl" size={20} /> STL, 3MF — modèles d'impression 3D (lecture / écriture)
                </div>
                <div>
                  <Icon name="pdf" size={20} /> PDF, PNG, JPEG — fonds de plan
                </div>
              </div>
            ),
          },
        ],
      },
    ],
  },
  {
    id: 'annotate',
    label: 'Annoter',
    panels: [
      { title: 'Texte', large: [{ label: 'Texte', icon: 'text', cmd: 'TEXTE' }] },
      {
        title: 'Cotes',
        large: [
          { label: 'Alignée', icon: 'dimaligned', cmd: 'COTALI' },
          { label: 'Linéaire', icon: 'dimlinear', cmd: 'COTLIN' },
        ],
        small: [
          { label: 'Rayon', icon: 'dimradius', cmd: 'COTRAYON' },
          { label: 'Diamètre', icon: 'dimdiameter', cmd: 'COTDIA' },
        ],
      },
      { title: 'Style de cote', items: [{ custom: () => <DimSettings /> }] },
      { title: 'Hachures', large: [{ label: 'Hachures', icon: 'hatch', cmd: 'HACHURES' }], items: [{ custom: () => <HatchSettings /> }] },
    ],
  },
  {
    id: 'param',
    label: 'Paramétrique',
    panels: [
      {
        title: 'Géométrique',
        large: [{ label: 'Contrainte auto', icon: 'autoconstrain', cmd: 'CONTAUTO' }],
        small: [
          { label: 'Coïncidence', icon: 'gccoincident', cmd: 'CGCOINCIDENT' },
          { label: 'Horizontal', icon: 'gchorizontal', cmd: 'CGHORIZONTAL' },
          { label: 'Vertical', icon: 'gcvertical', cmd: 'CGVERTICAL' },
          { label: 'Parallèle', icon: 'gcparallel', cmd: 'CGPARALLELE' },
          { label: 'Perpendiculaire', icon: 'gcperpendicular', cmd: 'CGPERPENDICULAIRE' },
          { label: 'Tangente', icon: 'gctangent', cmd: 'CGTANGENT' },
          { label: 'Concentrique', icon: 'gcconcentric', cmd: 'CGCONCENTRIQUE' },
          { label: 'Égal', icon: 'gcequal', cmd: 'CGEGAL' },
          { label: 'Fixe', icon: 'gcfix', cmd: 'CGFIXE' },
        ],
      },
      {
        title: 'Cote',
        large: [{ label: 'Linéaire', icon: 'dcaligned', cmd: 'CDALIGNEE' }],
        small: [
          { label: 'Horizontale', icon: 'dchorizontal', cmd: 'CDHORIZONTALE' },
          { label: 'Verticale', icon: 'dcvertical', cmd: 'CDVERTICALE' },
          { label: 'Angulaire', icon: 'dcangular', cmd: 'CDANGULAIRE' },
          { label: 'Rayon', icon: 'dcradius', cmd: 'CDRAYON' },
          { label: 'Diamètre', icon: 'dcdiameter', cmd: 'CDDIAMETRE' },
        ],
      },
      {
        title: 'Gérer',
        large: [
          { label: 'Supprimer', icon: 'delcon', cmd: 'SUPPRCONT' },
          { label: 'Paramètres', icon: 'params', action: (app) => app.set('panel', 'params') },
        ],
        small: [{ label: 'Afficher les contraintes', icon: 'showcon', action: (app) => app.toggle('showConstraints'), active: (app) => app.settings.showConstraints }],
        items: [{ custom: () => <DofStatus /> }],
      },
    ],
  },
  {
    id: 'view',
    label: 'Vue',
    panels: [
      {
        title: 'Espace de travail',
        large: [
          { label: 'Dessin 2D', icon: 'ws-2d', ...ws('2d'), tip: 'Plan 2D léger : vue de dessus, pas d’orbite, noyau 3D non chargé' },
          { label: 'Modélisation 3D', icon: 'ws-3d', ...ws('3d'), tip: 'Solides, surfaces, cube de vue, orbite (charge le noyau 3D)' },
        ],
      },
      {
        title: 'Navigation',
        large: [
          { label: 'Zoom étendu', icon: 'zoom-ext', action: (app) => app.viewport?.zoomExtents() },
          { label: 'Orbite', icon: 'orbit', action: () => undefined, tip: 'Orbite avec le bouton gauche (ou Maj + molette enfoncée)', only: '3d' },
          { label: 'Panoramique', icon: 'pan', action: () => undefined, tip: 'Panoramique avec le bouton gauche (ou molette enfoncée)' },
        ],
        small: [
          { label: 'Zoom fenêtre', icon: 'zoom-win', cmd: ['ZOOM', 'F'] },
          { label: 'Zoom avant', icon: 'zoom-in', action: (app) => app.viewport?.zoomFactor(1.6) },
          { label: 'Zoom arrière', icon: 'zoom-out', action: (app) => app.viewport?.zoomFactor(1 / 1.6) },
        ],
      },
      {
        title: 'Interface',
        large: [
          {
            label: 'Fenêtres de vue',
            icon: 'vports-3',
            cmd: ['FENETRES', '3'],
            tip: 'Plusieurs vues du dessin (Dessus, Face, Droite…) ; un clic dans une vue la rend active',
            menu: [
              { label: 'Une fenêtre', icon: 'vports-1', cmd: ['FENETRES', '1'] },
              { label: 'Deux, côte à côte', icon: 'vports-2v', cmd: ['FENETRES', '2V'] },
              { label: 'Deux, l’une sur l’autre', icon: 'vports-2h', cmd: ['FENETRES', '2H'] },
              { label: 'Trois', icon: 'vports-3', cmd: ['FENETRES', '3'] },
              { label: 'Quatre', icon: 'vports-4', cmd: ['FENETRES', '4'] },
            ],
          },
        ],
        small: [
          { label: 'Onglets des dessins', icon: 'file-tabs', action: (app) => app.set('fileTabs', !app.settings.fileTabs), active: (app) => app.settings.fileTabs },
          { label: 'Écran épuré', icon: 'fullscreen', action: (app) => app.toggleCleanScreen(), tip: 'Masque le ruban et les onglets (Ctrl+0)' },
          { label: 'Démarrage', icon: 'start', action: (app) => app.showStart(true) },
        ],
      },
      {
        title: 'Vues',
        only: '3d',
        compact: true,
        small: [
          { label: 'Dessus', icon: 'view-top', action: view('TOP') },
          { label: 'Face', icon: 'view-front', action: view('FRONT') },
          { label: 'Droite', icon: 'view-right', action: view('RIGHT') },
          { label: 'Dessous', icon: 'view-bottom', action: view('BOTTOM') },
          { label: 'Arrière', icon: 'view-back', action: view('BACK') },
          { label: 'Gauche', icon: 'view-left', action: view('LEFT') },
          { label: 'Iso SO', icon: 'view-iso', action: view('SWISO') },
          { label: 'Iso SE', icon: 'view-iso', action: view('SEISO') },
          { label: 'Iso NE', icon: 'view-iso', action: view('NEISO') },
          { label: 'Iso NO', icon: 'view-iso', action: view('NWISO') },
        ],
      },
      {
        title: 'Projection',
        only: '3d',
        small: [
          { label: 'Perspective', icon: 'perspective', action: (app) => app.set('projection', 'perspective'), active: (app) => app.settings.projection === 'perspective' },
          { label: 'Parallèle', icon: 'parallel', action: (app) => app.set('projection', 'orthographic'), active: (app) => app.settings.projection === 'orthographic' },
        ],
      },
      {
        title: 'Styles visuels',
        only: '3d',
        large: [
          { label: 'Réaliste', icon: 'vs-realistic', ...style('realistic') },
          { label: 'Ombré', icon: 'vs-shaded', ...style('shaded') },
          { label: 'Filaire', icon: 'vs-wire', ...style('wireframe') },
          { label: 'Rayons X', icon: 'vs-xray', ...style('xray') },
        ],
      },
      {
        title: 'Rendu',
        only: '3d',
        large: [
          { label: 'Rendu', icon: 'vs-render', ...style('render'), tip: 'Style Rendu : matériaux, reflets et ombres portées en direct' },
          { label: 'Matériaux', icon: 'material', cmd: 'MATERIAU', tip: 'Acier, aluminium, laiton, PLA, PETG, bois, verre… sur les solides choisis' },
          { label: 'Image de rendu', icon: 'render-image', cmd: 'RENDU', tip: 'Enregistre une image PNG haute définition (jusqu’en 4K), fond studio, blanc ou transparent' },
        ],
      },
      {
        title: 'Palettes',
        small: [
          { label: 'Propriétés', icon: 'pal-props', action: (app) => app.showPanel('properties'), active: (app) => app.settings.panel === 'properties' || (app.settings.propsFloating && app.settings.propsWindow) },
          { label: 'Calques', icon: 'layers', action: (app) => app.showPanel('layers'), active: (app) => app.settings.panel === 'layers' },
          { label: 'Paramètres', icon: 'params', action: (app) => app.showPanel('params'), active: (app) => app.settings.panel === 'params' },
          { label: 'Navigateur', icon: 'browser', action: (app) => app.showPanel('browser'), active: (app) => app.settings.panel === 'browser' },
          { label: 'Grille', icon: 'grid', action: (app) => app.toggle('grid'), active: (app) => app.settings.grid },
          { label: 'Régénérer', icon: 'regen', cmd: 'REGEN' },
          { label: 'Personnaliser', icon: 'customize', cmd: 'PERSONNALISER', tip: 'Raccourcis clavier sur mesure et onglet du ruban « Mon onglet »' },
        ],
      },
    ],
  },
  {
    id: 'solids',
    label: 'Solides',
    only: '3d',
    panels: [
      {
        title: 'Primitives',
        large: [
          { label: 'Boîte', icon: 'box', cmd: 'BOITE' },
          { label: 'Cylindre', icon: 'cylinder', cmd: 'CYLINDRE' },
          { label: 'Pièces', icon: 'parts', cmd: 'PIECES', tip: 'Bibliothèque : vis, écrous, rondelles, boulons, tubes, coudes, profilés, boîtes — il suffit de saisir les cotes' },
        ],
        small: [
          { label: 'Cône', icon: 'cone', cmd: 'CONE' },
          { label: 'Sphère', icon: 'sphere', cmd: 'SPHERE' },
          { label: 'Pyramide', icon: 'pyramid', cmd: 'PYRAMIDE' },
          { label: 'Tore', icon: 'torus', cmd: 'TORE' },
        ],
      },
      {
        title: 'Solide',
        large: [
          { label: 'Extrusion', icon: 'extrude', cmd: 'EXTRUSION' },
          { label: 'Révolution', icon: 'revolve', cmd: 'REVOLUTION' },
        ],
        small: [
          { label: 'Balayage', icon: 'sweep', cmd: 'BALAYAGE' },
          { label: 'Lissage', icon: 'loft', cmd: 'LISSAGE' },
          { label: 'Hélice', icon: 'helix', cmd: 'HELICE' },
          { label: 'Texte 3D', icon: 'text3d', cmd: 'TEXTE3D', tip: 'Texte en relief : posé sur le plan de travail, gravé dans une face ou embossé (polices avec accents)' },
        ],
      },
      {
        title: 'Modélisation directe',
        large: [{ label: 'Appuyer/tirer', icon: 'presspull', cmd: 'APPUYERTIRER', tip: 'Désignez une face plane d’un solide et tirez-la (ajout) ou poussez-la (enlèvement)' }],
        small: [
          { label: 'Esquisse sur face', icon: 'sketch', cmd: 'ESQUISSE', tip: 'Dessine sur une face plane horizontale : l’élévation courante prend sa hauteur' },
          { label: 'Élévation', icon: 'elevation', cmd: 'ELEV' },
          { label: 'Coupe de section', icon: 'section', cmd: 'ANALYSECOUPE' },
        ],
      },
      {
        title: 'Booléennes',
        large: [{ label: 'Union', icon: 'union', cmd: 'UNION' }],
        small: [
          { label: 'Soustraction', icon: 'subtract', cmd: 'SOUSTRACTION' },
          { label: 'Intersection', icon: 'intersect', cmd: 'INTERSECT' },
        ],
      },
      {
        title: 'Modification de solides',
        large: [
          { label: 'Raccord d’arêtes', icon: 'filletedge', cmd: 'RACCORDBORD' },
          { label: 'Perçage', icon: 'hole', cmd: 'PERCAGE', tip: 'Assistant de perçage : passage, lamé, fraisé, taraudé (filet réel en option) ou insert à chaud, M3 à M20, borgne ou débouchant' },
        ],
        small: [
          { label: 'Chanfrein d’arêtes', icon: 'chamferedge', cmd: 'CHANFREINBORD' },
          { label: 'Coque', icon: 'shell', cmd: 'COQUE' },
          { label: 'Coupe', icon: 'slice', cmd: 'COUPE' },
          { label: 'Épaissir', icon: 'thicken', cmd: 'EPAISSIR' },
          { label: 'Convertir en solide', icon: 'convsolid', cmd: 'CONVSOLIDE', tip: 'Corps maillé importé (STL/3MF) → vrai solide : raccords, coque, appuyer/tirer deviennent possibles' },
        ],
      },
    ],
  },
  {
    id: 'surfaces',
    label: 'Surfaces',
    only: '3d',
    panels: [
      {
        title: 'Créer',
        large: [
          { label: 'Plane', icon: 'planesurf', cmd: 'SURFPLANE' },
          { label: 'Réseau', icon: 'surfnetwork', cmd: 'SURFRESEAU' },
        ],
        small: [
          { label: 'Extrusion', icon: 'surfextrude', cmd: 'SURFEXTRU' },
          { label: 'Révolution', icon: 'surfrevolve', cmd: 'SURFREVOL' },
          { label: 'Balayage', icon: 'surfsweep', cmd: 'SURFBALAYAGE' },
          { label: 'Lissage', icon: 'surfloft', cmd: 'SURFLISSAGE' },
        ],
      },
      {
        title: 'Modifier',
        large: [{ label: 'Épaissir', icon: 'thicken', cmd: 'EPAISSIR' }],
        small: [{ label: 'Coupe', icon: 'slice', cmd: 'COUPE' }],
      },
    ],
  },
  {
    id: 'tools3d',
    label: 'Outils 3D',
    only: '3d',
    panels: [
      {
        title: 'Transformer',
        large: [
          { label: 'Déplacer 3D', icon: 'move3d', cmd: 'DEPLACER3D' },
          { label: 'Rotation 3D', icon: 'rotate3d', cmd: 'ROTATION3D' },
          { label: 'Miroir 3D', icon: 'mirror3d', cmd: 'MIROIR3D' },
        ],
      },
      {
        title: 'Réseaux',
        large: [{ label: 'Réseau 3D', icon: 'array3d', cmd: 'RESEAU3D', tip: 'Copies en grille X × Y × Z, en cercle autour d’un axe quelconque ou le long d’un chemin' }],
        small: [{ label: 'Le long d’un chemin', icon: 'arraypath', cmd: 'RESEAUCHEMIN', tip: 'Copies réparties sur une courbe, orientées sur sa tangente' }],
      },
      {
        title: 'Tôlerie',
        large: [
          { label: 'Tôle', icon: 'sheetmetal', cmd: 'TOLE', tip: 'Tôle de base depuis un contour fermé, bords pliés sur les arêtes cliquées (angle, longueur, rayon, facteur K) ; cliquez une tôle existante pour la modifier' },
          { label: 'Déplier', icon: 'flatpattern', cmd: 'DEPLIER', tip: 'Mise à plat : contour développé, lignes de pliage, perçages reportés, export DXF pour la découpe laser' },
        ],
      },
      {
        title: 'Booléennes',
        small: [
          { label: 'Union', icon: 'union', cmd: 'UNION' },
          { label: 'Soustraction', icon: 'subtract', cmd: 'SOUSTRACTION' },
          { label: 'Intersection', icon: 'intersect', cmd: 'INTERSECT' },
        ],
      },
      {
        title: 'Assemblage',
        large: [
          { label: 'Liaison', icon: 'joint', cmd: 'LIAISON', tip: 'Pivot ou glissière entre des corps (charnière, couvercle, tiroir), avec bornes' },
          { label: 'Piloter', icon: 'drivejoint', cmd: 'PILOTER', tip: 'Fait bouger une liaison : valeur, bornes ou animation (aussi par les curseurs du Navigateur)' },
        ],
        small: [{ label: 'Interférences', icon: 'interfere', cmd: 'INTERFERENCE', tip: 'Détecte les corps qui se chevauchent et crée les volumes communs en rouge' }],
      },
      {
        title: 'Analyse',
        large: [
          { label: 'Mètre 3D', icon: 'measure3d', cmd: 'MESUREGEOM', tip: 'Distance entre deux points, angle, épaisseur de paroi, distance entre deux faces' },
          { label: 'Vérifier le solide', icon: 'checksolid', cmd: 'VERIFSOLIDE' },
          { label: 'Propriétés de masse', icon: 'massprop', cmd: 'PROPMASSE' },
        ],
        small: [
          { label: 'Coupe de section', icon: 'section', cmd: 'ANALYSECOUPE' },
          { label: 'Mesurer', icon: 'dist', cmd: 'DIST' },
          { label: 'Liste', icon: 'list', cmd: 'LISTE' },
        ],
      },
    ],
  },
  {
    id: 'output',
    label: 'Sortie',
    panels: [
      {
        title: 'Mise en plan',
        large: [
          { label: 'Mise en plan', icon: 'drawing-sheet', cmd: 'MISEENPLAN', tip: 'Vues 2D cotables depuis la 3D : face, dessus, côtés, iso, lignes cachées, axes, cadre et cartouche à l’échelle' },
          { label: 'Mettre à jour', icon: 'view-update', cmd: 'MAJVUES', tip: 'Régénère les vues après une modification du modèle 3D' },
          { label: 'PDF', icon: 'pdf', cmd: 'EXPORTPDF', tip: 'PDF vectoriel à l’échelle de la feuille (ou de l’étendue du dessin)' },
        ],
      },
      {
        title: 'Impression 3D',
        only: '3d',
        large: [
          { label: 'STL', icon: 'stl', cmd: 'EXPORTSTL', tip: 'Export STL pour l’impression 3D' },
          { label: '3MF', icon: '3mf', cmd: 'EXPORT3MF', tip: 'Export 3MF pour l’impression 3D (unités, couleurs, objets)' },
          { label: 'Vérifier', icon: 'print3d', cmd: 'VERIFSOLIDE', tip: 'Vérifie que les solides sont valides et étanches avant impression' },
          { label: 'Imprimabilité', icon: 'interfere', cmd: 'IMPRIMABILITE', tip: 'Chevauchements, parois trop fines et porte-à-faux colorés dans la vue' },
        ],
      },
      {
        title: 'Exporter',
        large: [
          { label: 'STEP', icon: 'step', cmd: 'EXPORTSTEP' },
          { label: 'DXF', icon: 'dxf', cmd: 'EXPORTDXF' },
        ],
        small: [
          { label: 'SVG (vue de dessus)', icon: 'svg', cmd: 'EXPORTSVG' },
          { label: 'Image PNG', icon: 'png', cmd: 'CAPTURE' },
        ],
      },
      {
        title: 'Enregistrer',
        small: [
          { label: 'Enregistrer', icon: 'save', cmd: 'ENREG' },
          { label: 'Enregistrer sous', icon: 'saveas', cmd: 'ENREGSOUS' },
        ],
      },
    ],
  },
];

function runBtn(app: AppHost, b: { cmd?: string | string[]; action?: (app: AppHost) => void }): void {
  if (b.action) b.action(app);
  else if (Array.isArray(b.cmd)) app.runSequence(b.cmd);
  else if (b.cmd) app.run(b.cmd);
}

function tipOf(app: AppHost, b: Btn): string {
  const name = Array.isArray(b.cmd) ? b.cmd[0] : b.cmd;
  const def = name ? app.registry.resolve(name)?.def : undefined;
  const parts = [b.label];
  if (def) parts.push(`${def.localName}${def.aliases?.length ? ` (${def.aliases.slice(0, 2).join(', ')})` : ''}`);
  const desc = b.tip ?? def?.description;
  return desc ? `${parts.join(' — ')}\n${desc}` : parts.join(' — ');
}

function useNavActive(): (b: Btn) => boolean {
  const it = useInteraction();
  return (b) => (b.label === 'Orbite' ? it?.navMode === 'orbit' : b.label === 'Panoramique' ? it?.navMode === 'pan' : false);
}

/** Menu flottant ancré sous un élément (hors du ruban, qui masque ce qui dépasse). */
function Flyout({ anchor, onClose, children, className = 'rb-drop' }: { anchor: HTMLElement | null; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const w = ref.current?.offsetWidth ?? 220;
    setPos({ left: Math.max(4, Math.min(r.left, window.innerWidth - w - 4)), top: r.bottom + 2 });
  }, [anchor]);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const t = e.target as Element;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      // menu ▾ ouvert depuis un groupe replié : le groupe reste ouvert
      if (className === 'rb-flyout' && t.closest?.('.rb-drop')) return;
      onClose();
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', h);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k);
    };
  }, [onClose, anchor, className]);
  return createPortal(
    <div className={className} ref={ref} style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? 0 }}>
      {children}
    </div>,
    document.body,
  );
}

type MenuEntry = { label: string; icon: string; cmd?: string | string[]; action?: (app: AppHost) => void; sub?: boolean };

function DropMenu({ items, anchor, onClose }: { items: MenuEntry[]; anchor: HTMLElement | null; onClose: () => void }) {
  const app = useApp();
  return (
    <Flyout anchor={anchor} onClose={onClose}>
      {items.map((m, i) => (
        <button
          key={`${m.label}-${i}`}
          className={m.sub ? 'sub' : ''}
          onClick={() => {
            onClose();
            runBtn(app, m);
          }}
        >
          <Icon name={m.icon} size={20} />
          {m.label}
        </button>
      ))}
    </Flyout>
  );
}

function BigButton({ b }: { b: Btn }) {
  const app = useApp();
  const it = useInteraction();
  const nav = useNavActive();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = b.active?.(app) || nav(b);
  const onClick = () => {
    if (b.label === 'Orbite' && it) return it.setNavMode(it.navMode === 'orbit' ? null : 'orbit');
    if (b.label === 'Panoramique' && it) return it.setNavMode(it.navMode === 'pan' ? null : 'pan');
    runBtn(app, b);
  };
  return (
    <div className={`rb-big ${active ? 'active' : ''}`} ref={ref}>
      <button className="rb-big-main" title={tipOf(app, b)} onClick={onClick} onContextMenu={(e) => buttonMenu(app, b, e)}>
        <Icon name={b.icon} size={32} />
        <span>{b.label}</span>
      </button>
      {b.menu && (
        <>
          <button className="rb-big-arrow" onClick={() => setOpen(!open)} aria-label="Variantes">
            <Icon name="chevron" size={12} />
          </button>
          {open && <DropMenu items={b.menu} anchor={ref.current} onClose={() => setOpen(false)} />}
        </>
      )}
    </div>
  );
}

function SmallButton({ b, iconOnly }: { b: Btn; iconOnly?: boolean }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = b.active?.(app);
  const main = (
    <button className={`rb-small ${iconOnly ? 'compact' : ''} ${active ? 'active' : ''}`} title={tipOf(app, b)} onClick={() => runBtn(app, b)} onContextMenu={(e) => buttonMenu(app, b, e)}>
      <Icon name={b.icon} size={iconOnly ? 20 : 18} />
      {!iconOnly && <span>{b.label}</span>}
    </button>
  );
  if (!b.menu) return main;
  return (
    <div className={`rb-split ${active ? 'active' : ''}`} ref={ref}>
      {main}
      <button className="rb-split-arrow" onClick={() => setOpen(!open)} aria-label="Variantes" title="Variantes">
        <Icon name="chevron" size={10} />
      </button>
      {open && <DropMenu items={b.menu} anchor={ref.current} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Commandes d'un bouton pour un menu (le bouton puis ses variantes). */
const entriesOf = (b: Btn): MenuEntry[] => [b, ...(b.menu ?? []).filter((m) => m.label !== b.label).map((m) => ({ ...m, sub: true }))];

interface DragInfo {
  /** Titre du groupe en cours de glissement (null : rien). */
  dragging: string | null;
  start: (title: string) => void;
  drop: (title: string, after: boolean) => void;
  end: () => void;
  menu: (title: string, e: React.MouseEvent) => void;
}

function PanelBody({ p, workspace, plan }: { p: Panel; workspace: Workspace; plan: PanelPlan }) {
  const keep = (b: Btn) => !b.only || b.only === workspace;
  const small = (p.small ?? []).filter(keep);
  const per = p.compact ? 2 : 3;
  const shown = small.slice(0, plan.cols * per);
  const cols: Btn[][] = [];
  for (let i = 0; i < shown.length; i += per) cols.push(shown.slice(i, i + per));
  return (
    <div className="rb-panel-body">
      {p.large?.filter(keep).map((b) => <BigButton key={b.label} b={b} />)}
      {p.items?.map((it, i) => ('custom' in it ? <div key={i}>{it.custom()}</div> : <BigButton key={it.label} b={it} />))}
      {cols.map((c, i) => (
        <div className={`rb-col ${p.compact ? 'grid' : ''}`} key={i}>
          {c.map((b) => (
            <SmallButton key={b.label} b={b} iconOnly={plan.iconOnly} />
          ))}
        </div>
      ))}
    </div>
  );
}

function PanelView({ p, workspace, plan, drag }: { p: Panel; workspace: Workspace; plan: PanelPlan; drag: DragInfo }) {
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState<'before' | 'after' | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const keep = (b: Btn) => !b.only || b.only === workspace;
  const small = (p.small ?? []).filter(keep);
  const hidden = small.slice(plan.cols * (p.compact ? 2 : 3));
  const dnd = {
    onDragOver: (e: React.DragEvent) => {
      if (!drag.dragging || drag.dragging === p.title) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = ref.current!.getBoundingClientRect();
      setOver(e.clientX > r.left + r.width / 2 ? 'after' : 'before');
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!ref.current?.contains(e.relatedTarget as Node)) setOver(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const r = ref.current!.getBoundingClientRect();
      setOver(null);
      drag.drop(p.title, e.clientX > r.left + r.width / 2);
    },
  };
  const handle = {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', p.title);
      drag.start(p.title);
    },
    onDragEnd: () => drag.end(),
    onContextMenu: (e: React.MouseEvent) => drag.menu(p.title, e),
  };
  const cls = `rb-panel ${plan.collapsed ? 'collapsed' : ''} ${drag.dragging === p.title ? 'dragging' : ''} ${over ? `drop-${over}` : ''}`;
  if (plan.collapsed) {
    const icon = p.large?.find(keep)?.icon ?? small[0]?.icon ?? 'cmd-generic';
    return (
      <div className={cls} ref={ref} {...dnd}>
        <div className="rb-panel-body">
          <div className="rb-big" ref={titleRef}>
            <button className="rb-big-main" title={`${p.title} (glisser pour déplacer le groupe)`} onClick={() => setOpen(!open)} {...handle}>
              <Icon name={icon} size={32} />
              <span>{p.title}</span>
            </button>
            <button className="rb-big-arrow" onClick={() => setOpen(!open)} aria-label="Ouvrir le groupe">
              <Icon name="chevron" size={12} />
            </button>
          </div>
        </div>
        <div className="rb-panel-title">{p.title}</div>
        {open && (
          <Flyout anchor={titleRef.current} onClose={() => setOpen(false)} className="rb-flyout">
            <div className="rb-panel" onClick={(e) => (e.target as Element).closest('.rb-small, .rb-big-main, .rb-drop button') && setOpen(false)}>
              <PanelBody p={p} workspace={workspace} plan={{ cols: Math.ceil(small.length / (p.compact ? 2 : 3)), iconOnly: !!p.compact, collapsed: false }} />
              <div className="rb-panel-title">{p.title}</div>
            </div>
          </Flyout>
        )}
      </div>
    );
  }
  return (
    <div className={cls} ref={ref} {...dnd}>
      <PanelBody p={p} workspace={workspace} plan={plan} />
      <div className={`rb-panel-title ${hidden.length ? 'more' : ''}`} ref={titleRef} title="Glisser pour déplacer le groupe — clic droit : ordre des groupes" {...handle} onClick={() => hidden.length && setOpen(!open)}>
        <span>{p.title}</span>
        {hidden.length > 0 && <Icon name="caret-down" size={10} />}
      </div>
      {open && hidden.length > 0 && <DropMenu items={hidden.flatMap(entriesOf)} anchor={titleRef.current} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Commandes présentes dans le ruban : libellé, icône, onglet (pour « Mon onglet »). */
export interface RibbonCommand {
  cmd: string;
  label: string;
  icon: string;
  tab: string;
}

let catalog: RibbonCommand[] | null = null;
export function ribbonCommands(): RibbonCommand[] {
  if (catalog) return catalog;
  const seen = new Map<string, RibbonCommand>();
  for (const t of TABS)
    for (const p of t.panels)
      for (const b of [...(p.large ?? []), ...(p.small ?? []), ...(p.items ?? []).filter((i): i is Btn => !('custom' in i))]) {
        const list = [b, ...(b.menu ?? [])];
        for (const x of list) {
          if (!x.cmd) continue;
          const cmd = Array.isArray(x.cmd) ? x.cmd.join(' ') : x.cmd;
          if (!seen.has(cmd)) seen.set(cmd, { cmd, label: x === b || !b.menu ? x.label : `${b.label} : ${x.label}`, icon: x.icon, tab: t.label });
        }
      }
  catalog = [...seen.values()];
  return catalog;
}

/** Bouton de « Mon onglet » pour une commande (icône du ruban si elle y figure). */
function customBtn(app: AppHost, cmd: string): Btn {
  const meta = ribbonCommands().find((c) => c.cmd === cmd);
  const def = app.registry.resolve(cmd.split(/\s+/)[0]!)?.def;
  const label = meta?.label ?? (def ? def.localName.charAt(0) + def.localName.slice(1).toLowerCase() : cmd);
  return { label, icon: meta?.icon ?? 'cmd-generic', cmd: cmd.includes(' ') ? cmd.split(/\s+/) : cmd, tip: def?.description };
}

/** Menu du clic droit sur un bouton : ajouter / retirer de « Mon onglet », personnaliser. */
function buttonMenu(app: AppHost, b: Btn, e: React.MouseEvent): void {
  if (!b.cmd) return;
  e.preventDefault();
  const cmd = Array.isArray(b.cmd) ? b.cmd.join(' ') : b.cmd;
  const tab = app.settings.customTab;
  const has = tab.items.includes(cmd);
  app.ui.contextMenu(e.clientX, e.clientY, [
    {
      label: has ? `Retirer de « ${tab.label} »` : `Ajouter à « ${tab.label} »`,
      icon: 'tab-custom',
      action: () => app.set('customTab', { ...tab, items: has ? tab.items.filter((c) => c !== cmd) : [...tab.items, cmd] }),
    },
    { label: 'Personnaliser le ruban et les raccourcis…', icon: 'customize', action: () => app.ui.customize() },
  ]);
}

export function Ribbon() {
  const app = useHost(['settings', 'doc', 'constraints']);
  const workspace = app.settings.workspace;
  const custom = app.settings.customTab;
  const customTab: Tab | null = custom.items.length
    ? { id: 'custom', label: custom.label || 'Mon onglet', panels: [{ title: custom.label || 'Mon onglet', large: custom.items.map((c) => customBtn(app, c)) }] }
    : null;
  const tabs = [...TABS, ...(customTab ? [customTab] : [])].filter((t) => !t.only || t.only === workspace);
  const [tab, setTab] = useState(() => {
    try {
      return localStorage.getItem('sebcad.tab') ?? 'home';
    } catch {
      return 'home';
    }
  });
  const [collapsed, setCollapsed] = useState(false);
  const current = tabs.find((t) => t.id === tab) ?? tabs[0]!;
  const select = (id: string) => {
    if (id === tab) setCollapsed(!collapsed);
    else setCollapsed(false);
    setTab(id);
    try {
      localStorage.setItem('sebcad.tab', id);
    } catch {
      /* ignoré */
    }
  };

  // --- ordre des groupes (glisser-déposer, mémorisé par onglet) ---
  const orders = app.settings.ribbonOrder ?? {};
  const panels = orderPanels(
    current.panels.filter((p) => !p.only || p.only === workspace),
    orders[current.id],
  );
  const titles = panels.map((p) => p.title);
  const setOrder = (next: string[] | null) => {
    const o = { ...orders };
    if (next) o[current.id] = next;
    else delete o[current.id];
    app.set('ribbonOrder', o);
  };
  const [dragging, setDragging] = useState<string | null>(null);
  const drag: DragInfo = {
    dragging,
    start: (t) => setDragging(t),
    end: () => setDragging(null),
    drop: (t, after) => {
      if (dragging) setOrder(movePanel(titles, dragging, t, after));
      setDragging(null);
    },
    menu: (t, e) => {
      e.preventDefault();
      const k = titles.indexOf(t);
      const move = (to: number) => {
        const next = titles.filter((x) => x !== t);
        next.splice(to, 0, t);
        setOrder(next);
      };
      app.ui.contextMenu(e.clientX, e.clientY, [
        { label: 'Déplacer le groupe à gauche', icon: 'arrow-left', disabled: k <= 0, action: () => move(k - 1) },
        { label: 'Déplacer le groupe à droite', icon: 'arrow-right', disabled: k >= titles.length - 1, action: () => move(k + 1) },
        { label: 'Placer en premier', icon: 'arrow-left', disabled: k <= 0, action: () => move(0) },
        { label: 'Placer en dernier', icon: 'arrow-right', disabled: k >= titles.length - 1, action: () => move(titles.length - 1) },
        { label: `Rétablir l’ordre de l’onglet « ${current.label} »`, icon: 'undo', disabled: !orders[current.id], action: () => setOrder(null) },
      ]);
    },
  };

  // --- mise en page adaptative : on réduit les groupes jusqu'à ce que tout tienne ---
  const shapes: PanelShape[] = panels.map((p) => {
    const keep = (b: Btn) => !b.only || b.only === workspace;
    return { fixed: (p.large ?? []).filter(keep).length + (p.items?.length ?? 0), small: (p.small ?? []).filter(keep).length, per: p.compact ? 2 : 3, max: p.max, compact: p.compact };
  });
  const sig = `${current.id}|${workspace}|${titles.join('/')}|${collapsed}`;
  const [fit, setFit] = useState({ sig, level: 0 });
  const level = fit.sig === sig ? fit.level : 0;
  const plans = planAt(shapes, level);
  const top = maxLevel(shapes);
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = rowRef.current;
    if (el && el.scrollWidth > el.clientWidth + 1 && level < top) setFit({ sig, level: level + 1 });
  });
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === w) return;
      w = el.clientWidth;
      // on repart de la mise en page complète ; l'effet ci-dessus réduit avant l'affichage
      flushSync(() => setFit((f) => ({ sig: f.sig, level: 0 })));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed]);

  return (
    <div className="ribbon">
      <div className="rb-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={t.id === current.id ? 'on' : ''} onClick={() => select(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {!collapsed && (
        <div className="rb-panels" ref={rowRef}>
          {panels.map((p, i) => (
            <PanelView key={p.title} p={p} workspace={workspace} plan={plans[i]!} drag={drag} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Contrôles intégrés au ruban
// ---------------------------------------------------------------------------

function LayerCombo() {
  const app = useHost(['doc', 'selection']);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  const doc = app.doc;
  const sel = app.selection.list().map((h) => doc.get(h)).filter((e) => !!e);
  const shownName = sel.length ? (sel.every((e) => e!.layer === sel[0]!.layer) ? sel[0]!.layer : '*VARIE*') : doc.currentLayer;
  const shown = doc.layer(shownName);
  const choose = (name: string) => {
    setOpen(false);
    try {
      if (sel.length) doc.transaction('Changer de calque', () => sel.forEach((e) => doc.replaceEntity(e!.handle, { layer: name })));
      else doc.setCurrentLayer(name);
    } catch (e) {
      app.ui.toast((e as Error).message, 'error');
    }
  };
  const toggle = (name: string, key: 'visible' | 'frozen' | 'locked') => {
    try {
      const l = doc.layer(name)!;
      doc.updateLayer(name, { [key]: !l[key] });
    } catch (e) {
      app.ui.toast((e as Error).message, 'error');
    }
  };
  const row = (name: string, inList: boolean) => {
    const l = doc.layer(name);
    return (
      <div className="lc-row" key={name}>
        {l && (
          <>
            <span className="lc-ico" onMouseDown={(e) => e.stopPropagation()} onClick={() => inList && toggle(name, 'visible')} title="Activé / désactivé">
              <Icon name={l.visible ? 'bulb' : 'bulb-off'} size={14} />
            </span>
            <span className="lc-ico" onClick={() => inList && toggle(name, 'frozen')} title="Libéré / gelé">
              <Icon name={l.frozen ? 'snow' : 'sun'} size={14} />
            </span>
            <span className="lc-ico" onClick={() => inList && toggle(name, 'locked')} title="Déverrouillé / verrouillé">
              <Icon name={l.locked ? 'lock-closed' : 'lock-open'} size={14} />
            </span>
            <span className="swatch" style={{ background: l.color }} />
          </>
        )}
        <span className="lc-name" onClick={() => inList && choose(name)}>
          {name}
        </span>
      </div>
    );
  };
  return (
    <div className="layer-combo" ref={ref}>
      <div className="lc-current" onClick={() => setOpen(!open)} title={sel.length ? 'Calque des objets sélectionnés (choisir pour les déplacer)' : 'Calque courant'}>
        {shown ? row(shown.name, false) : <span className="lc-name">{shownName}</span>}
        <Icon name="chevron" size={12} />
      </div>
      {open && <div className="lc-list">{doc.layers.map((l) => row(l.name, true))}</div>}
    </div>
  );
}

function NumField({ label, value, onChange, step = 0.1, min }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const v = Number(text.replace(',', '.'));
    if (Number.isFinite(v) && (min === undefined || v >= min)) onChange(v);
    else setText(String(value));
  };
  return (
    <label className="rb-field">
      <span>{label}</span>
      <input type="number" step={step} value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), commit())} />
    </label>
  );
}

function HatchSettings() {
  const app = useHost(['doc']);
  const sv = app.sysvars;
  const set = (patch: Partial<typeof sv>) => {
    Object.assign(sv, patch);
    app.doc.changed();
  };
  return (
    <div className="rb-form">
      <label className="rb-field">
        <span>Motif</span>
        <select value={sv.HPNAME} onChange={(e) => set({ HPNAME: e.target.value as HatchPattern })}>
          <option value="SOLID">Plein</option>
          <option value="ANSI31">ANSI31 (45°)</option>
          <option value="ANSI37">ANSI37 (quadrillage 45°)</option>
          <option value="NET">Grille</option>
          <option value="GRADIENT">Dégradé</option>
        </select>
      </label>
      <NumField label="Échelle" value={sv.HPSCALE} min={0.0001} onChange={(v) => set({ HPSCALE: v })} />
      <NumField label="Angle (°)" value={sv.HPANG} step={15} onChange={(v) => set({ HPANG: v })} />
    </div>
  );
}

function DimSettings() {
  const app = useHost(['doc']);
  const sv = app.sysvars;
  const set = (patch: Partial<typeof sv>) => {
    Object.assign(sv, patch);
    app.doc.changed();
    app.viewport?.rebuild();
  };
  return (
    <div className="rb-form">
      <NumField label="Hauteur du texte" value={sv.DIMTXT} min={0.01} onChange={(v) => set({ DIMTXT: v })} />
      <NumField label="Flèches" value={sv.DIMASZ} min={0} onChange={(v) => set({ DIMASZ: v })} />
      <NumField label="Décimales" value={sv.DIMDEC} step={1} min={0} onChange={(v) => set({ DIMDEC: Math.round(Math.min(8, v)) })} />
    </div>
  );
}

function DofStatus() {
  const app = useHost(['constraints', 'doc']);
  const s = app.constraintStatus;
  const n = app.doc.constraints.length;
  return (
    <div className="rb-info dof">
      <div>{n} contrainte(s)</div>
      <div className={s.ok ? 'ok' : 'bad'}>{n ? (s.ok ? `${s.dof} degré(s) de liberté` : 'Conflit / non résolu') : '—'}</div>
    </div>
  );
}
