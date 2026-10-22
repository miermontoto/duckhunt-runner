// plataformas desde la config (t#495, M6.3): protocolo, pausa y cuota en la config v2; los supervisores que se dan
// de alta, se pausan, se reaniman y se retiran con la recarga; las que no reclaman (sin credencial, protocolo sin
// soporte); la credencial de cada una rotada y guardada solo en su entrada; lo que cada una ve de la máquina; su
// server-state en su directorio; y el deny de run-config recalculado por segmento.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test, type TestContext } from 'node:test';
import { configPath, loadConfig, loadConfigV2, runnerHome, saveConfigV2, type RunnerConfig } from '../src/config.js';
import { refreshAccess } from '../src/oauth.js';
import { LEGACY_PLATFORM_ID, serverStatePath } from '../src/paths.js';
import { credentialStore } from '../src/platforms/credentials.js';
import { PLATFORM_STATE } from '../src/platforms/supervisor.js';
import { RunLease } from '../src/run-lease.js';
import { internals, legacyOf, type DaemonInternals } from './daemon-harness.js';
import { fakeFactories, type FakePlatform } from './fake-platform.js';

const BASE = 'https://duckhunt.test';
const ACCESS_TTL_S = 3600;
const realFetch = globalThis.fetch;
let root = '';

const cfg: RunnerConfig = {
  baseUrl: BASE,
  clientId: 'c1',
  refreshToken: 'r1',
  label: 'fa',
  machineId: 'm-1',
  repos: { 'acme/api': { path: '/dev/api' }, 'acme/web': { path: '/dev/web' } },
  aws: { '123456789012': { profile: 'prod' }, '210987654321': { profile: 'dev' } },
  defaults: { maxConcurrent: 3 },
};

const credential = (clientId: string, baseUrl = 'https://beta.test'): object => ({ baseUrl, clientId, refreshToken: `r-${clientId}` });
const write = (platforms: object, extra: object = {}): void =>
  fs.writeFileSync(configPath(), JSON.stringify({ ...cfg, ...extra, version: 2, platforms }), { mode: 0o600 });
const readJson = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
const quiet = (t: TestContext): { warn: { mock: { calls: { arguments: unknown[] }[] } } } => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  return { warn: t.mock.method(console, 'warn', () => {}) };
};

