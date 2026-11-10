/**
 * Fenêtre principale : barre de titre avec accès rapide, ruban, zone de dessin, palettes
 * (Propriétés, Calques, Paramètres, Fonds de plan), barre d'état et raccourcis clavier globaux.
 */
import { useEffect, useRef, useState } from 'react';
import type { AppHost, PanelName } from '../app/AppHost';
import { focusCommandLine, isCommandLine } from './CommandLine';
import { isModalOpen, UiRoot } from './Dialogs';
import { Icon } from './icons';
import { InteractionContext, useApp, useHost } from './context';
import { LayersPanel } from './panels/Layers';
import { BrowserPanel } from './panels/Browser';
import { ParametersPanel } from './panels/Parameters';
import { PropertiesPanel } from './panels/Properties';
import { UnderlaysPanel } from './panels/Underlays';
import { PartsPanel } from './panels/Parts';
import { Ribbon } from './Ribbon';
import { DocTabs, StartPage, closeFromUi, switchTo } from './DocTabs';
import { comboOf, comboProblem } from './shortcuts';
import { StatusBar } from './StatusBar';
import { Viewport } from './Viewport';

export function App() {
  const app = useApp();
  const [holder] = useState(() => ({ current: null, listeners: new Set<() => void>() }));
  useGlobalKeys(app, holder);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (app.docs.some((t) => t.doc.dirty && t.doc.size > 0)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [app]);
  return (
    <InteractionContext.Provider value={holder}>
      <div className="app">
        <TitleBar />
        <Chrome />
        <div className="main">
          <Viewport />
          <Palette />
          <PropertiesWindow />
          <StartPage />
        </div>
        <StatusBar />
        <UiRoot />
      </div>
    </InteractionContext.Provider>
  );
}

// ---------------------------------------------------------------------------

/** Ruban et onglets des dessins, masqués en écran épuré (Ctrl+0). */
function Chrome() {
  const app = useHost(['settings']);
  if (app.cleanScreen) return null;
  return (
    <>
      <Ribbon />
      <DocTabs />
    </>
  );
}

