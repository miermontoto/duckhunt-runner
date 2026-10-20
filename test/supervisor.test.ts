// varias plataformas en un daemon (t#495, M6.2), con plataformas falsas: el scheduler (pool global + cuota por
// plataforma, reservar antes de reclamar), la reserva que vuelve si el claim no trae run, un slot libre que
// despierta a quien lo esperaba, la credencial muerta de una plataforma que solo para a esa (y la última, al
// daemon con EXIT_CODE_UNPAIRED) y el poll de cada una sin esperar al de las demás.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test, type TestContext } from 'node:test';
import { parseClaim, type ClaimResponse } from '../src/claim.js';
import { configPath, loadConfig, type RunnerConfig } from '../src/config.js';
import { EXIT_CODE_UNPAIRED } from '../src/daemon.js';
import { Scheduler } from '../src/platforms/scheduler.js';
import { PLATFORM_STATE } from '../src/platforms/supervisor.js';
import { RunLease } from '../src/run-lease.js';
import { readServerState } from '../src/server-state.js';
import { internals, legacyOf, type DaemonInternals, type SupervisorInternals } from './daemon-harness.js';
import { FakePlatform, fakeFactories, IDLE, runResult, UNAVAILABLE } from './fake-platform.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
const BETA = 'beta';
let root = '';

const cfg: RunnerConfig = {
  baseUrl: 'https://duckhunt.test',
  clientId: 'c1',
  refreshToken: 'r1',
  label: 'fa',
  repos: {},
  aws: {},
  defaults: { maxConcurrent: 1 },
};

const claimFor = (id: string): ClaimResponse => {
  const claim = parseClaim(JSON.parse(fs.readFileSync(new URL('claim-kits/prompt-read-full.json', FIXTURES), 'utf8')) as unknown);
  return { ...claim, run: { ...claim.run, id } };
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const settle = async (): Promise<void> => {
  // i/o secuencial: unas vueltas del event loop para que respondan las promesas en cadena.
  for (let i = 0; i < 10; i++) await flush();
};

interface Two {
  d: DaemonInternals;
  legacy: SupervisorInternals;
  beta: SupervisorInternals;
  fakes: { legacy: FakePlatform; beta: FakePlatform };
  // termina el run en vuelo de ese id (executeRun falso).
  finish: (runId: string) => Promise<void>;
}

// la entrada de `beta` en la config v2: otra plataforma duckhunt-42 con su credencial.
const betaEntry = (extra: object = {}): object => ({ protocol: 'duckhunt-42', credential: { baseUrl: 'https://beta.test', clientId: 'b1', refreshToken: 'rb' }, ...extra });

// daemon con la legacy y `beta` (de la config), ambas falsas; executeRun no lanza claude: espera a que la prueba
// lo termine.
async function two(t: TestContext, maxConcurrent = 1, beta: object = betaEntry()): Promise<Two> {
  fs.writeFileSync(configPath(), JSON.stringify({ ...cfg, defaults: { maxConcurrent }, version: 2, platforms: { [BETA]: beta } }), { mode: 0o600 });
  const { factories, created } = fakeFactories();
  const d = internals(loadConfig()!, { factories });
  await d.reloadConfig();
  const running = new Map<string, () => void>();
  t.mock.method(d, 'executeRun', ((_sup: SupervisorInternals, claim: ClaimResponse) => new Promise<void>((resolve) => running.set(claim.run.id, resolve))) as never);
  const finish = async (runId: string): Promise<void> => {
    running.get(runId)!();
    await settle();
  };
  return { d, legacy: legacyOf(d), beta: d.supervisors.get(BETA)!, fakes: { legacy: created.get('duckhunt')!, beta: created.get(BETA)! }, finish };
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-supervisor-'));
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  fs.writeFileSync(configPath(), JSON.stringify(cfg), { mode: 0o600 });
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('scheduler: hueco en el pool Y en la cuota; la reserva vuelve al soltarla', () => {
  let pool = 2;
  const s = new Scheduler(() => pool);
  assert.equal(s.tryReserve('a', 2), true);
  assert.equal(s.tryReserve('b', 1), true);
  assert.equal(s.tryReserve('a', 2), false, 'pool lleno');
  s.release('b');
  assert.equal(s.tryReserve('b', 1), true);
  assert.equal(s.tryReserve('b', 1), false, 'cuota de b llena');
  pool = 3;
  assert.equal(s.tryReserve('b', 1), false, 'aunque haya pool');
  assert.equal(s.tryReserve('a', 2), true);
  assert.deepEqual([s.used(), s.used('a'), s.used('b')], [3, 2, 1]);
  ['a', 'a', 'b'].forEach((id) => s.release(id));
  assert.equal(s.used(), 0);
});

test('reservar antes de reclamar: sin run (o sin respuesta) la reserva vuelve; con run, el slot es suyo hasta que acaba', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const { d, legacy, beta, fakes, finish } = await two(t);
  fakes.legacy.claims = [IDLE, UNAVAILABLE, runResult(claimFor('7'))];
  assert.equal(await d.pollOnce(legacy), false, 'sin trabajo');
  assert.equal(d.scheduler.used(), 0);
  assert.equal(await d.pollOnce(legacy), false, 'sin respuesta');
  assert.equal(d.scheduler.used(), 0);
  assert.equal(await d.pollOnce(legacy), true, 'un run');
  assert.deepEqual([d.scheduler.used(), legacy.leases.size], [1, 1]);
  // pool de 1 ocupado: beta ni reclama, espera slot.
  assert.equal(await d.pollOnce(beta), false);
  assert.deepEqual([beta.blocked, fakes.beta.announces.length], [true, 0]);
  const wake = t.mock.method(beta as unknown as { wake: () => void }, 'wake');
  await finish('7');
  assert.deepEqual([d.scheduler.used(), legacy.leases.size], [0, 0]);
  assert.equal(wake.mock.callCount(), 1, 'el slot libre despierta a quien lo esperaba');
  assert.equal(await d.pollOnce(beta), false);
  assert.equal(fakes.beta.announces.length, 1);
});

test('cada plataforma anuncia su cuota, no los slots libres del pool: la legacy todo el pool, una nueva 1 o la suya', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { d, legacy, beta, fakes } = await two(t, 3);
  fakes.legacy.claims = [runResult(claimFor('1'))];
  await d.pollOnce(legacy);
  await d.pollOnce(beta);
  assert.deepEqual([fakes.legacy.announces[0]!.slots, fakes.beta.announces[0]!.slots], [3, 1]);
  fakes.beta.claims = [runResult(claimFor('2'))];
  await d.pollOnce(beta);
  assert.equal(await d.pollOnce(beta), false, 'su cuota de 1 llena aunque quede pool');
  assert.equal(beta.blocked, true);
});

