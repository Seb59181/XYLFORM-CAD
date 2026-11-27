/**
 * Fenêtre « Lumières et ambiance » : sources de lumière du dessin (ampoule, projecteur, soleil)
 * réglables en couleur et en intensité, et ambiance du rendu réaliste (environnement, exposition,
 * occlusion ambiante, fond). Chaque réglage s'affiche aussitôt dans la vue ; OK enregistre le
 * tout en une étape d'annulation, Annuler revient à l'état d'avant.
 *
 * La fenêtre ne masque pas la vue : on peut tourner autour du modèle pendant les réglages.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import type { Vec3 } from '../core/commands/types';
import {
  defaultLight,
  ENVIRONMENT_LABEL,
  LIGHT_KIND_LABEL,
  LIGHT_PRESETS,
  sanitizeLight,
  type EnvironmentKind,
  type LightDef,
  type LightKind,
  type RenderEnvironment,
} from '../core/render';
import { useApp } from './context';
import { Frame, useKeys } from './Dialogs';

export interface RenderPanelResult {
  lights: LightDef[];
  env: RenderEnvironment;
}

/** Position de départ d'une nouvelle lampe : au-dessus et devant le modèle, côté gauche. */
export function suggestLightPlace(box: { min: Vec3; max: Vec3 } | null, kind: LightKind, index: number): { position: Vec3; target: Vec3 } {
  const b = box ?? { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 50 } };
  const c = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
  const r = Math.max(1, Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) / 2);
  const az = ((-120 + index * 75) * Math.PI) / 180;
  const el = kind === 'directional' ? 0.9 : 0.75;
  const d = kind === 'point' ? r * 1.6 : r * 2.4;
  const round = (v: number) => Math.round(v * 10) / 10;
  return {
    position: { x: round(c.x + d * Math.cos(el) * Math.cos(az)), y: round(c.y + d * Math.cos(el) * Math.sin(az)), z: round(c.z + d * Math.sin(el)) },
    target: { x: round(c.x), y: round(c.y), z: round(b.min.z) },
  };
}

function Slider({ value, min, max, step = 1, unit = '%', onChange }: { value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <div className="rp-slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <input
        type="number"
        min={min}
        step={step}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value.replace(',', '.'));
          if (Number.isFinite(v)) onChange(v);
        }}
      />
      <span>{unit}</span>
    </div>
  );
}

function VecInput({ value, onChange }: { value: Vec3; onChange: (v: Vec3) => void }) {
  return (
    <div className="rp-vec">
      {(['x', 'y', 'z'] as const).map((k) => (
        <input
          key={k}
          type="number"
          step="any"
          title={k.toUpperCase()}
          value={value[k]}
          onChange={(e) => {
            const v = Number(e.target.value.replace(',', '.'));
            if (Number.isFinite(v)) onChange({ ...value, [k]: v });
          }}
        />
      ))}
    </div>
  );
}