function TitleBar() {
  const app = useHost(['doc', 'command', 'settings', 'kernel', 'tabs']);
  const doc = app.doc;
  const ws = app.settings.workspace;
  const title = `${doc.fileName}${doc.dirty ? ' *' : ''}`;
  useEffect(() => {
    document.title = `${title} — Xylform CAD`;
  }, [title]);
  const q = (icon: string, label: string, cmd: string, disabled = false) => (
    <button className="tb-btn" title={label} disabled={disabled} onClick={() => app.run(cmd)}>
      <Icon name={icon} size={18} />
    </button>
  );
  const panel = (p: PanelName, icon: string, label: string) => (
    <button className={`tb-btn ${app.settings.panel === p || (p === 'properties' && app.settings.propsFloating && app.settings.propsWindow) ? 'on' : ''}`} title={label} onClick={() => app.showPanel(p)}>
      <Icon name={icon} size={18} />
    </button>
  );
  return (
    <header className="titlebar">
      <img className="tb-logo" src="/favicon.png" alt="" title="Xylform CAD, by Seb." />
      <div className="tb-quick">
        {q('new', 'Nouveau (Ctrl+N)', 'NOUVEAU')}
        {q('open', 'Ouvrir (Ctrl+O)', 'OUVRIR')}
        {q('save', 'Enregistrer (Ctrl+S)', 'ENREG')}
        {q('saveas', 'Enregistrer sous (Ctrl+Maj+S)', 'ENREGSOUS')}
        {q('import', 'Importer DWG, DXF ou STEP', 'IMPORTER')}
        {q('xref-attach', 'Attacher un fond de plan (DWG, DXF, PDF, image)', 'ATTACHER')}
        <span className="tb-sep" />
        {q('undo', 'Annuler (Ctrl+Z)', 'ANNULER', !doc.canUndo)}
        {q('redo', 'Rétablir (Ctrl+Y)', 'RETABLIR', !doc.canRedo)}
        <span className="tb-sep" />
        {q('stl', 'Exporter en STL', 'EXPORTSTL')}
        {q('3mf', 'Exporter en 3MF', 'EXPORT3MF')}
      </div>
      <div className="tb-ws" role="group" aria-label="Espace de travail">
        <button className={ws === '2d' ? 'on' : ''} title="Dessin 2D : plus léger (vue de dessus, pas d’orbite, noyau 3D non chargé)" onClick={() => app.set('workspace', '2d')}>
          2D
        </button>
        <button className={ws === '3d' ? 'on' : ''} title="Modélisation 3D : solides, cube de vue, orbite, appuyer/tirer" onClick={() => app.set('workspace', '3d')}>
          3D
        </button>
      </div>
      <div className="tb-title">
        Xylform CAD <span className="tb-by">by Seb.</span> <span className="tb-dim">—</span> <b>{title}</b>
      </div>
      <div className="tb-right">
        {panel('properties', 'pal-props', 'Propriétés (Ctrl+1)')}
        {panel('layers', 'layers', 'Gestionnaire des calques')}
        {panel('params', 'params', 'Gestionnaire de paramètres')}
        {panel('underlays', 'xref-palette', 'Fonds de plan (REFEXT)')}
        {panel('browser', 'browser', 'Navigateur : corps, esquisses, fonds de plan')}
        {panel('parts', 'parts', 'Bibliothèque de pièces (vis, écrous, tubes, profilés, boîtes)')}
        <button className="tb-btn" title="Aide (F1)" onClick={() => app.ui.showHelp()}>
          <Icon name="help" size={18} />
        </button>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------

const PANELS: { id: PanelName; label: string }[] = [
  { id: 'properties', label: 'Propriétés' },
  { id: 'layers', label: 'Calques' },
  { id: 'params', label: 'Paramètres' },
  { id: 'underlays', label: 'Fonds de plan' },
  { id: 'browser', label: 'Navigateur' },
  { id: 'parts', label: 'Pièces' },
];

interface PaletteLayout {
  /** Ancrée à droite (largeur `width`) ou flottante dans la vue (x, y, w, h relatifs à la vue). */
  floating: boolean;
  width: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

const LAYOUT_KEY = 'sebcad.palette';

function loadLayout(): PaletteLayout {
  const def: PaletteLayout = { floating: false, width: 350, x: 60, y: 60, w: 330, h: 480 };
  try {
    const old = Number(localStorage.getItem('sebcad.paletteWidth'));
    if (old) def.width = old;
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (raw) return { ...def, ...(JSON.parse(raw) as Partial<PaletteLayout>) };
  } catch {
    /* stockage indisponible */
  }
  return def;
}

function saveLayout(l: PaletteLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l));
  } catch {
    /* ignoré */
  }
}

/**
 * Palette latérale : ancrée à droite (redimensionnable par son bord) ou détachée, flottante et
 * déplaçable dans la vue (glisser la barre d'onglets, coin bas droit pour la taille). Double-clic
 * sur la barre : ancrer / détacher. La disposition est mémorisée.
 */
