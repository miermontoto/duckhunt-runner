// el cable legacy (contrato 42) no cambia ni un byte con los ids opacos (t#495, M1): los cuerpos esperados
// se capturaron con el daemon de antes del cambio (ids numéricos) y aquí se comparan como texto exacto. el de
// progress sale de la misma expresión que tenía el closure de entonces. además: un id opaco no llega nunca a
// ese cable (ni en /conversations ni en keptWorktrees).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { configPath, loadConfig, type RunnerConfig } from '../src/config.js';
import { RunLease } from '../src/run-lease.js';
import type { KeptWorktree } from '../src/server-state.js';
import type { StatusReport } from '../src/status-report.js';
import type { SeqEvent } from '../src/event-uploader.js';
import { internals, legacyOf } from './daemon-harness.js';
import { runnerVersion } from '../src/version.js';

const BASE = 'https://duckhunt.test';
const API = `${BASE}/api/runner`;
const MACHINE = '6f1d7c1e-5b0a-4c34-9b8e-2a3f7c1d9e01';
// MIN_HEARTBEAT_MS del daemon: el latido nunca va más rápido.
const HEARTBEAT_FLOOR_MS = 5_000;
const realFetch = globalThis.fetch;
let root = '';

const cfg: RunnerConfig = {
  baseUrl: BASE,
  clientId: 'c1',
  refreshToken: 'r1',
  label: 'fa',
  machineId: MACHINE,
  machineHost: 'fa',
  repos: { 'acme/api': { path: '/dev/api' } },
  aws: { '123456789012': { profile: 'prod' } },
  defaults: { maxConcurrent: 2 },
};

// lo que estos casos tocan: el claim y el latido del daemon y las llamadas del cable de su plataforma legacy.
interface Wire {
  claim(): Promise<unknown>;
  openConversations(ids: string[]): Promise<Set<string>>;
  postEvents(runId: string, events: SeqEvent[], seg: { segment?: number }): Promise<number>;
  postStatus(runId: string, report: StatusReport): Promise<void>;
  postProgress(runId: string, toolCalls: number, seg: { segment?: number }, workdir?: string): void;
  startHeartbeat(lease: RunLease, heartbeatMs: number, seg: { segment?: number }): NodeJS.Timeout;
  keptWorktrees: KeptWorktree[] | null;
}


// server falso: guarda `<ruta> <cuerpo tal cual>` de cada llamada a /api/runner.
function capture(): string[] {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'a', refresh_token: 'r2', expires_in: 3600 });
    calls.push(`${url.slice(API.length)} ${String(init?.body)}`);
    if (url.endsWith('/claim')) return new Response(null, { status: 204 });
    if (url.endsWith('/conversations')) return Response.json({ open: [12] });
    if (url.endsWith('/heartbeat')) return Response.json({ status: 'running', cancel: false });
    return Response.json({ ok: true });
  }) as typeof fetch;
  return calls;
}

