/**
 * PRESENTATION : visite des scènes (vues nommées) en plein écran, avec transitions animées ;
 * EXPORTPRESENTATION : enregistre la visite en vidéo WebM ou en GIF animé.
 * Les scènes se créent avec VUESNOMMEES > Enregistrer (cadrage, style, calques visibles, coupe).
 */
import { baseName, saveFile } from '../../io/fileAccess';
import { present, recordGif, recordVideo, videoMime, type TourOptions } from '../presentation';
import { cmd, getKeyword, getNumber, kw } from './helpers';

const tour: TourOptions = { transition: 1500, dwell: 2500 };

const noScenes = 'Aucune scène : enregistrez des vues avec VUESNOMMEES > Enregistrer (cadrage, style, calques et coupe).';

const presentation = cmd('PRESENTATION', 'PRESENTATION', ['DIAPORAMA', 'PRES'], 'Mode Présentation : enchaîne les scènes en plein écran avec des transitions animées', async (ctx, app) => {
  if (!app.viewport) return;
  const n = app.doc.namedViews.length;
  if (!n) return ctx.print(noScenes);
  {
    const k = await getKeyword(
      ctx,
      `Présentation de ${n} scène(s) — transition ${tour.transition / 1000} s, pause ${tour.dwell / 1000} s`,
      [kw('Manual', 'Manuelle', 'M', 'Flèches ou clic pour avancer'), kw('Auto', 'Auto', 'A', 'Lecture automatique en boucle'), kw('Timing', 'Durées', 'D', 'Transition et pause')],
      'Manual',
    );
    if (k === 'Timing') {
      const t = await getNumber(ctx, 'Durée de la transition (s)', { defaultValue: tour.transition / 1000, allowZero: true });
      if (typeof t === 'number') tour.transition = Math.round(t * 1000);
      const d = await getNumber(ctx, 'Pause sur chaque scène (s)', { defaultValue: tour.dwell / 1000, allowZero: true });
      if (typeof d === 'number') tour.dwell = Math.round(d * 1000);
      return ctx.print(`Transition ${tour.transition / 1000} s, pause ${tour.dwell / 1000} s (aussi pour EXPORTPRESENTATION).`);
    }
    ctx.print('Présentation : ← → ou clic pour naviguer, P pour la lecture automatique, Échap pour quitter.');
    await present(app, { ...tour, auto: k === 'Auto', loop: true });
    return ctx.print('Fin de la présentation.');
  }
});

const exportPresentation = cmd('EXPORTPRESENTATION', 'EXPORTPRESENTATION', ['EXPPRES', 'VIDEO', 'GIFANIME'], 'Enregistre la visite des scènes en vidéo (WebM) ou en GIF animé', async (ctx, app) => {
  if (!app.viewport) return;
  const n = app.doc.namedViews.length;
  if (!n) return ctx.print(noScenes);
  const hasVideo = !!videoMime();
  const k = await getKeyword(
    ctx,
    `Format de la visite (${n} scène(s))`,
    [...(hasVideo ? [kw('Video', 'Vidéo', 'V', 'WebM, qualité écran')] : []), kw('Gif', 'Gif', 'G', 'GIF animé léger (640 px, 10 images/s)')],
    hasVideo ? 'Video' : 'Gif',
  );
  const name = baseName(app.doc.fileName || 'presentation');
  ctx.print('Enregistrement de la visite… (Échap pour arrêter)');
  if (k === 'Video') {
    const blob = await recordVideo(app, tour, ctx.signal);
    const t = await saveFile(blob, { name: `${name}.webm`, mime: 'video/webm', description: 'Vidéo WebM', extensions: ['.webm'] });
    if (t) ctx.print(`Vidéo enregistrée : ${t.name} (${(blob.size / 1e6).toFixed(1)} Mo).`);
    return;
  }
  const data = await recordGif(app, { ...tour, maxWidth: 640 }, ctx.signal, (m) => ctx.print(m));
  const t = await saveFile(data, { name: `${name}.gif`, mime: 'image/gif', description: 'GIF animé', extensions: ['.gif'] });
  if (t) ctx.print(`GIF enregistré : ${t.name} (${(data.length / 1e6).toFixed(1)} Mo).`);
});

export const presentationCommands = [presentation, exportPresentation];
