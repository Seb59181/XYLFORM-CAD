/**
 * Cube de vue et barre de navigation, en haut à droite du viewport 3D.
 *   - clic sur une face, une arête ou un coin du cube : vue dans cette direction (26 vues) ;
 *   - glisser le cube : orbite libre autour de la cible (Z reste vers le haut) ;
 *   - maison : vue isométrique et zoom étendu.
 * Le cube est en CSS 3D, orienté à chaque image d'après la caméra (aucun second rendu WebGL).
 */
import { useEffect, useRef } from 'react';
import type { CadViewport } from '../render/CadViewport';
import { useHost, useInteraction } from './context';
import { Icon } from './icons';

type V = [number, number, number];
interface Face {
  id: string;
  label: string;
  /** Normale extérieure, droite et bas de la face vue de l'extérieur. */
  n: V;
  r: V;
  d: V;
}

const FACES: Face[] = [
  { id: 'top', label: 'HAUT', n: [0, 0, 1], r: [1, 0, 0], d: [0, -1, 0] },
  { id: 'bottom', label: 'BAS', n: [0, 0, -1], r: [1, 0, 0], d: [0, 1, 0] },
  { id: 'front', label: 'AVANT', n: [0, -1, 0], r: [1, 0, 0], d: [0, 0, -1] },
  { id: 'back', label: 'ARRIÈRE', n: [0, 1, 0], r: [-1, 0, 0], d: [0, 0, -1] },
  { id: 'right', label: 'DROITE', n: [1, 0, 0], r: [0, 1, 0], d: [0, 0, -1] },
  { id: 'left', label: 'GAUCHE', n: [-1, 0, 0], r: [0, -1, 0], d: [0, 0, -1] },
];

const SIZE = 64;
const CELLS = [-1, 0, 1] as const;

const faceTransform = ({ n, r, d }: Face) => {
  const h = SIZE / 2;
  return `matrix3d(${r[0]},${r[1]},${r[2]},0,${d[0]},${d[1]},${d[2]},0,${n[0]},${n[1]},${n[2]},0,${n[0] * h},${n[1] * h},${n[2] * h},1)`;
};

export function NavCube({ vp, onViewChanged }: { vp: CadViewport; onViewChanged: () => void }) {
  const cube = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);

  useEffect(() => {
    const update = () => {
      const el = cube.current;
      if (!el) return;
      // repère monde → écran CSS (y vers le bas) : rotation de la caméra, axe Y inversé
      const e = vp.activeCamera.matrixWorldInverse.elements;
      el.style.transform = `matrix3d(${e[0]},${-e[1]!},${e[2]},0,${e[4]},${-e[5]!},${e[6]},0,${e[8]},${-e[9]!},${e[10]},0,0,0,0,1)`;
    };
    vp.afterRender.add(update);
    vp.requestRender();
    return () => void vp.afterRender.delete(update);
  }, [vp]);

  const go = (f: Face, i: number, j: number) => {
    if (drag.current?.moved) return;
    vp.lookFrom({ x: f.n[0] + i * f.r[0] + j * f.d[0], y: f.n[1] + i * f.r[1] + j * f.d[1], z: f.n[2] + i * f.r[2] + j * f.d[2] });
    setTimeout(onViewChanged, 400);
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 3) return;
    if (!d.moved) (e.currentTarget as HTMLElement).setPointerCapture(d.id);
    d.moved = true;
    d.x = e.clientX;
    d.y = e.clientY;
    vp.orbitBy(dx * 0.012, dy * 0.012);
  };
  const onUp = () => {
    const d = drag.current;
    if (d?.moved) onViewChanged();
    // le clic qui suit un glissé ne doit pas changer de vue
    setTimeout(() => (drag.current = null), 0);
  };

  const home = () => {
    vp.zoomExtents();
    vp.setView('SWISO');
    setTimeout(onViewChanged, 400);
  };

  return (
    <div className="vc" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onContextMenu={(e) => e.preventDefault()}>
      <button className="vc-home" title="Vue d’accueil (isométrique, zoom étendu)" onPointerDown={(e) => e.stopPropagation()} onClick={home}>
        <Icon name="home" size={16} />
      </button>
      <div className="vc-cube" ref={cube}>
        {FACES.map((f) => (
          <div key={f.id} className={`vc-face vc-${f.id}`} style={{ transform: faceTransform(f) }}>
            {CELLS.flatMap((j) =>
              CELLS.map((i) => (
                <div key={`${i},${j}`} className={`vc-cell ${i === 0 && j === 0 ? 'vc-center' : ''}`} onClick={() => go(f, i, j)} />
              )),
            )}
            <span className="vc-label">{f.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Barre de navigation verticale sous le cube de vue (orbite, panoramique, zooms, coupe, navigateur). */
export function NavBar() {
  const app = useHost(['settings']);
  const it = useInteraction();
  const is3d = app.settings.workspace === '3d';
  const btn = (icon: string, title: string, onClick: () => void, on = false) => (
    <button key={icon} className={on ? 'on' : ''} title={title} onPointerDown={(e) => e.stopPropagation()} onClick={onClick}>
      <Icon name={icon} size={20} />
    </button>
  );
  return (
    <div className="vc-nav" onContextMenu={(e) => e.preventDefault()}>
      {is3d && btn('orbit', 'Orbite (ou Maj + molette enfoncée)', () => it?.setNavMode(it.navMode === 'orbit' ? null : 'orbit'), it?.navMode === 'orbit')}
      {btn('pan', 'Panoramique (ou molette enfoncée)', () => it?.setNavMode(it.navMode === 'pan' ? null : 'pan'), it?.navMode === 'pan')}
      {btn('zoom-ext', 'Zoom étendu (double-clic molette)', () => app.viewport?.zoomExtents())}
      {btn('zoom-win', 'Zoom fenêtre', () => app.runSequence(['ZOOM', 'F']))}
      {is3d && btn('section', 'Analyse de coupe (ANALYSECOUPE)', () => (app.viewport?.section ? app.viewport.setSection(null) : app.run('ANALYSECOUPE')), !!app.viewport?.section)}
      {is3d && btn('browser', 'Navigateur : corps, esquisses, fonds de plan', () => app.showPanel('browser'), app.settings.panel === 'browser')}
    </div>
  );
}
