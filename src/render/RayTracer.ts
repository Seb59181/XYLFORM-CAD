/**
 * Rendu photoréaliste par lancer de rayons (tracé de chemins, « path tracing ») sur la carte
 * graphique : lumière globale (rebonds de la lumière entre les objets), reflets et réfractions
 * physiques (verre, plastiques translucides), ombres douces exactes, environnement qui éclaire
 * la scène. L'image s'affine à chaque passe (échantillon) : bruitée au départ, nette ensuite.
 *
 * Le moteur reprend la scène de la vue (solides, matériaux, textures), les lumières du dessin et
 * l'ambiance (LUMIERES). Il travaille dans son propre canevas WebGL, à la taille de l'image
 * demandée, découpé en tuiles pour que l'interface reste fluide pendant le calcul.
 */
import * as THREE from 'three';
import { DenoiseMaterial, GradientEquirectTexture, PhysicalSpotLight, WebGLPathTracer } from 'three-gpu-pathtracer';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { RenderMaterial } from '../core/materials';
import { pointIntensity, type EnvironmentKind, type LightDef, type RenderEnvironment } from '../core/render';
import type { RaytraceBackground, RaytraceFloor, RaytraceJob, RaytraceSettings, RaytraceStatus } from '../app/AppHost';
import { environmentScene, type CadViewport } from './CadViewport';
import { tilesFor } from './raytraceMath';

/** Couleur et aspect du sol (le sol reçoit ombres, reflets et lumière renvoyée). */
const FLOORS: Record<Exclude<RaytraceFloor, 'none'>, { color: string; roughness: number; clearcoat?: number }> = {
  studio: { color: '#a7a9ad', roughness: 0.85 },
  white: { color: '#f0f0ee', roughness: 0.9 },
  dark: { color: '#2b2e33', roughness: 0.7 },
  gloss: { color: '#16181c', roughness: 0.12, clearcoat: 1 },
  wood: { color: '#8a6440', roughness: 0.6 },
};

/** Matériau du lancer de rayons tiré du matériau de la vue (et de la bibliothèque : verre…). */
export function physicalFrom(src: THREE.MeshStandardMaterial, lib: RenderMaterial | undefined, modelRadius: number): THREE.MeshPhysicalMaterial {
  const p = new THREE.MeshPhysicalMaterial({
    color: src.color.clone(),
    map: src.map,
    metalness: src.metalness,
    roughness: src.roughness,
    emissive: src.emissive.clone(),
    emissiveIntensity: src.emissiveIntensity,
    side: src.side,
  });
  const ps = src as THREE.MeshPhysicalMaterial;
  if (ps.isMeshPhysicalMaterial) {
    p.clearcoat = ps.clearcoat;
    p.clearcoatRoughness = ps.clearcoatRoughness;
  }
  if (lib?.transmission) {
    // vraie réfraction : matière épaisse (non « film mince »), teinte qui s'accentue avec l'épaisseur
    p.transmission = lib.transmission;
    p.ior = lib.ior ?? 1.5;
    p.thickness = Math.max(modelRadius * 0.1, 1e-3);
    p.attenuationColor = src.color.clone();
    p.attenuationDistance = Math.max(modelRadius * (lib.attenuation ?? 2), 1e-3);
    p.color.lerp(new THREE.Color(1, 1, 1), 0.6);
    p.side = THREE.DoubleSide;
  } else if (src.transparent && src.opacity < 1) {
    p.transparent = true;
    p.opacity = src.opacity;
  }
  return p;
}

/** Carte d'environnement (cube) d'une ambiance, rendue avec le renderer du lancer de rayons. */
function environmentCube(renderer: THREE.WebGLRenderer, kind: EnvironmentKind): { texture: THREE.CubeTexture; dispose: () => void } {
  const rt = new THREE.WebGLCubeRenderTarget(512, { type: THREE.HalfFloatType, generateMipmaps: false });
  const cam = new THREE.CubeCamera(0.1, 100, rt);
  const scene = kind === 'studio' ? new RoomEnvironment() : environmentScene(kind);
  const tm = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  try {
    cam.update(renderer, scene);
  } finally {
    renderer.toneMapping = tm;
  }
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      for (const x of Array.isArray(m.material) ? m.material : [m.material]) x.dispose();
    }
  });
  return { texture: rt.texture, dispose: () => rt.dispose() };
}

export interface RayTracerSource {
  vp: CadViewport;
  lights: LightDef[];
  env: RenderEnvironment;
  /** Matériau de bibliothèque d'un objet (verre, PETG…) d'après son identifiant. */
  materialOf: (handle: string) => RenderMaterial | undefined;
  /** Couleur de l'écran (fond « couleur de l'écran »). */
  screenColor: string;
}

