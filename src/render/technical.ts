/**
 * Style visuel « Technique » (dessin au trait, façon lignes cachées) : faces blanches non
 * éclairées, arêtes noires, arêtes cachées en tirets gris et contours apparents des surfaces
 * courbes (cylindres, sphères, congés), sur fond blanc.
 *
 * Les contours apparents sont tracés par la méthode de l'enveloppe inversée : les faces arrière
 * du solide, gonflées le long de leur normale d'une épaisseur constante en pixels, dépassent du
 * solide exactement sur sa silhouette.
 */
import * as THREE from 'three';

export const TECH_BACKGROUND = 0xffffff;
export const TECH_INK = '#141414';
export const TECH_HIDDEN = '#8a8f96';

const vertexShader = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_vertex>
  uniform float uThickness;
  uniform vec2 uResolution;
  void main() {
    #include <begin_vertex>
    #include <project_vertex>
    #include <clipping_planes_vertex>
    vec3 n = normalize(normalMatrix * normal);
    vec4 cn = projectionMatrix * vec4(n, 0.0);
    vec2 dir = length(cn.xy) > 1e-6 ? normalize(cn.xy) : vec2(0.0);
    gl_Position.xy += dir * uThickness * 2.0 / uResolution * gl_Position.w;
  }
`;

const fragmentShader = /* glsl */ `
  #include <common>
  #include <clipping_planes_pars_fragment>
  uniform vec3 uColor;
  void main() {
    #include <clipping_planes_fragment>
    gl_FragColor = vec4(uColor, 1.0);
  }
`;

/** Matériau des contours apparents (un seul, partagé : la résolution est mise à jour à chaque image). */
export function outlineMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    side: THREE.BackSide,
    clipping: true,
    uniforms: {
      uThickness: { value: 1.1 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uColor: { value: new THREE.Color(TECH_INK) },
    },
  });
}

/** Faces blanches non éclairées (laissent passer les arêtes devant elles). */
export function techFaceMaterial(doubleSide: boolean): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: doubleSide ? THREE.DoubleSide : THREE.FrontSide });
  m.toneMapped = false;
  return m;
}

/** Couleur d'un objet 2D sur fond blanc : le blanc (couleur 7) et les tons très clairs passent en noir. */
export function inkOnWhite(color: string): string {
  const c = new THREE.Color(color);
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return l > 0.8 ? TECH_INK : color;
}
