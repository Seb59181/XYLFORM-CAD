/// <reference lib="webworker" />
/**
 * Worker du noyau : charge OpenCascade (WASM ≈ 50 Mo, mis en cache par le navigateur)
 * et exécute les requêtes de `KernelClient` hors du thread de l'interface.
 */
import ocFactory from 'opencascade.js/dist/opencascade.full.js';
import wasmUrl from 'opencascade.js/dist/opencascade.full.wasm?url';
import manifoldFactory from 'manifold-3d';
import manifoldWasmUrl from 'manifold-3d/manifold.wasm?url';
import { OccKernel } from '../kernel/OccKernel';
import type { KernelRequest, KernelResponse } from '../kernel/protocol';
import { run } from '../kernel/dispatch';

declare const self: DedicatedWorkerGlobalScope;

const progress = (step: string, pct?: number) => self.postMessage({ type: 'progress', step, pct });

/** Télécharge le WebAssembly d'OpenCascade en signalant l'avancement (écran de démarrage). */
async function fetchWasm(url: string): Promise<ArrayBuffer | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) return undefined;
    const total = Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0, last = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      const pct = total ? Math.round((got / total) * 100) : -1;
      if (pct !== last) {
        last = pct;
        progress(total ? `Chargement du noyau 3D OpenCascade… ${pct} %` : `Chargement du noyau 3D OpenCascade… ${(got / 1e6).toFixed(0)} Mo`, total ? 10 + pct * 0.6 : undefined);
      }
    }
    const out = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) out.set(c, o), (o += c.length);
    return out.buffer;
  } catch {
    return undefined;
  }
}

const ready: Promise<OccKernel> = (async () => {
  progress('Chargement du noyau 3D OpenCascade…', 10);
  const wasmBinary = await fetchWasm(wasmUrl);
  progress('Initialisation du noyau 3D (compilation du WebAssembly)…', 72);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = await (ocFactory as any)({ ...(wasmBinary ? { wasmBinary } : {}), locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path) });
  const k = new OccKernel(oc);
  progress('Chargement du moteur de maillage (STL/3MF)…', 92);
  // booléens des corps maillés (STL/3MF importés) : ≈ 0,5 Mo de WebAssembly
  try {
    const mf = await manifoldFactory({ locateFile: () => manifoldWasmUrl });
    mf.setup();
    k.manifold = mf;
  } catch (e) {
    console.warn('manifold-3d indisponible', e);
  }
  return k;
})();

ready.then(
  () => self.postMessage({ type: 'ready' }),
  (e: unknown) => self.postMessage({ type: 'failed', error: String(e) }),
);

/** Buffers transférables (pas de copie) contenus dans un résultat. */
function transferables(value: unknown, out: Transferable[] = [], seen = new Set<unknown>()): Transferable[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return out;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    if (value.buffer instanceof ArrayBuffer && !out.includes(value.buffer)) out.push(value.buffer);
    return out;
  }
  for (const v of Object.values(value as Record<string, unknown>)) transferables(v, out, seen);
  return out;
}

self.onmessage = async (ev: MessageEvent<{ id: number; req: KernelRequest }>) => {
  const { id, req } = ev.data;
  let msg: KernelResponse;
  try {
    const k = await ready;
    const result = run(k, req);
    msg = { id, ok: true, result };
    self.postMessage(msg, transferables(result));
  } catch (e) {
    const error = e instanceof Error ? e.message : typeof e === 'number' ? `Erreur interne du noyau (${e})` : String(e);
    msg = { id, ok: false, error };
    self.postMessage(msg);
  }
};