/**
 * Travail de rendu : construit la scène, accumule les passes à chaque image de l'écran et
 * s'arrête au nombre de passes visé. `onUpdate` est appelé après chaque passe.
 */
export class RayTracer implements RaytraceJob {
  readonly canvas: HTMLCanvasElement;
  status: RaytraceStatus = 'building';
  error: string | undefined;
  progress = 0;
  onUpdate: (() => void) | undefined;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly tracer: WebGLPathTracer;
  private readonly scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private readonly disposers: (() => void)[] = [];
  private frame: number | null = null;
  private paused = false;
  private disposed = false;
  private elapsed = 0;
  private lastTick = 0;
  private settings: RaytraceSettings;
  private denoiseQuad: FullScreenQuad | null = null;
  private readonly center = new THREE.Vector3();
  private radius = 1;

  constructor(
    private readonly src: RayTracerSource,
    settings: RaytraceSettings,
  ) {
    this.settings = { ...settings };
    const W = Math.max(16, Math.round(settings.width)), H = Math.max(16, Math.round(settings.height));
    this.canvas = document.createElement('canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(W, H, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = src.env.exposure / 100;
    this.renderer.setClearColor(0x000000, 0);
    this.camera = this.snapshotCamera(W / H);
    this.tracer = new WebGLPathTracer(this.renderer);
    this.tracer.renderDelay = 0;
    this.tracer.minSamples = 1;
    this.tracer.fadeDuration = 0;
    this.tracer.dynamicLowRes = false;
    this.tracer.rasterizeScene = true;
    this.tracer.multipleImportanceSampling = true;
    this.tracer.filterGlossyFactor = 0.5;
    this.tracer.transmissiveBounces = 10;
    this.tracer.bounces = settings.bounces;
    const n = tilesFor(W, H);
    this.tracer.tiles.set(n, n);
    this.tracer.renderToCanvasCallback = (target, renderer, quad) => {
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      if (this.settings.denoise && this.tracer.samples >= 1) {
        const dq = (this.denoiseQuad ??= new FullScreenQuad(new DenoiseMaterial({ sigma: 2.5, kSigma: 1, threshold: 0.12, premultipliedAlpha: renderer.getContextAttributes().premultipliedAlpha })));
        (dq.material as DenoiseMaterial & { map: THREE.Texture | null }).map = target.texture;
        dq.render(renderer);
      } else quad.render(renderer);
      renderer.autoClear = auto;
    };
  }

  get samples(): number {
    return Math.floor(this.tracer.samples);
  }

  get elapsedMs(): number {
    return this.elapsed;
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  get maxSamples(): number {
    return this.settings.maxSamples;
  }

  /** Construit la scène (structure d'accélération des rayons) puis lance le calcul. */
  async start(): Promise<void> {
    try {
      await this.build();
      if (this.disposed) return;
      this.status = 'running';
      this.lastTick = performance.now();
      this.loop();
    } catch (e) {
      console.error(e);
      this.status = 'error';
      this.error = e instanceof Error ? e.message : String(e);
    }
    this.onUpdate?.();
  }

  setPaused(p: boolean): void {
    if (this.status === 'building' || this.status === 'error') return;
    this.paused = p;
    if (p) {
      if (this.status === 'running') this.status = 'paused';
    } else if (this.status === 'paused' || this.status === 'done') {
      this.status = 'running';
      this.lastTick = performance.now();
      this.loop();
    }
    this.onUpdate?.();
  }

  /** Réglages qui ne demandent pas de reconstruire la scène. */
  update(p: Partial<Pick<RaytraceSettings, 'bounces' | 'denoise' | 'maxSamples' | 'exposure'>>): void {
    const restart = (p.bounces !== undefined && p.bounces !== this.settings.bounces) || (p.exposure !== undefined && p.exposure !== this.settings.exposure);
    this.settings = { ...this.settings, ...p };
    this.tracer.bounces = this.settings.bounces;
    if (this.settings.exposure !== undefined) this.renderer.toneMappingExposure = this.settings.exposure / 100;
    if (restart) {
      this.tracer.reset();
      this.elapsed = 0;
    }
    if (this.status === 'done' && (restart || !(this.settings.maxSamples > 0) || this.samples < this.settings.maxSamples)) {
      this.status = 'running';
      this.lastTick = performance.now();
      this.loop();
    } else if (this.status === 'done' || this.status === 'paused') this.present();
    this.onUpdate?.();
  }

  /** Image PNG (taille réelle), après la dernière passe. */
  toBlob(): Promise<Blob | null> {
    this.present();
    return new Promise((resolve) => this.canvas.toBlob((b) => resolve(b), 'image/png'));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.tracer.dispose();
    this.denoiseQuad?.dispose();
    (this.denoiseQuad?.material as THREE.Material | undefined)?.dispose();
    for (const d of this.disposers) d();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.userData.own) m.geometry.dispose();
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // -------------------------------------------------------------------------

  private loop(): void {
    if (this.frame !== null || this.disposed) return;
    const step = () => {
      this.frame = null;
      if (this.disposed || this.paused || this.status !== 'running') return;
      const now = performance.now();
      this.elapsed += Math.min(now - this.lastTick, 1000);
      this.lastTick = now;
      const before = this.samples;
      this.tracer.renderSample();
      const max = this.settings.maxSamples;
      if (max > 0 && this.samples >= max) {
        this.status = 'done';
        this.onUpdate?.();
        return;
      }
      if (this.samples !== before) this.onUpdate?.();
      this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  /** Affiche la dernière accumulation (après un changement de débruitage, avant l'enregistrement). */
  private present(): void {
    if (this.status === 'building' || this.status === 'error') return;
    const paused = this.tracer.pausePathTracing;
    this.tracer.pausePathTracing = true;
    try {
      this.tracer.renderSample();
    } finally {
      this.tracer.pausePathTracing = paused;
    }
  }

  /** Caméra de la vue, aux proportions de l'image. */
  private snapshotCamera(aspect: number): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    const vp = this.src.vp;
    const c = vp.activeCamera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    c.updateMatrixWorld();
    if ((c as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const p = (c as THREE.PerspectiveCamera).clone(false);
      p.aspect = aspect;
      p.updateProjectionMatrix();
      p.updateMatrixWorld();
      return p;
    }
    const o = (c as THREE.OrthographicCamera).clone(false);
    const halfH = (o.top - o.bottom) / 2;
    const cx = (o.left + o.right) / 2;
    o.left = cx - halfH * aspect;
    o.right = cx + halfH * aspect;
    o.updateProjectionMatrix();
    o.updateMatrixWorld();
    return o;
  }

  private async build(): Promise<void> {
    const { vp, env } = this.src;
    const scene = this.scene;
    const box = new THREE.Box3();
    vp.modelRoot.updateMatrixWorld(true);
    const solids: { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial }[] = [];
    vp.modelRoot.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.userData.handle || m.userData.outline || Array.isArray(m.material)) return;
      const mat = m.material as THREE.MeshStandardMaterial;
      if (!mat.isMeshStandardMaterial) return;
      solids.push({ mesh: m, mat });
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
    });
    if (!solids.length) throw new Error('Aucun solide visible à rendre (le lancer de rayons rend les solides et surfaces 3D).');
    // les images de texture sont décodées en tâche de fond : on les attend un peu
    const maps = solids.map((s) => s.mat.map).filter((t): t is THREE.Texture => !!t);
    for (let i = 0; i < 40 && maps.some((t) => !t.image); i++) await new Promise((r) => setTimeout(r, 50));
    const c = box.getCenter(this.center);
    const r = (this.radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3));

    const mats = new Map<string, THREE.MeshPhysicalMaterial>();
    for (const { mesh, mat } of solids) {
      const lib = this.src.materialOf(String(mesh.userData.handle));
      const key = `${mat.uuid}|${lib?.id ?? ''}`;
      let pm = mats.get(key);
      if (!pm) {
        pm = physicalFrom(mat, lib, r);
        mats.set(key, pm);
      }
      const copy = new THREE.Mesh(mesh.geometry, pm);
      copy.matrixAutoUpdate = false;
      copy.matrix.copy(mesh.matrixWorld);
      scene.add(copy);
    }
    this.disposers.push(() => mats.forEach((m) => m.dispose()));
    if (maps.length) this.tracer.textureSize.set(2048, 2048);

    // sol
    const floor = this.settings.floor;
    if (floor !== 'none') {
      const f = FLOORS[floor];
      const fm = new THREE.MeshPhysicalMaterial({ color: f.color, roughness: f.roughness, metalness: 0, clearcoat: f.clearcoat ?? 0, clearcoatRoughness: 0.05 });
      const ground = new THREE.Mesh(new THREE.PlaneGeometry(r * 120, r * 120), fm);
      ground.userData.own = true;
      ground.position.set(c.x, c.y, box.min.z - r * 1e-4);
      scene.add(ground);
      this.disposers.push(() => fm.dispose());
    }

    this.addLights(c, r);
    this.applyEnvironment(env, this.settings.background);
    this.renderer.toneMappingExposure = (this.settings.exposure ?? env.exposure) / 100;

    // structure d'accélération des rayons (BVH) : calculée d'un bloc, après l'affichage de l'état
    this.progress = 0.5;
    this.onUpdate?.();
    await new Promise((r) => setTimeout(r, 30));
    if (this.disposed) return;
    this.tracer.setScene(scene, this.camera);
    this.progress = 1;
  }

