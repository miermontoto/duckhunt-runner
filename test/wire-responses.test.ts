// lo que el daemon hace con cada respuesta del cable legacy (t#495, M6): fijado con el daemon de antes del seam
// de plataformas, para que moverlo a platforms/ no cambie ni una llamada ni un log. el claim (401 con un refresh y
// un reintento, 204, 200 sin trabajo, http de error, red caída, json ilegible, un claim que no parsea con su
// status failed, la cabecera de comandos de repos), el latido (404, cancel, otro estado, 5xx, credencial muerta),
// el status (409 benigno, 4xx sin reintento, 5xx con backoff, credencial muerta) y /conversations caído.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { configPath, loadConfig, type RunnerConfig } from '../src/config.js';
import { EXIT_CODE_UNPAIRED, RunnerDaemon } from '../src/daemon.js';
import { RunLease } from '../src/run-lease.js';
import { readServerState } from '../src/server-state.js';
import { LEGACY_PLATFORM_ID } from '../src/paths.js';
import type { StatusReport } from '../src/status-report.js';

const BASE = 'https://duckhunt.test';
const API = `${BASE}/api/runner`;
const ACCESS_TTL_S = 3600;
// MIN_HEARTBEAT_MS y STATUS_POST_BACKOFF_MS del daemon.
const HEARTBEAT_FLOOR_MS = 5_000;
const STATUS_BACKOFF_MS = 2_000;
const realFetch = globalThis.fetch;
let root = '';

const cfg: RunnerConfig = {
  baseUrl: BASE,
  clientId: 'c1',
  refreshToken: 'r1',
  label: 'fa',
  repos: { 'acme/api': { path: '/dev/api' } },
  aws: {},
  defaults: {},
};

// server falso: cada llamada a /api/runner queda como `<ruta> <auth> <cuerpo>` y responde lo que diga `route`.
// el token endpoint rota (o rechaza con invalid_grant si `reject`).
interface Fake {
  calls: string[];
  tokens: number;
  reject: boolean;
  route: (pathname: string, auth: string) => Response | Promise<Response>;
}

function fake(route: Fake['route']): Fake {
  const server: Fake = { calls: [], tokens: 0, reject: false, route };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) {
      server.tokens++;
      if (server.reject) return Response.json({ error: 'invalid_grant', error_description: 'refresh_token inválido o expirado' }, { status: 400 });
      return Response.json({ access_token: `a${server.tokens}`, refresh_token: `r${server.tokens + 1}`, expires_in: ACCESS_TTL_S });
    }
    const pathname = url.slice(API.length);
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    server.calls.push(`${pathname} ${auth} ${String(init?.body)}`);
    return server.route(pathname, auth);
  }) as typeof fetch;
  return server;
}

// lo que estos casos tocan del daemon (las internas de la plataforma legacy).
interface Wire {
  claim(): Promise<unknown>;
  startHeartbeat(lease: RunLease, heartbeatMs: number, seg: { segment?: number }): NodeJS.Timeout;
  postStatus(runId: string, report: StatusReport): Promise<void>;
  openConversations(ids: string[]): Promise<Set<string>>;
  stopping: boolean;
  exitCode: number;
}

interface DaemonInternals {
  reloadConfig(): Promise<void>;
  claim(): Promise<unknown>;
  startHeartbeat(lease: RunLease, heartbeatMs: number, seg: { segment?: number }): NodeJS.Timeout;
  postStatus(runId: string, report: StatusReport): Promise<void>;
  openConversations(ids: string[]): Promise<Set<string>>;
  leases: Set<RunLease>;
  stopping: boolean;
  exitCode: number;
}

