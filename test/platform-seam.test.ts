// el daemon sobre el seam de plataforma (t#495, M6.1): con una plataforma falsa en vez del cable de duckhunt, lo
// que anuncia, qué hace con cada resultado del claim (un run, sin trabajo, un run que no parsea, sin respuesta) y
// que una credencial muerta lo para con EXIT_CODE_UNPAIRED.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { parseClaim, type ClaimResponse } from '../src/claim.js';
import { configPath, loadConfig, type RunnerConfig } from '../src/config.js';
import { EXIT_CODE_UNPAIRED, RunnerDaemon } from '../src/daemon.js';
import { LEGACY_PLATFORM_ID } from '../src/paths.js';
import { CLAIM_RESULT } from '../src/platforms/platform.js';
import { readServerState } from '../src/server-state.js';
import { fakeFactories, runResult, UNAVAILABLE, type FakePlatform } from './fake-platform.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
let root = '';

const cfg: RunnerConfig = {
  baseUrl: 'https://duckhunt.test',
  clientId: 'c1',
  refreshToken: 'r1',
  label: 'fa',
  machineId: 'm-1',
  repos: { 'acme/api': { path: '/dev/api' } },
  aws: { '123456789012': { profile: 'prod' }, default: { profile: 'yo' } },
  defaults: { maxConcurrent: 2 },
};

interface DaemonInternals {
  reloadConfig(): Promise<void>;
  claim(): Promise<ClaimResponse | null>;
  stopping: boolean;
  exitCode: number;
}

const claimFixture = (): ClaimResponse => parseClaim(JSON.parse(fs.readFileSync(new URL('claim-kits/prompt-read-full.json', FIXTURES), 'utf8')) as unknown);

async function daemon(): Promise<{ d: DaemonInternals; platform: FakePlatform }> {
  const { factories, created } = fakeFactories();
  const d = new RunnerDaemon(loadConfig()!, { factories }) as unknown as DaemonInternals;
  await d.reloadConfig();
  return { d, platform: created.get(LEGACY_PLATFORM_ID)! };
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-seam-'));
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  fs.writeFileSync(configPath(), JSON.stringify(cfg), { mode: 0o600 });
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('la plataforma recibe el anuncio de la máquina y el daemon el claim que devuelve', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { d, platform } = await daemon();
  const claim = claimFixture();
  platform.claims = [runResult(claim)];
  assert.equal(await d.claim(), claim);
  const [a] = platform.announces;
  assert.deepEqual([a!.label, a!.machineId, a!.slots, a!.repos, a!.awsAccounts, a!.kept], ['fa', 'm-1', 2, ['acme/api'], ['123456789012'], null]);
  assert.equal(readServerState(LEGACY_PLATFORM_ID)?.state, 'claimed');
  assert.equal(await d.claim(), null, 'sin más respuestas: sin trabajo');
});

test('un run que no parsea se cierra como failed con su motivo; sin respuesta no se guarda nada', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { d, platform } = await daemon();
  platform.claims = [UNAVAILABLE, { kind: CLAIM_RESULT.invalid, runId: '41', error: 'claim inválido: falta prompt', said: { state: 'claimed', runner: null }, commandsPending: false }];
  assert.equal(await d.claim(), null);
  assert.equal(readServerState(LEGACY_PLATFORM_ID), null);
  assert.equal(await d.claim(), null);
  assert.deepEqual(platform.results, [{ runId: '41', report: { status: 'failed', error: 'claim inválido: falta prompt' } }]);
});

test('la credencial muerta en el claim para el daemon con EXIT_CODE_UNPAIRED', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { d, platform } = await daemon();
  platform.reject = true;
  assert.equal(await d.claim(), null);
  assert.deepEqual([d.stopping, d.exitCode], [true, EXIT_CODE_UNPAIRED]);
  assert.equal(readServerState(LEGACY_PLATFORM_ID)?.state, 'unpaired');
});

test('la recarga de la config le pasa a la plataforma la credencial del fichero', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { d, platform } = await daemon();
  fs.writeFileSync(configPath(), JSON.stringify({ ...cfg, clientId: 'c2', refreshToken: 'u1' }), { mode: 0o600 });
  await d.reloadConfig();
  assert.deepEqual(platform.observed.map((c) => c.clientId), ['c1', 'c2']);
});
