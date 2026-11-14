// Lance les tests du noyau OpenCascade (plus longs) : fonctionne sous Windows, macOS et Linux.
import { spawn } from 'node:child_process';

const child = spawn('npx', ['vitest', 'run', 'tests/occ.test.ts', 'tests/kernel.test.ts', 'tests/parts.test.ts', 'tests/history.test.ts', 'tests/drawing.test.ts', 'tests/sheetmetal.test.ts', 'tests/lot2-occ.test.ts'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, OCC: '1' },
});
child.on('exit', (code) => process.exit(code ?? 1));
