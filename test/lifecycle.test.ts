// ciclo de vida de la máquina (0.11.0, t#465 P12) contra un server falso: el machine id (estable, ligado
// al host en el que nació) y a quién reemplaza un `login`, el claim que los anuncia y deja de mandar
// replacesClientId en cuanto el server lo acepta, lo que el server dice de la máquina guardado para
// `status`, `logout` (desvincula en el server y borra solo la credencial, los mapas se siguen usando; un
// 404 o una credencial muerta borran la local, un fallo del server no borra nada) y el daemon que para
// con EXIT_CODE_UNPAIRED cuando el refresh se rechaza.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { configPath, loadConfig, loadStoredConfig, type RunnerConfig } from '../src/config.js';
import { ensureMachineId, loginIdentity, ownedHere } from '../src/machine.js';
import { logoutCommand, unpairOnServer } from '../src/logout.js';
import { CredentialRejectedError, refreshAccess } from '../src/oauth.js';
import { EXIT_CODE_UNPAIRED, RunnerDaemon } from '../src/daemon.js';
import { describeServerState } from '../src/status.js';
import { reposCommand } from '../src/repos.js';
import { awsCommand } from '../src/aws.js';
import { readServerState, writeServerState } from '../src/server-state.js';
import { LEGACY_PLATFORM_ID, serverStatePath } from '../src/paths.js';

const BASE = 'https://duckhunt.test';
const HOST = 'fa';
const MACHINE = '6f1d7c1e-5b0a-4c34-9b8e-2a3f7c1d9e01';
const ACCESS_TTL_S = 3600;
const realFetch = globalThis.fetch;
let root = '';

interface Call {
  url: string;
  auth: string | null;
  body: Record<string, unknown> | null;
  form: URLSearchParams | null;
}

// server falso: el token endpoint rota (o rechaza con invalid_grant si `rejectRefresh`), /claim responde
// lo que diga `claim` y /unpair lo que diga `unpair`.
interface FakeServer {
  calls: Call[];
  rejectRefresh: boolean;
  claim: () => Response;
  unpair: () => Response;
}

