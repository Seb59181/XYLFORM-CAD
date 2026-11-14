/**
 * Viewport 3D : scène, interaction, curseur en croix, marqueurs d'accrochage, fenêtre de sélection,
 * saisie dynamique au curseur et commandes de fenêtre « [-][Vue][Style] » en haut à gauche.
 */
import { useContext, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Interaction } from '../app/Interaction';
import { restoreNamedView, saveNamedView, STYLE_LABEL, VIEW_LABEL } from '../app/commands/utility';
import { openDroppedFile } from '../app/commands/files';
import type { SnapKind } from '../core/entities/geometry';
import { promptAxis } from '../core/commands/types';
import { dynLayout, splitDyn } from '../core/commands/dynInput';
import { CadViewport, type StandardView } from '../render/CadViewport';
import { SceneSync } from '../render/SceneSync';
import type { ViewportLayout, VisualStyle } from '../app/AppHost';
import { AuxViewport } from './AuxViewport';
import { CommandLine, PromptText } from './CommandLine';
import { InteractionContext, useApp, useHost, useInteraction } from './context';
import { NavBar, NavCube } from './NavCube';

const DIRS: Record<StandardView, [number, number, number]> = {
  TOP: [0, 0, 1],
  BOTTOM: [0, 0, -1],
  FRONT: [0, -1, 0],
  BACK: [0, 1, 0],
  LEFT: [-1, 0, 0],
  RIGHT: [1, 0, 0],
  SWISO: [-1, -1, 1],
  SEISO: [1, -1, 1],
  NEISO: [1, 1, 1],
  NWISO: [-1, 1, 1],
};

