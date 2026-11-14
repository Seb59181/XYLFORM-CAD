/**
 * Icônes du ruban (SVG 32×32, traits à épaisseur constante à l'écran).
 * Couleurs : trait principal = currentColor, `A` = nouvel objet (bleu), `Y` = point (jaune).
 */
import type { JSX } from 'react';

const A = '#4ea1ff';
const Y = '#f2c94c';
const R = '#f85149';
const G = '#3fb950';
const F1 = '#7aa2d6';
const F2 = '#5276a6';
const F3 = '#39577f';

const dot = (x: number, y: number, c = Y) => <rect x={x - 1.8} y={y - 1.8} width={3.6} height={3.6} fill={c} stroke="none" />;
const label = (t: string, x = 16, y = 27, size = 8, color = 'currentColor') => (
  <text x={x} y={y} fontSize={size} fontWeight={700} fontFamily="Segoe UI, Arial, sans-serif" textAnchor="middle" fill={color} stroke="none">
    {t}
  </text>
);
const doc = (t: string, color: string) => (
  <>
    <path d="M8 3h11l6 6v20H8z" fill="#2b323c" />
    <path d="M19 3v6h6" />
    <rect x={5} y={15} width={22} height={10} rx={2} fill={color} stroke="none" />
    {label(t, 16, 23, t.length > 3 ? 6.5 : 7.5, '#fff')}
  </>
);
const cube = (face: 'top' | 'front' | 'right' | 'left' | 'back' | 'bottom' | 'iso') => {
  const top = 'M16 5l10 5-10 5-10-5z', front = 'M6 10l10 5v12L6 22z', right = 'M26 10l-10 5v12l10-5z';
  const hl = (d: string, on: boolean) => <path d={d} fill={on ? A : '#3a4350'} fillOpacity={on ? 0.85 : 1} />;
  return (
    <>
      {hl(top, face === 'top' || face === 'iso')}
      {hl(front, face === 'front' || face === 'iso')}
      {hl(right, face === 'right' || face === 'iso')}
      {face === 'left' && <path d="M6 10l-2 1v12l2-1z" fill={A} />}
      {face === 'left' && <path d="M3 9v14" stroke={A} strokeDasharray="2 2" />}
      {face === 'back' && <path d="M16 5v12l10-5" stroke={A} strokeDasharray="2 2" fill="none" />}
      {face === 'bottom' && <path d="M6 22l10 5 10-5-10-5z" stroke={A} strokeDasharray="2 2" fill="none" />}
    </>
  );
};
const box = (fill = true) => (
  <>
    <path d="M16 6l10 5-10 5-10-5z" fill={fill ? F1 : 'none'} />
    <path d="M6 11l10 5v11L6 22z" fill={fill ? F2 : 'none'} />
    <path d="M26 11l-10 5v11l10-5z" fill={fill ? F3 : 'none'} />
  </>
);
const magnifier = (inner: JSX.Element) => (
  <>
    <circle cx={13} cy={13} r={8} fill="#2b323c" />
    <path d="M19 19l8 8" strokeWidth={3} />
    {inner}
  </>
);
const lock = (x: number, y: number) => (
  <>
    <rect x={x} y={y + 4} width={9} height={7} rx={1} fill={Y} stroke="none" />
    <path d={`M${x + 2} ${y + 4}v-2a2.5 2.5 0 0 1 5 0v2`} stroke={Y} fill="none" />
  </>
);
const dimH = (y: number) => (
  <>
    <path d={`M6 ${y - 6}v8M26 ${y - 6}v8M6 ${y}h20`} />
    <path d={`M6 ${y}l4 -2v4zM26 ${y}l-4 -2v4z`} fill="currentColor" />
  </>
);

