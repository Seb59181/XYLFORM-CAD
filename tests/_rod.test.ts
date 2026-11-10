import { it } from 'vitest';
import initOpenCascade from 'opencascade.js/dist/node.js';
import { OccKernel } from '../src/kernel/OccKernel';
import { run } from '../src/kernel/dispatch';
import { threadedRod } from '../src/app/parts';
import type { KernelRequest, SolidResult } from '../src/kernel/protocol';
it('rod', async () => {
  const k = new OccKernel(await initOpenCascade());
  const K = async (r: KernelRequest) => run(k, r) as SolidResult;
  for (const L of (process.env.LS ?? '30,50,60,80,100').split(',').map(Number)) {
    const t = Date.now();
    try { const r = await threadedRod(K as never, 8, 1.25, 0, L, true); console.log('L', L, 'ok', r.display.volume.toFixed(1), Date.now() - t, 'ms'); }
    catch (e) { console.log('L', L, 'FAIL', (e as Error).message, Date.now() - t, 'ms'); }
  }
}, 900000);