export function Viewport() {
  const app = useApp();
  const holder = useContext(InteractionContext);
  const ref = useRef<HTMLDivElement>(null);
  const [vpObj, setVp] = useState<CadViewport | null>(null);
  const ready = !!vpObj;
  const detectRef = useRef<() => void>(() => undefined);
  const ws = useHost(['settings']).settings.workspace;
  const [viewName, setViewName] = useState<string>(VIEW_LABEL.SWISO);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    const el = ref.current!;
    const is2d = app.settings.workspace === '2d';
    const vp = new CadViewport(el, { projection: is2d ? 'orthographic' : app.settings.projection });
    if (is2d) vp.setWorkspace('2d', app.settings.projection, false);
    const scene = new SceneSync(app, vp);
    const it = new Interaction(app, vp, scene);
    vp.grid.visible = app.settings.grid;
    vp.setGridUnit(app.settings.gridUnit);
    const v3 = (p: { x: number; y: number; z: number }) => new THREE.Vector3(p.x, p.y, p.z);
    const detectView = () => {
      const dir = new THREE.Vector3().subVectors(vp.activeCamera.position, vp.controls.target).normalize();
      const found = (Object.keys(DIRS) as StandardView[]).find((k) => new THREE.Vector3(...DIRS[k]).normalize().dot(dir) > 0.9995);
      setViewName(found ? VIEW_LABEL[found] : 'Personnalisée');
    };
    detectRef.current = detectView;
    vp.controls.addEventListener('end', detectView);
    app.viewport = {
      zoomExtents: () => vp.zoomExtents(),
      zoomWindow: (a, b) => vp.zoomWindow(v3(a), v3(b)),
      zoomToPoints: (pts) => vp.zoomToPoints(pts),
      zoomFactor: (f) => vp.zoomFactor(f),
      setView: (v) => {
        // vue 3D demandée depuis l'espace 2D : on passe en 3D
        if (v !== 'TOP' && app.settings.workspace === '2d') app.set('workspace', '3d');
        vp.setView(v);
        setViewName(VIEW_LABEL[v]);
      },
      setProjection: (p) => vp.setProjection(p),
      setWorkspace: (w) => {
        vp.setWorkspace(w, app.settings.projection);
        if (w === '2d') section = null;
        setViewName(VIEW_LABEL[w === '2d' ? 'TOP' : 'SWISO']);
      },
      setSection: (sec, live) => {
        vp.setSection(sec ? new THREE.Plane().setFromNormalAndCoplanarPoint(v3(sec.normal).normalize(), v3(sec.origin)) : null);
        if (live) return;
        section = sec;
        app.emit('settings');
      },
      setWorkPlane: (z) => vp.setUcs(new THREE.Matrix4().makeTranslation(0, 0, z)),
      setGridUnit: (step) => vp.setGridUnit(step),
      viewDirection: () => {
        const d = new THREE.Vector3().subVectors(vp.activeCamera.position, vp.controls.target).normalize();
        return { x: d.x, y: d.y, z: d.z };
      },
      get section() {
        return section;
      },
      screenshot: () => vp.screenshot(),
      renderImage: (w, h, bg, ss) => vp.renderImage(w, h, bg, ss),
      viewSize: () => vp.viewSize,
      worldUnitsPerPixel: () => vp.worldUnitsPerPixel(),
      setLiveTransform: (handles, m) =>
        scene.setLiveTransform(handles, m ? new THREE.Matrix4().set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1) : null),
      redraw: () => vp.requestRender(),
      rebuild: () => scene.rebuild(),
      getViewState: () => vp.getViewState(),
      homeView: () => {
        vp.setView(app.settings.workspace === '2d' ? 'TOP' : 'SWISO', false);
        vp.frameBox(new THREE.Box3(new THREE.Vector3(-20, -20, 0), new THREE.Vector3(180, 120, 0)), 1);
        detectView();
      },
      setViewState: (v) => {
        vp.setViewState(v);
        detectView();
      },
      transitionTo: (v, ms) => vp.transitionTo(v, ms).then(detectView),
      container: vp.container,
      canvas: vp.canvas,
      renderFrame: () => vp.renderFrame(),
      setAnalysis: (layers) => {
        if (analysis) {
          vp.scene.remove(analysis);
          analysis.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.geometry.dispose();
              (o.material as THREE.Material).dispose();
            }
          });
          analysis = null;
        }
        if (layers?.length) {
          analysis = new THREE.Group();
          analysis.name = 'analyse-impression';
          for (const l of layers) {
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.BufferAttribute(l.positions, 3));
            g.setAttribute('color', new THREE.BufferAttribute(l.colors, 3));
            const m = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, depthWrite: false });
            analysis.add(new THREE.Mesh(g, m));
          }
          vp.scene.add(analysis);
        }
        vp.requestRender();
      },
    };
    setTimeout(() => app.syncSection(true), 0);
    let analysis: THREE.Group | null = null;
    let section: { origin: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } } | null = null;
    const offSettings = app.on('settings', () => {
      vp.grid.visible = app.settings.grid;
      vp.requestRender();
    });
    vp.renderer.domElement.style.cursor = 'none';
    vp.renderer.domElement.tabIndex = -1;
    // accès de débogage / tests automatisés en développement
    if (import.meta.env.DEV) Object.assign(window, { __sebcadViewport: vp, __sebcadInteraction: it });
    holder.current = it;
    holder.listeners.forEach((f) => f());
    setVp(vp);
    // zoom initial confortable sur une zone de travail de 200 mm
    vp.frameBox(new THREE.Box3(new THREE.Vector3(-20, -20, 0), new THREE.Vector3(180, 120, 0)), 1);
    return () => {
      offSettings();
      vp.controls.removeEventListener('end', detectView);
      it.dispose();
      scene.dispose();
      vp.dispose();
      app.viewport = null;
      holder.current = null;
    };
  }, [app, holder]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files[0];
    if (f) void openDroppedFile(app, f);
  };

  const layout = useHost(['settings']).settings.viewports;
  const aux = AUX_AREAS[layout];
  return (
    <div className={`vp-area layout-${layout}`} onDragOver={(e) => (e.preventDefault(), setDrag(true))} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
      <div className={`viewport ${drag ? 'drop' : ''} ${aux.length ? 'active-pane' : ''}`} ref={ref} style={{ gridArea: 'main' }}>
        {ready && <Overlay />}
        {ready && <ViewportControls viewName={viewName} />}
        {vpObj && ws === '3d' && <NavCube vp={vpObj} onViewChanged={() => detectRef.current()} />}
        {ready && <NavBar />}
        {ready && <DynamicInput />}
      </div>
      {vpObj && aux.map((area, i) => <AuxViewport key={`${layout}-${i}`} vp={vpObj} index={i} area={area} />)}
      <CommandLine />
      {drag && <div className="drop-hint">Déposez un dessin (.xcad, .dwg, .dxf, .step), un modèle 3D (.stl, .3mf) ou un fond de plan (.pdf, image)</div>}
    </div>
  );
}