function Palette() {
  const app = useHost(['settings']);
  const panel = app.settings.panel;
  const [layout, setLayoutState] = useState(loadLayout);
  const ref = useRef<HTMLElement>(null);
  const drag = useRef<{ kind: 'width' | 'move'; x: number; y: number; start: PaletteLayout } | null>(null);
  const setLayout = (l: PaletteLayout) => {
    setLayoutState(l);
    saveLayout(l);
  };

  // garde la palette flottante dans la vue (fenêtre redimensionnée)
  useEffect(() => {
    if (!layout.floating) return;
    const clamp = () => {
      const host = ref.current?.parentElement;
      if (!host) return;
      const W = host.clientWidth, H = host.clientHeight;
      setLayoutState((l) => {
        const w = Math.min(l.w, W - 8), h = Math.min(l.h, H - 8);
        const x = Math.max(4, Math.min(l.x, W - w - 4)), y = Math.max(4, Math.min(l.y, H - h - 4));
        return x === l.x && y === l.y && w === l.w && h === l.h ? l : { ...l, x, y, w, h };
      });
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [layout.floating, panel]);

  // taille choisie au coin (redimensionnement CSS) mémorisée
  useEffect(() => {
    const el = ref.current;
    if (!el || !layout.floating) return;
    const ro = new ResizeObserver(() => {
      const w = el.offsetWidth, h = el.offsetHeight;
      setLayoutState((l) => {
        if (Math.abs(l.w - w) < 1 && Math.abs(l.h - h) < 1) return l;
        const n = { ...l, w, h };
        saveLayout(n);
        return n;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [layout.floating, panel]);

  if (!panel) return null;

  const toggleFloat = () => {
    const host = ref.current?.parentElement;
    const W = host?.clientWidth ?? 1200;
    // détachée : posée à gauche de son ancienne place, sous le cube de vue
    setLayout(layout.floating ? { ...layout, floating: false } : { ...layout, floating: true, x: Math.max(4, W - layout.width - 150), y: 150, w: layout.width, h: Math.min(layout.h, (host?.clientHeight ?? 700) - 160) });
  };
  const onWidthDown = (e: React.PointerEvent) => {
    drag.current = { kind: 'width', x: e.clientX, y: e.clientY, start: layout };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onHeadDown = (e: React.PointerEvent) => {
    if (!layout.floating || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    drag.current = { kind: 'move', x: e.clientX, y: e.clientY, start: layout };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.kind === 'width') setLayoutState({ ...d.start, width: Math.max(250, Math.min(window.innerWidth * 0.6, d.start.width + d.x - e.clientX)) });
    else {
      const host = ref.current?.parentElement;
      const W = host?.clientWidth ?? window.innerWidth, H = host?.clientHeight ?? window.innerHeight;
      setLayoutState({
        ...d.start,
        x: Math.max(4, Math.min(W - d.start.w - 4, d.start.x + e.clientX - d.x)),
        y: Math.max(4, Math.min(H - 40, d.start.y + e.clientY - d.y)),
      });
    }
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setLayoutState((l) => (saveLayout(l), l));
  };

  const style: React.CSSProperties = layout.floating ? { left: layout.x, top: layout.y, width: layout.w, height: layout.h } : { width: layout.width };
  return (
    <aside ref={ref} className={`palette ${layout.floating ? 'floating' : ''}`} style={style} onContextMenu={(e) => e.stopPropagation()}>
      {!layout.floating && <div className="pal-resize" onPointerDown={onWidthDown} onPointerMove={onMove} onPointerUp={onUp} />}
      <div
        className="pal-tabs"
        onPointerDown={onHeadDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && toggleFloat()}
        title={layout.floating ? 'Glisser pour déplacer — double-clic pour ancrer à droite' : 'Double-clic pour détacher la palette'}
      >
        {layout.floating && <span className="pal-grip" aria-hidden />}
        {PANELS.filter((p) => !(p.id === 'properties' && app.settings.propsFloating)).map((p) => (
          <button key={p.id} className={panel === p.id ? 'on' : ''} title={p.label} onClick={() => app.set('panel', p.id)}>
            {p.label}
          </button>
        ))}
        <span className="pal-tools">
          <button
            className="pal-dock"
            title={layout.floating ? 'Ancrer la palette à droite' : panel === 'properties' ? 'Détacher les Propriétés (fenêtre libre, déplaçable sur le dessin)' : 'Détacher la palette (flottante dans la vue)'}
            onClick={() => (!layout.floating && panel === 'properties' ? app.setPropertiesFloating(true) : toggleFloat())}
          >
            <Icon name={layout.floating ? 'dock' : 'undock'} size={15} />
          </button>
          <button className="pal-close" title="Fermer la palette" onClick={() => app.set('panel', null)}>
            <Icon name="close" size={14} />
          </button>
        </span>
      </div>
      <div className="pal-body">
        {panel === 'properties' && <PropertiesPanel />}
        {panel === 'layers' && <LayersPanel />}
        {panel === 'params' && <ParametersPanel />}
        {panel === 'underlays' && <UnderlaysPanel />}
        {panel === 'browser' && <BrowserPanel />}
        {panel === 'parts' && <PartsPanel />}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Fenêtre libre des Propriétés
// ---------------------------------------------------------------------------

interface WindowRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PROPS_KEY = 'sebcad.propsWindow';

function loadRect(): WindowRect | null {
  try {
    const raw = localStorage.getItem(PROPS_KEY);
    return raw ? (JSON.parse(raw) as WindowRect) : null;
  } catch {
    return null;
  }
}

function saveRect(r: WindowRect): void {
  try {
    localStorage.setItem(PROPS_KEY, JSON.stringify(r));
  } catch {
    /* ignoré */
  }
}

/**
 * Propriétés détachées : fenêtre libre posée sur
 * le dessin, déplaçable par sa barre de titre, redimensionnable par son coin. La palette latérale
 * reste disponible pour les autres onglets. Position et taille sont mémorisées.
 */
function PropertiesWindow() {
  const app = useHost(['settings']);
  const open = app.settings.propsFloating && app.settings.propsWindow;
  const ref = useRef<HTMLElement>(null);
  const [rect, setRect] = useState<WindowRect | null>(loadRect);
  const drag = useRef<{ x: number; y: number; start: WindowRect } | null>(null);

  // première ouverture : à droite de la vue, sous le cube de vue ; toujours gardée dans la vue
  useEffect(() => {
    if (!open) return;
    const clamp = () => {
      const host = ref.current?.parentElement;
      if (!host) return;
      const W = host.clientWidth, H = host.clientHeight;
      setRect((r) => {
        const base = r ?? { x: Math.max(4, W - 340 - 190), y: 150, w: 340, h: Math.min(520, H - 170) };
        const w = Math.min(base.w, W - 8), h = Math.min(base.h, H - 8);
        const x = Math.max(4, Math.min(base.x, W - w - 4)), y = Math.max(4, Math.min(base.y, H - 40));
        return r && x === r.x && y === r.y && w === r.w && h === r.h ? r : { x, y, w, h };
      });
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [open]);

  // taille choisie au coin mémorisée
  useEffect(() => {
    const el = ref.current;
    if (!el || !open) return;
    const ro = new ResizeObserver(() => {
      const w = el.offsetWidth, h = el.offsetHeight;
      setRect((r) => {
        if (!r || (Math.abs(r.w - w) < 1 && Math.abs(r.h - h) < 1)) return r;
        const n = { ...r, w, h };
        saveRect(n);
        return n;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, rect !== null]);

  if (!open) return null;
  const onDown = (e: React.PointerEvent) => {
    if (!rect || e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    drag.current = { x: e.clientX, y: e.clientY, start: rect };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const host = ref.current?.parentElement;
    const W = host?.clientWidth ?? window.innerWidth, H = host?.clientHeight ?? window.innerHeight;
    setRect({ ...d.start, x: Math.max(4, Math.min(W - d.start.w - 4, d.start.x + e.clientX - d.x)), y: Math.max(4, Math.min(H - 40, d.start.y + e.clientY - d.y)) });
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    setRect((r) => (r && saveRect(r), r));
  };
  const style: React.CSSProperties = rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : { visibility: 'hidden' };
  return (
    <aside ref={ref} className="palette floating props-window" style={style} onContextMenu={(e) => e.stopPropagation()}>
      <div className="pal-tabs" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onDoubleClick={(e) => !(e.target as HTMLElement).closest('button') && app.setPropertiesFloating(false)} title="Glisser pour déplacer — double-clic pour rattacher à la palette">
        <span className="pal-grip" aria-hidden />
        <span className="pw-title">Propriétés</span>
        <span className="pal-tools">
          <button className="pal-dock" title="Rattacher les Propriétés à la palette" onClick={() => app.setPropertiesFloating(false)}>
            <Icon name="dock" size={15} />
          </button>
          <button className="pal-close" title="Fermer (Ctrl+1 pour rouvrir)" onClick={() => app.set('propsWindow', false)}>
            <Icon name="close" size={14} />
          </button>
        </span>
      </div>
      <div className="pal-body">
        <PropertiesPanel />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Clavier
// ---------------------------------------------------------------------------

function isField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

function useGlobalKeys(app: AppHost, holder: { current: { escape(): boolean } | null }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isModalOpen() || e.defaultPrevented) return;
      const cmd = isCommandLine(e.target);
      const field = isField(e.target) && !cmd;
      const mod = e.ctrlKey || e.metaKey;
      const proc = app.processor;
      // raccourcis personnalisés (PERSONNALISER), prioritaires sur les raccourcis intégrés
      if (!field) {
        const combo = comboOf(e);
        const custom = combo ? app.settings.shortcuts[combo] : undefined;
        if (custom && !comboProblem(combo!)) {
          e.preventDefault();
          app.setInput('');
          app.runSequence(custom.trim().split(/\s+/));
          return;
        }
      }
      const fkeys: Record<string, () => void> = {
        F1: () => app.ui.showHelp(),
        F3: () => app.toggle('osnap'),
        F7: () => app.toggle('grid'),
        F8: () => app.toggle('ortho'),
        F9: () => app.toggle('snap'),
        F10: () => app.toggle('polar'),
        F11: () => app.toggle('infer'),
        F12: () => app.toggle('dyn'),
      };
      const fk = fkeys[e.key];
      if (fk && !mod && !e.altKey) {
        e.preventDefault();
        fk();
        return;
      }
      if (e.key === 'Escape') {
        if (field) {
          (e.target as HTMLElement).blur();
          return;
        }
        e.preventDefault();
        if (holder.current?.escape()) return;
        if (!proc.isIdle) {
          proc.cancel();
          // calcul 3D en cours : le noyau est arrêté net puis relancé (solides rechargés)
          if (app.kernel.busy > 0) void app.interruptKernel();
        }
        else {
          app.setInput('');
          app.selection.clear();
        }
        return;
      }
      if (field) return;
      const typed = cmd && app.input.length > 0;
      // onglets des dessins : Ctrl+Tab / Ctrl+Maj+Tab (suivant / précédent), Ctrl+F4 (fermer)
      if (e.ctrlKey && !e.altKey && (e.key === 'Tab' || e.key === 'F4')) {
        e.preventDefault();
        if (e.key === 'F4') void closeFromUi(app, app.tab);
        else if (app.docs.length > 1) {
          const i = app.docs.indexOf(app.tab);
          const n = app.docs.length;
          void switchTo(app, app.docs[(i + (e.shiftKey ? n - 1 : 1)) % n]!);
        }
        return;
      }
      if (mod && !e.altKey) {
        const k = e.key.toLowerCase();
        const actions: Record<string, (() => void) | undefined> = {
          z: typed ? undefined : () => app.run(e.shiftKey ? 'RETABLIR' : 'ANNULER'),
          y: typed ? undefined : () => app.run('RETABLIR'),
          s: () => app.run(e.shiftKey ? 'ENREGSOUS' : 'ENREG'),
          o: () => app.run('OUVRIR'),
          n: () => app.run('NOUVEAU'),
          a: typed ? undefined : () => app.run('TOUTSEL'),
          c: typed || hasTextSelection() ? undefined : () => app.selection.size && app.run('COPIERPP'),
          x: typed ? undefined : () => app.selection.size && app.run('COUPERPP'),
          v: typed ? undefined : () => app.run('COLLERPP'),
          '1': () => app.showPanel('properties'),
          '0': () => app.toggleCleanScreen(),
          'à': () => app.toggleCleanScreen(),
          '&': () => app.showPanel('properties'),
        };
        const act = actions[k];
        if (act) {
          e.preventDefault();
          act();
        }
        return;
      }
      if (cmd) return; // la ligne de commande gère Entrée, Espace, flèches…
      if (e.key === 'Delete' && app.selection.size && proc.isIdle) {
        e.preventDefault();
        app.run('EFFACER');
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const v = app.input;
        app.setInput('');
        proc.submit(v);
        return;
      }
      // toute frappe imprimable part dans la ligne de commande
      if (e.key.length === 1 && !e.altKey) focusCommandLine();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app, holder]);
}

function hasTextSelection(): boolean {
  const s = window.getSelection();
  return !!s && s.toString().length > 0;
}
