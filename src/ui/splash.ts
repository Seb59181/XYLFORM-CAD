/**
 * Écran de démarrage (défini dans index.html pour s'afficher dès la première image) : nom,
 * version et étape en cours, pour montrer que l'application n'est pas bloquée pendant le
 * chargement de l'interface puis du noyau 3D (≈ 50 Mo de WebAssembly).
 */
const el = () => document.getElementById('splash');

/** Étape affichée ; `pct` (0 à 100) = barre de progression, sinon barre animée. */
export function setSplash(step: string, pct?: number): void {
  const s = el();
  if (!s) return;
  const text = s.querySelector('.sp-step');
  if (text) text.textContent = step;
  const bar = s.querySelector<HTMLElement>('.sp-bar');
  const fill = bar?.querySelector<HTMLElement>('i');
  if (bar && fill) {
    bar.classList.toggle('indet', pct === undefined);
    fill.style.width = pct === undefined ? '' : `${Math.max(4, Math.min(100, pct))}%`;
  }
}

export function splashError(message: string): void {
  setSplash(message, 100);
  el()?.querySelector('.sp-step')?.classList.add('err');
}

let hidden = false;
export function hideSplash(delay = 0): void {
  if (hidden) return;
  hidden = true;
  setTimeout(() => {
    const s = el();
    if (!s) return;
    s.classList.add('done');
    setTimeout(() => s.remove(), 400);
  }, delay);
}