async function daemon(platforms: object): Promise<{ d: DaemonInternals; created: Map<string, FakePlatform> }> {
  write(platforms);
  const { factories, created } = fakeFactories();
  const d = internals(loadConfig()!, { factories });
  await d.reloadConfig();
  return { d, created };
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-platform-config-'));
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

test('config: protocolo, pausa y cuota sobreviven a una escritura v2; lo que no vale se rechaza', () => {
  write({ beta: { protocol: 'duckhunt-42', trusted: true, paused: true, slots: 2, credential: credential('b1') }, gamma: { protocol: 'agent-runner/9' } });
  saveConfigV2((c) => ({ ...c, label: 'otra' }));
  const v2 = loadConfigV2()!;
  assert.deepEqual([v2.platforms.beta?.protocol, v2.platforms.beta?.paused, v2.platforms.beta?.slots], ['duckhunt-42', true, 2]);
  assert.equal(v2.platforms.gamma?.protocol, 'agent-runner/9', 'un protocolo desconocido no invalida la config');
  assert.equal(v2.platforms.duckhunt?.protocol, undefined, 'la legacy sin protocolo: duckhunt-42');
  const invalid = (platforms: object): void => {
    write(platforms);
    assert.throws(() => loadConfigV2(), /config v2 inválida/);
  };
  invalid({ beta: { slots: 0 } });
  invalid({ beta: { slots: 1.5 } });
  invalid({ beta: { paused: 'sí' } });
  invalid({ beta: { protocol: '' } });
  invalid({ duckhunt: { protocol: 'agent-runner/0' } });
});

test('alta, pausa, reanudación y retirada en caliente; una retirada con runs acaba los suyos', async (t) => {
  quiet(t);
  const { d, created } = await daemon({});
  assert.deepEqual([...d.supervisors.keys()], ['duckhunt']);
  write({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1') } });
  await d.reloadConfig();
  const beta = d.supervisors.get('beta')!;
  assert.equal(beta.state, PLATFORM_STATE.active);
  assert.ok(fs.statSync(path.join(runnerHome(), 'platforms', 'beta', 'run-config')).isDirectory(), 'su run-config ya existe (el deny lo cubre)');
  write({ beta: { protocol: 'duckhunt-42', trusted: true, paused: true, credential: credential('b1') } });
  await d.reloadConfig();
  assert.equal(beta.state, PLATFORM_STATE.paused);
  assert.equal(await d.pollOnce(beta), false);
  assert.equal(created.get('beta')!.announces.length, 0, 'en pausa no reclama');
  write({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1') } });
  await d.reloadConfig();
  assert.equal(beta.state, PLATFORM_STATE.active);
  const lease = new RunLease('5');
  beta.leases.add(lease);
  write({});
  await d.reloadConfig();
  assert.equal(beta.state, PLATFORM_STATE.removing);
  assert.equal(d.supervisors.get('beta'), beta, 'sigue hasta que acaba su run');
  assert.equal(lease.killedBy, null, 'su run no se corta');
  beta.leases.delete(lease);
  await d.reloadConfig();
  assert.deepEqual([...d.supervisors.keys()], ['duckhunt']);
});

test('sin credencial o con un protocolo sin soporte: un aviso y no reclama, ni deja al daemon sin plataformas', async (t) => {
  const { warn } = quiet(t);
  const { d } = await daemon({ gamma: { protocol: 'agent-runner/9', credential: credential('g1') }, delta: { protocol: 'duckhunt-42' } });
  assert.deepEqual([...d.supervisors.keys()], ['duckhunt']);
  await d.reloadConfig();
  const lines = warn.mock.calls.map((c) => String(c.arguments[0]));
  assert.deepEqual(lines, [
    '[runner] plataforma gamma: protocolo agent-runner/9 sin soporte en este runner: no reclama',
    '[runner] plataforma delta: sin credencial (`login`): no reclama',
  ]);
});

test('otra plataforma duckhunt-42 sin trusted no reclama: su techo no se le puede aplicar (sin toolset_v1)', async (t) => {
  const { warn } = quiet(t);
  const { d } = await daemon({ beta: { protocol: 'duckhunt-42', credential: credential('b1') } });
  assert.deepEqual([...d.supervisors.keys()], ['duckhunt']);
  assert.deepEqual(
    warn.mock.calls.map((c) => String(c.arguments[0])),
    ['[runner] plataforma beta: el protocolo duckhunt-42 no lleva toolset_v1 y su techo no se puede aplicar: solo en una plataforma trusted: no reclama'],
  );
  write({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1') } });
  await d.reloadConfig();
  assert.equal(d.supervisors.get('beta')?.state, PLATFORM_STATE.active, 'marcada trusted, reclama');
});

test('la que perdió la credencial vuelve con un `login` nuevo (otro clientId) sin reiniciar', async (t) => {
  quiet(t);
  const { d, created } = await daemon({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1') } });
  created.get('beta')!.reject = true;
  await d.pollOnce(d.supervisors.get('beta')!);
  assert.equal(d.supervisors.get('beta')!.state, PLATFORM_STATE.unpaired);
  assert.equal(d.stopping, false, 'quedaba la legacy');
  await d.reloadConfig();
  assert.equal(d.supervisors.get('beta')!.state, PLATFORM_STATE.unpaired, 'misma credencial: sigue fuera');
  write({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b2') } });
  await d.reloadConfig();
  const revived = d.supervisors.get('beta')!;
  assert.equal(revived.state, PLATFORM_STATE.active);
  assert.equal(revived.platform.identity().clientId, 'b2');
});

test('la credencial rechazada de una plataforma se borra solo de su entrada; un `login` la devuelve', async (t) => {
  quiet(t);
  const { d, created } = await daemon({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1') } });
  const beta = created.get('beta')!;
  beta.reject = true;
  beta.rejectNamesClient = true;
  await d.pollOnce(d.supervisors.get('beta')!);
  assert.equal(d.stopping, false, 'quedaba la legacy');
  const platforms = readJson().platforms as Record<string, Record<string, unknown>>;
  assert.deepEqual([platforms.beta!.credential, platforms.beta!.protocol, platforms.beta!.trusted], [undefined, 'duckhunt-42', true]);
  assert.equal(readJson().clientId, 'c1', 'la de duckhunt no se toca');
  await d.reloadConfig();
  assert.equal(d.supervisors.has('beta'), false, 'sin credencial: se retira');
  write({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b2') } });
  await d.reloadConfig();
  assert.equal(d.supervisors.get('beta')?.state, PLATFORM_STATE.active);
});

test('la de duckhunt rechazada con otra plataforma viva: se borra, la config se sigue recargando y un `login` la devuelve', async (t) => {
  const { warn } = quiet(t);
  const { d, created } = await daemon({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1') } });
  const duckhunt = created.get(LEGACY_PLATFORM_ID)!;
  duckhunt.reject = true;
  duckhunt.rejectNamesClient = true;
  await d.pollOnce(legacyOf(d));
  assert.equal(d.stopping, false, 'beta sigue reclamando');
  assert.equal(readJson().clientId, undefined);
  // un cambio de mapas tras el borrado: se recarga (la config sin la credencial de duckhunt vale) y la legacy se queda fuera.
  write({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1') } }, { clientId: undefined, refreshToken: undefined, repos: { 'acme/api': { path: '/dev/api' } } });
  await d.reloadConfig();
  assert.deepEqual(Object.keys(d.cfg.repos), ['acme/api'], 'la recarga no se atasca en «config incompleta»');
  assert.equal(legacyOf(d).state, PLATFORM_STATE.unpaired, 'la legacy siempre está: fuera, sin retirarse');
  assert.ok(warn.mock.calls.some((c) => /plataforma duckhunt: sin credencial/.test(String(c.arguments[0]))));
  write({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1') } }, { clientId: 'c2', refreshToken: 'u1' });
  await d.reloadConfig();
  assert.equal(legacyOf(d).state, PLATFORM_STATE.active, 'un login nuevo la devuelve');
  assert.equal(legacyOf(d).platform.identity().clientId, 'c2');
});

test('cada plataforma guarda lo que su server dijo en su directorio; la legacy, donde siempre', async (t) => {
  quiet(t);
  const { d } = await daemon({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1') } });
  await d.pollOnce(d.supervisors.get('beta')!);
  const file = serverStatePath('beta');
  assert.equal(file, path.join(runnerHome(), 'platforms', 'beta', 'server-state.json'));
  assert.equal((JSON.parse(fs.readFileSync(file, 'utf8')) as { clientId: string }).clientId, 'b1');
  assert.equal(fs.existsSync(serverStatePath('duckhunt')), false);
});

test('cada una ve de la máquina lo que expone: repos, cuentas aws y su salud; sin candidatos y con su machine id derivado si no es la legacy', async (t) => {
  quiet(t);
  const { d, created } = await daemon({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1'), expose: { repo: ['acme/web'], aws: ['210987654321'] } } });
  (d as unknown as { repoHealth: unknown; repoChoices: unknown }).repoHealth = [
    { repo: 'acme/api', kind: 'missing' },
    { repo: 'acme/web', kind: 'invalid' },
  ];
  (d as unknown as { repoChoices: unknown }).repoChoices = [{ repo: 'acme/web', candidates: [] }];
  await d.pollOnce(legacyOf(d));
  await d.pollOnce(d.supervisors.get('beta')!);
  const [legacy, beta] = [created.get('duckhunt')!.announces[0]!, created.get('beta')!.announces[0]!];
  assert.deepEqual([legacy.repos, legacy.awsAccounts, legacy.machineId, legacy.repoIssues?.length, legacy.repoCandidates?.length], [['acme/api', 'acme/web'], ['123456789012', '210987654321'], 'm-1', 2, 1]);
  assert.deepEqual([beta.repos, beta.awsAccounts, beta.repoIssues, beta.repoCandidates], [['acme/web'], ['210987654321'], [{ repo: 'acme/web', kind: 'invalid' }], null]);
  // M6.5: el de la máquina no; uno derivado de su emisor (machine.ts).
  assert.match(beta.machineId ?? '', /^[0-9a-f]{64}$/);
  assert.notEqual(beta.machineId, 'm-1');
  const refOf = (d as unknown as { refOf(s: unknown, type: string, key: string): unknown }).refOf.bind(d);
  assert.equal(refOf(d.supervisors.get('beta'), 'repo', 'acme/api'), null, 'un run suyo no usa lo que no le expone');
  assert.deepEqual(refOf(d.supervisors.get('beta'), 'repo', 'acme/web'), { path: '/dev/web' });
  assert.deepEqual(refOf(legacyOf(d), 'repo', 'acme/api'), { path: '/dev/api' });
});

test('los comandos de repos solo se aceptan de la legacy', async (t) => {
  quiet(t);
  const { d, created } = await daemon({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1') } });
  const beta = created.get('beta')!;
  const acked: unknown[] = [];
  beta.commands = async () => [{ id: 9, action: 'unmap', repo: 'acme/api', candidateId: null }];
  beta.ackCommands = async (results) => void acked.push(...results);
  await (d as unknown as { syncRepoCommands(s: unknown): Promise<void> }).syncRepoCommands(d.supervisors.get('beta'));
  assert.deepEqual(acked, [{ id: 9, ok: false, error: 'este runner solo acepta cambios de repos de duckhunt' }]);
  assert.deepEqual(Object.keys(loadConfig()!.repos), ['acme/api', 'acme/web']);
});

test('el deny de run-config se recalcula por segmento: una plataforma que aparece en disco queda cubierta', async (t) => {
  quiet(t);
  const { d } = await daemon({});
  const runDeny = (d as unknown as { runDeny(s: unknown): string[] }).runDeny.bind(d);
  const before = runDeny(legacyOf(d));
  assert.ok(!before.some((r) => r.includes('/platforms/gamma/')));
  fs.mkdirSync(path.join(runnerHome(), 'platforms', 'gamma', 'run-config'), { recursive: true });
  const after = runDeny(legacyOf(d));
  assert.ok(after.includes(`Read(/${path.join(runnerHome(), 'platforms', 'gamma', 'run-config')}/**)`));
  assert.ok(after.includes(`Read(/${path.join(runnerHome(), 'platforms', 'gamma', 'scratch')}/**)`), 'y su scratch');
});

test('una plataforma rota y guarda solo su credencial; la legacy, solo la suya', async () => {
  write({ beta: { protocol: 'duckhunt-42', trusted: true, credential: { ...credential('b1'), replacesClientId: 'b0' } }, gamma: { protocol: 'duckhunt-42', trusted: true, credential: credential('g1') } });
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const form = new URLSearchParams(String(init?.body));
    return Response.json({ access_token: 'a', refresh_token: `${form.get('refresh_token')}+`, expires_in: ACCESS_TTL_S });
  }) as typeof fetch;
  const beta = loadConfigV2()!.platforms.beta!.credential!;
  const rotated = await refreshAccess(beta, credentialStore('beta'));
  assert.equal(rotated.saved, true);
  let file = readJson() as { refreshToken: string; platforms: Record<string, { credential: { refreshToken: string } }> };
  assert.deepEqual([file.refreshToken, file.platforms.beta!.credential.refreshToken, file.platforms.gamma!.credential.refreshToken], ['r1', 'r-b1+', 'r-g1']);
  await refreshAccess({ baseUrl: BASE, clientId: 'c1', refreshToken: 'r1' });
  file = readJson() as typeof file;
  assert.deepEqual([file.refreshToken, file.platforms.beta!.credential.refreshToken], ['r1+', 'r-b1+']);
  credentialStore('beta').clearReplaces('b1', 'b0');
  assert.equal(loadConfigV2()!.platforms.beta!.credential!.replacesClientId, undefined);
  assert.equal(loadConfigV2()!.platforms.beta!.credential!.refreshToken, 'r-b1+');
});

test('una plataforma con runs no se sustituye aunque cambie de instancia; sin ellos, sí', async (t) => {
  quiet(t);
  const { d } = await daemon({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1') } });
  const first = d.supervisors.get('beta')!;
  first.leases.add(new RunLease('1'));
  write({ beta: { protocol: 'duckhunt-42', trusted: true, credential: credential('b1', 'https://beta2.test') } });
  await d.reloadConfig();
  assert.equal(d.supervisors.get('beta'), first);
  first.leases.clear();
  await d.reloadConfig();
  assert.notEqual(d.supervisors.get('beta'), first);
  assert.equal(d.supervisors.get('beta')!.platform.identity().baseUrl, 'https://beta2.test');
});