test('la credencial muerta de una plataforma solo para a esa; la de la última para el daemon con EXIT_CODE_UNPAIRED', async (t) => {
  t.mock.method(console, 'log', () => {});
  const error = t.mock.method(console, 'error', () => {});
  const { d, legacy, beta, fakes } = await two(t, 2, betaEntry({ slots: 2 }));
  const [mine, theirs] = [new RunLease('1'), new RunLease('2')];
  legacy.leases.add(mine);
  beta.leases.add(theirs);
  fakes.legacy.reject = true;
  assert.equal(await d.pollOnce(legacy), false);
  assert.deepEqual([legacy.state, beta.state, d.stopping, d.exitCode], [PLATFORM_STATE.unpaired, PLATFORM_STATE.active, false, 0]);
  assert.deepEqual([mine.killedBy, theirs.killedBy], ['cancel', null]);
  assert.match(String(error.mock.calls.at(-1)?.arguments[0]), /\. la plataforma duckhunt deja de reclamar$/);
  assert.equal(readServerState('duckhunt')?.state, 'unpaired');
  assert.equal(await d.pollOnce(legacy), false, 'ya no reclama');
  assert.equal(fakes.legacy.announces.length, 0);
  fakes.beta.claims = [runResult(claimFor('3'))];
  assert.equal(await d.pollOnce(beta), true, 'beta sigue');
  fakes.beta.reject = true;
  assert.equal(await d.pollOnce(beta), false);
  assert.deepEqual([d.stopping, d.exitCode], [true, EXIT_CODE_UNPAIRED]);
  assert.equal(theirs.killedBy, 'cancel');
  assert.match(String(error.mock.calls.at(-1)?.arguments[0]), /\. el daemon se detiene$/);
});

test('el poll de cada plataforma va por su cuenta: una colgada o caída no retrasa a la otra', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const { d, legacy, beta, fakes } = await two(t, 2);
  let release = (): void => {};
  fakes.legacy.hold = new Promise((resolve) => (release = resolve));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const polls = [legacy, beta].map((sup) => (d as unknown as { poll(s: SupervisorInternals): Promise<void> }).poll(sup));
  await settle();
  // i/o secuencial: cuatro esperas de poll de beta mientras el claim de la legacy sigue colgado.
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(5_000);
    await settle();
  }
  assert.deepEqual([fakes.legacy.announces.length, fakes.beta.announces.length], [1, 5]);
  // la legacy responde por fin sin respuesta útil: espera su poll sin tocar el de beta.
  fakes.legacy.claims = [UNAVAILABLE];
  release();
  await settle();
  t.mock.timers.tick(5_000);
  await settle();
  assert.deepEqual([fakes.legacy.announces.length, fakes.beta.announces.length], [2, 6]);
  d.stopping = true;
  [legacy, beta].forEach((sup) => (sup as unknown as { wake: () => void }).wake());
  await Promise.all(polls);
});