async function daemon(): Promise<Wire> {
  const d = internals(loadConfig()!);
  await d.reloadConfig();
  const sup = legacyOf(d);
  return {
    claim: () => sup.claim(),
    openConversations: (ids) => sup.platform.openConversations(ids),
    postEvents: (runId, events, seg) => sup.platform.events(runId, events, seg),
    postStatus: (runId, report) => sup.platform.result(runId, report),
    postProgress: (runId, toolCalls, seg, workdir) => d.postProgress(sup, runId, toolCalls, seg, workdir),
    startHeartbeat: (lease, ms, seg) => d.startHeartbeat(sup, lease, ms, seg),
    set keptWorktrees(kept: KeptWorktree[] | null) {
      sup.keptWorktrees = kept;
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-wire-'));
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  fs.writeFileSync(configPath(), JSON.stringify(cfg), { mode: 0o600 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('cuerpos del cable legacy byte a byte iguales a los del daemon con ids numéricos', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.timers.enable({ apis: ['setInterval'] });
  const calls = capture();
  const d = await daemon();
  d.keptWorktrees = [
    { runId: '3', dirtyFiles: 2, unpushedCommits: 0 },
    { runId: '12', dirtyFiles: 0, unpushedCommits: 1 },
  ];
  await d.claim();
  assert.deepEqual([...(await d.openConversations(['12', '34']))], ['12']);
  await d.postEvents('88', [{ seq: 5, kind: 'text', body: 'hola' }], { segment: 3 });
  await d.postStatus('88', { status: 'done', result: 'listo', costUsd: 0.25, numTurns: 2, toolCalls: 3, sessionId: 's-1', model: 'opus', resumed: true, segment: 3 });
  d.postProgress('88', 0, { segment: 3 }, 'worktree · feat/x');
  const timer = d.startHeartbeat(new RunLease('88'), 1, { segment: 3 });
  t.mock.timers.tick(HEARTBEAT_FLOOR_MS);
  clearInterval(timer);
  await settle();

  // la versión solo viaja si se puede leer (en dist-test no hay package.json al lado): como en el daemon.
  const version = runnerVersion() ? `"version":"${runnerVersion()}",` : '';
  assert.deepEqual(calls, [
    `/claim {"runnerLabel":"fa","repos":["acme/api"],"awsAccounts":["123456789012"],"capabilities":["events","checkout","repo_edit","secret_paths","seed_budget","aws_strict","worktree_report","logout","toolset_v1","toolset_render"],"slots":2,${version}"machine":{"id":"${MACHINE}"},"keptWorktrees":[{"runId":3,"dirtyFiles":2,"unpushedCommits":0},{"runId":12,"dirtyFiles":0,"unpushedCommits":1}],"awsDefault":false}`,
    '/conversations {"runIds":[12,34]}',
    '/runs/88/events {"events":[{"seq":5,"kind":"text","body":"hola"}],"segment":3}',
    '/runs/88/status {"status":"done","result":"listo","costUsd":0.25,"numTurns":2,"toolCalls":3,"sessionId":"s-1","model":"opus","resumed":true,"segment":3}',
    '/runs/88/progress {"toolCalls":0,"workdir":"worktree · feat/x","segment":3}',
    '/runs/88/heartbeat {"segment":3}',
  ]);
});

test('un id opaco no llega al cable legacy: ni se pregunta en /conversations ni se anuncia como conservado', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const calls = capture();
  const d = await daemon();
  d.keptWorktrees = [
    { runId: '7', dirtyFiles: 1, unpushedCommits: 0 },
    { runId: 'l-01HZ', dirtyFiles: 1, unpushedCommits: 0 },
  ];
  await d.claim();
  const open = await d.openConversations(['12', 'l-01HZ']);
  assert.ok(open.has('l-01HZ'), 'sin preguntar cuenta como abierta: solo la recoge el ttl');
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /id no numérico/);
  assert.match(calls[0]!, /"keptWorktrees":\[\{"runId":7,"dirtyFiles":1,"unpushedCommits":0\}\],"awsDefault":false\}$/);
  assert.equal(calls[1], '/conversations {"runIds":[12]}');
  // solo ids opacos: ni una llamada a /conversations.
  assert.deepEqual([...(await d.openConversations(['l-a', 'l-b']))].sort(), ['l-a', 'l-b']);
  assert.equal(calls.length, 2);
});

test('la clave aws `default` no se anuncia como cuenta: el cable legacy solo lleva ids de cuenta (t#495, M2)', async (t) => {
  t.mock.method(console, 'log', () => {});
  fs.writeFileSync(configPath(), JSON.stringify({ ...cfg, aws: { ...cfg.aws, default: { profile: 'personal' } } }), { mode: 0o600 });
  const calls = capture();
  const d = await daemon();
  await d.claim();
  assert.match(calls[0]!, /"awsAccounts":\["123456789012"\],/);
});

test('la etiqueta viaja dentro de lo que acepta el server: recortada y sin pasar de su tope; en blanco, el hostname (t#495, M3)', async (t) => {
  t.mock.method(console, 'log', () => {});
  const labelOf = async (label: string): Promise<string> => {
    fs.writeFileSync(configPath(), JSON.stringify({ ...cfg, label }), { mode: 0o600 });
    const calls = capture();
    await (await daemon()).claim();
    return String((JSON.parse(calls[0]!.slice(calls[0]!.indexOf('{'))) as { runnerLabel: string }).runnerLabel);
  };
  const long = await labelOf('x'.repeat(150));
  assert.equal(long.length, 100, 'una de más de 100 tumbaba cada claim con un 400');
  assert.ok(long.endsWith('…'));
  assert.equal(await labelOf('  fa  '), 'fa');
  assert.equal(await labelOf('   '), os.hostname().slice(0, 100));
});

test('el flip anuncia toolset_render y si duckhunt ve la aws por defecto; el interruptor deja el cable sin el flip (t#495, M5)', async (t) => {
  t.mock.method(console, 'log', () => {});
  const withDefault = { ...cfg, aws: { ...cfg.aws, default: { profile: 'personal' } } };
  fs.writeFileSync(configPath(), JSON.stringify(withDefault), { mode: 0o600 });
  const on = capture();
  await (await daemon()).claim();
  assert.match(on[0]!, /"toolset_v1","toolset_render"\]/);
  assert.match(on[0]!, /,"awsDefault":true\}$/, 'expuesta (duckhunt ve todo por defecto)');
  fs.writeFileSync(configPath(), JSON.stringify({ ...withDefault, defaults: { ...withDefault.defaults, toolsetRender: false } }), { mode: 0o600 });
  const off = capture();
  await (await daemon()).claim();
  assert.ok(!off[0]!.includes('toolset_render') && !off[0]!.includes('awsDefault'), `el cable sin el flip: ${off[0]}`);
});

