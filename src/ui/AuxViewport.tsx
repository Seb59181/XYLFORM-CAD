/**
 * Fenêtres de vue secondaires (FENETRES) : la même scène vue sous un autre angle (Dessus, Face,
 * Droite, iso…), chacune avec son renderer WebGL et sa caméra. On y navigue librement (molette =
 * zoom, molette enfoncée = panoramique, bouton gauche glissé = orbite) ; un simple clic la rend
 * active : sa vue passe dans la fenêtre principale, où l'on dessine, et inversement.
 */
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { ViewState } from '../app/AppHost';
import { VIEW_LABEL } from '../app/commands/utility';
import { type CadViewport, VIEW_DIRECTIONS, type StandardView } from '../render/CadViewport';
import { useHost } from './context';

const FOV = 35;

/** Vue standard la plus proche d'une direction (cible → caméra), ou null. */
export function standardViewOf(dir: THREE.Vector3): StandardView | null {
  const d = dir.clone().normalize();
  return (Object.keys(VIEW_DIRECTIONS) as StandardView[]).find((k) => new THREE.Vector3(...VIEW_DIRECTIONS[k]).normalize().dot(d) > 0.9995) ?? null;
}

export function AuxViewport({ vp, index, area }: { vp: CadViewport; index: number; area: string }) {
  const app = useHost(['settings']);
  const ref = useRef<HTMLDivElement>(null);
  const api = useRef<{ fit(): void; look(v: StandardView): void; swap(): void } | null>(null);
  const [label, setLabel] = useState<string>(() => VIEW_LABEL[app.settings.viewportViews[index] ?? 'TOP']);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const el = ref.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.localClippingEnabled = true;
    renderer.domElement.style.display = 'block';
    el.appendChild(renderer.domElement);
    const persp = new THREE.PerspectiveCamera(FOV, 1, 0.01, 1e7);
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e7, 1e7);
    let cam: THREE.PerspectiveCamera | THREE.OrthographicCamera = ortho;
    const controls = new OrbitControls(cam, renderer.domElement);
    controls.zoomToCursor = true;
    controls.screenSpacePanning = true;
    controls.minDistance = 1e-3;
    controls.maxDistance = 1e10;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: null } as never;
    let w = 1, h = 1;
    let fitted = false;

    const size = () => {
      w = Math.max(1, el.clientWidth);
      h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      persp.aspect = w / h;
      persp.updateProjectionMatrix();
      const half = (ortho.top - ortho.bottom) / 2;
      Object.assign(ortho, { left: -half * (w / h), right: half * (w / h) });
      ortho.updateProjectionMatrix();
    };

    let pending = false;
    const render = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (!el.isConnected) return;
        vp.renderAux(renderer, cam, controls.target, w, h);
      });
    };

    const useCamera = (c: THREE.PerspectiveCamera | THREE.OrthographicCamera) => {
      cam = c;
      controls.object = c;
    };

    /** Oriente la caméra selon une vue standard, en gardant la cible et le cadrage. */
    const look = (v: StandardView, half?: number) => {
      const iso = v.endsWith('ISO');
      useCamera(iso && app.settings.projection === 'perspective' ? persp : ortho);
      const halfH = half ?? (ortho.top - ortho.bottom) / 2 / ortho.zoom;
      const dir = new THREE.Vector3(...VIEW_DIRECTIONS[v]).normalize();
      const t = controls.target;
      const d = cam === persp ? halfH / Math.tan(THREE.MathUtils.degToRad(FOV / 2)) : Math.max(halfH * 20, 100);
      cam.position.copy(t).addScaledVector(dir, d);
      cam.up.copy(Math.abs(dir.z) > 0.999 ? new THREE.Vector3(0, Math.sign(dir.z), 0) : new THREE.Vector3(0, 0, 1));
      cam.lookAt(t);
      Object.assign(ortho, { zoom: 1, left: -halfH * (w / h), right: halfH * (w / h), top: halfH, bottom: -halfH });
      ortho.updateProjectionMatrix();
      controls.update();
      setLabel(VIEW_LABEL[v]);
      render();
    };

    const fit = () => {
      const box = vp.modelBox();
      if (box.isEmpty()) box.set(new THREE.Vector3(-20, -20, 0), new THREE.Vector3(180, 120, 0));
      else fitted = true;
      const s = box.getBoundingSphere(new THREE.Sphere());
      controls.target.copy(s.center);
      const v = app.settings.viewportViews[index] ?? 'TOP';
      const dir = cam.position.clone().sub(controls.target);
      look(standardViewOf(dir) ?? v, Math.max(s.radius * 1.1, 1));
    };

    const state = (): ViewState => {
      const half = cam === ortho ? (ortho.top - ortho.bottom) / 2 / ortho.zoom : cam.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(FOV / 2));
      const v = (p: THREE.Vector3) => ({ x: p.x, y: p.y, z: p.z });
      return { projection: cam === ortho ? 'orthographic' : 'perspective', position: v(cam.position), target: v(controls.target), up: v(cam.up), halfHeight: half };
    };

    /** Échange cette vue avec celle de la fenêtre principale (fenêtre rendue active). */
    const swap = () => {
      if (!app.viewport) return;
      const mine = state();
      const main = app.viewport.getViewState();
      app.viewport.setViewState({ ...mine, projection: app.settings.projection });
      controls.target.set(main.target.x, main.target.y, main.target.z);
      const dir = new THREE.Vector3(main.position.x - main.target.x, main.position.y - main.target.y, main.position.z - main.target.z);
      const std = standardViewOf(dir);
      if (std && !std.endsWith('ISO')) {
        look(std, main.halfHeight);
      } else {
        useCamera(app.settings.projection === 'perspective' ? persp : ortho);
        cam.up.set(main.up.x, main.up.y, main.up.z);
        cam.position.copy(controls.target).addScaledVector(dir.normalize(), cam === persp ? main.halfHeight / Math.tan(THREE.MathUtils.degToRad(FOV / 2)) : Math.max(main.halfHeight * 20, 100));
        cam.lookAt(controls.target);
        Object.assign(ortho, { zoom: 1, left: -main.halfHeight * (w / h), right: main.halfHeight * (w / h), top: main.halfHeight, bottom: -main.halfHeight });
        ortho.updateProjectionMatrix();
        controls.update();
        setLabel(std ? VIEW_LABEL[std] : 'Personnalisée');
        render();
      }
      if (std) {
        const views = [...app.settings.viewportViews];
        views[index] = std;
        app.set('viewportViews', views);
      }
    };

    api.current = { fit, look: (v) => look(v), swap };
    size();
    fit();
    controls.addEventListener('change', render);
    controls.addEventListener('end', () => {
      const std = standardViewOf(cam.position.clone().sub(controls.target));
      setLabel(std ? VIEW_LABEL[std] : 'Personnalisée');
    });
    const ro = new ResizeObserver(() => (size(), render()));
    ro.observe(el);
    // chaque image de la vue principale (dessin modifié, sélection…) redessine cette vue
    const after = () => render();
    vp.afterRender.add(after);
    const offTabs = app.on('tabs', () => setTimeout(fit, 60));
    const offDoc = app.on('doc', () => !fitted && setTimeout(fit, 60));

    // clic simple (sans glisser) : cette fenêtre devient la vue de travail
    let down: { x: number; y: number } | null = null;
    const onDown = (e: PointerEvent) => {
      down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    };
    const onUp = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4) swap();
      down = null;
    };
    const onDbl = () => fit();
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('dblclick', onDbl);
    return () => {
      api.current = null;
      ro.disconnect();
      vp.afterRender.delete(after);
      offTabs();
      offDoc();
      controls.dispose();
      renderer.domElement.removeEventListener('pointerdown', onDown);
      renderer.domElement.removeEventListener('pointerup', onUp);
      renderer.domElement.removeEventListener('dblclick', onDbl);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vp, index]);

  useEffect(() => {
    if (!menu) return;
    const h = () => setMenu(false);
    setTimeout(() => window.addEventListener('mousedown', h), 0);
    return () => window.removeEventListener('mousedown', h);
  }, [menu]);

  const item = (text: string, fn: () => void, on = false) => (
    <button key={text} className={on ? 'on' : ''} onMouseDown={(e) => e.stopPropagation()} onClick={() => (fn(), setMenu(false))}>
      {text}
    </button>
  );
  const views = Object.keys(VIEW_LABEL) as StandardView[];
  return (
    <div className="vp-aux" ref={ref} style={{ gridArea: area }} title="Clic : rendre cette vue active — molette : zoom — glisser : orbite — double-clic : zoom étendu">
      <div className="vp-controls" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
        <span onClick={() => setMenu(!menu)}>[+]</span>
        <span onClick={() => setMenu(!menu)}>[{label}]</span>
        {menu && (
          <div className="vp-menu">
            {item('Rendre active (échanger avec la vue principale)', () => api.current?.swap())}
            {item('Zoom étendu', () => api.current?.fit())}
            <div className="vp-menu-sep" />
            {views.map((v) =>
              item(VIEW_LABEL[v], () => {
                api.current?.look(v);
                const vs = [...app.settings.viewportViews];
                vs[index] = v;
                app.set('viewportViews', vs);
              }, VIEW_LABEL[v] === label),
            )}
            <div className="vp-menu-sep" />
            {item('Une seule fenêtre', () => app.set('viewports', '1'))}
          </div>
        )}
      </div>
    </div>
  );
}