function fakeServer(): FakeServer {
  const server: FakeServer = {
    calls: [],
    rejectRefresh: false,
    claim: () => new Response(null, { status: 204 }),
    unpair: () => Response.json({ ok: true, runnerId: 1, canceled: [] }),
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const isForm = url.endsWith('/oauth/token');
    const call: Call = {
      url,
      auth: new Headers(init?.headers).get('authorization'),
      body: !isForm && init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      form: isForm ? new URLSearchParams(String(init?.body)) : null,
    };
    server.calls.push(call);
    if (isForm) {
      if (server.rejectRefresh) return Response.json({ error: 'invalid_grant', error_description: 'refresh_token inválido o expirado' }, { status: 400 });
      return Response.json({ access_token: `access:${call.form!.get('client_id')}`, refresh_token: `${call.form!.get('refresh_token')}+`, expires_in: ACCESS_TTL_S });
    }
    if (url.endsWith('/api/runner/claim')) return server.claim();
    if (url.endsWith('/api/runner/unpair')) return server.unpair();
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return server;
}

const base: RunnerConfig = {
  baseUrl: BASE,
  clientId: 'c1',
  refreshToken: 'r1',
  label: 'fa',
  machineId: MACHINE,
  machineHost: HOST,
  repos: { 'acme/api': { path: '/dev/api' } },
  aws: { '123456789012': { profile: 'prod' } },
  defaults: { maxConcurrent: 2 },
};
const writeConfig = (cfg: object): void => fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
const readJson = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-lifecycle-'));
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  writeConfig(base);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

// --- identidad ---

test('login en la misma máquina: conserva el machine id y reemplaza la credencial anterior', () => {
  assert.deepEqual(loginIdentity(base, BASE, HOST), { machineId: MACHINE, machineHost: HOST, replacesClientId: 'c1' });
  // dos logins seguidos sin claim: sigue reemplazando la que tiene fila (la del primero que reclamó).
  assert.equal(loginIdentity({ ...base, clientId: 'c2', replacesClientId: 'c1' }, BASE, HOST).replacesClientId, 'c1');
  // contra otra instancia: la misma máquina, pero nada que reemplazar allí.
  assert.deepEqual(loginIdentity(base, 'https://otra.test', HOST), { machineId: MACHINE, machineHost: HOST, replacesClientId: undefined });
});

test('una config copiada de otra máquina (o de 0.10, sin host) estrena id y no reemplaza la credencial de la otra', () => {
  const copied = loginIdentity(base, BASE, 'portatil');
  assert.notEqual(copied.machineId, MACHINE);
  assert.match(copied.machineId, /^[0-9a-f-]{36}$/);
  assert.deepEqual([copied.machineHost, copied.replacesClientId], ['portatil', undefined]);
  assert.equal(ownedHere(base, 'portatil'), false);
  const legacy = loginIdentity({ ...base, machineId: undefined, machineHost: undefined }, BASE, HOST);
  assert.equal(legacy.replacesClientId, undefined, 'sin prueba de que la config sea de aquí');
  // primer login (sin config previa).
  assert.equal(loginIdentity({ repos: {}, aws: {}, defaults: {} }, BASE, HOST).replacesClientId, undefined);
});

test('ensureMachineId: lo genera una vez (config de 0.10) y luego es estable', () => {
  writeConfig({ ...base, machineId: undefined, machineHost: undefined });
  const id = ensureMachineId(HOST);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([readJson().machineId, readJson().machineHost], [id, HOST]);
  assert.equal(ensureMachineId('otro-host'), id, 'estable: no depende del host una vez generado');
  assert.equal(loadConfig()?.refreshToken, 'r1', 'solo toca su clave');
});

// --- el daemon reclamando ---

interface DaemonInternals {
  reloadConfig(): Promise<void>;
  claim(): Promise<unknown>;
  exitCode: number;
  stopping: boolean;
}

const daemonFor = (cfg: RunnerConfig): DaemonInternals => new RunnerDaemon(cfg) as unknown as DaemonInternals;

test('el claim anuncia la máquina y su login anterior hasta que el server lo acepta; guarda lo que dice de ella', async (t) => {
  t.mock.method(console, 'log', () => {});
  const server = fakeServer();
  const runner = { id: 7, name: 'servidor', paused: true, accepts: 'conversations', maxSlots: 1 };
  server.claim = () => Response.json({ run: null, runner, state: 'paused' }, { headers: { 'x-duckhunt-runner-state': 'paused' } });
  writeConfig({ ...base, clientId: 'c2', refreshToken: 'u1', replacesClientId: 'c1' });
  const daemon = daemonFor(loadConfig()!);
  await daemon.reloadConfig();
  assert.equal(await daemon.claim(), null, 'sin trabajo: 200 con run null');
  const first = server.calls.find((c) => c.url.endsWith('/claim'))!;
  assert.deepEqual(first.body!.machine, { id: MACHINE });
  assert.equal(first.body!.replacesClientId, 'c1');
  assert.ok((first.body!.capabilities as string[]).includes('logout'));
  assert.equal(readJson().replacesClientId, undefined, 'aceptado: fuera del fichero');
  await daemon.claim();
  const second = server.calls.filter((c) => c.url.endsWith('/claim'))[1]!;
  assert.equal(second.body!.replacesClientId, undefined, 'y del siguiente claim');
  const state = readServerState(LEGACY_PLATFORM_ID);
  assert.deepEqual([state?.clientId, state?.state, state?.runner], ['c2', 'paused', runner]);
  assert.equal(fs.statSync(serverStatePath(LEGACY_PLATFORM_ID)).mode & 0o777, 0o600);
  const lines = describeServerState(state, 'c2').join('\n');
  assert.match(lines, /máquina #7 «servidor» · pausa sí · acepta conversations · tope de slots 1/);
  assert.match(lines, /en pausa/);
});

test('un server anterior (204 sin cuerpo): el estado queda sin bloque runner, con la cabecera si la hay', async (t) => {
  t.mock.method(console, 'log', () => {});
  const server = fakeServer();
  server.claim = () => new Response(null, { status: 204, headers: { 'x-duckhunt-runner-state': 'full' } });
  const daemon = daemonFor(loadConfig()!);
  await daemon.reloadConfig();
  await daemon.claim();
  const state = readServerState(LEGACY_PLATFORM_ID);
  assert.deepEqual([state?.state, state?.runner], ['full', null]);
  assert.match(describeServerState(state, 'c1').join('\n'), /duckhunt anterior a 0\.11/);
  assert.match(describeServerState(state, 'otra').join('\n'), /credencial anterior/);
});

test('un refresh rechazado (desvinculada desde duckhunt): el daemon para con EXIT_CODE_UNPAIRED y no reintenta', async (t) => {
  t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const server = fakeServer();
  server.rejectRefresh = true;
  const daemon = daemonFor(loadConfig()!);
  await daemon.reloadConfig();
  assert.equal(await daemon.claim(), null);
  assert.equal(daemon.stopping, true);
  assert.equal(daemon.exitCode, EXIT_CODE_UNPAIRED);
  assert.match(String(error.mock.calls.at(-1)?.arguments[0]), /desvinculada desde duckhunt.*el daemon se detiene/);
  assert.equal(readServerState(LEGACY_PLATFORM_ID)?.state, 'unpaired');
  await assert.rejects(refreshAccess({ baseUrl: BASE, clientId: 'c1', refreshToken: 'r1' }), CredentialRejectedError);
});

// --- logout ---

test('logout: desvincula en el server con su propia credencial y borra solo la credencial', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const server = fakeServer();
  server.unpair = () => Response.json({ ok: true, runnerId: 7, canceled: [41, 42] });
  writeServerState({ at: 1, baseUrl: BASE, clientId: 'c1', state: null, runner: null, kept: null }, LEGACY_PLATFORM_ID);
  await logoutCommand();
  const unpair = server.calls.find((c) => c.url.endsWith('/api/runner/unpair'))!;
  assert.equal(unpair.auth, 'Bearer access:c1');
  const left = readJson();
  assert.deepEqual([left.clientId, left.refreshToken, left.replacesClientId], [undefined, undefined, undefined]);
  assert.deepEqual([left.baseUrl, left.machineId, left.label], [BASE, MACHINE, 'fa'], 'la máquina y su instancia se quedan');
  assert.deepEqual(left.repos, base.repos);
  assert.deepEqual(left.aws, base.aws);
  assert.equal(readServerState(LEGACY_PLATFORM_ID), null);
  assert.equal(loadStoredConfig()?.clientId, undefined);
  assert.throws(() => loadConfig(), /config incompleta/, '`start` pide login');
  // los mapas se quedan y se siguen viendo y editando sin credencial.
  const logged = (text: string): boolean => log.mock.calls.some((c) => String(c.arguments[0]).includes(text));
  await reposCommand(['list']);
  assert.ok(logged('acme/api'), '`repos list` tras logout');
  awsCommand(['list']);
  assert.ok(logged('123456789012'), '`aws list` tras logout');
  assert.notEqual(process.exitCode, 1);
  // sin credencial, nada que desvincular (y no llama a nadie).
  const before = server.calls.length;
  await logoutCommand();
  assert.equal(server.calls.length, before);
});

test('logout: un server sin el endpoint (404) o una credencial que ya no valía borran la local', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const server = fakeServer();
  server.unpair = () => new Response('not found', { status: 404 });
  assert.deepEqual(await unpairOnServer(loadConfig()!), { kind: 'unsupported' });
  writeConfig(base);
  await logoutCommand();
  assert.equal(readJson().clientId, undefined);
  assert.match(String(warn.mock.calls.at(-1)?.arguments[0]), /Ajustes → Agentes → Máquinas/);

  writeConfig(base);
  server.rejectRefresh = true;
  assert.deepEqual(await unpairOnServer(loadConfig()!), { kind: 'gone' });
  await logoutCommand();
  assert.equal(readJson().clientId, undefined);
});

test('logout: un error del server o de red no borra nada (la credencial seguiría viva allí)', async () => {
  const server = fakeServer();
  server.unpair = () => new Response('boom', { status: 500 });
  await assert.rejects(logoutCommand(), /http 500/);
  assert.equal(readJson().clientId, 'c1');
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  await assert.rejects(logoutCommand(), /ECONNREFUSED/);
  assert.equal(readJson().clientId, 'c1');
});
