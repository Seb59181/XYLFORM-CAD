/**
 * Mode Présentation : enchaîne les scènes (vues nommées avec calques, style et coupe) en plein
 * écran avec des transitions animées de la caméra, et enregistre la visite en vidéo ou en GIF.
 */
import { encodeGif, type GifFrame } from '../io/gif';
import type { AppHost } from './AppHost';
import { restoreNamedView, transitionToNamedView } from './commands/utility';

export interface TourOptions {
  /** Durée de la transition entre deux scènes (ms). */
  transition: number;
  /** Temps passé sur chaque scène (ms) en lecture automatique. */
  dwell: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
  });

function caption(container: HTMLElement): { set(text: string, hint?: string): void; remove(): void } {
  const el = document.createElement('div');
  el.className = 'presentation-caption';
  el.style.cssText =
    'position:absolute;left:50%;bottom:28px;transform:translateX(-50%);padding:8px 18px;border-radius:8px;background:rgba(0,0,0,.55);color:#fff;font:600 18px system-ui,sans-serif;pointer-events:none;z-index:50;text-align:center;transition:opacity .4s';
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.appendChild(el);
  return {
    set(text, hint) {
      el.innerHTML = '';
      el.append(text);
      if (hint) {
        const s = document.createElement('div');
        s.style.cssText = 'font-weight:400;font-size:12px;opacity:.75;margin-top:2px';
        s.textContent = hint;
        el.append(s);
      }
    },
    remove: () => el.remove(),
  };
}

/**
 * Présentation interactive : → / Espace / clic = scène suivante, ← = précédente, P = pause /
 * lecture automatique, Début / Fin, Échap = quitter. Résolue à la sortie.
 */
export async function present(app: AppHost, opts: TourOptions & { auto: boolean; loop: boolean }): Promise<void> {
  const vp = app.viewport;
  const scenes = app.doc.namedViews.map((v) => v.name);
  if (!vp || !scenes.length) return;
  const container = vp.container;
  const cap = caption(container);
  let i = 0, auto = opts.auto, done = false, gen = 0;
  let wake: (() => void) | null = null;
  const hint = () => `${i + 1} / ${scenes.length}${auto ? ' · lecture auto' : ''} — ← → naviguer · P ${auto ? 'pause' : 'lecture'} · Échap quitter`;
  const go = async (n: number, animate = true) => {
    i = (n + scenes.length) % scenes.length;
    const my = ++gen;
    cap.set(scenes[i]!, hint());
    if (animate) await transitionToNamedView(app, scenes[i]!, opts.transition);
    else restoreNamedView(app, scenes[i]!);
    return my === gen;
  };
  const kick = () => (wake?.(), (wake = null));
  const onKey = (e: KeyboardEvent) => {
    const k = e.key;
    if (k === 'Escape') done = true;
    else if (k === 'ArrowRight' || k === ' ' || k === 'PageDown' || k === 'Enter') void go(i + 1);
    else if (k === 'ArrowLeft' || k === 'PageUp' || k === 'Backspace') void go(i - 1);
    else if (k === 'Home') void go(0);
    else if (k === 'End') void go(scenes.length - 1);
    else if (k.toLowerCase() === 'p') {
      auto = !auto;
      cap.set(scenes[i]!, hint());
    } else return;
    e.preventDefault();
    e.stopPropagation();
    kick();
  };
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    void go(i + 1);
    kick();
  };
  const onFs = () => {
    if (!document.fullscreenElement) (done = true), kick();
  };
  window.addEventListener('keydown', onKey, true);
  container.addEventListener('pointerdown', onClick, true);
  container.classList.add('presenting');
  let fs = false;
  try {
    if (container.requestFullscreen && !document.fullscreenElement) {
      await container.requestFullscreen();
      fs = true;
      document.addEventListener('fullscreenchange', onFs);
    }
  } catch {
    /* plein écran refusé (navigateur) : présentation dans la fenêtre */
  }
  try {
    await go(0, false);
    while (!done) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const why = await new Promise<'key' | 'timer'>((r) => {
        wake = () => r('key');
        if (auto) timer = setTimeout(() => r('timer'), opts.dwell + opts.transition);
      });
      clearTimeout(timer);
      wake = null;
      if (done || why === 'key') continue; // la touche a déjà agi
      if (!opts.loop && i === scenes.length - 1) break;
      await go(i + 1);
    }
  } finally {
    window.removeEventListener('keydown', onKey, true);
    container.removeEventListener('pointerdown', onClick, true);
    document.removeEventListener('fullscreenchange', onFs);
    cap.remove();
    container.classList.remove('presenting');
    if (fs && document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
  }
}

/** Joue la visite une fois (scène 1 → dernière) en appelant `frame` à chaque image affichée. */
async function playOnce(app: AppHost, opts: TourOptions, signal: AbortSignal): Promise<void> {
  const scenes = app.doc.namedViews.map((v) => v.name);
  restoreNamedView(app, scenes[0]!);
  await sleep(opts.dwell, signal);
  for (let k = 1; k < scenes.length && !signal.aborted; k++) {
    await transitionToNamedView(app, scenes[k]!, opts.transition);
    await sleep(opts.dwell, signal);
  }
}

/** Formats vidéo pris en charge (webm VP9 / VP8), le premier disponible. */
export function videoMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) if (MediaRecorder.isTypeSupported(m)) return m;
  return null;
}

/** Enregistre la visite des scènes en vidéo WebM (capture du canevas à 30 i/s). */
export async function recordVideo(app: AppHost, opts: TourOptions, signal: AbortSignal): Promise<Blob> {
  const vp = app.viewport!;
  const mime = videoMime();
  if (!mime) throw new Error('L’enregistrement vidéo n’est pas disponible ici.');
  const stream = vp.canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const stopped = new Promise<void>((r) => (rec.onstop = () => r()));
  // le canevas n'émet d'images que lorsqu'il est redessiné : on force un rendu régulier
  const tick = setInterval(() => vp.renderFrame(), 1000 / 30);
  rec.start(500);
  try {
    await playOnce(app, opts, signal);
  } finally {
    clearInterval(tick);
    rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
  }
  return new Blob(chunks, { type: 'video/webm' });
}

/** Enregistre la visite en GIF animé (10 i/s, largeur ≤ `maxWidth`). */
export async function recordGif(app: AppHost, opts: TourOptions & { maxWidth: number; fps?: number }, signal: AbortSignal, onProgress?: (msg: string) => void): Promise<Uint8Array> {
  const vp = app.viewport!;
  const fps = opts.fps ?? 10;
  const src = vp.canvas;
  const k = Math.min(1, opts.maxWidth / Math.max(1, src.width));
  const w = Math.max(16, Math.round(src.width * k)), h = Math.max(16, Math.round(src.height * k));
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d', { willReadFrequently: true })!;
  const frames: GifFrame[] = [];
  const grab = () => {
    // rendu puis copie dans la même tâche (le tampon WebGL n'est pas conservé)
    vp.renderFrame();
    g.drawImage(src, 0, 0, w, h);
    frames.push({ width: w, height: h, data: g.getImageData(0, 0, w, h).data });
  };
  const tick = setInterval(grab, 1000 / fps);
  try {
    await playOnce(app, opts, signal);
  } finally {
    clearInterval(tick);
  }
  if (!frames.length) grab();
  onProgress?.(`Encodage de ${frames.length} images…`);
  await sleep(30);
  return encodeGif(frames, 1000 / fps);
}
