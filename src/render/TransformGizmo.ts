/**
 * Manipulateur 3D : flèches de déplacement le long de X, Y, Z et anneaux de
 * rotation autour de ces axes, posés au centre de la sélection, à taille constante à l'écran.
 * Ne fait qu'afficher et désigner : le glisser est géré par Interaction.
 */
import * as THREE from 'three';
import type { Vec3 } from '../core/commands/types';
import type { CadViewport } from './CadViewport';

export type GizmoHandle = { kind: 'move' | 'rotate'; axis: 0 | 1 | 2 };

const COLORS = [0xff5555, 0x3fd65a, 0x4ea1ff];
const HOT = 0xffd400;
/** Taille du manipulateur à l'écran (px). */
const SIZE = 95;

export class TransformGizmo {
  readonly group = new THREE.Group();
  private readonly hits: THREE.Mesh[] = [];
  private readonly visuals = new Map<string, THREE.Mesh[]>();
  private origin = new THREE.Vector3();
  private hot = '';
  private readonly raycaster = new THREE.Raycaster();

  constructor(private readonly vp: CadViewport) {
    this.group.name = 'TransformGizmo';
    this.group.visible = false;
    this.group.renderOrder = 20;
    const basic = (color: number, opacity = 1) =>
      new THREE.MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity, toneMapped: false });
    const invisible = new THREE.MeshBasicMaterial({ visible: false });
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    const up = new THREE.Vector3(0, 1, 0);
    axes.forEach((dir, i) => {
      const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
      // flèche : tige + cône (unité = SIZE px)
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.78, 8), basic(COLORS[i]!));
      shaft.position.copy(dir.clone().multiplyScalar(0.39 + 0.12));
      shaft.quaternion.copy(q);
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.2, 16), basic(COLORS[i]!));
      cone.position.copy(dir.clone().multiplyScalar(1.0));
      cone.quaternion.copy(q);
      const hit = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.0, 8), invisible);
      hit.position.copy(dir.clone().multiplyScalar(0.6));
      hit.quaternion.copy(q);
      hit.userData.handle = { kind: 'move', axis: i as 0 | 1 | 2 } satisfies GizmoHandle;
      this.add(`move${i}`, [shaft, cone], hit);
      // anneau de rotation : dans le plan perpendiculaire à l'axe
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.01, 6, 72), basic(COLORS[i]!, 0.85));
      const ringHit = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.06, 6, 48), invisible);
      const rq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      ring.quaternion.copy(rq);
      ringHit.quaternion.copy(rq);
      ringHit.userData.handle = { kind: 'rotate', axis: i as 0 | 1 | 2 } satisfies GizmoHandle;
      this.add(`rotate${i}`, [ring], ringHit);
    });
    const center = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12), basic(0xe6edf3, 0.9));
    this.group.add(center);
    this.group.traverse((o) => (o.renderOrder = 20));
    vp.scene.add(this.group);
    vp.beforeRender.add(this.onFrame);
  }

  private add(key: string, meshes: THREE.Mesh[], hit: THREE.Mesh): void {
    this.visuals.set(key, meshes);
    this.group.add(...meshes, hit);
    this.hits.push(hit);
  }

  dispose(): void {
    this.vp.beforeRender.delete(this.onFrame);
    this.vp.scene.remove(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    });
  }

  get visible(): boolean {
    return this.group.visible;
  }

  /** Affiche le manipulateur en `p` (null = masqué). */
  show(p: Vec3 | null): void {
    const was = this.group.visible;
    this.group.visible = !!p;
    if (p) this.origin.set(p.x, p.y, p.z);
    if (was || p) this.vp.requestRender();
  }

  get position(): Vec3 {
    return { x: this.origin.x, y: this.origin.y, z: this.origin.z };
  }

  /** Échelle : SIZE px à l'écran, à la distance du manipulateur. */
  private scaleNow(): number {
    const cam = this.vp.activeCamera as THREE.PerspectiveCamera | THREE.OrthographicCamera;
    const h = Math.max(this.vp.renderer.domElement.clientHeight, 1);
    if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
      const o = cam as THREE.OrthographicCamera;
      return ((o.top - o.bottom) / o.zoom / h) * SIZE;
    }
    const p = cam as THREE.PerspectiveCamera;
    const d = Math.max(p.position.distanceTo(this.origin), 1e-9);
    return ((2 * d * Math.tan(THREE.MathUtils.degToRad(p.fov / 2))) / h) * SIZE;
  }

  private readonly onFrame = () => {
    if (!this.group.visible) return;
    const s = this.scaleNow();
    this.group.position.copy(this.origin);
    this.group.scale.setScalar(s);
    this.group.updateMatrixWorld(true);
  };

  /** Poignée sous le rayon (coordonnées normalisées -1..1). */
  pick(ndc: THREE.Vector2): GizmoHandle | null {
    if (!this.group.visible) return null;
    this.onFrame();
    this.raycaster.setFromCamera(ndc, this.vp.activeCamera);
    const hits = this.raycaster.intersectObjects(this.hits, false);
    // une flèche passe avant un anneau quand les deux sont sous le curseur
    hits.sort((a, b) => Number((a.object.userData.handle as GizmoHandle).kind === 'rotate') - Number((b.object.userData.handle as GizmoHandle).kind === 'rotate') || a.distance - b.distance);
    return (hits[0]?.object.userData.handle as GizmoHandle | undefined) ?? null;
  }

  /** Met une poignée en surbrillance (jaune). */
  highlight(h: GizmoHandle | null): void {
    const key = h ? `${h.kind}${h.axis}` : '';
    if (key === this.hot) return;
    for (const [k, meshes] of this.visuals) {
      const axis = Number(k.slice(-1));
      for (const m of meshes) (m.material as THREE.MeshBasicMaterial).color.setHex(k === key ? HOT : COLORS[axis]!);
    }
    this.hot = key;
    this.vp.requestRender();
  }
}
