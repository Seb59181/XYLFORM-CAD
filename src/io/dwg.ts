/**
 * Lecture DWG (R13 à 2018+) : LibreDWG compilé en WebAssembly convertit le fichier en DXF,
 * relu ensuite par `readDxf`. Chargé à la demande (≈ 10 Mo) à la première ouverture d'un DWG.
 * LibreDWG est distribué sous licence GPL-3.0.
 */
import wasmUrl from 'libredwg-wasm?url';

let lib: Promise<{ dwg_write_dxf(data: ArrayBuffer): Uint8Array | null }> | null = null;

function load() {
  lib ??= (async () => {
    const mod = await import('@mlightcad/libredwg-web');
    const instance = await mod.createModule({ locateFile: (f: string) => (f.endsWith('.wasm') ? wasmUrl : f) });
    return mod.LibreDwg.createByWasmInstance(instance);
  })();
  lib.catch(() => (lib = null));
  return lib;
}

/** Convertit un DWG en texte DXF. */
export async function dwgToDxf(data: Uint8Array): Promise<string> {
  const l = await load();
  const out = l.dwg_write_dxf(data.slice().buffer);
  if (!out || !out.length) throw new Error('Ce fichier DWG n’a pas pu être lu (version non prise en charge ou fichier endommagé).');
  const utf8 = new TextDecoder('utf-8').decode(out);
  // DXF antérieurs à 2007 : page de code Windows
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(out) : utf8;
}
