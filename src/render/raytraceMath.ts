/**
 * Calculs purs du rendu par lancer de rayons (sans Three.js) : découpage en tuiles et durée
 * restante estimée.
 */

/** Nombre de tuiles par côté : une passe d'une grande image est découpée (pas de gel de l'écran). */
export function tilesFor(width: number, height: number): number {
  return Math.max(1, Math.min(4, Math.ceil(Math.sqrt((width * height) / (1280 * 720)))));
}

/** Durée restante estimée (ms) d'après le rythme mesuré ; 0 si terminé, null si inconnue ou sans fin. */
export function remainingMs(samples: number, target: number, elapsedMs: number): number | null {
  if (!(target > 0)) return null;
  if (samples >= target) return 0;
  if (samples <= 0) return null;
  return (elapsedMs / samples) * (target - samples);
}
