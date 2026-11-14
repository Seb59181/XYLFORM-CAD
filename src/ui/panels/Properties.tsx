/**
 * Palette Propriétés : propriétés générales (calque, couleur) et géométrie modifiable
 * des objets sélectionnés (les valeurs acceptent des expressions : 10*2+5).
 */
import { useEffect, useState } from 'react';
import type { AppHost } from '../../app/AppHost';
import { evaluateNumber } from '../../core/commands/InputParser';
import type { Vec3 } from '../../core/commands/types';
import type { Entity, HatchPattern, NewEntity, PrimitiveOp, TextAlign, TextVAlign } from '../../core/document/Document';
import { arcSweep, dimensionGeometry, entityArea, entityLabel, entityLength, normAngle } from '../../core/entities/geometry';
import { useHost } from '../context';
import { HistoryRows } from './History';
import { MATERIALS } from '../../core/materials';

const DEG = Math.PI / 180;
const JUSTIFY: [string, string][] = [
  ['baseline|left', 'Gauche (ligne de base)'],
  ['baseline|center', 'Centre (ligne de base)'],
  ['baseline|right', 'Droite (ligne de base)'],
  ['top|left', 'Haut gauche'],
  ['top|center', 'Haut centre'],
  ['top|right', 'Haut droite'],
  ['middle|left', 'Milieu gauche'],
  ['middle|center', 'Milieu centre'],
  ['middle|right', 'Milieu droite'],
  ['bottom|left', 'Bas gauche'],
  ['bottom|center', 'Bas centre'],
  ['bottom|right', 'Bas droite'],
];
const f4 = (v: number) => (Math.abs(v) < 1e-12 ? '0' : v.toFixed(4).replace(/\.?0+$/, ''));

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="pp-row">
      <span className="pp-label">{label}</span>
      <span className="pp-value">{children}</span>
    </div>
  );
}

/** Champ numérique : validation par Entrée ou perte du focus, expressions autorisées. */
export function NumInput({ value, onCommit, readOnly, varies }: { value: number; onCommit?: (v: number) => void; readOnly?: boolean; varies?: boolean }) {
  const shown = varies ? '*VARIE*' : f4(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  if (readOnly || !onCommit) return <span className="pp-ro">{shown}</span>;
  const commit = () => {
    const v = evaluateNumber(text.replace(',', '.'));
    if (v === null || !Number.isFinite(v)) return setText(shown);
    if (v !== value || varies) onCommit(v);
  };
  return <input className="pp-input" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />;
}

function TextInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return <input className="pp-input" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => text !== value && onCommit(text)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="pp-section">
      <div className="pp-section-title" onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'}</span> {title}
      </div>
      {open && children}
    </div>
  );
}

function PointRows({ label, p, set }: { label: string; p: Vec3; set: (p: Vec3) => void }) {
  return (
    <>
      <Row label={`${label} X`}>
        <NumInput value={p.x} onCommit={(x) => set({ ...p, x })} />
      </Row>
      <Row label={`${label} Y`}>
        <NumInput value={p.y} onCommit={(y) => set({ ...p, y })} />
      </Row>
      <Row label={`${label} Z`}>
        <NumInput value={p.z} onCommit={(z) => set({ ...p, z })} />
      </Row>
    </>
  );
}

