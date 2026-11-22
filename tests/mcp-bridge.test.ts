/**
 * Pont MCP (electron/mcp-bridge.cjs) lancé comme le ferait un assistant IA : JSON-RPC sur
 * l'entrée/sortie standard, relais des appels d'outils vers l'application (serveur HTTP local
 * simulé, jeton vérifié), messages clairs quand l'application n'est pas joignable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function client(connection: string) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['electron/mcp-bridge.cjs'], { env: { ...process.env, XYLFORM_MCP_CONNECTION: connection } });
  let buf = '';
  const waiting = new Map<number, (m: unknown) => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = JSON.parse(line) as { id: number };
      waiting.get(m.id)?.(m);
    }
  });
  let id = 0;
  const call = (method: string, params?: unknown) =>
    new Promise<{ result?: any; error?: any }>((resolve) => {
      const n = ++id;
      waiting.set(n, resolve as (m: unknown) => void);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
    });
  return { child, call, notify: (method: string) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`) };
}

describe('pont MCP', () => {
  let server: Server;
  let port = 0;
  const calls: { auth?: string; body: any }[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'xylform-mcp-'));
  const conn = join(dir, 'connexion.json');

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer secret') {
        res.writeHead(401).end('refusé');
        return;
      }
      if (req.url === '/ping') return void res.writeHead(200).end(JSON.stringify({ ok: true }));
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = JSON.parse(data);
        calls.push({ auth: req.headers.authorization, body });
        res.writeHead(200).end(JSON.stringify({ content: [{ type: 'text', text: `reçu ${body.tool} : ${body.args.script ?? ''}` }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => server.close());

  it('initialisation, liste des outils, appel relayé avec le jeton', async () => {
    writeFileSync(conn, JSON.stringify({ enabled: true, port, token: 'secret', exe: '' }));
    const c = client(conn);
    try {
      const init = await c.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      expect(init.result.protocolVersion).toBe('2025-06-18');
      expect(init.result.serverInfo.name).toBe('xylform-cad');
      expect(init.result.capabilities.tools).toBeTruthy();
      expect(init.result.instructions).toContain('xylform_consigne');
      c.notify('notifications/initialized');
      const old = await c.call('initialize', { protocolVersion: '2099-01-01' });
      expect(old.result.protocolVersion).toBe('2025-06-18');
      const list = await c.call('tools/list');
      const names = list.result.tools.map((t: { name: string }) => t.name);
      expect(names).toEqual(['xylform_consigne', 'xylform_executer_script', 'xylform_etat', 'xylform_capture', 'xylform_exporter', 'xylform_annuler']);
      for (const t of list.result.tools) expect(t.inputSchema.type).toBe('object');
      const r = await c.call('tools/call', { name: 'xylform_executer_script', arguments: { script: 'BOITE 0,0,0 1,1,1' } });
      expect(r.result.content[0].text).toBe('reçu xylform_executer_script : BOITE 0,0,0 1,1,1');
      expect(calls.at(-1)!.body).toEqual({ tool: 'xylform_executer_script', args: { script: 'BOITE 0,0,0 1,1,1' } });
      expect((await c.call('ping')).result).toEqual({});
      expect((await c.call('n/importe')).error.code).toBe(-32601);
      const unknown = await c.call('tools/call', { name: 'rien' });
      expect(unknown.result.isError).toBe(true);
    } finally {
      c.child.kill();
    }
  });

  it('application fermée, désactivée ou jeton périmé : erreur d’outil lisible', async () => {
    const c = client(conn);
    try {
      writeFileSync(conn, JSON.stringify({ enabled: false, port: 0, token: '' }));
      let r = await c.call('tools/call', { name: 'xylform_etat', arguments: {} });
      expect(r.result.isError).toBe(true);
      expect(r.result.content[0].text).toMatch(/désactivée/);
      writeFileSync(conn, JSON.stringify({ enabled: true, port: 1, token: 'x', exe: join(dir, 'absent.exe') }));
      r = await c.call('tools/call', { name: 'xylform_etat', arguments: {} });
      expect(r.result.content[0].text).toMatch(/n’est pas ouvert/);
      writeFileSync(conn, JSON.stringify({ enabled: true, port, token: 'secret' }));
      r = await c.call('tools/call', { name: 'xylform_etat', arguments: {} });
      expect(r.result.isError).toBeFalsy();
    } finally {
      c.child.kill();
    }
  });
});