export function RenderDialog({ initial, onDone }: { initial: RenderPanelResult; onDone: (v: RenderPanelResult | null) => void }) {
  const app = useApp();
  const [lights, setLights] = useState<LightDef[]>(initial.lights);
  const [env, setEnv] = useState<RenderEnvironment>(initial.env);
  const [sel, setSel] = useState<string | null>(initial.lights[0]?.id ?? null);
  const box = useMemo(() => {
    const bs = app.doc.all().flatMap((e) => (e.type === '3DSOLID' && !e.hidden ? [e.display.bbox] : []));
    if (!bs.length) return null;
    return {
      min: { x: Math.min(...bs.map((b) => b.min.x)), y: Math.min(...bs.map((b) => b.min.y)), z: Math.min(...bs.map((b) => b.min.z)) },
      max: { x: Math.max(...bs.map((b) => b.max.x)), y: Math.max(...bs.map((b) => b.max.y)), z: Math.max(...bs.map((b) => b.max.z)) },
    };
  }, [app]);

  // aperçu en direct
  useEffect(() => {
    app.viewport?.previewRender({ lights: lights.map(sanitizeLight), env });
  }, [app, lights, env]);

  const ok = () => onDone({ lights: lights.map(sanitizeLight), env });
  const cancel = () => onDone(null);
  useKeys(null, cancel);

  const cur = lights.find((l) => l.id === sel) ?? null;
  const patch = (p: Partial<LightDef>) => cur && setLights((ls) => ls.map((l) => (l.id === cur.id ? { ...l, ...p } : l)));
  const add = (kind: LightKind) => {
    const place = suggestLightPlace(box, kind, lights.length);
    const l = defaultLight(lights, kind, place.position, place.target);
    setLights((ls) => [...ls, l]);
    setSel(l.id);
  };
  const remove = () => {
    if (!cur) return;
    const rest = lights.filter((l) => l.id !== cur.id);
    setLights(rest);
    setSel(rest[0]?.id ?? null);
  };
  const setE = (p: Partial<RenderEnvironment>) => setEnv((e) => ({ ...e, ...p }));
  const preset = LIGHT_PRESETS.find((p) => p.color === cur?.color.toLowerCase());

  return (
    <Frame
      title="Lumières et ambiance"
      onClose={cancel}
      className="render-panel"
      footer={
        <>
          <button className="primary" onClick={ok}>
            OK
          </button>
          <button onClick={cancel}>Annuler</button>
        </>
      }
    >
      <p className="modal-message rp-intro">Les réglages s’affichent tout de suite dans la vue (styles Rendu et Photoréaliste). La vue reste utilisable : tournez autour du modèle pendant les réglages.</p>
      <div className="rp-section">Sources de lumière</div>
      <div className="rp-lights">
        <div className="rp-list" role="listbox" aria-label="Lumières du dessin">
          {lights.length === 0 && <div className="rp-empty">Aucune lumière : l’éclairage par défaut est utilisé.</div>}
          {lights.map((l) => (
            <div key={l.id} role="option" aria-selected={l.id === sel} className={`rp-item ${l.id === sel ? 'on' : ''}`} onClick={() => setSel(l.id)}>
              <input type="checkbox" checked={l.on} title="Allumée" onClick={(e) => e.stopPropagation()} onChange={(e) => setLights((ls) => ls.map((x) => (x.id === l.id ? { ...x, on: e.target.checked } : x)))} />
              <span className="rp-swatch" style={{ background: l.color }} />
              <span className="rp-name">{l.name}</span>
              <span className="rp-pct">{Math.round(l.intensity)} %</span>
            </div>
          ))}
        </div>
        <div className="rp-add">
          <button onClick={() => add('point')}>+ Ampoule</button>
          <button onClick={() => add('spot')}>+ Projecteur</button>
          <button onClick={() => add('directional')}>+ Soleil</button>
          <button onClick={remove} disabled={!cur}>
            Supprimer
          </button>
        </div>
      </div>
      {cur && (
        <div className="form-grid rp-grid">
          <label>Nom</label>
          <input type="text" value={cur.name} onChange={(e) => patch({ name: e.target.value })} spellCheck={false} />
          <label>Type</label>
          <select value={cur.kind} onChange={(e) => patch({ kind: e.target.value as LightKind, ...(e.target.value === 'spot' ? { angle: cur.angle ?? 30, penumbra: cur.penumbra ?? 0.3 } : {}) })}>
            {(Object.keys(LIGHT_KIND_LABEL) as LightKind[]).map((k) => (
              <option key={k} value={k}>
                {LIGHT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <label>Couleur</label>
          <div className="rp-color">
            <input type="color" value={cur.color} onChange={(e) => patch({ color: e.target.value })} aria-label="Couleur de la lumière" />
            <select value={preset?.color ?? ''} onChange={(e) => e.target.value && patch({ color: e.target.value })}>
              <option value="">{preset ? preset.label : 'Couleur libre'}</option>
              {LIGHT_PRESETS.map((p) => (
                <option key={p.color} value={p.color}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <label title="100 % = éclairage de référence au centre du modèle ; une lampe ponctuelle éclaire moins loin d’elle (décroissance naturelle).">Intensité</label>
          <Slider value={cur.intensity} min={0} max={400} step={5} onChange={(v) => patch({ intensity: v })} />
          {cur.kind === 'spot' && (
            <>
              <label>Ouverture du cône</label>
              <Slider value={cur.angle ?? 30} min={1} max={89} unit="°" onChange={(v) => patch({ angle: v })} />
              <label>Flou du bord</label>
              <Slider value={Math.round((cur.penumbra ?? 0.3) * 100)} min={0} max={100} onChange={(v) => patch({ penumbra: v / 100 })} />
            </>
          )}
          <label>{cur.kind === 'directional' ? 'Vient de (point)' : 'Position'}</label>
          <VecInput value={cur.position} onChange={(v) => patch({ position: v })} />
          {cur.kind !== 'point' && (
            <>
              <label>Vise (point)</label>
              <VecInput value={cur.target} onChange={(v) => patch({ target: v })} />
            </>
          )}
          <label className="check form-span">
            <input type="checkbox" checked={cur.shadows} onChange={(e) => patch({ shadows: e.target.checked })} />
            Ombres portées
          </label>
        </div>
      )}
      <div className="rp-section">Ambiance</div>
      <div className="form-grid rp-grid">
        <label>Environnement</label>
        <select value={env.environment} onChange={(e) => setE({ environment: e.target.value as EnvironmentKind })}>
          {(Object.keys(ENVIRONMENT_LABEL) as EnvironmentKind[]).map((k) => (
            <option key={k} value={k}>
              {ENVIRONMENT_LABEL[k]}
            </option>
          ))}
        </select>
        <label title="Lumière diffuse et reflets venant de l’environnement">Lumière ambiante</label>
        <Slider value={env.envIntensity} min={0} max={300} step={5} onChange={(v) => setE({ envIntensity: v })} />
        <label title="Luminosité générale de l’image">Exposition</label>
        <Slider value={env.exposure} min={10} max={300} step={5} onChange={(v) => setE({ exposure: v })} />
        <label>Fond</label>
        <select value={env.background} onChange={(e) => setE({ background: e.target.value as RenderEnvironment['background'] })}>
          <option value="environment">Environnement (flou)</option>
          <option value="screen">Couleur de l’écran</option>
        </select>
        {(
          [
            ['ambientOcclusion', 'Occlusion ambiante (creux et coins assombris)'],
            ['defaultLights', 'Garder le soleil par défaut avec vos lumières'],
            ['ground', 'Sol qui reçoit les ombres'],
          ] as const
        ).map(([k, label]) => (
          <Fragment key={k}>
            <label className="check form-span">
              <input type="checkbox" checked={env[k]} onChange={(e) => setE({ [k]: e.target.checked })} />
              {label}
            </label>
          </Fragment>
        ))}
      </div>
    </Frame>
  );
}
