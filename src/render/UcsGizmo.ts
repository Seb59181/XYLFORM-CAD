/**
 * Gizmo d'orientation SCU (UCS) : trièdre X/Y/Z dessiné dans un coin du viewport, qui suit la
 * rotation de la caméra. Cliquer une extrémité d'axe (pastille) aligne la vue sur cet axe
 * (comme les faces du cube de vue) ; cliquer le centre restaure l'isométrique SO.
 *
 * Rendu dans une scène séparée avec scissor : il ne subit ni la profondeur, ni le
 * zoom, ni les plans de coupe de la scène principale.
 */
import * as THREE from 'three';

export type AxisName = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z' | 'ISO';

const AXES: { name: Exclude<AxisName, 'ISO'>; dir: THREE.Vector3; color: number; label?: string }[] = [
  { name: '+X', dir: new THREE.Vector3(1, 0, 0), color: 0xe5534b, label: 'X' },
  { name: '+Y', dir: new THREE.Vector3(0, 1, 0), color: 0x57ab5a, label: 'Y' },
  { name: '+Z', dir: new THREE.Vector3(0, 0, 1), color: 0x539bf5, label: 'Z' },
  { name: '-X', dir: new THREE.Vector3(-1, 0, 0), color: 0xe5534b },
  { name: '-Y', dir: new THREE.Vector3(0, -1, 0), color: 0x57ab5a },
  { name: '-Z', dir: new THREE.Vector3(0, 0, -1), color: 0x539bf5 },
];

function labelSprite(text: string, color: number): THREE.Sprite {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#10141a';
  ctx.font = 'bold 36px "Segoe UI", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.scale.setScalar(0.42);
  return sprite;
}

export class UcsGizmo {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);
  /** Taille en pixels CSS. */
  size = 120;
  /** Marge depuis le coin bas-gauche (convention habituelle pour l'icône SCU). */
  margin = 12;
  private readonly root = new THREE.Group();
  private readonly pickables: THREE.Object3D[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private hovered: THREE.Object3D | null = null;

  constructor() {
    this.scene.add(this.root);
    for (const axis of AXES) {
      const positive = !!axis.label;
      if (positive) {
        const shaft = new THREE.Mesh(
          new THREE.CylinderGeometry(0.035, 0.035, 0.85, 12),
          new THREE.MeshBasicMaterial({ color: axis.color }),
        );
        // CylinderGeometry est orientée selon +Y : on la tourne vers l'axe
        shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.dir);
        shaft.position.copy(axis.dir).multiplyScalar(0.425);
        this.root.add(shaft);
      }
      const knob = positive
        ? labelSprite(axis.label!, axis.color)
        : new THREE.Sprite(new THREE.SpriteMaterial({ color: axis.color, opacity: 0.45, transparent: true, depthTest: false }));
      if (!positive) knob.scale.setScalar(0.22);
      knob.position.copy(axis.dir).multiplyScalar(positive ? 1.05 : 0.9);
      knob.userData.axis = axis.name;
      this.root.add(knob);
      this.pickables.push(knob);
    }
    const center = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), new THREE.MeshBasicMaterial({ color: 0xc9d1d9 }));
    center.userData.axis = 'ISO';
    this.root.add(center);
    this.pickables.push(center);
    this.camera.position.set(0, 0, 5);
  }

  /** Rectangle du gizmo en pixels CSS (origine en bas à gauche, comme gl.viewport). */
  rect(): { x: number; y: number; w: number; h: number } {
    return { x: this.margin, y: this.margin, w: this.size, h: this.size };
  }

  /**
   * Rend le gizmo par-dessus la scène principale. L'orientation est celle de la caméra
   * principale, combinée à l'orientation du SCU courant (`ucsMatrix`).
   */
  render(renderer: THREE.WebGLRenderer, mainCamera: THREE.Camera, ucsMatrix?: THREE.Matrix4): void {
    if (ucsMatrix) this.root.quaternion.setFromRotationMatrix(ucsMatrix);
    else this.root.quaternion.identity();
    this.camera.quaternion.copy(mainCamera.quaternion);
    this.camera.position.set(0, 0, 5).applyQuaternion(mainCamera.quaternion);
    this.camera.up.copy(mainCamera.up);

    const { x, y, w, h } = this.rect();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, w, h);
    renderer.setViewport(x, y, w, h);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    const size = renderer.getSize(new THREE.Vector2());
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.autoClear = autoClear;
  }

  /** Coordonnées CSS relatives au canvas → axe cliqué, ou null si hors gizmo. */
  pick(clientX: number, clientY: number, canvas: HTMLCanvasElement): AxisName | null {
    const bounds = canvas.getBoundingClientRect();
    const { x, y, w, h } = this.rect();
    const px = clientX - bounds.left - x;
    const py = bounds.bottom - clientY - y; // repère bas-gauche
    if (px < 0 || py < 0 || px > w || py > h) return null;
    const ndc = new THREE.Vector2((px / w) * 2 - 1, (py / h) * 2 - 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
    return (hit?.object.userData.axis as AxisName | undefined) ?? null;
  }

  /** Surbrillance au survol ; renvoie true si un rendu est nécessaire. */
  hover(clientX: number, clientY: number, canvas: HTMLCanvasElement): boolean {
    const axis = this.pick(clientX, clientY, canvas);
    const obj = axis ? (this.pickables.find((o) => o.userData.axis === axis) ?? null) : null;
    if (obj === this.hovered) return false;
    this.hovered?.scale.multiplyScalar(1 / 1.25);
    obj?.scale.multiplyScalar(1.25);
    this.hovered = obj;
    canvas.style.cursor = obj ? 'pointer' : '';
    return true;
  }

  dispose(): void {
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh | THREE.Sprite;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material & { map?: THREE.Texture | null };
      mat?.map?.dispose();
      mat?.dispose?.();
    });
  }
}
