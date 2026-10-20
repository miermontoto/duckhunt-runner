// una sesión de navegador exclusiva entre dos runs (t#495, M7): el segundo espera el turno con su nota y su copia se
// hace DESPUÉS de tomarlo (lifecycle.ts::mcp), así lleva lo que el primero devolvió al vault; y un run abortado no
// devuelve nada al vault, pero su copia se borra igual.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { KeyedMutex } from '../src/keyed-mutex.js';
import { holdLocks, materializeRun } from '../src/resources/lifecycle.js';
import { BROWSER_WAIT_NOTE, browserProvider } from '../src/resources/browser/provider.js';
import { RELEASE, type RunContext } from '../src/resources/types.js';
import type { PlannedResource } from '../src/resources/registry.js';

const KEY = 'jira';
const ORIGIN = 'https://acme.atlassian.net';
const SERVER = `res_browser_${KEY}`;
const savedHome = process.env.DUCKHUNT_RUNNER_HOME;
let root = '';
let vaultFile = '';

type State = { cookies: { name: string; value: string; domain: string; path: string; expires: number }[]; origins: unknown[] };
const cookie = (name: string): State['cookies'][number] => ({ name, value: name, domain: 'acme.atlassian.net', path: '/', expires: -1 });
const cookiesOf = (file: string): string[] => (JSON.parse(fs.readFileSync(file, 'utf8')) as State).cookies.map((c) => c.name).sort();
// lo que odysea guardaría en la copia del run: una cookie más.
const save = (stateFile: string, name: string): void => {
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as State;
  fs.writeFileSync(stateFile, JSON.stringify({ ...st, cookies: [...st.cookies, cookie(name)] }));
};

const vaultLocks = new KeyedMutex();
const provider = browserProvider({
  odysea: () => ({ ok: true, info: { bin: '/opt/odysea', version: '0.5.0' } }),
  vaultDir: () => path.dirname(vaultFile),
  vaultLocks,
  health: () => [],
});
const plan: PlannedResource[] = [
  { provider, request: { type: 'browser', key: KEY, access: 'read', params: {} }, ref: { session: KEY, origins: [ORIGIN], exclusive: true } },
];
const ctx = (runId: string): RunContext => ({ platform: 'duckhunt', runId, env: {}, gitLocks: new KeyedMutex() });
const scratch = { dir: () => root, exclusive: false };
const never = new Promise<never>(() => {});

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-browser-run-'));
  process.env.DUCKHUNT_RUNNER_HOME = path.join(root, 'home');
  const vault = path.join(root, 'vault');
  fs.mkdirSync(vault, { mode: 0o700 });
  vaultFile = path.join(vault, `${KEY}.json`);
  fs.writeFileSync(vaultFile, JSON.stringify({ cookies: [cookie('sid')], origins: [] }), { mode: 0o600 });
});

after(() => {
  process.env.DUCKHUNT_RUNNER_HOME = savedHome;
  fs.rmSync(root, { recursive: true, force: true });
});

test('dos runs de la misma sesión exclusiva: el segundo espera y su copia lleva lo que el primero devolvió', async () => {
  const turns = new KeyedMutex();
  const a = await materializeRun(plan, ctx('a'), scratch);
  const releaseA = await holdLocks(a.locks, turns, never, () => {});
  const mcpA = await a.mcp();
  const copyA = mcpA.servers[SERVER]!.env.ODYSEA_STATE_FILE!;
  save(copyA, 'rotated');

  const b = await materializeRun(plan, ctx('b'), scratch);
  const notes: string[] = [];
  const holdingB = holdLocks(b.locks, turns, never, (n) => notes.push(n));
  // b espera el turno de la sesión mientras a lo tenga.
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(notes, [BROWSER_WAIT_NOTE]);
  await a.release(RELEASE.done);
  releaseA();
  assert.deepEqual(cookiesOf(vaultFile), ['rotated', 'sid'], 'a devolvió su cookie al vault');
  assert.equal(fs.existsSync(copyA), false, 'y su copia se borró');

  const releaseB = await holdingB;
  const mcpB = await b.mcp();
  const copyB = mcpB.servers[SERVER]!.env.ODYSEA_STATE_FILE!;
  assert.deepEqual(cookiesOf(copyB), ['rotated', 'sid'], 'la copia de b, hecha con el turno ya suyo');

  // b se aborta (otro recurso falló, o no se lanzó): nada vuelve al vault y la copia se borra igual.
  save(copyB, 'aborted');
  await b.release(RELEASE.aborted);
  releaseB();
  assert.deepEqual(cookiesOf(vaultFile), ['rotated', 'sid'], 'aborted no devuelve nada');
  assert.equal(fs.existsSync(path.dirname(copyB)), false);
});
