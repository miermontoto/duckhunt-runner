// identidad y aislamiento por plataforma (t#495, M6.5 y el deny por segmento): el machine id derivado de cada
// plataforma (HMAC del secreto de la máquina y su emisor; la legacy, el de siempre), la etiqueta propia y lo privado
// de las demás plataformas (su estado y su auditoría) negado a cada run desde el segmento siguiente a su alta, sin
// tocar el deny de una instalación con solo duckhunt.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test, type TestContext } from 'node:test';
import { configPath, loadConfig, runnerHome, type RunnerConfig } from '../src/config.js';
import { derivedMachineId, ensureMachineSecret } from '../src/machine.js';
import { otherPlatformsDeny } from '../src/secret-paths.js';
import { internals, legacyOf, type DaemonInternals, type SupervisorInternals } from './daemon-harness.js';
import { fakeFactories, type FakePlatform } from './fake-platform.js';

let root = '';

const cfg: RunnerConfig = { baseUrl: 'https://duckhunt.test', clientId: 'c1', refreshToken: 'r1', label: 'fa', machineId: 'm-1', repos: {}, aws: {}, defaults: { maxConcurrent: 2 } };
const entry = (id: string, extra: object = {}): object => ({ protocol: 'duckhunt-42', trusted: true, credential: { baseUrl: `https://${id}.test`, clientId: `${id}-1`, refreshToken: 'r' }, ...extra });
const write = (platforms: object | null): void =>
  fs.writeFileSync(configPath(), JSON.stringify(platforms === null ? cfg : { ...cfg, version: 2, platforms }), { mode: 0o600 });
const readJson = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Record<string, unknown>;

async function daemon(t: TestContext, platforms: object | null): Promise<{ d: DaemonInternals; created: Map<string, FakePlatform> }> {
  t.mock.method(console, 'log', () => {});
  write(platforms);
  const { factories, created } = fakeFactories();
  const d = internals(loadConfig()!, { factories });
  await d.reloadConfig();
  return { d, created };
}

const runDeny = (d: DaemonInternals, sup: SupervisorInternals): string[] => (d as unknown as { runDeny(s: SupervisorInternals): string[] }).runDeny(sup);
const rule = (p: string, dir = false): string => `Read(/${path.resolve(p)}${dir ? '/**' : ''})`;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-identity-'));
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('machine id por plataforma: HMAC del secreto y del emisor como origen; estable, distinto entre emisores', () => {
  const secret = 'ab'.repeat(32);
  const id = derivedMachineId(secret, 'https://beta.test');
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(derivedMachineId(secret, 'https://Beta.test/'), id, 'el mismo origen');
  assert.notEqual(derivedMachineId(secret, 'https://gamma.test'), id);
  assert.notEqual(derivedMachineId('cd'.repeat(32), 'https://beta.test'), id, 'otra máquina, otro id');
});

test('el secreto de la máquina se genera una vez y se guarda en la config (0600)', () => {
  write(null);
  const secret = ensureMachineSecret();
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(ensureMachineSecret(), secret);
  assert.equal(readJson().machineSecret, secret);
  assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
});

test('a la legacy, el machine id de siempre y la config sin secreto; a otra, el derivado de su emisor y su etiqueta', async (t) => {
  // gamma con el emisor que guardó su `login --as` (M6.4): es lo que firma su id, no la base de la credencial.
  const { d, created } = await daemon(t, { beta: entry('beta', { label: 'portátil de beta' }), gamma: entry('gamma', { issuer: 'https://id.gamma.test' }) });
  const supervisor = (id: string): SupervisorInternals => d.supervisors.get(id)!;
  await d.pollOnce(legacyOf(d));
  assert.equal(readJson().machineSecret, undefined, 'con la legacy sola no hace falta: la config no cambia');
  await d.pollOnce(supervisor('beta'));
  await d.pollOnce(supervisor('gamma'));
  const [legacy, beta, gamma] = ['duckhunt', 'beta', 'gamma'].map((id) => created.get(id)!.announces[0]!);
  assert.deepEqual([legacy!.machineId, legacy!.label], ['m-1', 'fa']);
  const secret = readJson().machineSecret as string;
  assert.equal(beta!.machineId, derivedMachineId(secret, 'https://beta.test'));
  assert.equal(gamma!.machineId, derivedMachineId(secret, 'https://id.gamma.test'));
  assert.deepEqual([beta!.label, gamma!.label], ['portátil de beta', 'fa']);
});

test('solo duckhunt: el deny de cada segmento es el de siempre, sin nada de otras plataformas', async (t) => {
  const { d } = await daemon(t, null);
  assert.deepEqual(otherPlatformsDeny('duckhunt', ['duckhunt']), []);
  const deny = runDeny(d, legacyOf(d));
  assert.ok(deny.every((r) => !r.includes(`${path.sep}audit`) && !r.includes(`${path.sep}platforms${path.sep}`)), deny.join('\n'));
});

test('una plataforma añadida en caliente: su estado y su auditoría, negados a los runs de las demás desde el siguiente segmento', async (t) => {
  const { d } = await daemon(t, null);
  const before = runDeny(d, legacyOf(d));
  write({ beta: entry('beta') });
  await d.reloadConfig();
  const beta = d.supervisors.get('beta')!;
  const home = runnerHome();
  const betaHome = path.join(home, 'platforms', 'beta');
  const legacyNow = runDeny(d, legacyOf(d));
  assert.deepEqual(legacyNow.slice(0, before.length), before, 'lo de antes, en su orden: lo nuevo va detrás');
  [rule(path.join(betaHome, 'logs'), true), rule(path.join(betaHome, 'server-state.json')), rule(path.join(home, 'audit', 'beta'), true)].forEach((r) => assert.ok(legacyNow.includes(r), r));
  // al de beta, lo de la legacy (en la raíz de runnerHome) y su auditoría; lo suyo no.
  const betaDeny = runDeny(d, beta);
  [rule(path.join(home, 'logs'), true), rule(path.join(home, 'server-state.json')), rule(path.join(home, 'audit', 'duckhunt'), true)].forEach((r) => assert.ok(betaDeny.includes(r), r));
  assert.ok(!betaDeny.includes(rule(path.join(home, 'audit', 'beta'), true)));
  assert.ok(!betaDeny.includes(rule(path.join(betaHome, 'logs'), true)));
});
