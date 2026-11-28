/**
 * Moteur web-ifc (WebAssembly, chargé à la demande) pour la lecture des fichiers IFC.
 */
import wasmUrl from 'web-ifc/web-ifc.wasm?url';
import type { IfcAPI } from 'web-ifc';

export async function ifcApi(): Promise<IfcAPI> {
  const { IfcAPI: Api } = await import('web-ifc');
  const api = new Api();
  // un seul fil : le multi-fil exige SharedArrayBuffer (en-têtes d'isolation)
  await api.Init((path: string) => (path.endsWith('.wasm') ? wasmUrl : path), true);
  return api;
}