function Geometry({ app, e }: { app: AppHost; e: Entity }) {
  const set = (patch: Partial<NewEntity>) => app.doc.replaceEntity(e.handle, patch);
  switch (e.type) {
    case 'LINE': {
      const d = { x: e.end.x - e.start.x, y: e.end.y - e.start.y, z: e.end.z - e.start.z };
      const L = Math.hypot(d.x, d.y, d.z);
      const ang = Math.atan2(d.y, d.x);
      return (
        <>
          <PointRows label="Départ" p={e.start} set={(start) => set({ start })} />
          <PointRows label="Fin" p={e.end} set={(end) => set({ end })} />
          <Row label="Delta X">
            <NumInput value={d.x} readOnly />
          </Row>
          <Row label="Delta Y">
            <NumInput value={d.y} readOnly />
          </Row>
          <Row label="Longueur">
            <NumInput value={L} onCommit={(v) => L > 0 && set({ end: { x: e.start.x + (d.x / L) * v, y: e.start.y + (d.y / L) * v, z: e.start.z + (d.z / L) * v } })} />
          </Row>
          <Row label="Angle (°)">
            <NumInput value={((ang / DEG) % 360 + 360) % 360} onCommit={(a) => { const h = Math.hypot(d.x, d.y); set({ end: { x: e.start.x + h * Math.cos(a * DEG), y: e.start.y + h * Math.sin(a * DEG), z: e.end.z } }); }} />
          </Row>
        </>
      );
    }
    case 'CIRCLE':
      return (
        <>
          <PointRows label="Centre" p={e.center} set={(center) => set({ center })} />
          <Row label="Rayon">
            <NumInput value={e.radius} onCommit={(radius) => radius > 0 && set({ radius })} />
          </Row>
          <Row label="Diamètre">
            <NumInput value={2 * e.radius} onCommit={(d) => d > 0 && set({ radius: d / 2 })} />
          </Row>
          <Row label="Circonférence">
            <NumInput value={2 * Math.PI * e.radius} onCommit={(c) => c > 0 && set({ radius: c / (2 * Math.PI) })} />
          </Row>
          <Row label="Aire">
            <NumInput value={Math.PI * e.radius ** 2} onCommit={(a) => a > 0 && set({ radius: Math.sqrt(a / Math.PI) })} />
          </Row>
        </>
      );
    case 'ARC':
      return (
        <>
          <PointRows label="Centre" p={e.center} set={(center) => set({ center })} />
          <Row label="Rayon">
            <NumInput value={e.radius} onCommit={(radius) => radius > 0 && set({ radius })} />
          </Row>
          <Row label="Angle de départ">
            <NumInput value={e.startAngle / DEG} onCommit={(a) => set({ startAngle: normAngle(a * DEG) })} />
          </Row>
          <Row label="Angle de fin">
            <NumInput value={e.endAngle / DEG} onCommit={(a) => set({ endAngle: normAngle(a * DEG) })} />
          </Row>
          <Row label="Angle total">
            <NumInput value={arcSweep(e.startAngle, e.endAngle) / DEG} readOnly />
          </Row>
          <Row label="Longueur d’arc">
            <NumInput value={e.radius * arcSweep(e.startAngle, e.endAngle)} readOnly />
          </Row>
        </>
      );
    case 'POLYLINE':
      return <PolylineRows app={app} e={e} />;
    case 'ELLIPSE': {
      const maj = Math.hypot(e.majorAxis.x, e.majorAxis.y);
      return (
        <>
          <PointRows label="Centre" p={e.center} set={(center) => set({ center })} />
          <Row label="Rayon majeur">
            <NumInput value={maj} onCommit={(r) => r > 0 && set({ majorAxis: { x: (e.majorAxis.x / maj) * r, y: (e.majorAxis.y / maj) * r, z: 0 } })} />
          </Row>
          <Row label="Rayon mineur">
            <NumInput value={maj * e.ratio} onCommit={(r) => r > 0 && r <= maj && set({ ratio: r / maj })} />
          </Row>
          <Row label="Rapport">
            <NumInput value={e.ratio} onCommit={(ratio) => ratio > 0 && ratio <= 1 && set({ ratio })} />
          </Row>
        </>
      );
    }
    case 'SPLINE':
      return (
        <>
          <Row label="Points de lissage">
            <span className="pp-ro">{e.fitPoints.length}</span>
          </Row>
          <Row label="Fermée">
            <input type="checkbox" checked={e.closed} onChange={(ev) => set({ closed: ev.target.checked })} />
          </Row>
          <Row label="Longueur">
            <NumInput value={entityLength(e) ?? 0} readOnly />
          </Row>
        </>
      );
    case 'POINT':
      return <PointRows label="Position" p={e.position} set={(position) => set({ position })} />;
    case 'HELIX':
      return (
        <>
          <PointRows label="Base" p={e.center} set={(center) => set({ center })} />
          <Row label="Rayon de base">
            <NumInput value={e.baseRadius} onCommit={(baseRadius) => baseRadius > 0 && set({ baseRadius })} />
          </Row>
          <Row label="Rayon supérieur">
            <NumInput value={e.topRadius} onCommit={(topRadius) => topRadius >= 0 && set({ topRadius })} />
          </Row>
          <Row label="Hauteur">
            <NumInput value={e.height} onCommit={(height) => set({ height })} />
          </Row>
          <Row label="Tours">
            <NumInput value={e.turns} onCommit={(turns) => turns > 0 && set({ turns })} />
          </Row>
          <Row label="Pas (hauteur de spire)">
            <NumInput value={e.height / e.turns} onCommit={(p) => p !== 0 && set({ turns: Math.abs(e.height / p) })} />
          </Row>
          <Row label="Sens trigonométrique">
            <input type="checkbox" checked={e.ccw} onChange={(ev) => set({ ccw: ev.target.checked })} />
          </Row>
        </>
      );
    case 'HATCH':
      return (
        <>
          <Row label="Motif">
            <select className="pp-input" value={e.pattern} onChange={(ev) => set({ pattern: ev.target.value as HatchPattern })}>
              <option value="SOLID">Plein</option>
              <option value="ANSI31">ANSI31</option>
              <option value="ANSI37">ANSI37</option>
              <option value="NET">Grille</option>
              <option value="GRADIENT">Dégradé</option>
            </select>
          </Row>
          <Row label="Échelle">
            <NumInput value={e.scale} onCommit={(scale) => scale > 0 && set({ scale })} />
          </Row>
          <Row label="Angle (°)">
            <NumInput value={e.angle / DEG} onCommit={(a) => set({ angle: a * DEG })} />
          </Row>
          {e.pattern === 'GRADIENT' && (
            <Row label="Couleur 2">
              <input type="color" value={e.color2 ?? '#1d3557'} onChange={(ev) => set({ color2: ev.target.value })} />
            </Row>
          )}
          <Row label="Aire">
            <NumInput value={entityArea(e) ?? 0} readOnly />
          </Row>
        </>
      );
    case 'TEXT':
      return (
        <>
          <Row label="Contenu (\\P = ligne)">
            <TextInput value={e.text.replace(/\n/g, '\\P')} onCommit={(text) => set({ text: text.replace(/\\P/g, '\n') })} />
          </Row>
          <Row label="Justification">
            <select
              className="pp-input"
              value={`${e.valign ?? 'baseline'}|${e.align ?? 'left'}`}
              onChange={(ev) => {
                const [valign, align] = ev.target.value.split('|') as [TextVAlign, TextAlign];
                set({ align: align === 'left' ? undefined : align, valign: valign === 'baseline' ? undefined : valign });
              }}
            >
              {JUSTIFY.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Facteur de largeur">
            <NumInput value={e.widthFactor ?? 1} onCommit={(w) => w > 0 && set({ widthFactor: w === 1 ? undefined : w })} />
          </Row>
          <Row label="Hauteur">
            <NumInput value={e.height} onCommit={(height) => height > 0 && set({ height })} />
          </Row>
          <Row label="Rotation (°)">
            <NumInput value={e.rotation / DEG} onCommit={(r) => set({ rotation: r * DEG })} />
          </Row>
          <PointRows label="Position" p={e.position} set={(position) => set({ position })} />
        </>
      );
    case 'DIMENSION':
      return (
        <>
          <Row label={e.dimType === 'angular' ? 'Mesure (°)' : 'Mesure'}>
            <NumInput value={e.dimType === 'angular' ? (dimensionGeometry(e).value * 180) / Math.PI : dimensionGeometry(e).value} readOnly />
          </Row>
          {e.dimType === 'ordinate' && (
            <Row label="Axe mesuré">
              <select value={e.ordAxis ?? 'x'} onChange={(ev) => set({ ordAxis: ev.target.value as 'x' | 'y' })}>
                <option value="x">X (repère vertical)</option>
                <option value="y">Y (repère horizontal)</option>
              </select>
            </Row>
          )}
          <Row label="Style de cote">
            <select className="pp-input" value={e.dimStyle ?? 'Standard'} onChange={(ev) => set({ dimStyle: ev.target.value === 'Standard' ? undefined : ev.target.value })}>
              {Object.keys(app.doc.dimStyles).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Tolérance">
            <select className="pp-input" value={e.tol ?? ''} onChange={(ev) => set({ tol: (ev.target.value || undefined) as typeof e.tol })}>
              <option value="">Celle du style</option>
              <option value="none">Aucune</option>
              <option value="symmetric">Symétrique (±)</option>
              <option value="deviation">Écarts (+/−)</option>
              <option value="limits">Limites (max / min)</option>
            </select>
          </Row>
          {e.tol && e.tol !== 'none' && (
            <>
              <Row label="Écart supérieur">
                <NumInput value={e.tolPlus ?? 0} onCommit={(tolPlus) => set({ tolPlus })} />
              </Row>
              {e.tol !== 'symmetric' && (
                <Row label="Écart inférieur">
                  <NumInput value={e.tolMinus ?? 0} onCommit={(tolMinus) => set({ tolMinus })} />
                </Row>
              )}
            </>
          )}
          <Row label="Texte remplacé">
            <TextInput value={e.textOverride ?? ''} onCommit={(t) => set({ textOverride: t || undefined })} />
          </Row>
          <Row label="Hauteur du texte">
            <NumInput value={e.textHeight ?? app.sysvars.DIMTXT} onCommit={(textHeight) => textHeight > 0 && set({ textHeight })} />
          </Row>
        </>
      );
    case 'UNDERLAY': {
      const def = app.doc.underlays[e.ref];
      return (
        <>
          <Row label="Fond de plan">
            <span className="pp-ro" title={def?.path ?? def?.fileName}>
              {def ? `${def.name} (${def.kind.toUpperCase()}${def.loaded ? '' : ', déchargé'})` : 'Définition absente'}
            </span>
          </Row>
          <PointRows label="Insertion" p={e.position} set={(position) => set({ position })} />
          <Row label="Échelle">
            <NumInput value={e.scale} onCommit={(scale) => scale > 0 && set({ scale })} />
          </Row>
          <Row label="Rotation (°)">
            <NumInput value={e.rotation / DEG} onCommit={(r) => set({ rotation: normAngle(r * DEG) })} />
          </Row>
          <Row label="Largeur × hauteur">
            <span className="pp-ro">
              {f4((e.bounds.max.x - e.bounds.min.x) * e.scale)} × {f4((e.bounds.max.y - e.bounds.min.y) * e.scale)}
            </span>
          </Row>
          {def && (
            <Row label="Estompage (%)">
              <NumInput value={def.fade} onCommit={(v) => app.doc.updateUnderlayDef(def.id, { fade: Math.max(0, Math.min(90, Math.round(v))) })} />
            </Row>
          )}
        </>
      );
    }
    case '3DSOLID': {
      const d = e.display;
      const s = (p: Vec3) => `${f4(p.x)}, ${f4(p.y)}, ${f4(p.z)}`;
      return (
        <>
          <Row label="Nom">
            <TextInput value={e.name} onCommit={(name) => set({ name })} />
          </Row>
          <Row label="Type">
            <span className="pp-ro">
              {d.meshTriangles
                ? `Corps maillé ${d.solidCount ? 'fermé' : 'ouvert'} (${d.meshTriangles.toLocaleString('fr-FR')} triangles)`
                : d.solidCount
                  ? `${d.solidCount} solide(s)`
                  : 'Surface'}
            </span>
          </Row>
          <Row label="Matériau">
            <select className="pp-input" value={e.material ?? ''} onChange={(ev) => set({ material: ev.target.value || undefined })}>
              <option value="">Aucun (couleur seule)</option>
              {MATERIALS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Row>
          {e.primitive && !e.history && <PrimitiveRows app={app} e={e} op={e.primitive.op} />}
          {d.solidCount > 0 && (
            <Row label="Volume">
              <NumInput value={d.volume} readOnly />
            </Row>
          )}
          <Row label="Aire de surface">
            <NumInput value={d.area} readOnly />
          </Row>
          <Row label="Faces / arêtes">
            <span className="pp-ro">
              {d.faceCount} / {d.edgeCount}
            </span>
          </Row>
          <Row label="Boîte min">
            <span className="pp-ro">{s(d.bbox.min)}</span>
          </Row>
          <Row label="Boîte max">
            <span className="pp-ro">{s(d.bbox.max)}</span>
          </Row>
          <Row label="Dimensions">
            <span className="pp-ro">{s({ x: d.bbox.max.x - d.bbox.min.x, y: d.bbox.max.y - d.bbox.min.y, z: d.bbox.max.z - d.bbox.min.z })}</span>
          </Row>
        </>
      );
    }
  }
}

/**
 * Cotes d'une primitive 3D (boîte, cylindre, cône, sphère, pyramide, tore) : la modification
 * reconstruit le solide par le noyau, en conservant sa position et son orientation.
 */
function PrimitiveRows({ app, e, op }: { app: AppHost; e: Extract<Entity, { type: '3DSOLID' }>; op: PrimitiveOp }) {
  const [busy, setBusy] = useState(false);
  const edit = (patch: Partial<PrimitiveOp>) => {
    setBusy(true);
    app
      .editPrimitive(e.handle, { ...op, ...patch } as PrimitiveOp)
      .catch((err: Error) => app.ui.toast(`Modification impossible : ${err.message}`, 'error'))
      .finally(() => setBusy(false));
  };
  /** Valeur affichée positive ; le sens d'origine (hauteur négative…) est conservé. */
  const signed = (v: number, old: number) => (old < 0 ? -Math.abs(v) : Math.abs(v));
  const pos = (v: number) => v > 0;
  const rows: React.ReactNode[] = [];
  const num = (label: string, value: number, commit: (v: number) => void, ok: (v: number) => boolean = pos) =>
    rows.push(
      <Row key={label} label={label}>
        <NumInput value={value} onCommit={(v) => ok(v) && commit(v)} />
      </Row>,
    );
  switch (op.op) {
    case 'box':
      num('Longueur (X)', Math.abs(op.size.x), (v) => edit({ size: { ...op.size, x: signed(v, op.size.x) } }));
      num('Largeur (Y)', Math.abs(op.size.y), (v) => edit({ size: { ...op.size, y: signed(v, op.size.y) } }));
      num('Hauteur (Z)', Math.abs(op.size.z), (v) => edit({ size: { ...op.size, z: signed(v, op.size.z) } }));
      break;
    case 'cylinder':
      num('Rayon', op.radius, (radius) => edit({ radius }));
      num('Diamètre', 2 * op.radius, (d) => edit({ radius: d / 2 }));
      num('Hauteur', Math.abs(op.height), (v) => edit({ height: signed(v, op.height) }));
      break;
    case 'cone':
      num('Rayon de base', op.radius, (radius) => edit({ radius }), (v) => v >= 0 && (v > 0 || op.topRadius > 0));
      num('Diamètre de base', 2 * op.radius, (d) => edit({ radius: d / 2 }), (v) => v >= 0 && (v > 0 || op.topRadius > 0));
      num('Rayon supérieur', op.topRadius, (topRadius) => edit({ topRadius }), (v) => v >= 0 && (v > 0 || op.radius > 0));
      num('Diamètre supérieur', 2 * op.topRadius, (d) => edit({ topRadius: d / 2 }), (v) => v >= 0 && (v > 0 || op.radius > 0));
      num('Hauteur', Math.abs(op.height), (v) => edit({ height: signed(v, op.height) }));
      break;
    case 'sphere':
      num('Rayon', op.radius, (radius) => edit({ radius }));
      num('Diamètre', 2 * op.radius, (d) => edit({ radius: d / 2 }));
      break;
    case 'torus':
      num('Rayon', op.radius, (radius) => edit({ radius }));
      num('Diamètre', 2 * op.radius, (d) => edit({ radius: d / 2 }));
      num('Rayon du tube', op.tubeRadius, (tubeRadius) => edit({ tubeRadius }));
      num('Diamètre du tube', 2 * op.tubeRadius, (d) => edit({ tubeRadius: d / 2 }));
      break;
    case 'pyramid':
      num('Côtés', op.sides, (sides) => edit({ sides: Math.round(sides) }), (v) => Math.round(v) >= 3 && Math.round(v) <= 64);
      num('Rayon de base', op.radius, (radius) => edit({ radius }));
      num('Rayon supérieur', op.topRadius, (topRadius) => edit({ topRadius }), (v) => v >= 0);
      num('Hauteur', Math.abs(op.height), (v) => edit({ height: signed(v, op.height) }));
      break;
  }
  return (
    <>
      {rows}
      {busy && <p className="pp-hint">Reconstruction du solide…</p>}
    </>
  );
}

function PolylineRows({ app, e }: { app: AppHost; e: Extract<Entity, { type: 'POLYLINE' }> }) {
  const [vi, setVi] = useState(0);
  const i = Math.min(vi, e.points.length - 1);
  const p = e.points[i]!;
  const set = (patch: Partial<NewEntity>) => app.doc.replaceEntity(e.handle, patch);
  return (
    <>
      <Row label="Sommets">
        <span className="pp-ro">{e.points.length}</span>
      </Row>
      <Row label="Sommet courant">
        <span className="pp-spin">
          <button onClick={() => setVi((i - 1 + e.points.length) % e.points.length)}>◀</button>
          {i + 1}
          <button onClick={() => setVi((i + 1) % e.points.length)}>▶</button>
        </span>
      </Row>
      <Row label="Sommet X">
        <NumInput value={p.x} onCommit={(x) => set({ points: e.points.map((q, k) => (k === i ? { ...q, x } : q)) })} />
      </Row>
      <Row label="Sommet Y">
        <NumInput value={p.y} onCommit={(y) => set({ points: e.points.map((q, k) => (k === i ? { ...q, y } : q)) })} />
      </Row>
      <Row label="Élévation">
        <NumInput value={p.z} onCommit={(z) => set({ points: e.points.map((q) => ({ ...q, z })) })} />
      </Row>
      <Row label="Fermée">
        <input type="checkbox" checked={e.closed} onChange={(ev) => set({ closed: ev.target.checked })} />
      </Row>
      <Row label="Longueur">
        <NumInput value={entityLength(e) ?? 0} readOnly />
      </Row>
      {e.closed && (
        <Row label="Aire">
          <NumInput value={entityArea(e) ?? 0} readOnly />
        </Row>
      )}
    </>
  );
}

export function PropertiesPanel() {
  const app = useHost(['selection', 'doc']);
  const doc = app.doc;
  const sel = app.selection.list().map((h) => doc.get(h)).filter((e): e is Entity => !!e);
  const [typeFilter, setTypeFilter] = useState<string>('');
  const types = [...new Set(sel.map((e) => entityLabel(e)))];
  const shown = typeFilter && types.includes(typeFilter) ? sel.filter((e) => entityLabel(e) === typeFilter) : sel;
  if (!sel.length) {
    return (
      <div className="pp">
        <div className="pp-head">Aucune sélection</div>
        <Section title="Général">
          <Row label="Calque courant">
            <select className="pp-input" value={doc.currentLayer} onChange={(e) => doc.setCurrentLayer(e.target.value)}>
              {doc.layers.filter((l) => !l.frozen).map((l) => (
                <option key={l.name}>{l.name}</option>
              ))}
            </select>
          </Row>
          <Row label="Objets du dessin">
            <span className="pp-ro">{doc.size}</span>
          </Row>
          <Row label="Fichier">
            <span className="pp-ro">{doc.fileName}</span>
          </Row>
        </Section>
        <Section title="Variables">
          <Row label="Hauteur de texte">
            <NumInput value={app.sysvars.TEXTSIZE} onCommit={(v) => ((app.sysvars.TEXTSIZE = v), doc.changed())} />
          </Row>
          <Row label="Rayon de raccord">
            <NumInput value={app.sysvars.FILLETRAD} onCommit={(v) => ((app.sysvars.FILLETRAD = v), doc.changed())} />
          </Row>
          <Row label="Distance de décalage">
            <NumInput value={app.sysvars.OFFSETDIST} onCommit={(v) => ((app.sysvars.OFFSETDIST = v), doc.changed())} />
          </Row>
        </Section>
        <p className="pp-hint">Sélectionnez des objets (clic, fenêtre de gauche à droite, capture de droite à gauche) pour afficher et modifier leurs propriétés.</p>
      </div>
    );
  }
  const first = shown[0]!;
  const sameLayer = shown.every((e) => e.layer === first.layer);
  const sameColor = shown.every((e) => e.color === first.color);
  const all = (patch: Partial<NewEntity>) => doc.transaction('Propriétés', () => shown.forEach((e) => doc.replaceEntity(e.handle, patch)));
  return (
    <div className="pp">
      <div className="pp-head">
        <select className="pp-input" value={typeFilter && types.includes(typeFilter) ? typeFilter : ''} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">{types.length === 1 ? `${types[0]} (${sel.length})` : `Tout (${sel.length})`}</option>
          {types.length > 1 && types.map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>
      <Section title="Général">
        <Row label="Calque">
          <select className="pp-input" value={sameLayer ? first.layer : ''} onChange={(e) => all({ layer: e.target.value })}>
            {!sameLayer && <option value="">*VARIE*</option>}
            {doc.layers.map((l) => (
              <option key={l.name}>{l.name}</option>
            ))}
          </select>
        </Row>
        <Row label="Couleur">
          <span className="pp-color">
            <label>
              <input type="checkbox" checked={sameColor && !first.color} onChange={(e) => all({ color: e.target.checked ? undefined : doc.colorOf(first) })} />
              DuCalque
            </label>
            <input type="color" value={doc.colorOf(first)} onChange={(e) => all({ color: e.target.value })} />
          </span>
        </Row>
        <Row label="Épaisseur (calque)">
          <span className="pp-ro">{doc.layer(first.layer)?.lineweight.toFixed(2)} mm</span>
        </Row>
      </Section>
      {shown.length === 1 && (
        <Section title={first.type === '3DSOLID' ? '3D' : 'Géométrie'}>
          <Geometry app={app} e={first} />
        </Section>
      )}
      {shown.length === 1 && first.type === '3DSOLID' && first.history && (
        <Section title={`Historique (${first.history.length} étape${first.history.length > 1 ? 's' : ''})`}>
          <HistoryRows app={app} e={first} />
        </Section>
      )}
      {shown.length > 1 && <p className="pp-hint">{shown.length} objets : seules les propriétés communes sont modifiables. Filtrez par type ci-dessus.</p>}
    </div>
  );
}
