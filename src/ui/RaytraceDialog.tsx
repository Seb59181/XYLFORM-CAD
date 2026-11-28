/**
 * Fenêtre « Rendu lancer de rayons » : l'image se calcule passe après passe et s'affine sous les
 * yeux (bruitée au départ, nette ensuite). Réglages à gauche, image à droite ; Enregistrer écrit
 * le PNG à la taille réelle à tout moment, même avant la fin.
 *
 * Taille, fond, sol et douceur des ombres relancent le calcul ; rebonds, exposition, lissage du
 * bruit et nombre de passes s'appliquent sans reconstruire la scène.
 */
import { useEffect, useRef, useState } from 'react';
import type { RaytraceBackground, RaytraceFloor, RaytraceJob, RaytraceSettings } from '../app/AppHost';
import { baseName, saveFile } from '../io/fileAccess';
import { remainingMs } from '../render/raytraceMath';
import { useApp } from './context';
import { Frame, useKeys } from './Dialogs';

export const RT_SIZES: { value: string; label: string; size: [number, number] | null }[] = [
  { value: 'view', label: 'Vue actuelle', size: null },
  { value: 'hd720', label: '1280 × 720', size: [1280, 720] },
  { value: 'hd', label: 'Full HD 1920 × 1080', size: [1920, 1080] },
  { value: 'qhd', label: '2560 × 1440', size: [2560, 1440] },
  { value: 'uhd', label: '4K 3840 × 2160', size: [3840, 2160] },
  { value: 'square', label: 'Carré 2048 × 2048', size: [2048, 2048] },
  { value: 'a4', label: 'A4 paysage 3508 × 2480', size: [3508, 2480] },
];

export const RT_QUALITY: { value: number; label: string }[] = [
  { value: 32, label: 'Aperçu (32 passes)' },
  { value: 128, label: 'Bonne (128 passes)' },
  { value: 512, label: 'Haute (512 passes)' },
  { value: 2048, label: 'Très haute (2048 passes)' },
  { value: 0, label: 'Sans fin (jusqu’à l’arrêt)' },
];

const BACKGROUNDS: { value: RaytraceBackground; label: string }[] = [
  { value: 'environment', label: 'Environnement (flou)' },
  { value: 'studio', label: 'Studio (dégradé clair)' },
  { value: 'white', label: 'Blanc' },
  { value: 'screen', label: 'Couleur de l’écran' },
  { value: 'transparent', label: 'Transparent (PNG)' },
];

const FLOORS: { value: RaytraceFloor; label: string }[] = [
  { value: 'studio', label: 'Gris studio mat' },
  { value: 'white', label: 'Blanc mat' },
  { value: 'dark', label: 'Sombre mat' },
  { value: 'gloss', label: 'Noir brillant (reflets)' },
  { value: 'wood', label: 'Bois' },
  { value: 'none', label: 'Aucun sol' },
];

/** Derniers réglages (gardés pendant la session). */
let last: Omit<RaytraceSettings, 'width' | 'height'> & { size: string } | null = null;

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : m ? `${m} min ${String(r).padStart(2, '0')} s` : `${r} s`;
}

