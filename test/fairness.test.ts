// reparto justo de los slots (t#495, M6.5): un slot que se libera se ofrece en round-robin a la siguiente plataforma
// que espera uno y se le guarda hasta que lo reserva o caduca; una sin trabajo pasa el turno en el acto. simulaciones
// con reloj falso sobre el scheduler (justicia entre tres, sin hambre con Σ cuotas ≤ pool, una por vuelta con más
// cuota que pool) y lo mismo en el daemon con plataformas falsas.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test, type TestContext } from 'node:test';
import { parseClaim, type ClaimResponse } from '../src/claim.js';
import { configPath, loadConfig, type RunnerConfig } from '../src/config.js';
import { Scheduler, type Waiting } from '../src/platforms/scheduler.js';
import { internals, legacyOf, type DaemonInternals, type SupervisorInternals } from './daemon-harness.js';
import { fakeFactories, IDLE, runResult, type FakePlatform } from './fake-platform.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
const TTL_MS = 5_000;
let root = '';

// un scheduler con reloj falso.
function clocked(pool: number): { s: Scheduler; tick: (ms: number) => void } {
  let now = 0;
  return { s: new Scheduler(() => pool, TTL_MS, () => now), tick: (ms) => (now += ms) };
}

// simula plataformas que SIEMPRE tienen trabajo: cada run que acaba libera su slot, quien acaba vuelve a pedir uno (sin
// él, espera) y el slot se ofrece en round-robin a las que esperan. devuelve a quién fue cada slot liberado.
function simulate(pool: number, quotas: Readonly<Record<string, number>>, freed: number): string[] {
  const { s } = clocked(pool);
  const order = Object.keys(quotas);
  const running: string[] = [];
  // arranque: cada una reserva lo que su cuota y el pool dejen, en orden.
  order.forEach((id) => {
    while (s.tryReserve(id, quotas[id]!)) running.push(id);
  });
  const given: string[] = [];
  // i/o secuencial: un run acaba (el más viejo), su plataforma lo intenta otra vez y el slot se ofrece.
  for (let i = 0; i < freed; i++) {
    const done = running.shift()!;
    s.release(done);
    // esperan las demás (con trabajo y sin slot); la que acabó no esperaba: compite después, como en el daemon.
    const waiting: Waiting[] = order.filter((id) => id !== done).map((id) => ({ id, quota: quotas[id]! }));
    const next = s.offer(order, waiting);
    // la que acabó prueba ya; solo se lo lleva si nadie tenía turno.
    const taker = next ?? (s.tryReserve(done, quotas[done]!) ? done : null);
    if (next !== null) assert.equal(s.tryReserve(next, quotas[next]!), true, `${next} reserva el slot que se le ofreció`);
    if (taker !== null) {
      running.push(taker);
      given.push(taker);
    }
  }
  return given;
}