async function wire(leases: RunLease[] = []): Promise<Wire> {
  const d = new RunnerDaemon(loadConfig()!) as unknown as DaemonInternals;
  await d.reloadConfig();
  leases.forEach((lease) => d.leases.add(lease));
  return {
    claim: () => d.claim(),
    startHeartbeat: (lease, ms, seg) => d.startHeartbeat(lease, ms, seg),
    postStatus: (runId, report) => d.postStatus(runId, report),
    openConversations: (ids) => d.openConversations(ids),
    get stopping() {
      return d.stopping;
    },
    get exitCode() {
      return d.exitCode;
    },
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const settle = async (): Promise<void> => {
  // i/o secuencial: unas cuantas vueltas del event loop para que respondan las promesas en cadena.
  for (let i = 0; i < 10; i++) await flush();
};
const said = (mock: { mock: { calls: { arguments: unknown[] }[] } }): string[] => mock.mock.calls.map((c) => String(c.arguments[0]));

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-responses-'));
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

test('claim: un 401 refresca una vez y reintenta con el token nuevo', async (t) => {
  t.mock.method(console, 'log', () => {});
  const server = fake((pathname, auth) => (auth === 'Bearer a1' ? new Response('caducado', { status: 401 }) : new Response(null, { status: 204 })));
  const d = await wire();
  assert.equal(await d.claim(), null);
  assert.equal(server.tokens, 2);
  assert.deepEqual(
    server.calls.map((c) => c.split(' ').slice(0, 3).join(' ')),
    ['/claim Bearer a1', '/claim Bearer a2'],
  );
});

test('claim: 204 con motivo y 200 sin trabajo guardan lo que dijo el server; un http de error y la red caída, nada', async (t) => {
  t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const runner = { id: 7, name: null, paused: false, accepts: 'all', maxSlots: null };
  const answers: (() => Response)[] = [
    () => new Response(null, { status: 204, headers: { 'x-duckhunt-runner-state': 'full' } }),
    () => Response.json({ run: null, runner }, { headers: { 'x-duckhunt-runner-state': 'upgrade' } }),
    () => new Response('boom', { status: 500 }),
  ];
  const server = fake(() => answers.shift()!());
  const d = await wire();
  assert.equal(await d.claim(), null);
  assert.deepEqual([readServerState(LEGACY_PLATFORM_ID)?.state, readServerState(LEGACY_PLATFORM_ID)?.runner], ['full', null]);
  assert.equal(await d.claim(), null);
  assert.deepEqual([readServerState(LEGACY_PLATFORM_ID)?.state, readServerState(LEGACY_PLATFORM_ID)?.runner], ['upgrade', runner]);
  assert.equal(await d.claim(), null);
  assert.equal(readServerState(LEGACY_PLATFORM_ID)?.state, 'upgrade', 'un 500 no lo toca');
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith('/oauth/token')) return Response.json({ access_token: 'x', refresh_token: 'y', expires_in: ACCESS_TTL_S });
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  assert.equal(await d.claim(), null);
  assert.deepEqual(said(error), ['[runner] claim falló: http 500 boom', '[runner] claim inaccesible: ECONNREFUSED']);
  assert.equal(server.calls.length, 3);
});

test('claim: un json ilegible cuenta como reclamado y no postea nada; un claim que no parsea se cierra como failed', async (t) => {
  t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const answers: (() => Response)[] = [
    () => new Response('{no es json', { status: 200 }),
    () => Response.json({ run: { id: 41 }, prompt: 'x' }),
  ];
  const server = fake((pathname) => (pathname === '/claim' ? answers.shift()!() : Response.json({ ok: true })));
  const d = await wire();
  assert.equal(await d.claim(), null);
  assert.equal(readServerState(LEGACY_PLATFORM_ID)?.state, 'claimed');
  assert.match(said(error)[0]!, /^\[runner\] claim con json ilegible: /);
  assert.equal(await d.claim(), null);
  const status = server.calls.find((c) => c.startsWith('/runs/41/status'))!;
  const message = said(error).at(-1)!.replace(/^\[runner\] /, '');
  assert.equal(status, `/runs/41/status Bearer a1 ${JSON.stringify({ status: 'failed', error: message })}`);
  assert.deepEqual(
    server.calls.map((c) => c.split(' ')[0]),
    ['/claim', '/claim', '/runs/41/status'],
  );
});

test('claim: la cabecera de comandos de repos los pide, los aplica a la config y reporta', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const server = fake((pathname) => {
    if (pathname === '/claim') return new Response(null, { status: 204, headers: { 'x-duckhunt-repo-commands': '1' } });
    if (pathname === '/repo-commands') return Response.json({ commands: [{ id: 5, action: 'unmap', repo: 'acme/api' }] });
    return Response.json({ ok: true });
  });
  const d = await wire();
  await d.claim();
  await settle();
  assert.match(server.calls[0]!, /^\/claim Bearer a1 \{"runnerLabel":"fa","repos":\["acme\/api"\],/);
  assert.deepEqual(server.calls.slice(1), ['/repo-commands Bearer a1 {"runnerLabel":"fa"}', '/repo-commands/results Bearer a1 {"results":[{"id":5,"ok":true}]}']);
  assert.deepEqual(loadConfig()!.repos, {});
});

test('latido: 404, cancel u otro estado matan el run; un 5xx no', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setInterval'] });
  const answers: Record<string, () => Response> = {
    '/runs/1/heartbeat': () => new Response('no', { status: 404 }),
    '/runs/2/heartbeat': () => Response.json({ status: 'running', cancel: true }),
    '/runs/3/heartbeat': () => Response.json({ status: 'queued', cancel: false }),
    '/runs/4/heartbeat': () => new Response('boom', { status: 503 }),
    '/runs/5/heartbeat': () => Response.json({ status: 'running', cancel: false }),
  };
  fake((pathname) => answers[pathname]!());
  const leases = ['1', '2', '3', '4', '5'].map((id) => new RunLease(id));
  const d = await wire(leases);
  const timers = leases.map((lease) => d.startHeartbeat(lease, 1, { segment: 2 }));
  t.mock.timers.tick(HEARTBEAT_FLOOR_MS);
  await settle();
  assert.deepEqual(
    leases.map((l) => l.killedBy),
    ['cancel', 'cancel', 'cancel', null, null],
  );
  timers.forEach(clearInterval);
});

