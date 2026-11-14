/**
 * Barre d'état : coordonnées, aides au dessin (GRILLE, RESOL, ORTHO, POLAIRE, ACCROBJ, DYN, EP),
 * contraintes, état du noyau 3D et style visuel.
 */
import { useEffect, useRef, useState } from 'react';
import type { AppHost, ViewportLayout, ViewState } from '../app/AppHost';
import { curvePoints, SNAP_LABEL, type SnapKind } from '../core/entities/geometry';
import type { DrawingSheet } from '../core/document/Document';
import { useHost, useInteraction } from './context';
import { Icon } from './icons';

/** Éléments de la barre d'état que l'on peut masquer (menu ☰ « Personnalisation »). */
export const STATUS_ITEMS: { id: string; label: string }[] = [
  { id: 'coords', label: 'Coordonnées' },
  { id: 'layouts', label: 'Onglets Objet / mises en plan' },
  { id: 'grid', label: 'Grille' },
  { id: 'snap', label: 'Résolution' },
  { id: 'ortho', label: 'Ortho' },
  { id: 'polar', label: 'Repérage polaire' },
  { id: 'osnap', label: 'Accrochage aux objets' },
  { id: 'infer', label: 'Repérage et inférences' },
  { id: 'gizmo', label: 'Manipulateur 3D' },
  { id: 'dyn', label: 'Saisie dynamique' },
  { id: 'lwt', label: 'Épaisseurs de ligne' },
  { id: 'showConstraints', label: 'Contraintes' },
  { id: 'vports', label: 'Fenêtres de vue' },
  { id: 'kernel', label: 'État du noyau 3D' },
  { id: 'clean', label: 'Écran épuré' },
];

export const LAYOUT_LABEL: Record<ViewportLayout, string> = { '1': 'Une fenêtre', '2v': 'Deux, côte à côte', '2h': 'Deux, l’une sur l’autre', '3': 'Trois (grande à gauche)', '4': 'Quatre' };

/** Points d'une mise en plan (cadre et vues) pour la cadrer. */
function sheetPoints(app: AppHost, sh: DrawingSheet) {
  const hs = [...sh.frame, ...sh.views.flatMap((v) => v.handles)];
  return hs.flatMap((h) => {
    const e = app.doc.get(h);
    return e ? curvePoints(e).flat() : [];
  });
}

/**
 * Onglets « Objet » et mises en plan (comme Model / Layout) : une mise en plan est dessinée à
 * l'échelle dans le plan XY ; son onglet la cadre en vue de dessus. « Objet » revient à la vue
 * de modélisation, « + » crée une mise en plan.
 */
function LayoutTabs() {
  const app = useHost(['doc', 'tabs']);
  const [sheet, setSheet] = useState<string | null>(null);
  const modelView = useRef<ViewState | null>(null);
  const tabId = app.tab.id;
  useEffect(() => {
    setSheet(null);
    modelView.current = null;
  }, [tabId]);
  const sheets = app.doc.sheets;
  const current = sheet && sheets.some((s) => s.id === sheet) ? sheet : null;
  const goModel = () => {
    if (!current) return;
    setSheet(null);
    if (modelView.current) app.viewport?.setViewState(modelView.current);
    modelView.current = null;
  };
  const goSheet = (sh: DrawingSheet) => {
    if (!current && app.viewport) modelView.current = app.viewport.getViewState();
    setSheet(sh.id);
    if (app.settings.workspace === '3d') app.viewport?.setView('TOP');
    const pts = sheetPoints(app, sh);
    setTimeout(() => (pts.length ? app.viewport?.zoomToPoints(pts) : undefined), app.settings.workspace === '3d' ? 380 : 0);
  };
  return (
    <div className="sb-layouts">
      <button className={`sb-tab ${current ? '' : 'on'}`} title="Espace objet (modélisation)" onClick={goModel}>
        Objet
      </button>
      {sheets.map((sh) => (
        <button key={sh.id} className={`sb-tab ${current === sh.id ? 'on' : ''}`} title={`Mise en plan « ${sh.name} »${sh.format ? ` (${sh.format})` : ''} : cadrer en vue de dessus`} onClick={() => goSheet(sh)}>
          {sh.name}
        </button>
      ))}
      <button className="sb-tab sb-tab-add" title="Nouvelle mise en plan (MISEENPLAN)" onClick={() => app.run('MISEENPLAN')}>
        <Icon name="plus" size={12} />
      </button>
    </div>
  );
}

const MODES: SnapKind[] = ['END', 'MID', 'CEN', 'QUA', 'INT', 'NOD', 'INS', 'PER', 'TAN', 'NEA'];
const POLAR = [5, 10, 15, 18, 22.5, 30, 45, 90];

function Popup({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    setTimeout(() => window.addEventListener('mousedown', h), 0);
    return () => window.removeEventListener('mousedown', h);
  }, [onClose]);
  return (
    <div className="sb-popup" ref={ref}>
      {children}
    </div>
  );
}

const STEPS = [0.1, 0.5, 1, 2, 5, 10, 25, 50, 100];