  /** Lumières du dessin (+ soleil par défaut), avec une taille réelle : ombres douces exactes. */
  private addLights(c: THREE.Vector3, r: number): void {
    const { lights, env } = this.src;
    const soft = Math.max(0, Math.min(1, this.settings.softness / 100));
    const lampRadius = r * (0.005 + 0.12 * soft);
    const on = lights.filter((l) => l.on);
    const sun = (dir: THREE.Vector3, illuminance: number, color: THREE.ColorRepresentation) => {
      // soleil = projecteur très lointain de taille apparente réglable (0,3° à 5°)
      const D = r * 400;
      const l = new PhysicalSpotLight(color, illuminance * D * D, 0, Math.atan((r * 90) / D), 0, 2);
      l.position.copy(c).addScaledVector(dir.clone().normalize(), D);
      l.target.position.copy(c);
      l.radius = D * Math.tan(THREE.MathUtils.degToRad(0.3 + 4.7 * soft));
      this.scene.add(l, l.target);
    };
    for (const d of on) {
      const color = new THREE.Color(d.color);
      const pos = new THREE.Vector3(d.position.x, d.position.y, d.position.z);
      const tgt = new THREE.Vector3(d.target.x, d.target.y, d.target.z);
      if (d.kind === 'directional') {
        const dir = pos.clone().sub(tgt);
        if (dir.lengthSq() < 1e-12) dir.set(0, 0, 1);
        sun(dir, (d.intensity / 100) * 2.4, color);
      } else if (d.kind === 'spot') {
        const l = new PhysicalSpotLight(color, pointIntensity(d.intensity, pos.distanceTo(c)), 0, THREE.MathUtils.degToRad(d.angle ?? 30), d.penumbra ?? 0.3, 2);
        l.position.copy(pos);
        l.target.position.copy(tgt);
        l.radius = lampRadius;
        this.scene.add(l, l.target);
      } else {
        // ampoule : deux demi-sphères d'émission (haut / bas) d'une lampe de taille réelle, ombres
        // douces ; la jointure est le plan horizontal de la lampe (invisible sur le sol et le modèle
        // placé dessous)
        const I = pointIntensity(d.intensity, pos.distanceTo(c));
        for (const s of [-1, 1]) {
          const l = new PhysicalSpotLight(color, I, 0, Math.PI / 2 - 1e-3, 0.002, 2);
          l.position.copy(pos);
          l.target.position.copy(pos).add(new THREE.Vector3(0, 0, s * r));
          l.radius = lampRadius;
          this.scene.add(l, l.target);
        }
      }
    }
    if (env.defaultLights || !on.length) {
      // même soleil que la vue Photoréaliste : à ~70° de la caméra, 55° de hauteur
      const vp = this.src.vp;
      const off = this.camera.position.clone().sub(vp.controls.target);
      const az = Math.hypot(off.x, off.y) > 1e-9 ? Math.atan2(off.y, off.x) : -Math.PI / 2;
      const sa = az - (70 * Math.PI) / 180, el = (55 * Math.PI) / 180;
      const dir = new THREE.Vector3(Math.cos(el) * Math.cos(sa), Math.cos(el) * Math.sin(sa), Math.sin(el));
      const color = env.environment === 'workshop' ? 0xffd2a1 : env.environment === 'night' ? 0x9db4ff : 0xfff4e6;
      sun(dir, env.environment === 'night' ? 0.35 : 2.6, color);
    }
  }