test('latido con la credencial muerta: el daemon para con EXIT_CODE_UNPAIRED y corta sus runs', async (t) => {
  t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setInterval'] });
  const server = fake(() => Response.json({ status: 'running' }));
  server.reject = true;
  const lease = new RunLease('9');
  const d = await wire([lease]);
  const timer = d.startHeartbeat(lease, 1, {});
  t.mock.timers.tick(HEARTBEAT_FLOOR_MS);
  await settle();
  clearInterval(timer);
  assert.equal(d.stopping, true);
  assert.equal(d.exitCode, EXIT_CODE_UNPAIRED);
  assert.equal(lease.killedBy, 'cancel');
  assert.match(said(error).at(-1)!, /^\[runner\] la credencial de esta máquina ya no vale .*\. el daemon se detiene$/);
  assert.equal(readServerState(LEGACY_PLATFORM_ID)?.state, 'unpaired');
  assert.equal(server.calls.length, 0, 'sin token no llega a latir');
});

test('status: 409 es benigno, un 4xx no se reintenta, un 5xx sí con backoff y la credencial muerta corta', async (t) => {
  t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const answers: Record<string, (() => Response)[]> = {
    '/runs/1/status': [() => new Response('cerrado', { status: 409 })],
    '/runs/2/status': [() => new Response('mal', { status: 422 })],
    '/runs/3/status': [() => new Response('caído', { status: 503 }), () => Response.json({ ok: true })],
  };
  const server = fake((pathname) => answers[pathname]!.shift()!());
  const d = await wire();
  await d.postStatus('1', { status: 'done' });
  await d.postStatus('2', { status: 'done' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const third = d.postStatus('3', { status: 'failed', error: 'x', segment: 4 });
  await settle();
  t.mock.timers.tick(STATUS_BACKOFF_MS);
  await third;
  t.mock.timers.reset();
  assert.deepEqual(server.calls, [
    '/runs/1/status Bearer a1 {"status":"done"}',
    '/runs/2/status Bearer a1 {"status":"done"}',
    '/runs/3/status Bearer a1 {"status":"failed","error":"x","segment":4}',
    '/runs/3/status Bearer a1 {"status":"failed","error":"x","segment":4}',
  ]);
  assert.deepEqual(said(error), ['[runner] status post rechazado: http 422 mal', '[runner] status post: http 503 (intento 1/5)']);

  const dead = fake(() => Response.json({ ok: true }));
  dead.reject = true;
  const d2 = await wire();
  await d2.postStatus('6', { status: 'done' });
  assert.equal(dead.calls.length, 0);
  assert.match(said(error).at(-1)!, /^\[runner\] status post falló \(intento 1\/5\): la credencial de esta máquina ya no vale/);
});

test('/conversations caído o con un cuerpo raro: esas conversaciones cuentan como abiertas', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const answers: (() => Response)[] = [() => new Response('boom', { status: 500 }), () => Response.json({ open: 'no' })];
  fake(() => answers.shift()!());
  const d = await wire();
  assert.deepEqual([...(await d.openConversations(['3', '4']))].sort(), ['3', '4']);
  assert.deepEqual([...(await d.openConversations(['5']))], ['5']);
  assert.deepEqual(said(error), ['[runner] gc: /conversations respondió http 500: solo se aplica el ttl']);
});
