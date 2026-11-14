/**
 * Initialisation de la scène 3D CAO :
 *   - convention Z vers le haut (le plan XY est le plan de dessin) ;
 *   - rendu WebGL2 avec tampon de profondeur logarithmique (pièces de 0,01 mm à 10 km) ;
 *   - éclairage « CAO » : lampe frontale attachée à la caméra + hémisphère + deux lumières
 *     d'appoint fixes + environnement PMREM faible pour les matériaux métalliques ;
 *   - caméras perspective ET orthographique, bascule sans perte de cadrage ;
 *   - navigation : molette = zoom vers le curseur, molette enfoncée = panoramique,
 *     Maj + molette enfoncée = orbite, double-clic molette = zoom étendu ;
 *   - grille adaptative, icône SCU au point d'origine et gizmo d'orientation dans le coin ;
 *   - rendu à la demande (pas de boucle permanente : économie GPU/batterie).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TECH_BACKGROUND } from './technical';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { AdaptiveGrid } from './AdaptiveGrid';
import { UcsGizmo, type AxisName } from './UcsGizmo';

// À faire AVANT toute création de caméra/objet.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export type Projection = 'perspective' | 'orthographic';
export type Workspace = '2d' | '3d';
export type StandardView = 'TOP' | 'BOTTOM' | 'FRONT' | 'BACK' | 'LEFT' | 'RIGHT' | 'SWISO' | 'SEISO' | 'NEISO' | 'NWISO';

/** Directions caméra → cible pour les vues prédéfinies (menu Vue / cube de vue). */
export const VIEW_DIRECTIONS: Record<StandardView, [number, number, number]> = {
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

const AXIS_TO_VIEW: Record<AxisName, StandardView> = {
  '+X': 'RIGHT',
  '-X': 'LEFT',
  '+Y': 'BACK',
  '-Y': 'FRONT',
  '+Z': 'TOP',
  '-Z': 'BOTTOM',
  ISO: 'SWISO',
};

export interface CadViewportOptions {
  background?: THREE.ColorRepresentation;
  /** Pas minimal de la grille (GRIDUNIT). */
  gridUnit?: number;
  projection?: Projection;
}

type ViewStateLike = { projection: Projection; position: THREE.Vector3Like; target: THREE.Vector3Like; up: THREE.Vector3Like; halfHeight: number };

export class CadViewport {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** Calque racine des entités du document (le reste = aides visuelles). */
  readonly modelRoot = new THREE.Group();
  readonly grid = new AdaptiveGrid();
  /** Couleur du fond (hors style Technique). */
  private background: THREE.ColorRepresentation = 0x212830;
  readonly gizmo = new UcsGizmo();
  readonly perspective: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;
  readonly controls: OrbitControls;
  /** Matrice du SCU courant (repère utilisateur). */
  readonly ucs = new THREE.Matrix4();
  /** Repère SCU : parent de la grille (le plan de travail suit le SCU). */
  private readonly ucsFrame = new THREE.Group();
  private readonly ucsIcon: THREE.Group;
  private readonly headlight = new THREE.DirectionalLight(0xffffff, 1.35);
  /** Style « Rendu » : soleil à ombres portées, sol qui reçoit les ombres, tonalité ACES. */
  private renderMode = false;
  private readonly sun = new THREE.DirectionalLight(0xfff4e6, 2.4);
  private readonly ground = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.32 }));
  private readonly sceneBox = new THREE.Box3();
  private envMap: THREE.Texture | null = null;
  private readonly clipBox = new THREE.Box3();
  private readonly clipBox2 = new THREE.Box3();
  private readonly clipSphere = new THREE.Sphere();
  private readonly clipDir = new THREE.Vector3();
  private readonly clipV = new THREE.Vector3();
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private renderRequested = false;
  private animation: number | null = null;
  private readonly resizeObserver: ResizeObserver;
  private readonly disposers: (() => void)[] = [];
  /** Appelés avant chaque image (résolution des lignes épaisses, tailles à l'écran…). */
  readonly beforeRender = new Set<() => void>();
  /** Appelés après chaque image (aides en surimpression HTML). */
  readonly afterRender = new Set<() => void>();
  /** Espace 2D : vue de dessus parallèle, sans orbite ni gizmo d'orientation. */
  private mode2d = false;
  /** Analyse de coupe : plan qui découpe les objets du modèle. */
  private section: THREE.Plane | null = null;
  private readonly sectionPlanes: THREE.Plane[] = [];
  private readonly sectioned = new Set<THREE.Material>();
  /** Bouchage hachuré de la coupe (technique du tampon de stencil). */
  private readonly capGroup = new THREE.Group();
  private readonly capPairs = new Map<THREE.Mesh, [THREE.Mesh, THREE.Mesh]>();
  private capPlane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> | null = null;
  private stencilMats: [THREE.Material, THREE.Material] | null = null;

  constructor(
    readonly container: HTMLElement,
    opts: CadViewportOptions = {},
  ) {
    // --- Renderer -----------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      stencil: true, // bouchage des coupes de section
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.localClippingEnabled = true; // plans de coupe (SECTIONPLANE)
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    // Fond anthracite de l'espace objet (≈ #212830)
    this.background = opts.background ?? 0x212830;
    this.scene.background = new THREE.Color(this.background);

    // --- Caméras ----------------------------------------------------------------
    const { clientWidth: w, clientHeight: h } = container;
    const aspect = w / Math.max(h, 1);
    this.perspective = new THREE.PerspectiveCamera(35, aspect, 0.01, 1e7);
    this.ortho = new THREE.OrthographicCamera(-aspect, aspect, 1, -1, -1e7, 1e7);
    this.perspective.position.set(-120, -120, 100);
    this.camera = opts.projection === 'orthographic' ? this.ortho : this.perspective;

    // --- Navigation -------------------------------------------------------------
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;
    this.controls.zoomToCursor = true;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 1e-3;
    this.controls.maxDistance = 1e10; // coordonnées géographiques (DWG géoréférencés)
    // Bouton gauche réservé à la sélection et aux commandes.
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: null } as never;
    // OrbitControls bascule PAN → ROTATE quand Maj/Ctrl est enfoncé : Maj+molette = orbite.
    this.controls.addEventListener('change', () => this.requestRender());

    // --- Éclairage CAO ------------------------------------------------------------
    this.setupLighting();

    // --- Aides visuelles ------------------------------------------------------------
    this.grid.baseStep = opts.gridUnit ?? 1;
    this.ucsIcon = this.createUcsIcon();
    this.ucsFrame.add(this.grid);
    this.scene.add(this.ucsFrame, this.ucsIcon, this.modelRoot, this.capGroup);

    this.syncOrthoFrustum();
    this.setView('SWISO', false);

    // --- Événements -----------------------------------------------------------------
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.bindPointer();
    this.resize();
  }

  get activeCamera(): THREE.Camera {
    return this.camera;
  }

  get projection(): Projection {
    return this.camera === this.ortho ? 'orthographic' : 'perspective';
  }

  get workspace(): Workspace {
    return this.mode2d ? '2d' : '3d';
  }

  /**
   * Espace de travail. 2D : vue de dessus en projection parallèle, orbite désactivée (seuls
   * panoramique et zoom restent), gizmo masqué. 3D : projection choisie, orbite libre.
   */
  setWorkspace(ws: Workspace, projection: Projection, animate = true): void {
    const was2d = this.mode2d;
    this.mode2d = ws === '2d';
    this.controls.enableRotate = !this.mode2d;
    if (this.mode2d) {
      this.setSection(null);
      this.setProjection('orthographic');
      this.setView('TOP', animate);
    } else {
      this.setProjection(projection);
      if (was2d) this.setView('SWISO', animate);
    }
    this.requestRender();
  }

  // =========================================================================
  // Éclairage
  // =========================================================================

  private setupLighting(): void {
    // 1. Ciel froid / sol chaud : donne immédiatement le sens haut/bas des volumes.
    this.scene.add(new THREE.HemisphereLight(0xdfe8f5, 0x3b3328, 0.75));

    // 2. Lampe frontale attachée à la caméra, légèrement décalée en haut à gauche :
    //    toute face vue est éclairée, quelle que soit l'orbite (comportement des modeleurs CAO).
    this.headlight.position.set(-0.4, 0.6, 1);
    this.headlight.target.position.set(0, 0, -1);
    this.perspective.add(this.headlight, this.headlight.target);
    // les deux caméras font partie de la scène pour que leurs lumières enfants soient actives
    this.scene.add(this.perspective, this.ortho);

    // 3. Deux lumières fixes faibles pour séparer les faces parallèles au regard.
    const key = new THREE.DirectionalLight(0xffffff, 0.5);
    key.position.set(1, -2, 3);
    const fill = new THREE.DirectionalLight(0xb8c7ff, 0.25);
    fill.position.set(-2, 1, -1);
    this.scene.add(key, fill);

    // 4. Environnement neutre pour les réflexions des matériaux métalliques (acier, alu).
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.envMap = env;
    this.scene.environment = env;
    this.scene.environmentIntensity = 0.35;
    pmrem.dispose();
    this.disposers.push(() => env.dispose());

    // 5. Style Rendu : soleil haut à gauche (ombres douces) et sol « attrape-ombres »
    this.sun.visible = false;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.radius = 4;
    this.ground.visible = false;
    this.ground.receiveShadow = true;
    this.ground.renderOrder = -1;
    this.scene.add(this.sun, this.sun.target, this.ground);
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  /** Style visuel « Rendu » : ombres portées, reflets plus marqués, tonalité photographique. */
  /** Style Technique : fond blanc et grille gris clair (dessin au trait). */
  setTechnical(on: boolean): void {
    if (this.technical === on) return;
    this.technical = on;
    this.scene.background = new THREE.Color(on ? TECH_BACKGROUND : this.background);
    const u = this.grid.material.uniforms;
    u.uMinorColor!.value.set(on ? 0xdfe2e6 : 0x3a4350);
    u.uMajorColor!.value.set(on ? 0xbfc4ca : 0x56616f);
    this.requestRender();
  }

  private technical = false;

  setRenderMode(on: boolean): void {
    if (on === this.renderMode) return;
    this.renderMode = on;
    this.renderer.shadowMap.enabled = on;
    this.renderer.toneMapping = on ? THREE.ACESFilmicToneMapping : THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = on ? 1.05 : 1;
    this.scene.environmentIntensity = on ? 0.85 : 0.35;
    this.headlight.intensity = on ? 0.55 : 1.35;
    this.sun.visible = this.ground.visible = on;
    this.requestRender();
  }

  /** Soleil et sol cadrés sur le modèle (appelé avant chaque image en mode Rendu). */
  private fitSun(): void {
    const box = this.sceneBox.makeEmpty();
    this.modelRoot.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.castShadow) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld));
    });
    if (box.isEmpty()) {
      this.ground.visible = false;
      return;
    }
    this.ground.visible = true;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1e-3);
    // soleil à ~70° de la caméra et haut (55°) : ombres visibles, portées vers la droite
    const off = this.camera.position.clone().sub(this.controls.target);
    const az = Math.hypot(off.x, off.y) > 1e-9 ? Math.atan2(off.y, off.x) : -Math.PI / 2;
    const sa = az - (70 * Math.PI) / 180, el = (55 * Math.PI) / 180;
    const dir = new THREE.Vector3(Math.cos(el) * Math.cos(sa), Math.cos(el) * Math.sin(sa), Math.sin(el));
    this.sun.position.copy(c).addScaledVector(dir, r * 4);
    this.sun.target.position.copy(c);
    this.sun.target.updateMatrixWorld();
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -r * 1.6;
    cam.right = cam.top = r * 1.6;
    cam.near = r * 0.5;
    cam.far = r * 8;
    cam.updateProjectionMatrix();
    // sol juste sous le modèle, assez grand pour recevoir l'ombre allongée
    this.ground.position.set(c.x, c.y, box.min.z - r * 1e-4);
    this.ground.scale.set(r * 12, r * 12, 1);
  }

  /** Matériau par défaut des solides : mat, légèrement satiné, arêtes nettes. */
  static solidMaterial(color: THREE.ColorRepresentation = 0xb8bec6): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color,
      metalness: 0.05,
      roughness: 0.55,
      flatShading: false,
      polygonOffset: true, // laisse les arêtes (LineSegments) passer devant les faces
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
  }

  // =========================================================================
  // Icône SCU au point d'origine (taille constante à l'écran)
  // =========================================================================

  private createUcsIcon(): THREE.Group {
    const g = new THREE.Group();
    g.name = 'UcsIcon';
    const mk = (dir: THREE.Vector3, color: number) => {
      const arrow = new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color, 0.22, 0.09);
      (arrow.line.material as THREE.LineBasicMaterial).depthTest = false;
      (arrow.cone.material as THREE.MeshBasicMaterial).depthTest = false;
      arrow.renderOrder = 10;
      return arrow;
    };
    g.add(mk(new THREE.Vector3(1, 0, 0), 0xe5534b), mk(new THREE.Vector3(0, 1, 0), 0x57ab5a), mk(new THREE.Vector3(0, 0, 1), 0x539bf5));
    // petit carré à l'origine = SCU général (SCG), comme l'icône habituelle
    const square = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0.15, 0, 0),
        new THREE.Vector3(0.15, 0.15, 0),
        new THREE.Vector3(0, 0.15, 0),
      ]),
      new THREE.LineBasicMaterial({ color: 0xc9d1d9, depthTest: false }),
    );
    g.add(square);
    return g;
  }

  /** Définit le SCU courant (commande SCU/UCS) : la grille et l'icône suivent. */
  /** Pas minimal de la grille (GRILLE › Pas) ; 0 = 1 unité. La grille reste adaptative au-delà. */
  setGridUnit(step: number): void {
    this.grid.baseStep = step > 0 ? step : 1;
    this.requestRender();
  }

  setUcs(matrix: THREE.Matrix4): void {
    this.ucs.copy(matrix);
    matrix.decompose(this.ucsFrame.position, this.ucsFrame.quaternion, this.ucsFrame.scale);
    this.ucsFrame.updateMatrixWorld(true);
    this.requestRender();
  }

  // =========================================================================
  // Projection et vues
  // =========================================================================

  setProjection(p: Projection): void {
    if (p === this.projection) return;
    const from = this.camera;
    const to = p === 'orthographic' ? this.ortho : this.perspective;
    to.position.copy(from.position);
    to.quaternion.copy(from.quaternion);
    to.up.copy(from.up);
    if (to === this.ortho) {
      // hauteur visible au plan de la cible conservée : 2·d·tan(fov/2)
      this.ortho.zoom = 1;
      this.syncOrthoFrustum();
    } else {
      // retour en perspective : distance équivalente au zoom ortho courant
      const height = (this.ortho.top - this.ortho.bottom) / this.ortho.zoom;
      const d = height / (2 * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2)));
      const dir = new THREE.Vector3().subVectors(to.position, this.controls.target).normalize();
      to.position.copy(this.controls.target).addScaledVector(dir, d);
    }
    // la lampe frontale suit la caméra active
    to.add(this.headlight, this.headlight.target);
    this.camera = to;
    this.controls.object = to;
    this.controls.update();
    this.requestRender();
  }

  private syncOrthoFrustum(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    const aspect = w / Math.max(h, 1);
    const d = this.perspective.position.distanceTo(this.controls.target);
    const halfH = d * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
    Object.assign(this.ortho, { left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH });
    this.ortho.updateProjectionMatrix();
  }

  /** Vue prédéfinie, animée (≈ 350 ms, interpolation sphérique autour de la cible). */
  setView(view: StandardView, animate = true): void {
    this.lookFrom(new THREE.Vector3(...VIEW_DIRECTIONS[view]), animate);
  }

  /** Vue depuis une direction quelconque (cible → caméra), ex. arête ou coin du cube de vue. */
  lookFrom(direction: { x: number; y: number; z: number }, animate = true): void {
    const target = this.controls.target.clone();
    const distance = this.camera.position.distanceTo(target) || 200;
    const dir = new THREE.Vector3(direction.x, direction.y, direction.z).normalize();
    const endPos = target.clone().addScaledVector(dir, distance);
    // vues de dessus/dessous : "haut" de l'écran = +Y, sinon +Z
    const endUp = Math.abs(dir.z) > 0.999 ? new THREE.Vector3(0, Math.sign(dir.z), 0) : new THREE.Vector3(0, 0, 1);
    if (!animate) {
      this.camera.position.copy(endPos);
      this.camera.up.copy(endUp);
      this.camera.lookAt(target);
      this.controls.update();
      this.requestRender();
      return;
    }
    const startOffset = this.camera.position.clone().sub(target);
    const endOffset = endPos.clone().sub(target);
    const startUp = this.camera.up.clone();
    const q = new THREE.Quaternion().setFromUnitVectors(startOffset.clone().normalize(), endOffset.clone().normalize());
    const qi = new THREE.Quaternion();
    const t0 = performance.now();
    const duration = 350;
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / duration);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
      qi.identity().slerp(q, e);
      this.camera.position.copy(target).add(startOffset.clone().applyQuaternion(qi));
      this.camera.up.copy(startUp).lerp(endUp, e).normalize();
      this.camera.lookAt(target);
      this.controls.update();
      this.renderNow();
      this.animation = t < 1 ? requestAnimationFrame(step) : null;
    };
    this.animation = requestAnimationFrame(step);
  }

  /**
   * Orbite autour de la cible (cube de vue glissé, barre de navigation) : azimut autour de Z et
   * élévation, en radians. Z reste vers le haut, l'élévation est bornée juste avant les pôles.
   */
  orbitBy(dAzimuth: number, dElevation: number): void {
    if (this.mode2d) return;
    if (this.animation !== null) cancelAnimationFrame(this.animation), (this.animation = null);
    const target = this.controls.target;
    const off = this.camera.position.clone().sub(target);
    const r = off.length() || 1;
    const flat = Math.hypot(off.x, off.y);
    // vue de dessus/dessous exacte : l'azimut se lit sur le vecteur « haut » de la caméra
    const up = this.camera.up;
    let az = flat > r * 1e-6 ? Math.atan2(off.y, off.x) : off.z >= 0 ? Math.atan2(-up.y, -up.x) : Math.atan2(up.y, up.x);
    let el = Math.asin(THREE.MathUtils.clamp(off.z / r, -1, 1));
    az -= dAzimuth;
    el = THREE.MathUtils.clamp(el + dElevation, -Math.PI / 2 + 1e-3, Math.PI / 2 - 1e-3);
    this.camera.position.set(target.x + r * Math.cos(el) * Math.cos(az), target.y + r * Math.cos(el) * Math.sin(az), target.z + r * Math.sin(el));
    this.camera.up.set(0, 0, 1);
    this.camera.lookAt(target);
    this.controls.update();
    this.requestRender();
  }

  /** Analyse de coupe : `plane` garde le côté où la distance signée est positive ; null = arrêt. */
  setSection(plane: THREE.Plane | null): void {
    this.section = plane ? plane.clone() : null;
    this.sectionPlanes.length = 0;
    if (this.section) this.sectionPlanes.push(this.section);
    else {
      for (const pair of this.capPairs.values()) this.capGroup.remove(...pair);
      this.capPairs.clear();
      if (this.capPlane) this.capPlane.visible = false;
      for (const m of this.sectioned) {
        m.clippingPlanes = null;
        if (m.userData.sectionSide !== undefined) m.side = m.userData.sectionSide as THREE.Side;
        delete m.userData.sectionSide;
        m.needsUpdate = true;
      }
      this.sectioned.clear();
    }
    this.requestRender();
  }

  get sectionPlane(): THREE.Plane | null {
    return this.section;
  }

  /** Applique le plan de coupe aux matériaux du modèle (y compris ceux créés depuis). */
  private applySection(): void {
    if (!this.section) return;
    // seuls les solides et surfaces sont coupés (pas les courbes 2D ni les fonds de plan)
    const solids: THREE.Object3D[] = [];
    this.scene.traverse((o) => void (o.userData.solid && solids.push(o)));
    for (const root of solids)
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && mesh.userData.closedSolid && !this.capPairs.has(mesh)) {
          const [back, front] = this.stencilMaterials();
          const pair: [THREE.Mesh, THREE.Mesh] = [new THREE.Mesh(mesh.geometry, back), new THREE.Mesh(mesh.geometry, front)];
          for (const s of pair) {
            s.matrixAutoUpdate = false;
            s.renderOrder = 2;
            s.raycast = () => undefined;
          }
          this.capPairs.set(mesh, pair);
          this.capGroup.add(...pair);
        }
        const mat = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!mat) return;
        for (const m of Array.isArray(mat) ? mat : [mat]) {
          if (this.sectioned.has(m)) continue;
          m.clippingPlanes = this.sectionPlanes;
          // intérieur visible à travers la coupe (surfaces, solides mal fermés)
          if (mesh.isMesh && m.side !== THREE.DoubleSide && !mesh.userData.outline) {
            m.userData.sectionSide = m.side;
            m.side = THREE.DoubleSide;
          }
          m.needsUpdate = true;
          this.sectioned.add(m);
        }
      });
    // paires de stencil : suivent leur maillage (supprimé, masqué, déplacé)
    let box: THREE.Box3 | null = null;
    for (const [mesh, pair] of this.capPairs) {
      let alive = !!mesh.parent, visible = alive;
      for (let o: THREE.Object3D | null = mesh; visible && o; o = o.parent) visible = o.visible;
      if (!alive) {
        this.capGroup.remove(...pair);
        this.capPairs.delete(mesh);
        continue;
      }
      for (const s of pair) {
        s.visible = visible;
        s.matrix.copy(mesh.matrixWorld);
        s.matrixWorldNeedsUpdate = true;
      }
      if (visible) {
        const g = mesh.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const b = g.boundingBox!.clone().applyMatrix4(mesh.matrixWorld);
        box = box ? box.union(b) : b;
      }
    }
    const cap = this.capMesh();
    cap.visible = !!box;
    if (!box) return;
    // plan de bouchage : centré sur la projection du modèle, assez grand pour tout couvrir
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const center = this.section.projectPoint(sphere.center, new THREE.Vector3());
    const size = sphere.radius * 2.2;
    cap.position.copy(center);
    cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.section.normal);
    cap.scale.set(size, size, 1);
    // hachures à pas constant à l'écran (≈ 9 px)
    const rep = size / Math.max(9 * this.worldUnitsPerPixel(), 1e-9);
    cap.material.map!.repeat.set(rep, rep);
  }

  private stencilMaterials(): [THREE.Material, THREE.Material] {
    if (this.stencilMats) return this.stencilMats;
    const mk = (side: THREE.Side, op: THREE.StencilOp) =>
      new THREE.MeshBasicMaterial({
        side,
        colorWrite: false,
        depthWrite: false,
        depthTest: false,
        stencilWrite: true,
        stencilFunc: THREE.AlwaysStencilFunc,
        stencilFail: op,
        stencilZFail: op,
        stencilZPass: op,
        clippingPlanes: this.sectionPlanes,
      });
    this.stencilMats = [mk(THREE.BackSide, THREE.IncrementWrapStencilOp), mk(THREE.FrontSide, THREE.DecrementWrapStencilOp)];
    this.disposers.push(() => this.stencilMats?.forEach((m) => m.dispose()));
    return this.stencilMats;
  }

  private capMesh(): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial> {
    if (this.capPlane) return this.capPlane;
    // hachures à 45° (style « coupe » des dessins techniques)
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d')!;
    g.fillStyle = '#d29a3f';
    g.fillRect(0, 0, 32, 32);
    g.strokeStyle = '#5a3d12';
    g.lineWidth = 3;
    g.beginPath();
    for (const o of [-32, 0, 32]) {
      g.moveTo(o, 32);
      g.lineTo(o + 32, 0);
    }
    g.stroke();
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.8,
      metalness: 0,
      side: THREE.DoubleSide,
      stencilWrite: true,
      stencilRef: 0,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,
    });
    this.capPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.capPlane.renderOrder = 3;
    this.capPlane.raycast = () => undefined;
    this.capGroup.add(this.capPlane);
    this.disposers.push(() => {
      tex.dispose();
      mat.dispose();
      this.capPlane?.geometry.dispose();
    });
    return this.capPlane;
  }

  /** ZOOM Étendu : cadre toute la géométrie du modèle. */
  zoomExtents(margin = 1.15): void {
    // les lignes de construction (guides) sont très longues : hors de l'emprise
    const box = new THREE.Box3();
    for (const c of this.modelRoot.children) if (!c.userData.noBounds) box.expandByObject(c);
    this.frameBox(box, margin);
  }

  /** Cadre un ensemble de points (zoom objet). */
  zoomToPoints(pts: { x: number; y: number; z: number }[], margin = 1.15): void {
    this.frameBox(new THREE.Box3().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, p.y, p.z))), margin);
  }

  /** Cadre une boîte englobante dans la vue courante (sans changer la direction de vue). */
  frameBox(box: THREE.Box3, margin = 1.15): void {
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).normalize();
    const fov = THREE.MathUtils.degToRad(this.perspective.fov);
    const d = (sphere.radius * margin) / Math.sin(fov / 2);
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, d);
    if (this.camera === this.ortho) {
      this.ortho.zoom = 1;
      const aspect = this.container.clientWidth / Math.max(this.container.clientHeight, 1);
      const halfH = sphere.radius * margin;
      Object.assign(this.ortho, { left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH });
      this.ortho.updateProjectionMatrix();
    }
    this.controls.update();
    this.requestRender();
  }

  // =========================================================================
  // Rendu
  // =========================================================================

  requestRender(): void {
    if (this.renderRequested) return;
    this.renderRequested = true;
    requestAnimationFrame(() => {
      this.renderRequested = false;
      // l'amortissement continue tant que update() signale un mouvement
      if (this.controls.update()) this.requestRender();
      this.renderNow();
    });
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  renderFrame(): void {
    this.renderNow();
  }

  private renderNow(): void {
    const cam = this.camera;
    for (const fn of this.beforeRender) fn();
    this.grid.update(cam, this.controls.target);
    this.updateClipping();
    this.applySection();
    if (this.renderMode) this.fitSun();
    // icône SCU : taille constante (~ 60 px) quel que soit le zoom
    const worldPerPixel = this.worldUnitsPerPixel();
    this.ucsIcon.matrix.copy(this.ucs).multiply(new THREE.Matrix4().makeScale(60 * worldPerPixel, 60 * worldPerPixel, 60 * worldPerPixel));
    this.ucsIcon.matrixAutoUpdate = false;
    this.ucsIcon.matrixWorldNeedsUpdate = true;
    this.renderer.render(this.scene, cam);
    if (!this.mode2d) this.gizmo.render(this.renderer, cam, this.ucs);
    for (const fn of this.afterRender) fn();
  }

  /**
   * Plans de découpe ajustés à chaque image sur le modèle et la grille : la précision du tampon
   * de profondeur reste bonne à toutes les échelles (du 0,01 mm aux coordonnées géographiques)
   * et le décalage de polygones laisse les arêtes devant les faces.
   */
  private updateClipping(cam: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.camera, target: THREE.Vector3 = this.controls.target): void {
    const box = this.clipBox.makeEmpty();
    this.modelRoot.traverseVisible((o) => {
      const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
      if (!g || !g.attributes) return;
      if (!g.boundingBox) g.computeBoundingBox();
      if (g.boundingBox && !g.boundingBox.isEmpty()) box.union(this.clipBox2.copy(g.boundingBox).applyMatrix4(o.matrixWorld));
    });
    const d = Math.max(cam.position.distanceTo(target), 1e-6);
    const dir = cam.getWorldDirection(this.clipDir);
    let zMin = Infinity, zMax = -Infinity;
    if (!box.isEmpty()) {
      const sphere = box.getBoundingSphere(this.clipSphere);
      const zc = this.clipV.subVectors(sphere.center, cam.position).dot(dir);
      zMin = zc - sphere.radius;
      zMax = zc + sphere.radius;
    }
    if (cam instanceof THREE.PerspectiveCamera) {
      // la grille s'estompe à 8 × la distance de la cible
      const far = Math.max(d * 12, zMax) * 1.05;
      const near = Math.min(d / 20, Math.max(d / 2000, zMin * 0.9));
      if (Math.abs(cam.near - near) > near * 1e-3 || Math.abs(cam.far - far) > far * 1e-3) {
        cam.near = near;
        cam.far = far;
        cam.updateProjectionMatrix();
      }
    } else {
      const h = (cam.top - cam.bottom) / cam.zoom;
      const near = Math.min(zMin, d - h * 10) - h * 0.1;
      const far = Math.max(zMax, d + h * 10) + h * 0.1;
      if (cam.near !== near || cam.far !== far) {
        cam.near = near;
        cam.far = far;
        cam.updateProjectionMatrix();
      }
    }
  }

  // =========================================================================
  // État de la vue (onglets de dessins) et fenêtres secondaires
  // =========================================================================

  /** Position de la caméra, pour la restituer en revenant sur un dessin. */
  getViewState(): { projection: Projection; position: THREE.Vector3Like; target: THREE.Vector3Like; up: THREE.Vector3Like; halfHeight: number } {
    const c = this.camera;
    const halfHeight = c === this.ortho ? (this.ortho.top - this.ortho.bottom) / 2 / this.ortho.zoom : this.camera.position.distanceTo(this.controls.target) * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
    const v = (p: THREE.Vector3) => ({ x: p.x, y: p.y, z: p.z });
    return { projection: this.projection, position: v(c.position), target: v(this.controls.target), up: v(c.up), halfHeight };
  }

  setViewState(s: ViewStateLike): void {
    if (this.animation !== null) cancelAnimationFrame(this.animation), (this.animation = null);
    // l'espace 2D impose la vue de dessus parallèle
    if (!this.mode2d) this.setProjection(s.projection);
    this.applyViewState(s);
  }

  /**
   * Transition animée vers un cadrage (mode Présentation) : la cible glisse, la direction de
   * visée tourne, la hauteur visible et le « haut » s'interpolent. Résolue à la fin.
   */
  transitionTo(s: ViewStateLike, ms = 1200): Promise<void> {
    if (this.animation !== null) cancelAnimationFrame(this.animation), (this.animation = null);
    if (ms <= 0) {
      this.setViewState(s);
      return Promise.resolve();
    }
    const a = this.getViewState();
    if (!this.mode2d) this.setProjection(s.projection);
    const V = (p: THREE.Vector3Like) => new THREE.Vector3(p.x, p.y, p.z);
    const t0 = V(a.target), t1 = V(s.target);
    const o0 = V(a.position).sub(t0), o1 = V(s.position).sub(t1);
    const d0 = o0.length() || 1, d1 = o1.length() || 1;
    const q = new THREE.Quaternion().setFromUnitVectors(o0.clone().normalize(), o1.clone().normalize());
    const qi = new THREE.Quaternion();
    const u0 = V(a.up), u1 = V(s.up);
    const start = performance.now();
    return new Promise((resolve) => {
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / ms);
        const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        qi.identity().slerp(q, e);
        const target = t0.clone().lerp(t1, e);
        const off = o0.clone().normalize().applyQuaternion(qi).multiplyScalar(d0 + (d1 - d0) * e);
        const up = u0.clone().lerp(u1, e);
        if (up.lengthSq() < 1e-9) up.copy(u1);
        this.applyViewState({ projection: s.projection, target, position: target.clone().add(off), up: up.normalize(), halfHeight: a.halfHeight + (s.halfHeight - a.halfHeight) * e });
        this.renderNow();
        if (t < 1) this.animation = requestAnimationFrame(step);
        else {
          this.animation = null;
          resolve();
        }
      };
      this.animation = requestAnimationFrame(step);
    });
  }

  private applyViewState(s: ViewStateLike): void {
    const c = this.camera;
    this.controls.target.set(s.target.x, s.target.y, s.target.z);
    if (this.mode2d) {
      const d = Math.max(Math.hypot(s.position.x - s.target.x, s.position.y - s.target.y, s.position.z - s.target.z), 1);
      c.position.set(s.target.x, s.target.y, s.target.z + d);
      c.up.set(0, 1, 0);
    } else {
      c.position.set(s.position.x, s.position.y, s.position.z);
      c.up.set(s.up.x, s.up.y, s.up.z);
      if (c === this.perspective) {
        // même hauteur visible quelle que soit la projection d'origine
        const dir = c.position.clone().sub(this.controls.target);
        if (dir.lengthSq() < 1e-18) dir.set(-1, -1, 1);
        c.position.copy(this.controls.target).addScaledVector(dir.normalize(), s.halfHeight / Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2)));
      }
    }
    c.lookAt(this.controls.target);
    if (c === this.ortho) {
      const aspect = this.container.clientWidth / Math.max(this.container.clientHeight, 1);
      Object.assign(this.ortho, { zoom: 1, left: -s.halfHeight * aspect, right: s.halfHeight * aspect, top: s.halfHeight, bottom: -s.halfHeight });
      this.ortho.updateProjectionMatrix();
    }
    this.controls.update();
    this.requestRender();
  }

  /**
   * Rendu de la même scène dans une fenêtre de vue secondaire (son propre renderer WebGL et sa
   * caméra) : plans de découpe, grille, lampe frontale et épaisseur des lignes sont réglés pour
   * cette caméra le temps de l'image, puis rendus à la vue principale.
   */
  renderAux(renderer: THREE.WebGLRenderer, cam: THREE.PerspectiveCamera | THREE.OrthographicCamera, target: THREE.Vector3, w: number, h: number): void {
    const lineMats: { m: { resolution: THREE.Vector2 }; x: number; y: number }[] = [];
    const seen = new Set<THREE.Material>();
    this.scene.traverse((o) => {
      const mats = (o as THREE.Mesh).material;
      if (!mats) return;
      for (const m of Array.isArray(mats) ? mats : [mats]) {
        if (seen.has(m)) continue;
        seen.add(m);
        const lm = m as unknown as { isLineMaterial?: boolean; resolution: THREE.Vector2 };
        if (lm.isLineMaterial) lineMats.push({ m: lm, x: lm.resolution.x, y: lm.resolution.y }), lm.resolution.set(w, h);
      }
    });
    this.updateClipping(cam, target);
    this.grid.update(cam, target);
    this.applySection();
    const pixel = cam instanceof THREE.OrthographicCamera ? (cam.top - cam.bottom) / cam.zoom / Math.max(h, 1) : (2 * cam.position.distanceTo(target) * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / Math.max(h, 1);
    this.ucsIcon.matrix.copy(this.ucs).multiply(new THREE.Matrix4().makeScale(50 * pixel, 50 * pixel, 50 * pixel));
    this.ucsIcon.matrixWorldNeedsUpdate = true;
    const hadParent = !!cam.parent;
    if (!hadParent) this.scene.add(cam);
    cam.add(this.headlight, this.headlight.target);
    renderer.shadowMap.enabled = this.renderMode;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = this.renderer.toneMapping;
    renderer.toneMappingExposure = this.renderer.toneMappingExposure;
    renderer.localClippingEnabled = true;
    try {
      renderer.render(this.scene, cam);
    } finally {
      this.camera.add(this.headlight, this.headlight.target);
      if (!hadParent) this.scene.remove(cam);
      for (const l of lineMats) l.m.resolution.set(l.x, l.y);
      this.grid.update(this.camera, this.controls.target);
      const wpp = this.worldUnitsPerPixel();
      this.ucsIcon.matrix.copy(this.ucs).multiply(new THREE.Matrix4().makeScale(60 * wpp, 60 * wpp, 60 * wpp));
      this.ucsIcon.matrixWorldNeedsUpdate = true;
    }
  }

  /** Boîte englobante du modèle (cadrage des fenêtres secondaires). */
  modelBox(): THREE.Box3 {
    return new THREE.Box3().setFromObject(this.modelRoot);
  }

  /** Image PNG du viewport (rendu immédiat puis lecture du tampon). */
  screenshot(): Promise<Blob | null> {
    this.renderNow();
    return new Promise((resolve) => this.renderer.domElement.toBlob((b) => resolve(b), 'image/png'));
  }

  /**
   * Image de rendu hors écran à la taille demandée (suréchantillonnée puis réduite pour lisser
   * les bords), sans grille, icône SCU, sélection ni poignées. `background` : couleur CSS,
   * 'studio' (dégradé clair) ou null (transparent).
   */
  async renderImage(width: number, height: number, background: string | 'studio' | null, supersample = 2): Promise<Blob | null> {
    const r = this.renderer;
    const ss = Math.max(1, Math.min(supersample, 8192 / Math.max(width, height), r.capabilities.maxTextureSize / Math.max(width, height)));
    const W = Math.round(width * ss), H = Math.round(height * ss);
    const oldSize = r.getSize(new THREE.Vector2());
    const oldRatio = r.getPixelRatio();
    const oldBg = this.scene.background;
    const oldClear = r.getClearAlpha();
    const hidden: THREE.Object3D[] = [];
    const keep = new Set<THREE.Object3D>([this.modelRoot, this.sun, this.sun.target, this.ground, this.perspective, this.ortho, this.capGroup]);
    for (const o of this.scene.children) if (o.visible && !keep.has(o) && !(o as THREE.Light).isLight) (o.visible = false), hidden.push(o);
    const persp = { aspect: this.perspective.aspect };
    const ortho = { left: this.ortho.left, right: this.ortho.right };
    let studio: THREE.Texture | null = null;
    try {
      r.setPixelRatio(1);
      r.setSize(W, H, false);
      this.perspective.aspect = W / H;
      this.perspective.updateProjectionMatrix();
      const halfH = (this.ortho.top - this.ortho.bottom) / 2;
      this.ortho.left = -halfH * (W / H);
      this.ortho.right = halfH * (W / H);
      this.ortho.updateProjectionMatrix();
      if (background === null) {
        this.scene.background = null;
        r.setClearAlpha(0);
      } else if (background === 'studio') {
        const c = document.createElement('canvas');
        c.width = 2;
        c.height = 256;
        const g = c.getContext('2d')!;
        const grad = g.createLinearGradient(0, 0, 0, 256);
        grad.addColorStop(0, '#f4f6f9');
        grad.addColorStop(1, '#c9ced6');
        g.fillStyle = grad;
        g.fillRect(0, 0, 2, 256);
        studio = new THREE.CanvasTexture(c);
        studio.colorSpace = THREE.SRGBColorSpace;
        this.scene.background = studio;
      } else this.scene.background = new THREE.Color(background);
      if (this.renderMode) this.fitSun();
      for (const fn of this.beforeRender) fn();
      this.updateClipping();
      this.applySection();
      r.render(this.scene, this.camera);
      // réduction (lissage) dans un canevas 2D
      const out = document.createElement('canvas');
      out.width = width;
      out.height = height;
      const g = out.getContext('2d')!;
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(r.domElement, 0, 0, W, H, 0, 0, width, height);
      return await new Promise<Blob | null>((resolve) => out.toBlob((b) => resolve(b), 'image/png'));
    } finally {
      studio?.dispose();
      for (const o of hidden) o.visible = true;
      this.scene.background = oldBg;
      r.setClearAlpha(oldClear);
      r.setPixelRatio(oldRatio);
      r.setSize(oldSize.x, oldSize.y, false);
      this.perspective.aspect = persp.aspect;
      this.perspective.updateProjectionMatrix();
      Object.assign(this.ortho, ortho);
      this.ortho.updateProjectionMatrix();
      for (const fn of this.beforeRender) fn();
      this.renderNow();
    }
  }

  /** Taille de l'image du viewport (pixels CSS). */
  get viewSize(): { w: number; h: number } {
    return { w: this.container.clientWidth, h: this.container.clientHeight };
  }

  /** ZOOM Fenêtre : cadre le rectangle défini par deux points du plan de travail. */
  zoomWindow(a: THREE.Vector3, b: THREE.Vector3): void {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const d = new THREE.Vector3().subVectors(b, a);
    const w = Math.abs(d.dot(right)), h = Math.abs(d.dot(up));
    if (w < 1e-9 && h < 1e-9) return;
    const aspect = this.container.clientWidth / Math.max(this.container.clientHeight, 1);
    const halfH = Math.max(h, w / aspect) / 2;
    const center = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    const dir = new THREE.Vector3().subVectors(cam.position, this.controls.target).normalize();
    const dist = halfH / Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
    this.controls.target.copy(center);
    cam.position.copy(center).addScaledVector(dir, dist);
    if (cam === this.ortho) {
      this.ortho.zoom = 1;
      Object.assign(this.ortho, { left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH });
      this.ortho.updateProjectionMatrix();
    }
    this.controls.update();
    this.requestRender();
  }

  /** Zoom d'un facteur autour de la cible (> 1 = rapproche). */
  zoomFactor(f: number): void {
    if (this.camera === this.ortho) {
      this.ortho.zoom *= f;
      this.ortho.updateProjectionMatrix();
    } else {
      const offset = new THREE.Vector3().subVectors(this.camera.position, this.controls.target).divideScalar(f);
      this.camera.position.copy(this.controls.target).add(offset);
    }
    this.controls.update();
    this.requestRender();
  }

  /** Taille d'un pixel écran au niveau de la cible (accrochages, tolérance de sélection). */
  worldUnitsPerPixel(): number {
    const h = Math.max(this.container.clientHeight, 1);
    if (this.camera === this.ortho) return (this.ortho.top - this.ortho.bottom) / this.ortho.zoom / h;
    const d = this.camera.position.distanceTo(this.controls.target);
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2))) / h;
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.perspective.aspect = w / h;
    this.perspective.updateProjectionMatrix();
    const halfH = (this.ortho.top - this.ortho.bottom) / 2;
    this.ortho.left = -halfH * (w / h);
    this.ortho.right = halfH * (w / h);
    this.ortho.updateProjectionMatrix();
    this.requestRender();
  }

  // =========================================================================
  // Interaction gizmo
  // =========================================================================

  private bindPointer(): void {
    const el = this.renderer.domElement;
    const onMove = (e: PointerEvent) => {
      if (this.mode2d) return;
      if (this.gizmo.hover(e.clientX, e.clientY, el)) this.requestRender();
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || this.mode2d) return;
      const axis = this.gizmo.pick(e.clientX, e.clientY, el);
      if (axis) {
        e.stopImmediatePropagation(); // ne pas démarrer une sélection
        this.setView(AXIS_TO_VIEW[axis]);
      }
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerdown', onDown, { capture: true });
    this.disposers.push(() => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerdown', onDown, { capture: true });
    });
  }

  dispose(): void {
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    this.resizeObserver.disconnect();
    this.disposers.forEach((d) => d());
    this.controls.dispose();
    this.gizmo.dispose();
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