/** Zones de grille des fenêtres secondaires pour chaque disposition. */
const AUX_AREAS: Record<ViewportLayout, string[]> = { '1': [], '2v': ['a1'], '2h': ['a1'], '3': ['a1', 'a2'], '4': ['a1', 'a2', 'a3'] };

// ---------------------------------------------------------------------------

function Marker({ kind, x, y }: { kind: SnapKind; x: number; y: number }) {
  const s = 7;
  const common = { fill: 'none', stroke: '#ffd400', strokeWidth: 2 };
  switch (kind) {
    case 'END':
      return <rect x={x - s} y={y - s} width={2 * s} height={2 * s} {...common} />;
    case 'MID':
      return <path d={`M${x} ${y - s - 1}L${x + s + 1} ${y + s}H${x - s - 1}Z`} {...common} />;
    case 'CEN':
      return <circle cx={x} cy={y} r={s} {...common} />;
    case 'QUA':
      return <path d={`M${x} ${y - s - 1}L${x + s + 1} ${y}L${x} ${y + s + 1}L${x - s - 1} ${y}Z`} {...common} />;
    case 'INT':
      return <path d={`M${x - s} ${y - s}L${x + s} ${y + s}M${x + s} ${y - s}L${x - s} ${y + s}`} {...common} />;
    case 'NOD':
      return (
        <g {...common}>
          <circle cx={x} cy={y} r={s} />
          <path d={`M${x - 5} ${y - 5}L${x + 5} ${y + 5}M${x + 5} ${y - 5}L${x - 5} ${y + 5}`} />
        </g>
      );
    case 'INS':
      return <path d={`M${x - s} ${y - s}H${x + 2}V${y}H${x + s}V${y + s}H${x - 2}V${y}H${x - s}Z`} {...common} />;
    case 'PER':
      return <path d={`M${x - s} ${y - s}V${y + s}H${x + s}M${x - s} ${y}H${x}V${y + s}`} {...common} />;
    case 'TAN':
      return (
        <g {...common}>
          <circle cx={x} cy={y} r={s - 1} />
          <path d={`M${x - s - 2} ${y - s}H${x + s + 2}`} />
        </g>
      );
    case 'NEA':
      return <path d={`M${x - s} ${y - s}H${x + s}L${x - s} ${y + s}H${x + s}Z`} {...common} />;
    case 'EXT':
      return (
        <g {...common}>
          <path d={`M${x - s - 3} ${y + 1}H${x - 3}M${x} ${y + 1}H${x + 3}M${x + 6} ${y + 1}H${x + s + 3}`} />
        </g>
      );
    case 'PAR':
      return <path d={`M${x - s} ${y + 3}L${x - 1} ${y - s + 1}M${x + 1} ${y + s - 1}L${x + s} ${y - 3}`} {...common} />;
    case 'FACE':
      return <path d={`M${x - s} ${y + 3}L${x - 2} ${y - s + 1}L${x + s} ${y - 3}L${x + 2} ${y + s - 1}Z`} {...common} stroke="#4ea1ff" fill="rgba(78,161,255,0.25)" />;
  }
}

