// la máquina desde duckhunt (t#670): el pool que fija la persona (remote_slots, también tras reiniciar), cuándo sabe un
// daemon reiniciarse solo (selfUpdateMode), y la actualización de punta a punta con plataformas falsas: drena sin
// reclamar en las demás, espera a sus runs, comprueba y se reinicia; un fallo se anuncia hasta que el server lo suelta y
// la persona puede cancelarla mientras drena.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test, type TestContext } from 'node:test';
import { parseClaim, type ClaimResponse } from '../src/claim.js';
import { concurrency, configPath, loadConfig, type RunnerConfig } from '../src/config.js';
import { LEGACY_PLATFORM_ID } from '../src/paths.js';
import { CLAIM_RESULT, type ClaimResult } from '../src/platforms/platform.js';
import { inOwnSystemdUnit, selfUpdateMode, UPDATE_MODE, UpdateError, type ProcessFacts, type SelfUpdater } from '../src/self-update.js';
import { writeServerState, type RunnerBlock } from '../src/server-state.js';
import { internals, type DaemonInternals, type SupervisorInternals } from './daemon-harness.js';
import { fakeFactories, runResult, type FakePlatform } from './fake-platform.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
const NEXT = '9.9.9';
const NPX_SCRIPT = '/home/u/.npm/_npx/abc/node_modules/duckhunt-runner/dist/index.js';
let root = '';

const facts = (over: Partial<ProcessFacts> = {}): ProcessFacts => ({
  script: NPX_SCRIPT,
  env: {},
  platform: 'linux',
  pid: 4242,
  cgroup: '0::/user.slice/user-1000.slice/session-3.scope\n',
  inContainer: false,
  unitInstalled: false,
  ...over,
});

const block = (over: Partial<RunnerBlock> = {}): RunnerBlock => ({ id: 1, name: null, paused: false, accepts: 'all', maxSlots: null, update: null, ...over });
const idleWith = (runner: RunnerBlock, state: string | null = null): ClaimResult => ({ kind: CLAIM_RESULT.idle, said: { state, runner }, commandsPending: false });
// un run con el bloque de la máquina (su pool de 2: el siguiente claim cabe con este en curso).
const runWith = (claim: ClaimResponse, runner: RunnerBlock): ClaimResult => ({ ...runResult(claim), said: { state: 'claimed', runner } } as ClaimResult);

const claimFor = (id: string): ClaimResponse => {
  const claim = parseClaim(JSON.parse(fs.readFileSync(new URL('claim-kits/prompt-read-full.json', FIXTURES), 'utf8')) as unknown);
  return { ...claim, run: { ...claim.run, id } };
};