export const ICONS: Record<string, JSX.Element> = {
  // --- Dessin ---------------------------------------------------------------
  line: (
    <>
      <path d="M5 26L27 6" />
      {dot(5, 26)}
      {dot(27, 6)}
    </>
  ),
  pline: (
    <>
      <path d="M4 25l7-14 8 10 8-14" />
      {dot(4, 25)}
      {dot(11, 11)}
      {dot(19, 21)}
      {dot(27, 7)}
    </>
  ),
  circle: (
    <>
      <circle cx={16} cy={16} r={10} />
      <path d="M16 16l7 -7" stroke={A} />
      {dot(16, 16)}
    </>
  ),
  'circle-2p': (
    <>
      <circle cx={16} cy={16} r={10} />
      <path d="M6 16h20" stroke={A} />
      {dot(6, 16)}
      {dot(26, 16)}
    </>
  ),
  'circle-3p': (
    <>
      <circle cx={16} cy={16} r={10} />
      {dot(6, 16)}
      {dot(22, 8)}
      {dot(20, 25)}
    </>
  ),
  'circle-ttr': (
    <>
      <circle cx={16} cy={14} r={7} />
      <path d="M3 21h26M5 4l16 0" stroke={A} />
    </>
  ),
  arc: (
    <>
      <path d="M5 24A13 13 0 0 1 27 14" />
      {dot(5, 24)}
      {dot(13, 10)}
      {dot(27, 14)}
    </>
  ),
  rectangle: (
    <>
      <rect x={5} y={8} width={22} height={16} />
      {dot(5, 24)}
      {dot(27, 8)}
    </>
  ),
  polygon: <path d="M16 4l10.4 6v12L16 28 5.6 22V10z" />,
  ellipse: (
    <>
      <ellipse cx={16} cy={16} rx={12} ry={7} />
      {dot(16, 16)}
    </>
  ),
  spline: (
    <>
      <path d="M4 22C10 2 18 30 28 9" />
      {dot(4, 22)}
      {dot(16, 16)}
      {dot(28, 9)}
    </>
  ),
  point: (
    <>
      <path d="M16 8v16M8 16h16" strokeOpacity={0.5} />
      <circle cx={16} cy={16} r={3} fill={Y} stroke="none" />
    </>
  ),
  hatch: (
    <>
      <rect x={5} y={6} width={22} height={20} />
      <path d="M5 14l8-8M5 22l16-16M9 26l18-18M17 26l10-10" stroke={A} />
    </>
  ),
  text: (
    <>
      {label('A', 13, 25, 22)}
      <path d="M23 8v16M20 8h6M20 24h6" stroke={A} />
    </>
  ),
  helix: <path d="M9 27c14 0 14-4 0-4s14-4 0-4 14-4 0-4 14-4 0-4 14-4 0-4" stroke={A} />,
  // --- Cotes ---------------------------------------------------------------------
  dimaligned: (
    <>
      <path d="M6 22L22 6M10 26L26 10" strokeOpacity={0.5} />
      <path d="M8 24L24 8" stroke={A} />
      <path d="M8 24l1.5-4.5 3 3zM24 8l-4.5 1.5 3 3z" fill={A} stroke="none" />
    </>
  ),
  dimlinear: (
    <>
      {dimH(18)}
      {label('25', 16, 14, 8, A)}
    </>
  ),
  dimradius: (
    <>
      <circle cx={13} cy={18} r={9} />
      <path d="M13 18l7-7 6-6" stroke={A} />
      {label('R', 24, 22, 9, A)}
    </>
  ),
  dimdiameter: (
    <>
      <circle cx={16} cy={16} r={10} />
      <path d="M8 24L24 8" stroke={A} />
      <path d="M8 24l1.5-4.5 3 3zM24 8l-4.5 1.5 3 3z" fill={A} stroke="none" />
    </>
  ),
  dimangular: (
    <>
      <path d="M5 27L27 27M5 27L21 7" />
      <path d="M19 27a14 14 0 0 0-4.2-10" stroke={A} />
      {label('°', 24, 19, 10, A)}
    </>
  ),
  dimarc: (
    <>
      <path d="M5 25a12 12 0 0 1 22 0" />
      <path d="M8 20a9 9 0 0 1 16 0" stroke={A} strokeOpacity={0.5} />
      <path d="M11 12a6 3 0 0 1 10 0" stroke={A} />
    </>
  ),
  dimordinate: (
    <>
      <path d="M6 26V6M6 26h20" strokeOpacity={0.5} />
      <path d="M14 24V12M22 24V8" stroke={A} />
      {dot(14, 24)}
      {dot(22, 24)}
    </>
  ),
  dimcontinue: (
    <>
      <path d="M4 22V12M16 22V12M28 22V12" strokeOpacity={0.5} />
      <path d="M4 15h24" stroke={A} />
      <path d="M4 15l3-1.5v3zM16 15l-3-1.5v3zM16 15l3-1.5v3zM28 15l-3-1.5v3z" fill={A} stroke="none" />
    </>
  ),
  dimbaseline: (
    <>
      <path d="M4 26V8M16 26V14M28 26V8" strokeOpacity={0.5} />
      <path d="M4 18h12M4 11h24" stroke={A} />
      <path d="M4 18l3-1.5v3zM16 18l-3-1.5v3zM4 11l3-1.5v3zM28 11l-3-1.5v3z" fill={A} stroke="none" />
    </>
  ),
  dimstyle: (
    <>
      <path d="M4 12h24" stroke={A} />
      <path d="M4 12l4-2v4zM28 12l-4-2v4z" fill={A} stroke="none" />
      <path d="M4 8v8M28 8v8" strokeOpacity={0.5} />
      <path d="M6 22h20M6 27h12" strokeOpacity={0.7} />
    </>
  ),
  leader: (
    <>
      <path d="M5 27L15 13h12" stroke={A} />
      <path d="M5 27l1.5-5 3 2.2z" fill={A} stroke="none" />
      <path d="M17 9h10" strokeOpacity={0.6} />
    </>
  ),
  label: (
    <>
      <rect x={13} y={4} width={16} height={9} rx={1.5} stroke={A} />
      <path d="M13 13L6 24" stroke={A} />
      {dot(6, 24)}
      <path d="M4 28h14l-4-8H8z" strokeOpacity={0.5} />
    </>
  ),
  tapeguide: (
    <>
      <path d="M2 22h28" stroke={A} strokeDasharray="3 2" />
      <rect x={5} y={6} width={12} height={10} rx={2} />
      <path d="M17 13h9v3h-9" />
      <path d="M11 9v4" strokeOpacity={0.6} />
    </>
  ),
  protractor: (
    <>
      <path d="M4 24h24a12 12 0 0 0-24 0z" />
      <path d="M16 24L26 8" stroke={A} strokeDasharray="3 2" />
      {dot(16, 24)}
    </>
  ),
  block: (
    <>
      <path d="M16 4l11 6v12l-11 6-11-6V10z" />
      <path d="M5 10l11 6 11-6M16 16v12" stroke={A} />
    </>
  ),
  insert: (
    <>
      <path d="M18 8l9 5v10l-9 5-9-5V13z" strokeOpacity={0.6} />
      <path d="M3 4l8 8M11 6v6H5" stroke={A} />
    </>
  ),
  components: (
    <>
      <rect x={4} y={4} width={10} height={10} />
      <rect x={18} y={4} width={10} height={10} stroke={A} />
      <rect x={4} y={18} width={10} height={10} stroke={A} />
      <rect x={18} y={18} width={10} height={10} />
    </>
  ),
  sectionplane: (
    <>
      <path d="M6 10l14-4 6 6v14l-14 4-6-6z" strokeOpacity={0.5} />
      <path d="M4 16l18-6v12L4 28z" stroke={A} fill="rgba(255,170,60,0.25)" />
    </>
  ),
  scene: (
    <>
      <rect x={3} y={8} width={20} height={16} rx={2} />
      <path d="M23 13l6-3v12l-6-3" stroke={A} />
      <path d="M7 20l5-6 4 4 3-3 2 5" strokeOpacity={0.6} />
    </>
  ),
  present: (
    <>
      <rect x={3} y={5} width={26} height={17} rx={1.5} />
      <path d="M13 9.5v8l7-4z" fill={A} stroke="none" />
      <path d="M16 22v5M10 28h12" />
    </>
  ),
  balloon: (
    <>
      <circle cx={20} cy={11} r={7} stroke={A} />
      <path d="M15 16L5 26" />
      {dot(5, 26)}
      <path d="M18.5 8.5l2-1.5v8" strokeOpacity={0.8} />
    </>
  ),
  bom: (
    <>
      <rect x={4} y={5} width={24} height={22} />
      <path d="M4 11h24M4 17h24M4 22h24M10 5v22" strokeOpacity={0.6} />
      <path d="M4 11h24" stroke={A} />
    </>
  ),
  detailview: (
    <>
      <circle cx={10} cy={12} r={6} stroke={A} strokeDasharray="3 2" />
      <circle cx={22} cy={22} r={7} />
      <path d="M15 16l3 2" stroke={A} />
    </>
  ),
  sectionview: (
    <>
      <path d="M4 6v20M28 6v20" stroke={A} />
      <path d="M2 6h5M25 6h5" stroke={A} />
      <rect x={9} y={10} width={14} height={12} />
      <path d="M9 18l4-8M13 22l8-12M18 22l5-9" strokeOpacity={0.6} />
    </>
  ),
  holecallout: (
    <>
      <circle cx={9} cy={22} r={5} />
      <path d="M12 19l6-9h10" stroke={A} />
      <path d="M19 7h3M24 7h4" strokeOpacity={0.7} />
    </>
  ),
  // --- Modification -------------------------------------------------------------------
  move: (
    <path d="M16 4v24M4 16h24M16 4l-3 4h6zM16 28l-3-4h6zM4 16l4-3v6zM28 16l-4-3v6z" fill="currentColor" />
  ),
  copy: (
    <>
      <rect x={4} y={10} width={14} height={14} />
      <rect x={14} y={5} width={14} height={14} stroke={A} fill="#2b323c" />
    </>
  ),
  rotate: (
    <>
      <path d="M8 22A10 10 0 1 1 22 25" stroke={A} />
      <path d="M22 25l-1-5 5 2z" fill={A} stroke="none" />
      <rect x={11} y={11} width={10} height={10} strokeOpacity={0.6} />
      {dot(16, 16)}
    </>
  ),
  mirror: (
    <>
      <path d="M16 3v26" strokeDasharray="3 2" strokeOpacity={0.7} />
      <path d="M13 8L4 24h9z" />
      <path d="M19 8l9 16h-9z" stroke={A} />
    </>
  ),
  scale: (
    <>
      <rect x={4} y={14} width={10} height={10} />
      <rect x={4} y={4} width={22} height={20} stroke={A} strokeDasharray="3 2" />
      <path d="M14 14l10-8" stroke={A} />
    </>
  ),
  offset: (
    <>
      <path d="M4 24c4-14 12-18 24-18" />
      <path d="M9 27c3-10 9-14 19-14" stroke={A} />
    </>
  ),
  stretch: (
    <>
      <path d="M4 8h12v16H4z" />
      <path d="M16 8l10 0v16H16" stroke={A} strokeDasharray="3 2" />
      <path d="M19 16h8l-3-3m3 3l-3 3" stroke={A} />
    </>
  ),
  fillet: (
    <>
      <path d="M5 27V17M15 5h12" />
      <path d="M5 17A12 12 0 0 1 15 5" stroke={A} />
      <path d="M5 17V5h10" strokeDasharray="2 2" strokeOpacity={0.4} />
    </>
  ),
  chamfer: (
    <>
      <path d="M5 27V15M17 5h10" />
      <path d="M5 15L17 5" stroke={A} />
      <path d="M5 15V5h12" strokeDasharray="2 2" strokeOpacity={0.4} />
    </>
  ),
  trim: (
    <>
      <path d="M4 16h24" />
      <path d="M16 4v12" />
      <path d="M16 16v12" stroke={R} strokeDasharray="3 2" />
      <path d="M22 22l6 6M28 22l-6 6" stroke={R} />
    </>
  ),
  extend: (
    <>
      <path d="M26 4v24" />
      <path d="M4 16h10" />
      <path d="M14 16h12" stroke={A} strokeDasharray="3 2" />
      <path d="M26 16l-4-3v6z" fill={A} stroke="none" />
    </>
  ),
  break: (
    <>
      <path d="M4 22l8-6M20 10l8-6" />
      {dot(12, 16)}
      {dot(20, 10)}
    </>
  ),
  breakpoint: (
    <>
      <path d="M4 24L28 8" />
      <circle cx={16} cy={16} r={3} fill={A} stroke="none" />
    </>
  ),
  divide: (
    <>
      <path d="M4 16h24" />
      {[8, 14, 20, 26].map((x) => (
        <circle key={x} cx={x - 1} cy={16} r={2} fill={Y} stroke="none" />
      ))}
    </>
  ),
  join: (
    <>
      <path d="M4 22l8-8" />
      <path d="M20 14l8 8" />
      <path d="M12 14h8" stroke={A} />
    </>
  ),
  explode: (
    <>
      <rect x={10} y={10} width={12} height={12} />
      <path d="M8 8L3 3M24 8l5-5M8 24l-5 5M24 24l5 5" stroke={A} />
    </>
  ),
  erase: (
    <>
      <path d="M13 26L5 18 18 5l10 10-11 11z" fill="#2b323c" />
      <path d="M10 13l10 10" />
      <path d="M13 26h14" stroke={R} />
    </>
  ),
  arrayrect: (
    <>
      {[5, 13, 21].flatMap((x) => [5, 13, 21].map((y) => <rect key={`${x}${y}`} x={x} y={y} width={6} height={6} stroke={x === 5 && y === 21 ? 'currentColor' : A} />))}
    </>
  ),
  arraypolar: (
    <>
      <circle cx={16} cy={16} r={10} strokeDasharray="2 3" strokeOpacity={0.5} />
      {[0, 60, 120, 180, 240, 300].map((a) => (
        <circle key={a} cx={16 + 10 * Math.cos((a * Math.PI) / 180)} cy={16 + 10 * Math.sin((a * Math.PI) / 180)} r={2.5} stroke={a === 0 ? 'currentColor' : A} fill="#2b323c" />
      ))}
    </>
  ),
  matchprop: (
    <>
      <path d="M6 26l9-9" strokeWidth={3} />
      <path d="M15 17l3 3 9-9-3-3z" fill={A} stroke="none" />
    </>
  ),
  // --- Calques et utilitaires ----------------------------------------------------------
  layers: (
    <>
      <path d="M16 20l12-6-12-6-12 6z" fill="#3a4350" />
      <path d="M4 18l12 6 12-6" stroke={A} />
      <path d="M4 22l12 6 12-6" stroke={Y} />
    </>
  ),
  layerstate: (
    <>
      <path d="M14 16l10-5-10-5-10 5z" fill="#3a4350" />
      <path d="M4 15l10 5 10-5" stroke={A} />
      <rect x={18} y={18} width={11} height={11} rx={1} fill={A} stroke="none" />
      <rect x={21} y={18} width={5} height={4} fill="#fff" stroke="none" />
    </>
  ),
  laycur: (
    <>
      <path d="M14 16l10-5-10-5-10 5z" fill="#3a4350" />
      <path d="M4 15l10 5 10-5" stroke={A} />
      <path d="M17 24l4 4 8-9" stroke={G} strokeWidth={2.5} />
    </>
  ),
  dist: (
    <>
      <path d="M4 22L28 10" stroke={A} />
      <path d="M4 22l3.8-3.5 1.2 3.5zM28 10l-3.8 3.5-1.2-3.5z" fill={A} stroke="none" />
      <path d="M8 28l20-10" strokeOpacity={0.5} />
    </>
  ),
  area: <path d="M5 24l4-16 14 4 4 12z" fill={A} fillOpacity={0.35} stroke={A} />,
  id: (
    <>
      <path d="M16 4v24M4 16h24" strokeOpacity={0.6} />
      <circle cx={16} cy={16} r={3} fill={Y} stroke="none" />
      {label('xy', 24, 11, 7, A)}
    </>
  ),
  list: <path d="M8 8h18M8 14h18M8 20h18M8 26h12M4 8h1M4 14h1M4 20h1M4 26h1" />,
  selectall: (
    <>
      <rect x={4} y={4} width={24} height={20} strokeDasharray="3 2" stroke={A} />
      <path d="M17 15l9 12-4-1-2 4z" fill="currentColor" />
    </>
  ),
  paste: (
    <>
      <rect x={6} y={6} width={18} height={22} rx={2} fill="#2b323c" />
      <rect x={11} y={3} width={8} height={5} rx={1} fill={Y} stroke="none" />
      <path d="M10 14h10M10 19h10M10 24h6" stroke={A} />
    </>
  ),
  copyclip: (
    <>
      <path d="M6 9h12v18H6z" fill="#2b323c" />
      <path d="M12 5h14v18H12z" fill="#2b323c" stroke={A} />
    </>
  ),
  cut: (
    <>
      <circle cx={9} cy={23} r={4} />
      <circle cx={23} cy={23} r={4} />
      <path d="M11 20L24 4M21 20L8 4" stroke={A} />
    </>
  ),
  // --- Fichiers ----------------------------------------------------------------------------
  new: (
    <>
      <path d="M8 3h11l6 6v20H8z" fill="#2b323c" />
      <path d="M19 3v6h6" />
      <path d="M16 14v10M11 19h10" stroke={A} strokeWidth={2.4} />
    </>
  ),
  open: (
    <>
      <path d="M3 9h9l3 3h14v15H3z" fill="#c9a43e" stroke="none" />
      <path d="M3 27l5-11h22l-5 11z" fill={Y} stroke="none" />
    </>
  ),
  save: (
    <>
      <path d="M5 5h18l4 4v18H5z" fill={A} stroke="none" />
      <rect x={9} y={5} width={12} height={8} fill="#e6edf3" stroke="none" />
      <rect x={9} y={18} width={14} height={9} fill="#1c2128" stroke="none" />
    </>
  ),
  saveas: (
    <>
      <path d="M4 6h16l3 3v15H4z" fill={A} stroke="none" />
      <rect x={7} y={6} width={10} height={6} fill="#e6edf3" stroke="none" />
      <path d="M18 28l2-6 8-8 4 4-8 8z" fill={Y} stroke="none" />
    </>
  ),
  import: (
    <>
      <path d="M12 3h9l6 6v20H12z" fill="#2b323c" />
      <path d="M3 18h14l-4-4m4 4l-4 4" stroke={A} strokeWidth={2.2} />
    </>
  ),
  export: (
    <>
      <path d="M5 3h9l6 6v20H5z" fill="#2b323c" />
      <path d="M14 18h14l-4-4m4 4l-4 4" stroke={A} strokeWidth={2.2} />
    </>
  ),
  dwg: doc('DWG', '#c0392b'),
  dxf: doc('DXF', '#2d7d46'),
  pdf: doc('PDF', '#b8322a'),
  image: (
    <>
      <rect x={4} y={6} width={24} height={20} rx={2} fill="#2b323c" />
      <path d="M6 23l7-8 5 5 3-3 5 6" stroke={A} />
      <circle cx={21} cy={11} r={2.4} fill={Y} stroke="none" />
    </>
  ),
  // fond de plan : feuille estompée derrière un trait du dessin
  xref: (
    <>
      <rect x={4} y={5} width={19} height={16} fill="#2b323c" stroke="#6e7a8a" strokeDasharray="2.5 2" />
      <path d="M7 17l5-6 4 3 4-5" stroke="#6e7a8a" />
      <path d="M12 27l16-13" stroke={A} strokeWidth={2} />
      {dot(12, 27)}
      {dot(28, 14)}
    </>
  ),
  'xref-attach': (
    <>
      <rect x={3} y={4} width={19} height={16} fill="#2b323c" stroke="#6e7a8a" strokeDasharray="2.5 2" />
      <path d="M6 16l5-6 4 3 4-5" stroke="#6e7a8a" />
      <path d="M17 18l10 10M27 21v7h-7" stroke={G} strokeWidth={2} />
    </>
  ),
  'xref-palette': (
    <>
      <rect x={5} y={4} width={22} height={24} rx={2} fill="#2b323c" />
      <path d="M9 10h14M9 16h14M9 22h9" />
      <rect x={7} y={8} width={3} height={3} fill={G} stroke="none" />
      <rect x={7} y={14} width={3} height={3} fill={G} stroke="none" />
      <rect x={7} y={20} width={3} height={3} fill="#6e7a8a" stroke="none" />
    </>
  ),
  reload: <path d="M25 11a10 10 0 1 0 1 8M25 4v7h-7" stroke={A} strokeWidth={2} />,
  unload: <path d="M8 8l16 16M24 8L8 24" stroke={R} strokeWidth={2} />,
  bind: (
    <>
      <path d="M13 19l6-6" stroke={A} strokeWidth={2} />
      <path d="M10 16l-3 3a4 4 0 0 0 6 6l3-3M22 16l3-3a4 4 0 0 0-6-6l-3 3" strokeWidth={2} />
    </>
  ),
  step: doc('STEP', '#7952b3'),
  stl: doc('STL', '#d35400'),
  '3mf': doc('3MF', '#16a085'),
  svg: doc('SVG', '#b7950b'),
  png: doc('PNG', '#2874a6'),
  undo: <path d="M10 8L4 13l6 5M4 13h14a8 8 0 0 1 0 16h-6" />,
  redo: <path d="M22 8l6 5-6 5M28 13H14a8 8 0 0 0 0 16h6" />,
  print3d: (
    <>
      <path d="M4 4h24v4H4zM6 8v20M26 8v20M4 28h24" />
      <path d="M13 10h6l-3 5z" fill={A} stroke="none" />
      <path d="M10 26h12l-2-7h-8z" fill={F2} />
    </>
  ),
  // --- Paramétrique ---------------------------------------------------------------------------
  gccoincident: (
    <>
      <path d="M4 26l12-10M16 16l12-12" />
      <circle cx={16} cy={16} r={3.5} fill={A} stroke="none" />
    </>
  ),
  gchorizontal: (
    <>
      <path d="M4 20h24" stroke={A} strokeWidth={2.4} />
      {label('H', 16, 14, 10)}
    </>
  ),
  gcvertical: (
    <>
      <path d="M12 4v24" stroke={A} strokeWidth={2.4} />
      {label('V', 22, 20, 10)}
    </>
  ),
  gcparallel: <path d="M5 22L19 6M13 26L27 10" stroke={A} strokeWidth={2.2} />,
  gcperpendicular: <path d="M6 26h20M16 26V6" stroke={A} strokeWidth={2.2} />,
  gctangent: (
    <>
      <circle cx={16} cy={18} r={8} />
      <path d="M3 10h26" stroke={A} strokeWidth={2.2} />
    </>
  ),
  gcconcentric: (
    <>
      <circle cx={16} cy={16} r={11} />
      <circle cx={16} cy={16} r={6} stroke={A} />
      {dot(16, 16)}
    </>
  ),
  gcequal: (
    <>
      <path d="M4 8h12M16 24h12" />
      {label('=', 22, 15, 14, A)}
    </>
  ),
  gcfix: (
    <>
      <path d="M4 26L20 10" />
      {lock(17, 3)}
    </>
  ),
  autoconstrain: (
    <>
      <rect x={4} y={10} width={16} height={14} />
      <path d="M22 3l-5 10h5l-4 10 10-13h-5l4-7z" fill={Y} stroke="none" />
    </>
  ),
  dcaligned: (
    <>
      <path d="M6 22L22 6" stroke={A} />
      <path d="M6 22l1.5-4.5 3 3zM22 6l-4.5 1.5 3 3z" fill={A} stroke="none" />
      {lock(19, 17)}
    </>
  ),
  dchorizontal: (
    <>
      {dimH(12)}
      {lock(12, 17)}
    </>
  ),
  dcvertical: (
    <>
      <path d="M6 6h8M6 26h8M10 6v20" />
      <path d="M10 6l-2 4h4zM10 26l-2-4h4z" fill="currentColor" />
      {lock(18, 12)}
    </>
  ),
  dcradius: (
    <>
      <circle cx={12} cy={16} r={8} />
      <path d="M12 16l6-6" stroke={A} />
      {lock(19, 17)}
    </>
  ),
  dcdiameter: (
    <>
      <circle cx={12} cy={16} r={8} />
      <path d="M6 22L18 10" stroke={A} />
      {lock(19, 17)}
    </>
  ),
  dcangular: (
    <>
      <path d="M4 26h20M4 26L18 8" />
      <path d="M14 26a10 10 0 0 0-4-8" stroke={A} />
      {lock(19, 12)}
    </>
  ),
  delcon: (
    <>
      <path d="M4 20h18" stroke={A} />
      {label('H', 12, 14, 10)}
      <path d="M20 20l8 8M28 20l-8 8" stroke={R} strokeWidth={2.2} />
    </>
  ),
  showcon: (
    <>
      <path d="M3 16c6-9 20-9 26 0-6 9-20 9-26 0z" />
      <circle cx={16} cy={16} r={4} fill={A} stroke="none" />
    </>
  ),
  params: label('f(x)', 16, 21, 12, A),
  // --- Vue -------------------------------------------------------------------------------------------
  'view-top': cube('top'),
  'view-front': cube('front'),
  'view-right': cube('right'),
  'view-left': cube('left'),
  'view-back': cube('back'),
  'view-bottom': cube('bottom'),
  'view-iso': cube('iso'),
  perspective: <path d="M4 10l10-4v20l-10-4zM14 6l14-2v24l-14-2" />,
  parallel: <path d="M4 8h12v16H4zM16 8l12-4v16l-12 4" />,
  'vs-realistic': (
    <>
      <defs>
        <radialGradient id="ico-sph" cx="35%" cy="30%" r="70%">
          <stop offset="0" stopColor="#e6edf3" />
          <stop offset="1" stopColor="#36506f" />
        </radialGradient>
      </defs>
      <circle cx={16} cy={16} r={11} fill="url(#ico-sph)" />
    </>
  ),
  'vs-technical': (
    <>
      <rect x={4} y={4} width={24} height={24} rx={2} fill="#f4f4f0" stroke="none" />
      <path d="M8 22l8-4 8 4-8 4zM8 22V12l8-4 8 4v10M16 18V8" stroke="#111" />
      <path d="M8 12l8 4 8-4" stroke="#111" strokeDasharray="2 1.6" strokeOpacity={0.7} />
    </>
  ),
  'named-views': (
    <>
      <rect x={4} y={9} width={18} height={14} rx={2} />
      <path d="M22 13l6-3v12l-6-3z" />
      <path d="M8 27h10" stroke={A} />
      {dot(13, 16, A)}
    </>
  ),
  'vs-shaded': <circle cx={16} cy={16} r={11} fill={F2} stroke="none" />,
  'vs-wire': (
    <>
      <circle cx={16} cy={16} r={11} />
      <ellipse cx={16} cy={16} rx={11} ry={4} />
      <ellipse cx={16} cy={16} rx={4} ry={11} />
    </>
  ),
  'vs-xray': (
    <>
      <circle cx={16} cy={16} r={11} fill={A} fillOpacity={0.3} />
      <ellipse cx={16} cy={16} rx={11} ry={4} strokeOpacity={0.6} />
    </>
  ),
  'zoom-ext': magnifier(<path d="M9 10V9h2M17 10V9h-2M9 16v1h2M17 16v1h-2" stroke={A} />),
  'zoom-win': magnifier(<rect x={9} y={10} width={8} height={6} stroke={A} />),
  'zoom-in': magnifier(<path d="M13 9v8M9 13h8" stroke={A} strokeWidth={2} />),
  'zoom-out': magnifier(<path d="M9 13h8" stroke={A} strokeWidth={2} />),
  orbit: (
    <>
      <circle cx={16} cy={16} r={6} fill={F2} stroke="none" />
      <ellipse cx={16} cy={16} rx={13} ry={6} stroke={A} transform="rotate(-20 16 16)" />
      <path d="M26 9l2 3-4 1z" fill={A} stroke="none" />
    </>
  ),
  pan: <path d="M11 17V8a2 2 0 0 1 4 0v7V6a2 2 0 0 1 4 0v9-6a2 2 0 0 1 4 0v10c0 6-3 9-8 9s-7-3-9-7l-2-4a2 2 0 0 1 3-2l2 3" fill="#2b323c" />,
  regen: (
    <>
      <path d="M26 12A11 11 0 0 0 6 12M6 20a11 11 0 0 0 20 0" stroke={A} />
      <path d="M26 5v7h-7M6 27v-7h7" />
    </>
  ),
  'pal-props': (
    <>
      <rect x={5} y={4} width={22} height={24} rx={2} fill="#2b323c" />
      <path d="M9 10h6M9 16h6M9 22h6M18 10h5M18 16h5M18 22h5" />
      <path d="M5 8h22" stroke={A} />
    </>
  ),
  grid: <path d="M4 4v24M10 4v24M16 4v24M22 4v24M28 4v24M4 4h24M4 10h24M4 16h24M4 22h24M4 28h24" strokeOpacity={0.7} />,
  // --- Solides -----------------------------------------------------------------------------------------
  box: box(),
  cylinder: (
    <>
      <path d="M6 9v14a10 4 0 0 0 20 0V9" fill={F2} />
      <ellipse cx={16} cy={9} rx={10} ry={4} fill={F1} />
    </>
  ),
  cone: (
    <>
      <path d="M16 3L5 23a11 4 0 0 0 22 0z" fill={F2} />
      <path d="M5 23a11 4 0 0 0 22 0" />
    </>
  ),
  sphere: 'vs-realistic' as never,
  pyramid: (
    <>
      <path d="M16 3L4 21l12 7z" fill={F1} />
      <path d="M16 3l12 18-12 7z" fill={F3} />
    </>
  ),
  torus: (
    <>
      <ellipse cx={16} cy={16} rx={13} ry={8} fill={F2} />
      <ellipse cx={16} cy={15} rx={5} ry={2.5} fill="#1c2128" />
    </>
  ),
  extrude: (
    <>
      <path d="M5 24l11 5 11-5-11-5z" fill={F1} />
      <path d="M5 13l11 5 11-5-11-5z" strokeDasharray="2 2" />
      <path d="M16 18V4m0 0l-3 4m3-4l3 4" stroke={A} strokeWidth={2.2} />
    </>
  ),
  revolve: (
    <>
      <path d="M16 3v26" strokeDasharray="3 2" />
      <path d="M16 8h6v6l-3 3 3 3v4h-6" fill={F1} />
      <path d="M8 22a9 3 0 1 0 0-12" stroke={A} />
      <path d="M8 10l-1 3 3 0z" fill={A} stroke="none" />
    </>
  ),
  sweep: (
    <>
      <path d="M5 26C5 14 14 10 27 8" stroke={A} />
      <ellipse cx={7} cy={24} rx={4} ry={2} fill={F1} />
      <path d="M4 22c2-10 9-14 22-16M10 26c1-9 8-13 18-14" strokeOpacity={0.6} />
    </>
  ),
  loft: (
    <>
      <ellipse cx={16} cy={7} rx={7} ry={3} />
      <rect x={6} y={21} width={20} height={7} fill={F1} />
      <path d="M9 7L6 21M23 7l3 14" strokeOpacity={0.7} stroke={A} />
    </>
  ),
  union: (
    <>
      <circle cx={12} cy={16} r={8} fill={F2} />
      <circle cx={20} cy={16} r={8} fill={F2} />
      <path d="M16 9.3a8 8 0 0 1 0 13.4" stroke={F2} strokeWidth={2} />
    </>
  ),
  subtract: (
    <>
      <circle cx={12} cy={16} r={8} fill={F2} />
      <circle cx={20} cy={16} r={8} fill="#1c2128" strokeDasharray="3 2" />
    </>
  ),
  intersect: (
    <>
      <circle cx={12} cy={16} r={8} strokeDasharray="3 2" />
      <circle cx={20} cy={16} r={8} strokeDasharray="3 2" />
      <path d="M16 9.3a8 8 0 0 1 0 13.4a8 8 0 0 1 0-13.4z" fill={A} stroke="none" />
    </>
  ),
  filletedge: (
    <>
      {box()}
      <path d="M6 11c3-3 7-4 10-5" stroke={Y} strokeWidth={2.5} />
    </>
  ),
  chamferedge: (
    <>
      {box()}
      <path d="M6 11l10 5" stroke={Y} strokeWidth={2.5} />
    </>
  ),
  shell: (
    <>
      {box()}
      <path d="M16 9l6 3-6 3-6-3z" fill="#1c2128" />
    </>
  ),
  slice: (
    <>
      {box()}
      <path d="M2 18l14-7 14 7-14 7z" fill={A} fillOpacity={0.45} stroke={A} />
    </>
  ),
  thicken: (
    <>
      <path d="M4 18c6-6 18-6 24 0" fill="none" stroke={A} />
      <path d="M4 24c6-6 18-6 24 0" />
      <path d="M16 6v8m0 0l-3-3m3 3l3-3" stroke={Y} />
    </>
  ),
  move3d: (
    <>
      <path d="M16 18V4" stroke="#57ab5a" />
      <path d="M16 18l12 6" stroke="#e5534b" />
      <path d="M16 18L4 24" stroke="#539bf5" />
      <path d="M16 3l-2.5 4h5z" fill="#57ab5a" stroke="none" />
    </>
  ),
  rotate3d: (
    <>
      <ellipse cx={16} cy={16} rx={12} ry={5} stroke="#539bf5" />
      <ellipse cx={16} cy={16} rx={5} ry={12} stroke="#e5534b" />
      <circle cx={16} cy={16} r={12} stroke="#57ab5a" />
    </>
  ),
  mirror3d: (
    <>
      <path d="M4 22l12-6 12 6-12 6z" fill={A} fillOpacity={0.3} stroke={A} />
      <path d="M10 14l6-10 6 10z" fill={F1} />
    </>
  ),
  checksolid: (
    <>
      {box()}
      <circle cx={24} cy={24} r={6} fill={G} stroke="none" />
      <path d="M21 24l2 2 4-4" stroke="#fff" strokeWidth={2} />
    </>
  ),
  massprop: (
    <>
      {box()}
      {label('kg', 24, 30, 8, Y)}
    </>
  ),
  // --- Surfaces -----------------------------------------------------------------------------------------------
  planesurf: (
    <>
      <path d="M3 20l13-8 13 8-13 8z" fill={A} fillOpacity={0.4} stroke={A} />
      <path d="M9.5 16l13 8M16 12v16M22.5 16l-13 8" strokeOpacity={0.5} />
    </>
  ),
  surfnetwork: (
    <>
      <path d="M4 22C8 10 14 8 16 6c4 4 9 6 12 14-6 2-10 6-12 8-4-4-8-6-12-6z" fill={A} fillOpacity={0.35} stroke={A} />
      <path d="M10 15c4 2 8 2 12 1M16 6v22" strokeOpacity={0.5} />
    </>
  ),
  surfextrude: (
    <>
      <path d="M4 24c4-6 8-6 12 0s8 6 12 0" />
      <path d="M4 12c4-6 8-6 12 0s8 6 12 0V24c-4 6-8 6-12 0s-8-6-12 0z" fill={A} fillOpacity={0.3} stroke={A} />
    </>
  ),
  surfrevolve: (
    <>
      <path d="M16 3v26" strokeDasharray="3 2" />
      <path d="M8 6c-6 6-6 14 0 20h16c6-6 6-14 0-20z" fill={A} fillOpacity={0.3} stroke={A} />
    </>
  ),
  surfsweep: (
    <>
      <path d="M4 26C6 14 14 8 28 6" stroke={Y} />
      <path d="M2 20C5 10 13 4 27 2l2 8C17 12 10 18 8 28z" fill={A} fillOpacity={0.3} stroke={A} />
    </>
  ),
  surfloft: (
    <>
      <path d="M8 6c3-3 13-3 16 0" />
      <path d="M4 26c4 3 20 3 24 0" />
      <path d="M8 6L4 26c4 3 20 3 24 0L24 6c-3-3-13-3-16 0z" fill={A} fillOpacity={0.3} stroke={A} />
    </>
  ),
  // --- Divers ---------------------------------------------------------------------------------------------------------
  help: (
    <>
      <circle cx={16} cy={16} r={12} fill={A} stroke="none" />
      {label('?', 16, 22, 16, '#fff')}
    </>
  ),
  close: <path d="M8 8l16 16M24 8L8 24" />,
  // --- Fenêtres de vue (FENETRES) ------------------------------------------------------------------
  'vports-1': <rect x={4} y={6} width={24} height={20} rx={1.5} fill="#2b323c" stroke={A} />,
  'vports-2v': (
    <>
      <rect x={4} y={6} width={24} height={20} rx={1.5} fill="#2b323c" />
      <rect x={4} y={6} width={12} height={20} rx={1.5} stroke={A} />
    </>
  ),
  'vports-2h': (
    <>
      <rect x={4} y={6} width={24} height={20} rx={1.5} fill="#2b323c" />
      <rect x={4} y={6} width={24} height={10} rx={1.5} stroke={A} />
    </>
  ),
  'vports-3': (
    <>
      <rect x={4} y={6} width={24} height={20} rx={1.5} fill="#2b323c" />
      <path d="M17 6v20M17 16h11" />
      <rect x={4} y={6} width={13} height={20} rx={1.5} stroke={A} />
    </>
  ),
  'vports-4': (
    <>
      <rect x={4} y={6} width={24} height={20} rx={1.5} fill="#2b323c" />
      <path d="M16 6v20M4 16h24" />
      <rect x={4} y={6} width={12} height={10} rx={1.5} stroke={A} />
    </>
  ),
  fullscreen: <path d="M5 11V5h6M21 5h6v6M27 21v6h-6M11 27H5v-6" />,
  'file-tabs': (
    <>
      <path d="M3 12h26v15H3z" fill="#2b323c" />
      <path d="M3 12V7h9l2 5" fill="#3a4350" />
      <path d="M14 12V7h9l2 5" stroke={A} />
    </>
  ),
  start: (
    <>
      <path d="M5 15L16 6l11 9" />
      <path d="M8 13v13h16V13" fill="#2b323c" />
      <rect x={13} y={18} width={6} height={8} fill={A} stroke="none" />
    </>
  ),
  menu: <path d="M6 9h20M6 16h20M6 23h20" />,
  chevron: <path d="M10 13l6 6 6-6" />,
  'caret-down': <path d="M8 12h16l-8 9z" fill="currentColor" />,
  'arrow-left': <path d="M26 16H7M13 9l-7 7 7 7" />,
  'arrow-right': <path d="M6 16h19M19 9l7 7-7 7" />,
  eye: <path d="M3 16c6-9 20-9 26 0-6 9-20 9-26 0zM16 12a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" />,
  bulb: (
    <>
      <path d="M11 20c-3-2-5-5-5-8a10 10 0 0 1 20 0c0 3-2 6-5 8v3H11z" fill={Y} stroke="none" />
      <path d="M12 26h8M13 29h6" />
    </>
  ),
  'bulb-off': (
    <>
      <path d="M11 20c-3-2-5-5-5-8a10 10 0 0 1 20 0c0 3-2 6-5 8v3H11z" fill="#4a5462" stroke="none" />
      <path d="M12 26h8M13 29h6" />
    </>
  ),
  sun: (
    <>
      <circle cx={16} cy={16} r={6} fill={Y} stroke="none" />
      <path d="M16 3v4M16 25v4M3 16h4M25 16h4M7 7l3 3M22 22l3 3M7 25l3-3M22 10l3-3" stroke={Y} />
    </>
  ),
  moon: <path d="M21 4a12 12 0 1 0 7 17A10 10 0 0 1 21 4z" fill="#9fb4d8" stroke="none" />,
  snow: <path d="M16 3v26M5 9.5l22 13M5 22.5l22-13M13 5l3 3 3-3M13 27l3-3 3 3" stroke="#79c0ff" />,
  'lock-open': (
    <>
      <rect x={8} y={15} width={16} height={12} rx={2} fill="#4a5462" stroke="none" />
      <path d="M11 15v-4a5 5 0 0 1 10 0" />
    </>
  ),
  'lock-closed': (
    <>
      <rect x={8} y={15} width={16} height={12} rx={2} fill={Y} stroke="none" />
      <path d="M11 15v-4a5 5 0 0 1 10 0v4" stroke={Y} />
    </>
  ),
  trash: <path d="M6 9h20M12 9V5h8v4M8 9l2 19h12l2-19M13 13v11M19 13v11" />,
  plus: <path d="M16 6v20M6 16h20" strokeWidth={2.4} />,
  check: <path d="M6 16l7 7 13-14" stroke={G} strokeWidth={2.6} />,
  home: <path d="M5 16L16 6l11 10M8 13.5V26h6v-7h4v7h6V13.5" />,
  'eye-off': <path d="M3 16c6-9 20-9 26 0-6 9-20 9-26 0zM16 12a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM5 27L27 5" />,
  section: (
    <>
      <path d="M6 12l10-5 10 5v10l-10 5-10-5z" fill={F3} />
      <path d="M16 7v20M6 12l10 5 10-5" strokeOpacity={0.5} />
      <path d="M16 3v26" stroke={A} strokeWidth={2} />
      <path d="M16 17l10-5v10l-10 5z" fill={F1} />
    </>
  ),
  measure3d: (
    <>
      <path d="M4 22l12 6 12-6-12-6z" fill={F3} />
      <path d="M6 13l20-8" stroke={A} strokeWidth={2} />
      <path d="M6 9v8M26 1v8" stroke={A} />
      <path d="M11 11.5l1 2M15 10l1 2M19 8.5l1 2" stroke={A} />
      {dot(6, 13)}
      {dot(26, 5)}
    </>
  ),
  text3d: (
    <>
      <path d="M6 9h14M13 9v17" stroke={F2} strokeWidth={5} />
      <path d="M4 7h14M11 7v17" stroke={A} strokeWidth={3} />
      <path d="M22 26l6-3V11l-6 3z" fill={F3} />
    </>
  ),
  convsolid: (
    <>
      <path d="M3 18l6-9 6 9z M9 9l6 9" fill={F3} strokeOpacity={0.8} />
      <path d="M15 14h4m0 0l-2-2m2 2l-2 2" stroke={A} strokeWidth={1.8} />
      <path d="M21 10l5-3 5 3v8l-5 3-5-3z" fill={F1} transform="translate(-2 3)" />
    </>
  ),
  array3d: (
    <>
      {[0, 1, 2].map((i) => (
        <g key={i} transform={`translate(${i * 8} ${-i * 4 + 8})`}>
          <path d="M3 12l5-2.5 5 2.5-5 2.5z" fill={F1} />
          <path d="M3 12v6l5 2.5v-6z" fill={F2} />
          <path d="M13 12v6l-5 2.5v-6z" fill={F3} />
        </g>
      ))}
    </>
  ),
  arraypath: (
    <>
      <path d="M3 27C8 12 20 26 29 6" stroke={Y} strokeWidth={1.6} fill="none" strokeDasharray="3 2" />
      {[
        [5, 21],
        [15, 18],
        [24, 11],
      ].map(([x, y]) => (
        <rect key={x} x={x! - 3} y={y! - 3} width={6} height={6} fill={F1} transform={`rotate(${-20 - x!} ${x} ${y})`} />
      ))}
    </>
  ),
  'vs-render': (
    <>
      <ellipse cx={17} cy={26} rx={11} ry={3} fill="#0d1014" opacity={0.6} />
      <circle cx={15} cy={15} r={9} fill="#8fb4e8" />
      <circle cx={12} cy={11} r={3} fill="#fff" opacity={0.85} />
      <path d="M24 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" fill={Y} />
    </>
  ),
  material: (
    <>
      <circle cx={10} cy={11} r={6} fill="#c9a94e" />
      <circle cx={8} cy={9} r={2} fill="#fff" opacity={0.7} />
      <circle cx={22} cy={11} r={6} fill="#c3c7cc" />
      <circle cx={20} cy={9} r={2} fill="#fff" opacity={0.8} />
      <circle cx={16} cy={22} r={6} fill="#e85d4a" />
      <circle cx={14} cy={20} r={2} fill="#fff" opacity={0.5} />
    </>
  ),
  'render-image': (
    <>
      <rect x={3} y={6} width={26} height={20} rx={2} fill="#dfe5ee" />
      <path d="M3 22l8-7 6 5 4-3 8 6v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill={F2} />
      <circle cx={22} cy={12} r={3} fill={Y} />
    </>
  ),
  'cmd-generic': (
    <>
      <rect x={4} y={7} width={24} height={18} rx={2} fill="#2b323c" stroke={A} />
      <path d="M8 13l4 3-4 3" stroke={Y} strokeWidth={1.8} fill="none" />
      <path d="M14 20h8" stroke={A} strokeWidth={1.8} />
    </>
  ),
  'tab-custom': (
    <>
      <path d="M3 27V9h9l2-4h9l2 4h4v18z" fill="#2b323c" stroke={A} />
      <path d="M16 12l1.6 3.4 3.7.4-2.8 2.5.8 3.7L16 20.2 12.7 22l.8-3.7-2.8-2.5 3.7-.4z" fill={Y} stroke="none" />
    </>
  ),
  customize: (
    <>
      <path d="M5 9h14M25 9h2M5 16h4M15 16h12M5 23h10M21 23h6" stroke="#9aa6b5" strokeWidth={2} strokeLinecap="round" />
      <circle cx={22} cy={9} r={3} fill={A} stroke="none" />
      <circle cx={12} cy={16} r={3} fill={Y} stroke="none" />
      <circle cx={18} cy={23} r={3} fill={A} stroke="none" />
    </>
  ),
  'drawing-sheet': (
    <>
      <rect x={2} y={5} width={28} height={22} rx={1} fill="#e8ecf1" stroke="#9aa6b5" />
      <rect x={6} y={9} width={8} height={6} fill="none" stroke="#20262e" strokeWidth={1.3} />
      <rect x={6} y={17} width={8} height={5} fill="none" stroke="#20262e" strokeWidth={1.3} />
      <rect x={16} y={9} width={5} height={6} fill="none" stroke="#20262e" strokeWidth={1.3} />
      <path d="M8 12h4" stroke="#4fa8e8" strokeWidth={1} strokeDasharray="1.5 1" />
      <rect x={19} y={20} width={10} height={6} fill="#c9d2dd" stroke="#20262e" strokeWidth={0.8} />
      <path d="M23 9l3-1.5 3 1.5v4l-3 1.5-3-1.5z" fill={A} fillOpacity={0.5} stroke={A} strokeWidth={1} />
    </>
  ),
  'view-update': (
    <>
      <rect x={3} y={6} width={18} height={14} rx={1} fill="#e8ecf1" stroke="#9aa6b5" />
      <rect x={6} y={9} width={7} height={5} fill="none" stroke="#20262e" strokeWidth={1.3} />
      <path d="M26 14a8 8 0 1 1-4-6.9" stroke={Y} strokeWidth={2} fill="none" />
      <path d="M22 4v4h4" stroke={Y} strokeWidth={2} fill="none" />
    </>
  ),
  sheetmetal: (
    <>
      <path d="M4 22l14-6 10 4-14 6z" fill={F1} />
      <path d="M4 22v-12l2-1v12z" fill={F2} />
      <path d="M28 20v-12l-2-1v12z" fill={F3} />
      <path d="M4 10c0-1 1-2 2-2" stroke={A} strokeWidth={1.2} fill="none" />
      <path d="M14 26v-2l14-6" stroke="#20262e" strokeWidth={0.8} fill="none" />
    </>
  ),
  flatpattern: (
    <>
      <path d="M10 4h12v6h6v12h-6v6H10v-6H4V10h6z" fill="#e8ecf1" stroke="#9aa6b5" />
      <path d="M10 10h12M10 22h12M10 10v12M22 10v12" stroke={Y} strokeWidth={1.2} strokeDasharray="3 1.5" />
      <circle cx={16} cy={16} r={2} fill="none" stroke="#20262e" strokeWidth={1} />
    </>
  ),
  hole: (
    <>
      <path d="M2 12l14-7 14 7-14 7z" fill={F1} />
      <path d="M2 12v9l14 7v-9z" fill={F2} />
      <path d="M30 12v9l-14 7v-9z" fill={F3} />
      <ellipse cx={16} cy={12} rx={6} ry={3} fill="#20262e" stroke={A} strokeWidth={1.4} />
      <ellipse cx={16} cy={12.5} rx={3} ry={1.5} fill="#0d1014" />
      <path d="M16 3v6" stroke={Y} strokeWidth={1.6} />
      <path d="M14 7l2 2.5 2-2.5" stroke={Y} strokeWidth={1.6} fill="none" />
    </>
  ),
  joint: (
    <>
      <path d="M3 22l11-5v6L3 28z" fill={F2} />
      <path d="M16 8l12-5v6l-12 5z" fill={F1} transform="rotate(28 16 16)" />
      <circle cx={15} cy={18} r={3.5} fill="#2b323c" stroke={A} strokeWidth={2} />
      <path d="M22 26a9 9 0 0 0 4-8" stroke={Y} strokeWidth={1.6} />
      <path d="M26 18l-2 2m2-2l1.5 2.5" stroke={Y} strokeWidth={1.6} />
    </>
  ),
  drivejoint: (
    <>
      <path d="M4 16h24" stroke="#5a6472" strokeWidth={3} strokeLinecap="round" />
      <path d="M4 16h13" stroke={A} strokeWidth={3} strokeLinecap="round" />
      <circle cx={17} cy={16} r={4} fill="#e6edf3" stroke={A} strokeWidth={2} />
      <path d="M8 6l6 3-6 3z" fill={G} stroke="none" />
    </>
  ),
  interfere: (
    <>
      <rect x={4} y={9} width={14} height={14} fill={F3} />
      <circle cx={20} cy={14} r={8} fill={F2} fillOpacity={0.7} />
      <path d="M12 9.2a8 8 0 0 1 6 13.8V23h-6z" fill={R} fillOpacity={0.85} stroke={R} />
    </>
  ),
  presspull: (
    <>
      <path d="M4 22l12 6 12-6-12-6z" fill={F2} />
      <path d="M10 19l6 3 6-3-6-3z" fill={A} fillOpacity={0.55} stroke={A} />
      <path d="M16 19V5m0 0l-3.5 4M16 5l3.5 4" stroke={A} strokeWidth={2.2} />
    </>
  ),
  sketch: (
    <>
      <path d="M3 21l13-7 13 7-13 7z" fill={F3} />
      <path d="M9 21l5-3 7 2-4 4z" stroke={A} />
      <path d="M20 4l5 5-9 9h-5v-5z" fill="#2b323c" />
      <path d="M18 6l5 5" />
    </>
  ),
  browser: (
    <>
      <path d="M7 5v20M7 10h5M7 18h5M7 25h5M15 14v6h4" strokeOpacity={0.7} />
      <rect x={12} y={7} width={14} height={6} rx={1.5} fill={F2} />
      <rect x={12} y={15} width={14} height={6} rx={1.5} fill={F1} />
      <rect x={19} y={23} width={9} height={5} rx={1.5} fill={A} stroke="none" />
    </>
  ),
  'ws-2d': (
    <>
      <rect x={5} y={6} width={22} height={20} rx={1.5} fill="#2b323c" />
      <path d="M9 21l6-9 4 6 3-3 2 6z" stroke={A} />
    </>
  ),
  'ws-3d': (
    <>
      <path d="M16 4l11 6v12l-11 6-11-6V10z" fill={F2} />
      <path d="M5 10l11 6 11-6M16 16v12" />
    </>
  ),
  elevation: (
    <>
      <path d="M4 24l12 5 12-5-12-5z" fill={F3} />
      <path d="M4 13l12 5 12-5-12-5z" fill={F1} fillOpacity={0.6} stroke={A} />
      <path d="M28 24V13" strokeDasharray="2 2" />
    </>
  ),
  qselect: (
    <>
      <path d="M5 8h12M5 15h9M5 22h7" />
      <path d="M17 13h11l-4 6v6l-3 2v-8z" fill={F2} stroke={A} />
    </>
  ),
  find: (
    <>
      <circle cx={13} cy={13} r={7} fill="#2b323c" />
      <path d="M18 18l9 9" strokeWidth={2.4} />
      <path d="M10 13h6" stroke={A} />
    </>
  ),
  options: (
    <>
      <circle cx={16} cy={16} r={4} />
      <path d="M16 4v4M16 24v4M4 16h4M24 16h4M7.5 7.5l2.8 2.8M21.7 21.7l2.8 2.8M7.5 24.5l2.8-2.8M21.7 10.3l2.8-2.8" />
    </>
  ),
  undock: (
    <>
      <rect x={4} y={9} width={17} height={18} rx={1.5} />
      <path d="M15 4h13v13" />
      <path d="M28 4L17 15" stroke={A} strokeWidth={2} />
    </>
  ),
  dock: (
    <>
      <rect x={4} y={5} width={24} height={22} rx={1.5} />
      <path d="M20 5v22" />
      <rect x={20} y={5} width={8} height={22} fill={A} fillOpacity={0.5} stroke="none" />
    </>
  ),
  parts: (
    <>
      <path d="M6 9l8-4 8 4v9l-8 4-8-4z" fill={F2} />
      <path d="M6 9l8 4 8-4M14 13v9" />
      <path d="M22 18h6v9h-6z" fill={F1} />
      <path d="M25 18v-6" stroke={A} strokeWidth={2.2} />
    </>
  ),
  'part-bolt': (
    <>
      <path d="M9 4h14l3 5-3 5H9L6 9z" fill={F2} />
      <path d="M12 14h8v15h-8z" fill={F1} />
      <path d="M12 17l8 2M12 21l8 2M12 25l8 2" strokeOpacity={0.7} />
    </>
  ),
  'part-chc': (
    <>
      <rect x={7} y={4} width={18} height={9} rx={2} fill={F2} />
      <path d="M13.5 6.5h5l1.5 2.5-1.5 2.5h-5L12 9z" fill="#20262e" />
      <path d="M12 13h8v16h-8z" fill={F1} />
      <path d="M12 17l8 2M12 21l8 2M12 25l8 2" strokeOpacity={0.7} />
    </>
  ),
  'part-nut': (
    <>
      <path d="M9 6h14l6 10-6 10H9L3 16z" fill={F2} />
      <circle cx={16} cy={16} r={5} fill="#20262e" />
    </>
  ),
  'part-washer': (
    <>
      <circle cx={16} cy={16} r={12} fill={F1} />
      <circle cx={16} cy={16} r={5} fill="#20262e" />
    </>
  ),
  'part-rod': (
    <>
      <path d="M12 3h8v26h-8z" fill={F1} />
      <path d="M12 6l8 2M12 10l8 2M12 14l8 2M12 18l8 2M12 22l8 2M12 26l8 2" strokeOpacity={0.7} />
    </>
  ),
  'part-tube': (
    <>
      <path d="M8 9v16a8 3 0 0 0 16 0V9" fill={F2} />
      <ellipse cx={16} cy={9} rx={8} ry={3} fill={F1} />
      <ellipse cx={16} cy={9} rx={5} ry={1.8} fill="#20262e" />
    </>
  ),
  'part-rect-tube': (
    <>
      <path d="M6 10l10-5 10 5v14l-10 5-10-5z" fill={F2} />
      <path d="M6 10l10 5 10-5-10-5z" fill={F1} />
      <path d="M10 10l6 3 6-3-6-3z" fill="#20262e" />
    </>
  ),
  'part-elbow': (
    <>
      <path d="M5 27V17a12 12 0 0 1 12-12h10v8H17a4 4 0 0 0-4 4v10z" fill={F2} />
      <path d="M27 5v8" stroke={A} />
    </>
  ),
  'part-pvc-elbow': (
    <>
      <path d="M4 28V18a13 13 0 0 1 13-13h11" fill="none" stroke={F2} strokeWidth={9} strokeOpacity={0.9} />
      <path d="M3 22h10v7H3zM21 2h7v10h-7z" fill={F1} />
    </>
  ),
  'part-pvc-tee': (
    <>
      <path d="M12 3h8v26h-8z" fill={F2} />
      <path d="M20 12h6v8h-6z" fill={F2} />
      <path d="M11 2h10v6H11zM11 24h10v6H11zM25 11h5v10h-5z" fill={F1} />
    </>
  ),
  'part-pvc-wye': (
    <>
      <path d="M11 3h8v26h-8z" fill={F2} />
      <path d="M17 19l9-9 4 4-9 9z" fill={F2} />
      <path d="M10 2h10v6H10zM10 24h10v6H10zM24 6l6 6-3 3-6-6z" fill={F1} />
    </>
  ),
  'part-angle': (
    <>
      <path d="M6 26V6h6v14h14v6z" fill={F2} />
    </>
  ),
  'part-channel': (
    <>
      <path d="M5 7h6v14h10V7h6v19H5z" fill={F2} />
    </>
  ),
  'part-box': (
    <>
      <path d="M4 12l12-6 12 6v12l-12 6-12-6z" fill={F2} />
      <path d="M7 12l9-4.5 9 4.5-9 4.5z" fill="#20262e" />
      <path d="M16 18v12M4 12l12 6 12-6" />
    </>
  ),
  'part-plate': (
    <>
      <path d="M3 17l13-7 13 7-13 7z" fill={F1} />
      <path d="M3 17v3l13 7 13-7v-3" />
      <ellipse cx={9} cy={17} rx={1.6} ry={1} fill="#20262e" />
      <ellipse cx={23} cy={17} rx={1.6} ry={1} fill="#20262e" />
      <ellipse cx={16} cy={13} rx={1.6} ry={1} fill="#20262e" />
      <ellipse cx={16} cy={21} rx={1.6} ry={1} fill="#20262e" />
    </>
  ),
  'part-hinge': (
    <>
      <path d="M3 9h11v14H3z" fill={F2} />
      <path d="M18 9h11v14H18z" fill={F1} />
      <path d="M14 6h4v5h-4zM14 13.5h4v5h-4zM14 21h4v5h-4z" fill={F1} />
      <path d="M16 4v24" stroke={A} />
      <circle cx={7} cy={16} r={1.3} fill="#20262e" />
      <circle cx={25} cy={16} r={1.3} fill="#20262e" />
    </>
  ),
  'part-piano': (
    <>
      <path d="M2 11h12v10H2z" fill={F2} />
      <path d="M18 11h12v10H18z" fill={F1} />
      <path d="M14 3h4v3h-4zM14 9h4v3h-4zM14 15h4v3h-4zM14 21h4v3h-4zM14 27h4v2h-4z" fill={F1} />
      <path d="M16 2v28" stroke={A} />
    </>
  ),
  'part-pip': (
    <>
      <path d="M3 10h10v12H3z" fill={F2} />
      <path d="M19 10h10v12H19z" fill={F1} />
      <rect x={12.5} y={5} width={7} height={6} rx={3} fill={F2} />
      <rect x={12.5} y={13} width={7} height={6} rx={3} fill={F1} />
      <rect x={12.5} y={21} width={7} height={6} rx={3} fill={F2} />
      <path d="M8 27h16" stroke={A} strokeDasharray="2 2" />
    </>
  ),
  'part-paumelle': (
    <>
      <rect x={13} y={3} width={6} height={12} rx={2.5} fill={F2} />
      <rect x={13} y={17} width={6} height={12} rx={2.5} fill={F1} />
      <path d="M4 17h9v12H4z" fill={F1} />
      <path d="M19 3h9v12h-9z" fill={F2} />
      <path d="M16 6v20" stroke={A} />
    </>
  ),
  'part-living': (
    <>
      <path d="M2 12h12l1.5 4h1L18 12h12v6H2z" fill={F2} />
      <path d="M14 18h4" stroke={A} strokeWidth={2} />
    </>
  ),
  'part-kerf': (
    <>
      <path d="M3 8h26v16H3z" fill={F2} />
      <path d="M11 11v10M15 8v6M15 18v6M19 11v10M23 8v6M23 18v6M7 8v6M7 18v6" stroke="#20262e" strokeWidth={1.6} />
    </>
  ),
};
ICONS.sphere = ICONS['vs-realistic']!;

export function Icon({ name, size = 32, className }: { name: string; size?: number; className?: string }) {
  const body = ICONS[name] ?? ICONS.help;
  return (
    <svg className={`ico ${className ?? ''}`} width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {body}
    </svg>
  );
}