function Overlay() {
  const it = useInteraction();
  if (!it) return null;
  const st = it.state;
  const c = st.cursor;
  return (
    <svg className="vp-overlay">
      {st.box && (
        <rect
          x={Math.min(st.box.x0, st.box.x1)}
          y={Math.min(st.box.y0, st.box.y1)}
          width={Math.abs(st.box.x1 - st.box.x0)}
          height={Math.abs(st.box.y1 - st.box.y0)}
          fill={st.box.crossing ? 'rgba(63,185,80,0.16)' : 'rgba(31,111,235,0.18)'}
          stroke={st.box.crossing ? '#3fb950' : '#4ea1ff'}
          strokeDasharray={st.box.crossing ? '6 4' : undefined}
          strokeWidth={1}
        />
      )}
      {c && st.crosshair && (
        <g stroke="#e6edf3" strokeWidth={1} shapeRendering="crispEdges">
          <path d={`M${c.x - 2000} ${c.y + 0.5}H${c.x - (st.pickbox ? 6 : 0)}M${c.x + (st.pickbox ? 6 : 0)} ${c.y + 0.5}H${c.x + 2000}`} strokeOpacity={0.85} />
          <path d={`M${c.x + 0.5} ${c.y - 2000}V${c.y - (st.pickbox ? 6 : 0)}M${c.x + 0.5} ${c.y + (st.pickbox ? 6 : 0)}V${c.y + 2000}`} strokeOpacity={0.85} />
          {st.pickbox && <rect x={c.x - 5.5} y={c.y - 5.5} width={11} height={11} fill="none" />}
        </g>
      )}
      {st.guides.map((g, i) => (
        <line key={`g${i}`} x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={g.color} strokeWidth={g.dashed ? 1 : 1.6} strokeDasharray={g.dashed ? '5 4' : undefined} strokeOpacity={0.95} />
      ))}
      {st.acquired.map((a, i) => (
        <path key={`a${i}`} d={`M${a.x - 4} ${a.y}H${a.x + 4}M${a.x} ${a.y - 4}V${a.y + 4}`} stroke="#3fb950" strokeWidth={1.5} />
      ))}
      {st.marker && (
        <g>
          <Marker kind={st.marker.kind} x={st.marker.x} y={st.marker.y} />
          <g transform={`translate(${st.marker.x + 14} ${st.marker.y + 18})`}>
            <rect x={0} y={-12} width={st.marker.label.length * 7 + 12} height={18} rx={3} fill="#1c2128" stroke="#ffd400" strokeOpacity={0.5} />
            <text x={6} y={1} fill="#ffd400" fontSize={12}>
              {st.marker.label}
            </text>
          </g>
        </g>
      )}
      {st.tip && c && (
        <g transform={`translate(${c.x + 16} ${c.y - 28})`}>
          <rect x={0} y={-13} width={st.tip.length * 6.6 + 14} height={19} rx={3} fill="#1c2128" stroke="#3fb950" strokeOpacity={0.6} />
          <text x={7} y={1} fill="#c9d1d9" fontSize={12}>
            {st.tip}
          </text>
        </g>
      )}
    </svg>
  );
}

/** Saisie dynamique : invite et valeur tapée près du curseur. */
function DynamicInput() {
  const app = useHost(['prompt', 'input', 'cursor', 'settings']);
  const it = useInteraction();
  const spec = app.activeSpec;
  const c = it?.state.cursor;
  if (!app.settings.dyn || !c || !spec || it?.navMode) return null;
  const base = spec.basePoint;
  const w = app.cursor.world;
  let measure = '';
  if (base && w && (spec.kind === 'point' || spec.kind === 'distance')) {
    const dx = w.x - base.x, dy = w.y - base.y, dz = w.z - base.z;
    const u = promptAxis(spec);
    const L = u ? dx * u.x + dy * u.y + dz * u.z : Math.hypot(dx, dy, dz);
    const ang = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    measure = u ? `${L.toFixed(3)}` : `${L.toFixed(3)} < ${ang.toFixed(1)}°`;
  } else if (!base && w && spec.kind === 'point') measure = `${w.x.toFixed(3)}, ${w.y.toFixed(3)}`;
  // deux cases (Longueur Tab Angle, X Tab Y) : la case tapée est figée, l'autre suit le curseur
  const layout = dynLayout(spec, app.settings.dynRelative);
  const parts = layout ? splitDyn(app.input, layout.mode) : null;
  if (layout && w && (!app.input || parts)) {
    let live: [string, string];
    if (layout.mode === 'polar') {
      const b = layout.base!;
      live = [Math.hypot(w.x - b.x, w.y - b.y, w.z - b.z).toFixed(3), `${(((Math.atan2(w.y - b.y, w.x - b.x) * 180) / Math.PI + 360) % 360).toFixed(1)}°`];
    } else {
      const o = layout.base ?? { x: 0, y: 0 };
      live = [(w.x - o.x).toFixed(3), (w.y - o.y).toFixed(3)];
    }
    const active = parts?.active ?? 0;
    const typed = parts?.fields ?? ['', ''];
    return (
      <div className="dyn" style={{ left: c.x + 22, top: c.y + 22 }}>
        <div className="dyn-prompt">
          <PromptText text={spec.message + (spec.keywords?.length ? ` [${spec.keywords.map((k) => k.local).join('/')}]` : '')} keywords={spec.keywords} onKeyword={(k) => app.processor.submit(k)} />
        </div>
        <div className="dyn-row dyn-fields">
          {[0, 1].map((i) => (
            <span key={i} className={`dyn-field ${i === active ? 'active' : ''} ${typed[i] ? 'typed' : ''}`} title={layout.labels[i]}>
              <small>{layout.labels[i]}</small>
              {typed[i] || live[i]}
              {i === active && <i className="dyn-caret" />}
            </span>
          ))}
          <span className="dyn-hint">Tab</span>
        </div>
      </div>
    );
  }
  return (
    <div className="dyn" style={{ left: c.x + 22, top: c.y + 22 }}>
      <div className="dyn-prompt">
        <PromptText text={spec.message + (spec.keywords?.length ? ` [${spec.keywords.map((k) => k.local).join('/')}]` : '')} keywords={spec.keywords} onKeyword={(k) => app.processor.submit(k)} />
      </div>
      <div className="dyn-row">
        {app.input ? <span className="dyn-value">{app.input}</span> : measure && <span className="dyn-measure">{measure}</span>}
      </div>
    </div>
  );
}