const settle = async (): Promise<void> => {
  // i/o secuencial: unas vueltas del event loop para que respondan las promesas en cadena.
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

const cfg: RunnerConfig = { baseUrl: 'https://duckhunt.test', clientId: 'c1', refreshToken: 'r1', label: 'fa', repos: {}, aws: {}, defaults: { maxConcurrent: 1 } };
const beta = { protocol: 'duckhunt-42', trusted: true, credential: { baseUrl: 'https://beta.test', clientId: 'beta-1', refreshToken: 'r' } };

interface Harness {
  d: DaemonInternals;
  legacy: SupervisorInternals;
  other: SupervisorInternals;
  fakes: { legacy: FakePlatform; other: FakePlatform };
  calls: string[];
  finish: (runId: string) => Promise<void>;
}

// daemon con la legacy y beta (falsas), un updater falso que anota lo que hace y executeRun que espera a la prueba.
async function harness(t: TestContext, updater: Partial<SelfUpdater> = {}, defaults: RunnerConfig['defaults'] = cfg.defaults): Promise<Harness> {
  fs.writeFileSync(configPath(), JSON.stringify({ ...cfg, defaults, version: 2, platforms: { beta } }), { mode: 0o600 });
  const { factories, created } = fakeFactories();
  const calls: string[] = [];
  const fake: SelfUpdater = {
    mode: UPDATE_MODE.detached,
    verify: async (v) => void calls.push(`verify ${v}`),
    restart: async (mode, v) => void calls.push(`restart ${mode} ${v}`),
    ...updater,
  };
  const d = internals(loadConfig()!, { factories, updater: fake });
  await d.reloadConfig();
  const running = new Map<string, () => void>();
  t.mock.method(d, 'executeRun', ((_sup: SupervisorInternals, claim: ClaimResponse) => new Promise<void>((resolve) => running.set(claim.run.id, resolve))) as never);
  return {
    d,
    legacy: d.supervisors.get(LEGACY_PLATFORM_ID)!,
    other: d.supervisors.get('beta')!,
    fakes: { legacy: created.get(LEGACY_PLATFORM_ID)!, other: created.get('beta')! },
    calls,
    finish: async (runId) => {
      running.get(runId)!();
      await settle();
    },
  };
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-self-update-'));
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('concurrency: el tope de duckhunt manda sobre la config, acotado a 16; uno inválido no cuenta', () => {
  assert.equal(concurrency({ maxConcurrent: 3 }, 6), 6);
  assert.equal(concurrency({}, 1), 1);
  assert.equal(concurrency({ maxConcurrent: 3 }, null), 3);
  assert.equal(concurrency({ maxConcurrent: 3 }, 0), 3, 'un tope inválido deja la config');
  assert.equal(concurrency({}, 40), 16);
});

test('selfUpdateMode: solo desde npx, y en su unidad de systemd o sin otro supervisor', () => {
  assert.equal(selfUpdateMode(facts()), UPDATE_MODE.detached, 'nohup, tmux o una terminal: relevo');
  assert.equal(selfUpdateMode(facts({ script: '/usr/lib/node_modules/duckhunt-runner/dist/index.js' })), null, 'instalado: lo actualiza su gestor');
  const unit = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/duckhunt-runner.service\n';
  assert.equal(selfUpdateMode(facts({ env: { INVOCATION_ID: 'x' }, cgroup: unit, unitInstalled: true })), UPDATE_MODE.systemd);
  assert.equal(selfUpdateMode(facts({ env: { INVOCATION_ID: 'x' }, cgroup: unit, unitInstalled: false })), null, 'una unidad que no escribió service.ts');
  assert.equal(selfUpdateMode(facts({ env: { INVOCATION_ID: 'x' } })), null, 'una unidad de systemd ajena relanzaría la vieja');
  assert.equal(selfUpdateMode(facts({ env: { pm_id: '3' } })), null, 'pm2');
  assert.equal(selfUpdateMode(facts({ pid: 1 })), null, 'pid 1 de un contenedor');
  assert.equal(selfUpdateMode(facts({ inContainer: true })), null);
  assert.equal(selfUpdateMode(facts({ platform: 'darwin', env: { XPC_SERVICE_NAME: 'info.duckhunt.runner' } })), null, 'su LaunchAgent');
  assert.equal(selfUpdateMode(facts({ platform: 'darwin', env: { XPC_SERVICE_NAME: '0' } })), UPDATE_MODE.detached, 'una terminal de macos');
  assert.equal(selfUpdateMode(facts({ platform: 'win32' })), null);
  assert.equal(inOwnSystemdUnit(null), false);
});

test('remote_slots: el pool sigue al tope de duckhunt (también tras reiniciar) y solo la legacy lo anuncia', async (t) => {
  t.mock.method(console, 'log', () => {});
  const h = await harness(t);
  assert.equal(await h.d.pollOnce(h.legacy), false);
  assert.ok(h.fakes.legacy.announces[0]!.capabilities.includes('remote_slots'));
  assert.ok(h.fakes.legacy.announces[0]!.capabilities.includes('self_update'));
  assert.equal(h.fakes.legacy.announces[0]!.slots, 1, 'sin tope: los de la config');
  h.fakes.legacy.claims = [idleWith(block({ maxSlots: 4 }))];
  await h.d.pollOnce(h.legacy);
  await h.d.pollOnce(h.legacy);
  assert.equal(h.fakes.legacy.announces.at(-1)!.slots, 4);
  await h.d.pollOnce(h.other);
  assert.ok(!h.fakes.other.announces[0]!.capabilities.includes('remote_slots'), 'beta no fija la máquina');

  // otro arranque lee el último bloque guardado: el pool vale desde el primer claim.
  writeServerState({ at: Date.now(), baseUrl: cfg.baseUrl, clientId: 'c1', state: null, runner: block({ maxSlots: 5 }), kept: null }, LEGACY_PLATFORM_ID);
  const again = await harness(t);
  await again.d.pollOnce(again.legacy);
  assert.equal(again.fakes.legacy.announces[0]!.slots, 5);
});

test('actualizar: drena (beta no reclama), espera a su run y luego comprueba y se reinicia', async (t) => {
  t.mock.method(console, 'log', () => {});
  const h = await harness(t);
  h.fakes.legacy.claims = [runWith(claimFor('1'), block({ maxSlots: 2 }))];
  assert.equal(await h.d.pollOnce(h.legacy), true);
  h.fakes.legacy.claims = [idleWith(block({ maxSlots: 2, update: { version: NEXT } }), 'updating')];
  await h.d.pollOnce(h.legacy);
  assert.deepEqual(h.calls, [], 'con un run en curso, espera');
  assert.equal(await h.d.pollOnce(h.other), false);
  assert.equal(h.fakes.other.announces.length, 0, 'drenando, las demás plataformas no reclaman');
  await h.finish('1');
  h.fakes.legacy.claims = [idleWith(block({ maxSlots: 2, update: { version: NEXT } }), 'updating')];
  await h.d.pollOnce(h.legacy);
  await settle();
  assert.deepEqual(h.calls, [`verify ${NEXT}`, `restart detached ${NEXT}`]);
  assert.deepEqual([h.d.stopping, h.d.exitCode], [true, 0]);
});

test('actualizar: un fallo sigue reclamando y se anuncia hasta que el server suelta la petición', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const h = await harness(t, {
    verify: async () => {
      throw new UpdateError('npx no pudo bajar o arrancar duckhunt-runner@9.9.9');
    },
  });
  h.fakes.legacy.claims = [idleWith(block({ update: { version: NEXT } }), 'updating')];
  await h.d.pollOnce(h.legacy);
  await settle();
  assert.equal(h.d.stopping, false);
  // el siguiente claim lo dice; el server lo suelta y deja de anunciarse.
  h.fakes.legacy.claims = [idleWith(block())];
  await h.d.pollOnce(h.legacy);
  assert.deepEqual(h.fakes.legacy.announces.at(-1)!.updateFailed, { version: NEXT, error: 'npx no pudo bajar o arrancar duckhunt-runner@9.9.9' });
  await h.d.pollOnce(h.legacy);
  assert.equal(h.fakes.legacy.announces.at(-1)!.updateFailed, null);
  await h.d.pollOnce(h.other);
  assert.equal(h.fakes.other.announces.length, 1, 'sin drenar, beta vuelve a reclamar');
});

test('actualizar: cancelada mientras drena, vuelve a reclamar; con remoteUpdate: false ni la anuncia', async (t) => {
  t.mock.method(console, 'log', () => {});
  const h = await harness(t);
  h.fakes.legacy.claims = [runWith(claimFor('1'), block({ maxSlots: 2 }))];
  await h.d.pollOnce(h.legacy);
  h.fakes.legacy.claims = [idleWith(block({ maxSlots: 2, update: { version: NEXT } }), 'updating'), idleWith(block({ maxSlots: 2 }))];
  await h.d.pollOnce(h.legacy);
  await h.d.pollOnce(h.legacy);
  await h.finish('1');
  await h.d.pollOnce(h.legacy);
  assert.deepEqual(h.calls, [], 'cancelada: no se actualiza');
  await h.d.pollOnce(h.other);
  assert.equal(h.fakes.other.announces.length, 1);

  const off = await harness(t, {}, { maxConcurrent: 1, remoteUpdate: false });
  off.fakes.legacy.claims = [idleWith(block({ update: { version: NEXT } }))];
  await off.d.pollOnce(off.legacy);
  await off.d.pollOnce(off.legacy);
  await settle();
  assert.ok(!off.fakes.legacy.announces[0]!.capabilities.includes('self_update'));
  assert.deepEqual(off.calls, [], 'apagada en la máquina: ni drena ni se actualiza');
});