/** Choix d'un pas : 0 (automatique), valeurs courantes ou valeur libre. */
function StepChoice({ value, auto, onChange }: { value: number; auto: string; onChange: (v: number) => void }) {
  const [free, setFree] = useState(value > 0 && !STEPS.includes(value) ? String(value) : '');
  return (
    <div className="sb-steps">
      <label>
        <input type="radio" checked={value === 0} onChange={() => onChange(0)} />
        {auto}
      </label>
      <div className="sb-step-row">
        {STEPS.map((v) => (
          <button key={v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
            {String(v).replace('.', ',')}
          </button>
        ))}
        <input
          className="sb-step-free"
          placeholder="autre"
          value={free}
          onChange={(e) => setFree(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const v = parseFloat(free.replace(',', '.'));
            if (v > 0) onChange(v);
          }}
        />
      </div>
    </div>
  );
}

export function StatusBar() {
  const app = useHost(['settings', 'cursor', 'kernel', 'constraints', 'selection', 'doc']);
  const it = useInteraction();
  const [pop, setPop] = useState<null | 'osnap' | 'polar' | 'vports' | 'custom' | 'grid' | 'dyn'>(null);
  const s = app.settings;
  const shown = (id: string) => !s.statusHidden.includes(id);
  const w = app.cursor.world;
  const k = app.kernel;
  const toggle = (key: Parameters<typeof app.toggle>[0], label: string, title: string, menu?: 'osnap' | 'polar' | 'grid' | 'dyn') =>
    shown(key) && (
    <div className="sb-group">
      <button className={`sb-toggle ${s[key] ? 'on' : ''}`} onClick={() => app.toggle(key)} title={title}>
        {label}
      </button>
      {menu && (
        <button className="sb-drop" onClick={() => setPop(pop === menu ? null : menu)} title="Paramètres">
          ▾
        </button>
      )}
    </div>
  );
  const kernelText = k.status === 'ready' ? (k.busy > 0 ? 'Noyau 3D : calcul…' : 'Noyau 3D prêt') : k.status === 'loading' ? 'Noyau 3D : chargement…' : k.status === 'idle' ? 'Noyau 3D en veille' : 'Noyau 3D indisponible';
  return (
    <div className="statusbar">
      <div className="sb-left">
        {shown('layouts') && <LayoutTabs />}
        {shown('coords') && <span className="sb-coords">{w ? `${w.x.toFixed(4)}, ${w.y.toFixed(4)}, ${w.z.toFixed(4)}` : '—'}</span>}
        {app.processor.elevation !== 0 && (
          <span className="sb-elev" title="Plan de travail surélevé (ELEV, ESQUISSE > Sol pour revenir à 0)" onClick={() => app.run('ELEV')}>
            Plan Z = {Number(app.processor.elevation.toFixed(4))}
          </span>
        )}
        {app.selection.size > 0 && <span className="sb-sel">{app.selection.size} sélectionné(s)</span>}
        {it?.navMode && <span className="sb-nav">{it.navMode === 'orbit' ? 'ORBITE' : 'PANORAMIQUE'} — Échap pour quitter</span>}
      </div>
      <div className="sb-right">
        {toggle('grid', s.gridUnit > 0 ? `GRILLE ${s.gridUnit}` : 'GRILLE', 'Grille (F7) ; ▾ : pas de la grille et de la résolution', 'grid')}
        {toggle('snap', s.snap && (s.snapUnit || s.gridUnit) ? `RESOL ${s.snapUnit || s.gridUnit}` : 'RESOL', 'Accrochage à la grille (F9)')}
        {toggle('ortho', 'ORTHO', 'Mode orthogonal (F8)')}
        {toggle('polar', `POLAIRE ${s.polarIncrement}°`, 'Repérage polaire (F10)', 'polar')}
        {toggle('osnap', 'ACCROBJ', 'Accrochage aux objets (F3)', 'osnap')}
        {toggle('infer', 'REPOBJ', 'Repérage et inférences (F11) : axes X/Y/Z en couleur, alignements sur les points accrochés, accrochage sur les faces en 3D')}
        {app.settings.workspace === '3d' && toggle('gizmo', 'GIZMO', 'Manipulateur 3D : flèches (déplacer) et anneaux (pivoter) sur la sélection')}
        {toggle('dyn', 'DYN', 'Saisie dynamique (F12) : tapez la longueur, Tab, l’angle (ou largeur Tab hauteur)', 'dyn')}
        {toggle('lwt', 'EP', 'Afficher les épaisseurs de ligne')}
        {toggle('showConstraints', 'CONTR', 'Afficher les contraintes')}
        {app.doc.constraints.length > 0 && <span className={`sb-dof ${app.constraintStatus.ok ? '' : 'bad'}`}>{app.constraintStatus.ok ? `DDL ${app.constraintStatus.dof}` : 'Conflit'}</span>}
        {shown('vports') && (
          <div className="sb-group">
            <button className={`sb-icon ${s.viewports !== '1' ? 'on' : ''}`} title={`Fenêtres de vue : ${LAYOUT_LABEL[s.viewports]} (FENETRES)`} onClick={() => setPop(pop === 'vports' ? null : 'vports')}>
              <Icon name={`vports-${s.viewports}`} size={17} />
            </button>
          </div>
        )}
        {shown('kernel') && (
          <span className={`sb-kernel ${k.status}`} title="OpenCascade (WebAssembly)">
            <i />
            {kernelText}
          </span>
        )}
        {app.kernelBusy && (
          <button className="sb-stop" title="Arrêter le calcul 3D en cours (Échap) : le noyau est relancé et les solides rechargés" onClick={() => void app.interruptKernel(true)}>
            ■ Arrêter
          </button>
        )}
        {shown('clean') && (
          <button className={`sb-icon ${app.cleanScreen ? 'on' : ''}`} title="Écran épuré : masque le ruban et les onglets (Ctrl+0)" onClick={() => app.toggleCleanScreen()}>
            <Icon name="fullscreen" size={16} />
          </button>
        )}
        <button className="sb-icon" title="Personnaliser la barre d’état" onClick={() => setPop(pop === 'custom' ? null : 'custom')}>
          <Icon name="menu" size={16} />
        </button>
      </div>
      {pop === 'vports' && (
        <Popup onClose={() => setPop(null)}>
          <div className="sb-popup-title">Fenêtres de vue</div>
          {(Object.keys(LAYOUT_LABEL) as ViewportLayout[]).map((l) => (
            <label key={l} className="sb-vp-choice">
              <input type="radio" checked={s.viewports === l} onChange={() => (app.set('viewports', l), setPop(null))} />
              <Icon name={`vports-${l}`} size={18} />
              {LAYOUT_LABEL[l]}
            </label>
          ))}
        </Popup>
      )}
      {pop === 'custom' && (
        <Popup onClose={() => setPop(null)}>
          <div className="sb-popup-title">Personnalisation de la barre d’état</div>
          {STATUS_ITEMS.map((it) => (
            <label key={it.id}>
              <input type="checkbox" checked={shown(it.id)} onChange={() => app.set('statusHidden', shown(it.id) ? [...s.statusHidden, it.id] : s.statusHidden.filter((x) => x !== it.id))} />
              {it.label}
            </label>
          ))}
          <div className="sb-popup-row">
            <button onClick={() => app.set('statusHidden', [])}>Tout afficher</button>
            <button onClick={() => app.set('fileTabs', !s.fileTabs)}>{s.fileTabs ? 'Masquer' : 'Afficher'} les onglets des dessins</button>
          </div>
        </Popup>
      )}
      {pop === 'osnap' && (
        <Popup onClose={() => setPop(null)}>
          <div className="sb-popup-title">Accrochage aux objets</div>
          {MODES.map((m) => {
            const on = s.osnapModes.includes(m);
            return (
              <label key={m}>
                <input type="checkbox" checked={on} onChange={() => app.set('osnapModes', on ? s.osnapModes.filter((x) => x !== m) : [...s.osnapModes, m])} />
                {SNAP_LABEL[m]}
              </label>
            );
          })}
          <div className="sb-popup-row">
            <button onClick={() => app.set('osnapModes', MODES.filter((m) => m !== 'NEA'))}>Tous</button>
            <button onClick={() => app.set('osnapModes', [])}>Aucun</button>
          </div>
        </Popup>
      )}
      {pop === 'grid' && (
        <Popup onClose={() => setPop(null)}>
          <div className="sb-popup-title">Pas de la grille</div>
          <StepChoice value={s.gridUnit} auto="Adaptatif (suit le zoom)" onChange={(v) => app.set('gridUnit', v)} />
          <div className="sb-popup-title">Pas de la résolution (F9)</div>
          <StepChoice value={s.snapUnit} auto="Comme la grille" onChange={(v) => (app.set('snapUnit', v), s.snap || app.toggle('snap'))} />
        </Popup>
      )}
      {pop === 'dyn' && (
        <Popup onClose={() => setPop(null)}>
          <div className="sb-popup-title">Saisie dynamique</div>
          <label>
            <input type="radio" checked={s.dynRelative} onChange={() => app.set('dynRelative', true)} />
            Coordonnées relatives (# pour l’absolu)
          </label>
          <label>
            <input type="radio" checked={!s.dynRelative} onChange={() => app.set('dynRelative', false)} />
            Coordonnées absolues (@ pour le relatif)
          </label>
          <div className="sb-popup-note">Tab passe de la longueur à l’angle, ou de la largeur à la hauteur.</div>
        </Popup>
      )}
      {pop === 'polar' && (
        <Popup onClose={() => setPop(null)}>
          <div className="sb-popup-title">Incrément polaire</div>
          {POLAR.map((p) => (
            <label key={p}>
              <input type="radio" checked={s.polarIncrement === p} onChange={() => (app.set('polarIncrement', p), app.set('polar', true))} />
              {p}°
            </label>
          ))}
        </Popup>
      )}
    </div>
  );
}