test('al arrancar avisa una vez si la máquina tiene aws y duckhunt no ve su `default`; con ella o con el interruptor, nada (t#495, M5)', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const warnings = async (config: RunnerConfig): Promise<string[]> => {
    warn.mock.resetCalls();
    fs.writeFileSync(configPath(), JSON.stringify(config), { mode: 0o600 });
    const d = internals(loadConfig()!) as unknown as { reloadConfig(): Promise<void>; warnAwsDefault(): void; hasAws: boolean };
    await d.reloadConfig();
    d.hasAws = true;
    d.warnAwsDefault();
    return warn.mock.calls.map((c) => String(c.arguments[0]));
  };
  const [line, ...more] = await warnings(cfg);
  assert.equal(more.length, 0);
  assert.match(line ?? '', /^\[runner\] los runs de duckhunt sin cuenta aws ya no heredan la aws de esta máquina.*`duckhunt-runner resource add aws default <perfil>`/);
  assert.deepEqual(await warnings({ ...cfg, aws: { ...cfg.aws, default: { profile: 'personal' } } }), [], 'con `default` expuesta');
  assert.deepEqual(await warnings({ ...cfg, defaults: { ...cfg.defaults, toolsetRender: false } }), [], 'con el interruptor');
});

test('las sesiones de navegador solo se anuncian expuestas a duckhunt y con el flip: resources, su salud y la capability browser (t#495, M7)', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const dir = fs.mkdtempSync(path.join(root, 'browser-'));
  const odysea = path.join(dir, 'odysea');
  fs.writeFileSync(odysea, `#!${process.execPath}\nif (process.argv[2] === '--version') console.log('0.5.0');\n`, { mode: 0o755 });
  const vault = path.join(dir, 'vault');
  fs.mkdirSync(vault, { mode: 0o700 });
  // el cuerpo del claim de un daemon con esta config (con la salud de sus sesiones ya mirada, como al arrancar).
  const announce = async (extra: object): Promise<string> => {
    fs.writeFileSync(configPath(), JSON.stringify({ ...cfg, ...extra }), { mode: 0o600 });
    const calls = capture();
    const d = internals(loadConfig()!) as ReturnType<typeof internals> & { refreshBrowserHealth(force?: boolean): Promise<void> };
    await d.reloadConfig();
    await d.refreshBrowserHealth(true);
    await legacyOf(d).claim();
    return calls[0]!;
  };
  const browser = { version: 2, resources: { browser: { jira: { session: 'jira', origins: ['https://acme.atlassian.net'] } } }, providers: { browser: { bin: odysea, vaultDir: vault } } };
  const exposed = { platforms: { duckhunt: { expose: { repo: '*', aws: '*', browser: '*' } } } };
  const hidden = await announce(browser);
  assert.ok(!hidden.includes('"resources"'), `sin exponerla a duckhunt, ni la clave: ${hidden}`);
  assert.match(hidden, /"toolset_render","browser"\]/, 'la capability es de la máquina: odysea está');
  const shown = await announce({ ...browser, ...exposed });
  // sin sesión guardada en el vault: su salud lo dice.
  assert.match(shown, /,"resources":\[\{"type":"browser","keys":\["jira"\]\}\],"health":\[\{"type":"browser","key":"jira","kind":"missing"\}\]\}$/);
  const off = await announce({ ...browser, ...exposed, defaults: { ...cfg.defaults, toolsetRender: false } });
  assert.ok(!off.includes('"resources"') && !off.includes('"browser"'), `el interruptor: el cable sin el flip: ${off}`);
});
