/**
 * Grille adaptative infinie (plan XY du SCU), rendue entièrement dans le shader :
 *  - deux niveaux (mineur / majeur ×10) dont le pas suit la distance caméra en puissances de 10,
 *    avec fondu enchaîné entre niveaux pour éviter tout « saut » au zoom ;
 *  - lignes anti-crénelées d'épaisseur constante en pixels (fwidth) ;
 *  - axes X (rouge) et Y (vert) mis en évidence ; atténuation à l'horizon.
 * La variable GRIDUNIT de l'utilisateur fixe le pas minimal.
 */
import * as THREE from 'three';

const vertexShader = /* glsl */ `
  uniform mat4 uLocal;        // transformation propre de la grille (sans le SCU parent)
  varying vec3 vWorld;
  varying vec2 vPlane;        // coordonnées dans le plan XY du SCU
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vPlane = (uLocal * vec4(position, 1.0)).xy;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uStep;        // pas du niveau mineur courant
  uniform float uBlend;       // 0..1 : progression vers le niveau suivant
  uniform vec3  uMinorColor;
  uniform vec3  uMajorColor;
  uniform vec3  uAxisX;
  uniform vec3  uAxisY;
  uniform vec3  uCameraPos;
  uniform float uFadeDistance;
  varying vec3 vWorld;
  varying vec2 vPlane;

  float gridLine(vec2 p, float step, float widthPx) {
    vec2 coord = p / step;
    vec2 d = fwidth(coord);
    vec2 g = abs(fract(coord - 0.5) - 0.5) / d;
    return 1.0 - min(min(g.x, g.y) / widthPx, 1.0);
  }

  void main() {
    vec2 p = vPlane;
    float minor = gridLine(p, uStep, 1.0) * (1.0 - uBlend);
    float mid   = gridLine(p, uStep * 10.0, 1.0);
    float major = gridLine(p, uStep * 100.0, 1.5) * uBlend;

    vec3 color = uMinorColor;
    float alpha = max(minor * 0.35, mid * 0.55);
    if (major > 0.0 || mid > 0.0) color = mix(uMinorColor, uMajorColor, max(mid, major));
    alpha = max(alpha, major * 0.8);

    // axes
    vec2 dp = fwidth(p);
    float ax = 1.0 - min(abs(p.y) / (dp.y * 1.5), 1.0);
    float ay = 1.0 - min(abs(p.x) / (dp.x * 1.5), 1.0);
    if (ax > 0.0) { color = mix(color, uAxisX, ax); alpha = max(alpha, ax); }
    if (ay > 0.0) { color = mix(color, uAxisY, ay); alpha = max(alpha, ay); }

    // fondu en distance (évite le moiré à l'horizon)
    float dist = length(vWorld - uCameraPos);
    alpha *= 1.0 - smoothstep(uFadeDistance * 0.5, uFadeDistance, dist);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

export class AdaptiveGrid extends THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  /** Pas minimal (GRIDUNIT). */
  baseStep = 1;

  constructor() {
    super(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uStep: { value: 1 },
          uBlend: { value: 0 },
          uMinorColor: { value: new THREE.Color(0x3a4350) },
          uMajorColor: { value: new THREE.Color(0x56616f) },
          uAxisX: { value: new THREE.Color(0xd9534f) },
          uAxisY: { value: new THREE.Color(0x5cb85c) },
          uCameraPos: { value: new THREE.Vector3() },
          uFadeDistance: { value: 1000 },
          uLocal: { value: new THREE.Matrix4() },
        },
      }),
    );
    this.name = 'AdaptiveGrid';
    this.frustumCulled = false;
    this.renderOrder = -1;
  }

  /**
   * À appeler avant chaque rendu : recentre le plan et choisit le niveau de détail.
   * La grille est enfant du repère SCU ; `target` est la cible caméra en coordonnées SCG.
   */
  update(camera: THREE.Camera, target: THREE.Vector3): void {
    const distance =
      camera instanceof THREE.OrthographicCamera
        ? (camera.top - camera.bottom) / camera.zoom
        : camera.position.distanceTo(target);
    const raw = Math.max(distance / 50, this.baseStep);
    const level = Math.log10(raw / this.baseStep);
    const u = this.material.uniforms;
    u.uStep!.value = this.baseStep * Math.pow(10, Math.floor(level));
    u.uBlend!.value = level - Math.floor(level);
    // en parallèle, la distance réelle de la caméra est arbitraire : on la ramène à l'échelle de la vue
    if (camera instanceof THREE.OrthographicCamera) u.uCameraPos!.value.subVectors(camera.position, target).setLength(distance).add(target);
    else u.uCameraPos!.value.copy(camera.position);
    u.uFadeDistance!.value = distance * 8;
    const size = distance * 20;
    const local = this.parent ? this.parent.worldToLocal(target.clone()) : target;
    this.scale.set(size, size, 1);
    this.position.set(local.x, local.y, 0);
    this.updateMatrix();
    u.uLocal!.value.copy(this.matrix);
  }

  /** Pas courant, utilisé par l'accrochage à la grille (SNAP adaptatif). */
  get currentStep(): number {
    return this.material.uniforms.uStep!.value as number;
  }
}