function ViewportControls({ viewName }: { viewName: string }) {
  const app = useHost(['settings', 'doc']);
  const [menu, setMenu] = useState<null | 'main' | 'view' | 'style'>(null);
  useEffect(() => {
    if (!menu) return;
    const h = () => setMenu(null);
    setTimeout(() => window.addEventListener('mousedown', h), 0);
    return () => window.removeEventListener('mousedown', h);
  }, [menu]);
  const item = (label: string, fn: () => void, on = false) => (
    <button key={label} className={on ? 'on' : ''} onMouseDown={(e) => e.stopPropagation()} onClick={() => (fn(), setMenu(null))}>
      {label}
    </button>
  );
  // vues nommées du dessin (VUESNOMMEES) : rappel en un clic, enregistrement de la vue courante
  const namedItems = () => (
    <>
      <div className="vp-menu-sep">Vues nommées</div>
      {app.doc.namedViews.map((v) => item(v.name, () => restoreNamedView(app, v.name)))}
      {item('Enregistrer la vue…', () => {
        let i = app.doc.namedViews.length + 1;
        while (app.doc.namedView(`Vue${i}`)) i++;
        void app.ui.prompt('Enregistrer la vue', `Vue${i}`, 'Nom de la vue').then((n) => n && saveNamedView(app, n) && app.ui.toast(`Vue « ${n.trim()} » enregistrée.`));
      })}
    </>
  );
  if (app.settings.workspace === '2d')
    return (
      <div className="vp-controls" onMouseDown={(e) => e.stopPropagation()}>
        <span onClick={() => setMenu(menu === 'main' ? null : 'main')}>[−]</span>
        <span title="Espace 2D : vue de dessus, sans orbite" onClick={() => setMenu(menu === 'main' ? null : 'main')}>
          [Plan 2D]
        </span>
        {menu === 'main' && (
          <div className="vp-menu">
            {item('Zoom étendu', () => app.viewport?.zoomExtents())}
            {item('Grille', () => app.toggle('grid'), app.settings.grid)}
            {item('Passer en 3D', () => app.set('workspace', '3d'))}
            {namedItems()}
          </div>
        )}
      </div>
    );
  return (
    <div className="vp-controls" onMouseDown={(e) => e.stopPropagation()}>
      <span onClick={() => setMenu(menu === 'main' ? null : 'main')}>[−]</span>
      <span onClick={() => setMenu(menu === 'view' ? null : 'view')}>[{viewName}]</span>
      <span onClick={() => setMenu(menu === 'style' ? null : 'style')}>[{STYLE_LABEL[app.settings.visualStyle]}]</span>
      {menu === 'main' && (
        <div className="vp-menu">
          {item('Zoom étendu', () => app.viewport?.zoomExtents())}
          {item('Perspective', () => app.set('projection', 'perspective'), app.settings.projection === 'perspective')}
          {item('Parallèle', () => app.set('projection', 'orthographic'), app.settings.projection === 'orthographic')}
          {item('Grille', () => app.toggle('grid'), app.settings.grid)}
          {item('Passer en 2D', () => app.set('workspace', '2d'))}
        </div>
      )}
      {menu === 'view' && (
        <div className="vp-menu">
          {(Object.keys(VIEW_LABEL) as StandardView[]).map((v) => item(VIEW_LABEL[v], () => app.viewport?.setView(v), VIEW_LABEL[v] === viewName))}
          {namedItems()}
        </div>
      )}
      {menu === 'style' && <div className="vp-menu">{(Object.keys(STYLE_LABEL) as VisualStyle[]).map((s) => item(STYLE_LABEL[s], () => app.set('visualStyle', s), s === app.settings.visualStyle))}</div>}
    </div>
  );
}