export function RaytraceDialog({ initial, onClose }: { initial: RaytraceSettings; onClose: () => void }) {
  const app = useApp();
  const view = app.viewport?.viewSize() ?? { w: 1280, h: 720 };
  const [size, setSize] = useState<string>(last?.size ?? 'view');
  const [s, setS] = useState<Omit<RaytraceSettings, 'width' | 'height'>>(() => {
    const { width: _w, height: _h, ...rest } = initial;
    if (!last) return rest;
    const { size: _s, ...l } = last;
    return { ...rest, ...l, exposure: rest.exposure };
  });
  const jobRef = useRef<RaytraceJob | null>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const [saving, setSaving] = useState(false);
  const dims = (RT_SIZES.find((x) => x.value === size)?.size ?? [Math.max(64, view.w), Math.max(64, view.h)]) as [number, number];
  const W = dims[0], H = dims[1];

  useEffect(() => {
    last = { ...s, size };
  }, [s, size]);

  // (re)construction : taille, fond, sol, douceur des ombres
  useEffect(() => {
    let job: RaytraceJob | null = null;
    let cancelled = false;
    let raf = 0;
    const timer = window.setTimeout(async () => {
      if (!app.viewport?.raytrace) return;
      try {
        job = await app.viewport.raytrace({ ...s, width: W, height: H });
      } catch (e) {
        app.ui.toast(`Lancer de rayons indisponible : ${e instanceof Error ? e.message : String(e)}`, 'error');
        return;
      }
      if (cancelled) return job.dispose();
      jobRef.current = job;
      job.canvas.className = 'rt-canvas';
      job.canvas.style.aspectRatio = `${W} / ${H}`;
      holder.current?.replaceChildren(job.canvas);
      job.onUpdate = () => {
        if (!raf) raf = requestAnimationFrame(() => ((raf = 0), setTick((t) => t + 1)));
      };
      setTick((t) => t + 1);
      void job.start();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      job?.dispose();
      if (jobRef.current === job) jobRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app, W, H, s.background, s.floor, s.softness]);

  // réglages appliqués sans reconstruire
  useEffect(() => {
    jobRef.current?.update({ bounces: s.bounces, denoise: s.denoise, maxSamples: s.maxSamples, exposure: s.exposure });
  }, [s.bounces, s.denoise, s.maxSamples, s.exposure]);

  const close = () => onClose();
  useKeys(null, close);

  const job = jobRef.current;
  const set = (p: Partial<RaytraceSettings>) => setS((v) => ({ ...v, ...p }));
  const save = async () => {
    if (!job) return;
    setSaving(true);
    try {
      const blob = await job.toBlob();
      if (!blob) return app.ui.toast('L’image n’a pas pu être lue.', 'error');
      const data = new Uint8Array(await blob.arrayBuffer());
      const t = await saveFile(data, { name: `${baseName(app.doc.fileName)}-rendu-rayons.png`, mime: 'image/png', description: 'Image PNG', extensions: ['.png'] });
      if (t) app.ui.toast(`Rendu enregistré : ${t.name} (${W} × ${H}, ${job.samples} passes)`, 'success');
    } finally {
      setSaving(false);
    }
  };

  const status = job?.status ?? 'building';
  const pct = job && job.maxSamples > 0 ? Math.min(100, (job.samples / job.maxSamples) * 100) : null;
  const rest = job ? remainingMs(job.samples, job.maxSamples, job.elapsedMs) : null;
  let line: string;
  if (!job || status === 'building') line = `Préparation de la scène${job && job.progress > 0 ? ` (${Math.round(job.progress * 100)} %)` : ''}… la première passe peut demander quelques secondes.`;
  else if (status === 'error') line = `Échec : ${job.error ?? 'erreur inconnue'}`;
  else {
    line = `Passe ${job.samples}${job.maxSamples > 0 ? ` / ${job.maxSamples}` : ''} · ${fmtTime(job.elapsedMs)}`;
    if (status === 'done') line += ' · terminé';
    else if (status === 'paused') line += ' · en pause';
    else if (rest !== null && job.samples >= 3) line += ` · reste ≈ ${fmtTime(rest)}`;
  }

  return (
    <Frame
      title="Rendu lancer de rayons"
      onClose={close}
      className="rt-panel"
      footer={
        <>
          <button className="primary" onClick={save} disabled={!job || status === 'building' || status === 'error' || saving}>
            Enregistrer l’image…
          </button>
          <button onClick={() => job?.setPaused(status === 'running')} disabled={!job || (status !== 'running' && status !== 'paused')}>
            {status === 'paused' ? 'Reprendre' : 'Pause'}
          </button>
          <button onClick={close}>Fermer</button>
        </>
      }
    >
      <div className="rt-body">
        <div className="rt-side">
          <p className="modal-message rp-intro">Lumière globale, reflets et réfractions exacts, ombres douces. L’image s’affine à chaque passe ; enregistrez-la quand elle vous convient.</p>
          <div className="form-grid rp-grid">
            <label>Taille</label>
            <select value={size} onChange={(e) => setSize(e.target.value)}>
              {RT_SIZES.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.size ? x.label : `${x.label} (${view.w} × ${view.h})`}
                </option>
              ))}
            </select>
            <label>Qualité</label>
            <select value={s.maxSamples} onChange={(e) => set({ maxSamples: Number(e.target.value) })}>
              {RT_QUALITY.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
            <label title="Nombre de rebonds de la lumière entre les objets : plus = éclairage indirect plus complet, plus lent">Rebonds</label>
            <select value={s.bounces} onChange={(e) => set({ bounces: Number(e.target.value) })}>
              {[2, 3, 5, 8, 12].map((b) => (
                <option key={b} value={b}>
                  {b}
                  {b === 5 ? ' (conseillé)' : b === 2 ? ' (rapide)' : b === 12 ? ' (intérieurs, verre)' : ''}
                </option>
              ))}
            </select>
            <label>Fond</label>
            <select value={s.background} onChange={(e) => set({ background: e.target.value as RaytraceBackground })}>
              {BACKGROUNDS.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
            <label>Sol</label>
            <select value={s.floor} onChange={(e) => set({ floor: e.target.value as RaytraceFloor })}>
              {FLOORS.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
            <label title="Taille des lampes et du soleil : ombres nettes à gauche, très douces à droite">Douceur des ombres</label>
            <div className="rp-slider">
              <input type="range" min={0} max={100} step={5} value={s.softness} onChange={(e) => set({ softness: Number(e.target.value) })} />
              <span>{s.softness} %</span>
            </div>
            <label title="Luminosité générale de l’image">Exposition</label>
            <div className="rp-slider">
              <input type="range" min={10} max={300} step={5} value={s.exposure ?? 100} onChange={(e) => set({ exposure: Number(e.target.value) })} />
              <span>{s.exposure ?? 100} %</span>
            </div>
            <label className="check form-span" title="Filtre qui lisse le grain restant en gardant les arêtes nettes">
              <input type="checkbox" checked={s.denoise} onChange={(e) => set({ denoise: e.target.checked })} />
              Lisser le bruit restant
            </label>
          </div>
          <p className="rt-hint">Lumières, environnement : LUMIERES · matériaux (verre, métaux, matière lumineuse) : MATERIAU · images sur les faces : TEXTURE. Cadrez la vue avant d’ouvrir cette fenêtre.</p>
        </div>
        <div className="rt-main">
          <div className="rt-view" ref={holder} />
          <div className="rt-status">
            <div className="rt-bar">
              <div style={{ width: `${pct ?? (status === 'running' ? 100 : 0)}%` }} className={pct === null && status === 'running' ? 'endless' : ''} />
            </div>
            <span>
              {W} × {H} · {line}
            </span>
          </div>
        </div>
      </div>
    </Frame>
  );
}