const claimFor = (id: string): ClaimResponse => {
  const claim = parseClaim(JSON.parse(fs.readFileSync(new URL('claim-kits/prompt-read-full.json', FIXTURES), 'utf8')) as unknown);
  return { ...claim, run: { ...claim.run, id } };
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const settle = async (): Promise<void> => {
  // i/o secuencial: unas vueltas del event loop para que respondan las promesas en cadena.
  for (let i = 0; i < 10; i++) await flush();
};

const cfg: RunnerConfig = { baseUrl: 'https://duckhunt.test', clientId: 'c1', refreshToken: 'r1', label: 'fa', repos: {}, aws: {}, defaults: { maxConcurrent: 1 } };
const entry = (id: string, extra: object = {}): object => ({ protocol: 'duckhunt-42', trusted: true, credential: { baseUrl: `https://${id}.test`, clientId: `${id}-1`, refreshToken: 'r' }, ...extra });

interface Three {
  d: DaemonInternals;
  sups: SupervisorInternals[];
  fakes: FakePlatform[];
  finish: (runId: string) => Promise<void>;
}

// daemon con la legacy, beta y gamma (falsas) y un pool de 1; executeRun espera a que la prueba lo termine.
async function three(t: TestContext): Promise<Three> {
  fs.writeFileSync(configPath(), JSON.stringify({ ...cfg, version: 2, platforms: { beta: entry('beta'), gamma: entry('gamma') } }), { mode: 0o600 });
  const { factories, created } = fakeFactories();
  const d = internals(loadConfig()!, { factories });
  await d.reloadConfig();
  const running = new Map<string, () => void>();
  t.mock.method(d, 'executeRun', ((_sup: SupervisorInternals, claim: ClaimResponse) => new Promise<void>((resolve) => running.set(claim.run.id, resolve))) as never);
  const ids = ['duckhunt', 'beta', 'gamma'];
  return {
    d,
    sups: ids.map((id) => d.supervisors.get(id)!),
    fakes: ids.map((id) => created.get(id)!),
    finish: async (runId) => {
      running.get(runId)!();
      await settle();
    },
  };
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-fairness-'));
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('justicia entre tres: con un slot y las tres con trabajo, el slot da la vuelta a, b, c, a…', () => {
  assert.deepEqual(simulate(1, { a: 1, b: 1, c: 1 }, 9), ['b', 'c', 'a', 'b', 'c', 'a', 'b', 'c', 'a']);
});

test('más cuota que pool: cada plataforma que espera recibe un slot por vuelta (ninguna se lleva dos seguidas)', () => {
  const given = simulate(2, { a: 2, b: 2, c: 2 }, 30);
  const counts = given.reduce<Record<string, number>>((acc, id) => ({ ...acc, [id]: (acc[id] ?? 0) + 1 }), {});
  assert.deepEqual(Object.keys(counts).sort(), ['a', 'b', 'c']);
  assert.ok(Math.max(...Object.values(counts)) - Math.min(...Object.values(counts)) <= 1, `reparto ${JSON.stringify(counts)}`);
  // en cada vuelta de tres, las tres.
  [0, 3, 6, 9, 12].forEach((i) => assert.deepEqual(given.slice(i, i + 3).sort(), ['a', 'b', 'c'], `vuelta ${i / 3}`));
});

test('sin hambre con Σ cuotas ≤ pool: una oferta a otra nunca deja a una bajo su cuota sin slot', () => {
  const { s } = clocked(3);
  assert.equal(s.tryReserve('a', 1), true);
  assert.equal(s.tryReserve('b', 1), true);
  s.release('a');
  // el slot de a se le ofrece a c, que espera: b (en su cuota) y a siguen pudiendo lo suyo.
  assert.equal(s.offer(['a', 'b', 'c'], [{ id: 'c', quota: 1 }]), 'c');
  assert.equal(s.tryReserve('a', 1), true, 'a, bajo su cuota, tiene sitio aunque haya una oferta a c');
  assert.equal(s.tryReserve('c', 1), true);
  assert.equal(s.used(), 3);
});

test('una oferta se guarda solo a quien le toca y caduca sin reservar; nadie con la cuota llena la recibe', () => {
  const { s, tick } = clocked(1);
  assert.equal(s.tryReserve('a', 1), true);
  s.release('a');
  assert.equal(s.offer(['a', 'b'], [{ id: 'a', quota: 1 }, { id: 'b', quota: 1 }]), 'a', 'sin turno previo: la primera');
  assert.equal(s.tryReserve('b', 1), false, 'el slot es de a mientras dure la oferta');
  tick(TTL_MS);
  assert.equal(s.tryReserve('b', 1), true, 'caducada, el slot es de quien llegue');
  s.release('b');
  assert.equal(s.offer(['a', 'b'], [{ id: 'b', quota: 0 }]), null, 'b sin cuota: nadie');
  s.withdraw('a');
});

test('daemon: el slot que se libera va a la siguiente en round-robin, y una sin trabajo pasa el turno en el acto', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { d, sups, fakes, finish } = await three(t);
  const [legacy, beta, gamma] = sups as [SupervisorInternals, SupervisorInternals, SupervisorInternals];
  fakes[0]!.claims = [runResult(claimFor('1'))];
  assert.equal(await d.pollOnce(legacy), true);
  // pool de 1 lleno: beta y gamma esperan.
  assert.deepEqual([await d.pollOnce(beta), await d.pollOnce(gamma), beta.blocked, gamma.blocked], [false, false, true, true]);
  const woken = (sup: SupervisorInternals): { mock: { callCount(): number } } => t.mock.method(sup as unknown as { wake: () => void }, 'wake');
  const [wakeBeta, wakeGamma] = [woken(beta), woken(gamma)];
  await finish('1');
  assert.deepEqual([wakeBeta.mock.callCount(), wakeGamma.mock.callCount()], [1, 0], 'el turno es de beta, no de las dos a la vez');
  assert.equal(await d.pollOnce(legacy), false, 'la legacy no se lo lleva: es de beta');
  assert.equal(fakes[0]!.announces.length, 1);
  // beta no tiene trabajo: devuelve el slot y el turno pasa a gamma sin esperar a su poll.
  fakes[1]!.claims = [IDLE];
  assert.equal(await d.pollOnce(beta), false);
  assert.equal(wakeGamma.mock.callCount(), 1, 'gamma, la siguiente');
  fakes[2]!.claims = [runResult(claimFor('2'))];
  assert.equal(await d.pollOnce(gamma), true);
  assert.equal(legacyOf(d).leases.size + gamma.leases.size, 1);
});

test('daemon con una sola plataforma: el slot libre vuelve a ella como siempre', async (t) => {
  t.mock.method(console, 'log', () => {});
  fs.writeFileSync(configPath(), JSON.stringify(cfg), { mode: 0o600 });
  const { factories, created } = fakeFactories();
  const d = internals(loadConfig()!, { factories });
  await d.reloadConfig();
  const running = new Map<string, () => void>();
  t.mock.method(d, 'executeRun', ((_sup: SupervisorInternals, claim: ClaimResponse) => new Promise<void>((resolve) => running.set(claim.run.id, resolve))) as never);
  const legacy = legacyOf(d);
  created.get('duckhunt')!.claims = [runResult(claimFor('1')), runResult(claimFor('2'))];
  assert.equal(await d.pollOnce(legacy), true);
  assert.equal(await d.pollOnce(legacy), false, 'sin slot');
  running.get('1')!();
  await settle();
  assert.equal(await d.pollOnce(legacy), true, 'el slot libre es suyo');
});