  /** Éclairage d'environnement et fond. */
  private applyEnvironment(env: RenderEnvironment, background: RaytraceBackground): void {
    const scene = this.scene;
    const cube = environmentCube(this.renderer, env.environment);
    this.disposers.push(cube.dispose);
    const base = env.environment === 'night' ? 0.12 : env.environment === 'outdoor' ? 0.8 : 1;
    scene.environment = cube.texture;
    scene.environmentIntensity = (base * env.envIntensity) / 100;
    scene.environmentRotation.set(Math.PI / 2, 0, 0);
    scene.backgroundRotation.set(Math.PI / 2, 0, 0);
    if (background === 'environment') {
      scene.background = cube.texture;
      scene.backgroundBlurriness = 0.35;
      scene.backgroundIntensity = Math.max(0.05, scene.environmentIntensity);
    } else if (background === 'studio') {
      const g = new GradientEquirectTexture(64);
      g.topColor.set('#f4f6f9');
      g.bottomColor.set('#b9bec7');
      g.exponent = 1.5;
      g.update();
      scene.background = g;
      scene.backgroundBlurriness = 0;
      scene.backgroundIntensity = 1;
      this.disposers.push(() => g.dispose());
    } else if (background === 'transparent') scene.background = null;
    else {
      scene.background = new THREE.Color(background === 'white' ? '#ffffff' : this.src.screenColor);
      // le fond passe par la tonalité photographique : blanc franc malgré la compression des clairs
      scene.backgroundIntensity = background === 'white' ? 3 : 1;
    }
  }
}
