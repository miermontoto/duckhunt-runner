// ciclo de vida de los recursos de un run (t#495, M2) con proveedores falsos: orden de fases (y el env que hereda
// cada una), todo o nada (deshacer al revés con `aborted`, sin paths en el error), env_conflict, el scratch por
// defecto, los avisos en orden de feed, los turnos ordenados y sin cruce, soltar al revés aunque uno falle, el
// registro (tipo desconocido, aislar solo con toolset_v1) y las peticiones de un claim legacy.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { parseClaim } from '../src/claim.js';
import { KeyedMutex } from '../src/keyed-mutex.js';
import { CWD_WAIT_NOTE, holdLocks, materializeRun, SCRATCH_NOTE, type ScratchDefault } from '../src/resources/lifecycle.js';
import { legacyRequests, legacyResourceError, legacyScratchExclusive } from '../src/resources/legacy.js';
import { ProviderRegistry } from '../src/resources/registry.js';
import { REPO_TYPE } from '../src/resources/repo/provider.js';
import {
  ACCESS,
  PHASE,
  RELEASE,
  ResourceUnavailableError,
  UNAVAILABLE_KIND,
  type Materialized,
  type Phase,
  type ReleaseOutcome,
  type ResourceProvider,
  type ResourceRequest,
  type RunContext,
} from '../src/resources/types.js';

const SCRATCH = '/home/u/.duckhunt-runner/scratch';
const scratch = (exclusive = false): ScratchDefault => ({ dir: () => SCRATCH, exclusive });
const ctx: RunContext = { platform: 'duckhunt', runId: '88', env: { PATH: '/bin', AWS_PROFILE: 'user' }, gitLocks: new KeyedMutex() };
const request = (type: string, key: string | null = 'k'): ResourceRequest => ({ type, key, access: ACCESS.read, params: {} });

// proveedor falso que anota en `log` cada paso (materializar, aislar, soltar) y el env que vio.
function fake(
  type: string,
  phase: Phase,
  log: string[],
  out: Partial<Omit<Materialized, 'release'>> | Error = {},
  opts: { releaseThrows?: boolean; isolate?: boolean } = {},
): ResourceProvider {
  const make = (how: string, c: RunContext): Materialized => {
    log.push(`${how} ${type} AWS_PROFILE=${c.env.AWS_PROFILE ?? '-'}`);
    if (out instanceof Error) throw out;
    return {
      warnings: [],
      ...out,
      release: async (outcome: ReleaseOutcome) => {
        log.push(`release ${type} ${outcome}`);
        if (opts.releaseThrows) throw new Error(`no suelta ${type}`);
      },
    };
  };
  return {
    type,
    phase,
    materialize: async (_req, _ref, c) => make('materialize', c),
    ...(opts.isolate ? { isolate: async (c: RunContext) => make('isolate', c) } : {}),
  };
}

const planOf = (...providers: ResourceProvider[]) => providers.map((provider) => ({ provider, request: request(provider.type), ref: null }));

test('fases en orden env → cwd → mcp: cada una hereda el env de las anteriores; al soltar, al revés', async () => {
  const log: string[] = [];
  const res = await materializeRun(
    planOf(
      fake('browser', PHASE.mcp, log),
      fake('repo', PHASE.cwd, log, { cwd: { dir: '/dev/app', checkout: true, skipPermissions: false }, note: 'origin/main@abc' }),
      fake('aws', PHASE.env, log, { env: { AWS_PROFILE: 'okt', AWS_ACCESS_KEY_ID: null } }),
    ),
    { ...ctx, env: { ...ctx.env, AWS_ACCESS_KEY_ID: 'AKIA' } },
    scratch(),
  );
  assert.deepEqual(log, ['materialize aws AWS_PROFILE=user', 'materialize repo AWS_PROFILE=okt', 'materialize browser AWS_PROFILE=okt']);
  assert.deepEqual(res.env, { PATH: '/bin', AWS_PROFILE: 'okt' }, 'null quita la variable del env base');
  assert.equal(res.cwd.dir, '/dev/app');
  assert.equal(res.note, 'origin/main@abc');
  await res.release(RELEASE.done);
  assert.deepEqual(log.slice(3), ['release browser done', 'release repo done', 'release aws done']);
});

test('todo o nada: si falla el recurso i, los anteriores se sueltan al revés con aborted y el error no lleva paths', async () => {
  const log: string[] = [];
  const boom = new Error('EACCES: permission denied, mkdir /home/u/.duckhunt-runner/run-config/aws-88');
  await assert.rejects(
    materializeRun(planOf(fake('a', PHASE.env, log), fake('b', PHASE.env, log), fake('repo', PHASE.cwd, log, boom), fake('mcp', PHASE.mcp, log)), ctx, scratch()),
    (err: unknown) => {
      assert.ok(err instanceof ResourceUnavailableError);
      assert.deepEqual([err.code, err.type, err.key, err.kind], ['resource_unavailable', 'repo', 'k', UNAVAILABLE_KIND.failed]);
      assert.equal(err.cause, boom, 'el detalle queda para el log local');
      assert.doesNotMatch(err.message, /\//, 'sin paths en lo que viaja');
      return true;
    },
  );
  assert.deepEqual(log, ['materialize a AWS_PROFILE=user', 'materialize b AWS_PROFILE=user', 'materialize repo AWS_PROFILE=user', 'release b aborted', 'release a aborted'], 'el de después nunca se materializa');
});

test('env_conflict: la misma variable con valores distintos aborta (los dos se sueltan); con el mismo valor, no', async () => {
  const log: string[] = [];
  await assert.rejects(
    materializeRun(planOf(fake('aws', PHASE.env, log, { env: { AWS_REGION: 'eu-west-1' } }), fake('kube', PHASE.env, log, { env: { AWS_REGION: 'us-east-1' } })), ctx, scratch()),
    (err: unknown) => err instanceof ResourceUnavailableError && err.kind === UNAVAILABLE_KIND.envConflict && err.type === 'kube',
  );
  assert.deepEqual(log.slice(2), ['release kube aborted', 'release aws aborted']);
  const same = await materializeRun(planOf(fake('aws', PHASE.env, [], { env: { AWS_REGION: 'eu-west-1' } }), fake('kube', PHASE.env, [], { env: { AWS_REGION: 'eu-west-1' } })), ctx, scratch());
  assert.equal(same.env.AWS_REGION, 'eu-west-1');
  // quitar y poner la misma variable también es un conflicto.
  await assert.rejects(materializeRun(planOf(fake('a', PHASE.env, [], { env: { X: null } }), fake('b', PHASE.env, [], { env: { X: '1' } })), ctx, scratch()), ResourceUnavailableError);
});

test('dos recursos con cwd: cwd_conflict', async () => {
  const cwd = { dir: '/x', checkout: true, skipPermissions: false };
  await assert.rejects(
    materializeRun(planOf(fake('repo', PHASE.cwd, [], { cwd }), fake('otro', PHASE.cwd, [], { cwd })), ctx, scratch()),
    (err: unknown) => err instanceof ResourceUnavailableError && err.kind === UNAVAILABLE_KIND.cwdConflict,
  );
});

test('sin cwd de un proveedor: el scratch, con turno si el run escribe; la nota del proveedor que degradó manda', async () => {
  const none = await materializeRun([], ctx, scratch());
  assert.deepEqual([none.cwd, none.note, none.locks], [{ dir: SCRATCH, checkout: false, skipPermissions: false }, SCRATCH_NOTE, []]);
  const degraded = await materializeRun(planOf(fake('repo', PHASE.cwd, [], { note: 'scratch · sin repo mapeado', warnings: ['repo x no mapeado'] })), ctx, scratch(true));
  assert.equal(degraded.note, 'scratch · sin repo mapeado');
  assert.deepEqual(degraded.locks, [{ key: path.resolve(SCRATCH), waitNote: CWD_WAIT_NOTE }]);
});

test('los avisos salen en orden de feed: primero dónde corre (cwd), luego env y mcp', async () => {
  const res = await materializeRun(
    planOf(fake('aws', PHASE.env, [], { warnings: ['aws sin mapear'] }), fake('mcp', PHASE.mcp, [], { warnings: ['mcp'] }), fake('repo', PHASE.cwd, [], { warnings: ['rama ignorada'] })),
    ctx,
    scratch(),
  );
  assert.deepEqual(res.warnings, ['rama ignorada', 'aws sin mapear', 'mcp']);
});

test('soltar: al revés y cada uno aislado, uno que lanza no deja a los demás sin soltar', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  const log: string[] = [];
  const res = await materializeRun(planOf(fake('a', PHASE.env, log), fake('b', PHASE.cwd, log, {}, { releaseThrows: true }), fake('c', PHASE.mcp, log)), ctx, scratch());
  await res.release(RELEASE.failed);
  assert.deepEqual(log.slice(3), ['release c failed', 'release b failed', 'release a failed']);
  assert.match(String(error.mock.calls[0]?.arguments[0]), /soltar el recurso b k falló: no suelta b/);
});

test('turnos: sin repetir, en orden de clave (dos runs con A,B y B,A no se esperan en cruz) y con nota al esperar', async () => {
  const mutex = new KeyedMutex();
  const order: string[] = [];
  const acquire = mutex.acquire.bind(mutex);
  mutex.acquire = (key: string) => {
    order.push(key);
    return acquire(key);
  };
  const never = new Promise<never>(() => {});
  const lock = (key: string) => ({ key, waitNote: `espero ${key}` });
  const first = await holdLocks([lock('b'), lock('a'), lock('b')], mutex, never, () => {});
  assert.deepEqual(order, ['a', 'b']);
  const notes: string[] = [];
  const second = holdLocks([lock('a'), lock('b')], mutex, never, (n) => notes.push(n));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(notes, ['espero a'], 'espera el primero sin tomar el segundo');
  // el primero suelta los dos a la vez: el segundo ya no espera por b.
  first();
  const releaseSecond = await second;
  assert.deepEqual(notes, ['espero a']);
  assert.deepEqual(order, ['a', 'b', 'a', 'b']);
  releaseSecond();
  await new Promise((r) => setImmediate(r));
  assert.equal(mutex.busy('a') || mutex.busy('b'), false);
});

test('turnos: un run que muere esperando deja de esperar y lo que le llega tarde se suelta solo', async () => {
  const mutex = new KeyedMutex();
  const holder = await mutex.acquire('a');
  let kill!: () => void;
  const killed = new Promise<void>((r) => (kill = r));
  const waiting = holdLocks([{ key: 'a', waitNote: CWD_WAIT_NOTE }, { key: 'b', waitNote: CWD_WAIT_NOTE }], mutex, killed, () => {});
  kill();
  const release = await waiting;
  release();
  assert.equal(mutex.busy('b'), false, 'no siguió con b');
  holder();
  await new Promise((r) => setImmediate(r));
  assert.equal(mutex.busy('a'), false, 'el turno de a que llegó tarde se soltó');
});

test('registro: un tipo sin proveedor no se materializa a medias; aislar solo con toolset_v1 y solo lo no pedido', () => {
  const log: string[] = [];
  const registry = new ProviderRegistry([fake('repo', PHASE.cwd, log), fake('aws', PHASE.env, log, {}, { isolate: true })]);
  assert.throws(
    () => registry.plan([request('kube')], () => null),
    (err: unknown) => err instanceof ResourceUnavailableError && err.kind === UNAVAILABLE_KIND.unknownType && err.type === 'kube',
  );
  const refs = registry.plan([request('repo', 'okt/api')], (type, key) => (type === 'repo' && key === 'okt/api' ? { path: '/dev/api' } : null));
  assert.deepEqual(
    refs.map((p) => [p.provider.type, p.request?.key, p.ref]),
    [['repo', 'okt/api', { path: '/dev/api' }]],
  );
  assert.deepEqual(registry.plan([request('repo')], () => null, true).map((p) => [p.provider.type, p.request === null]), [
    ['repo', false],
    ['aws', true],
  ]);
  assert.deepEqual(registry.plan([request('aws')], () => null, true).length, 1, 'con aws pedida no se aísla');
  assert.throws(() => new ProviderRegistry([fake('repo', PHASE.cwd, log), fake('repo', PHASE.cwd, log)]), /mismo tipo/);
});

test('claim legacy: el repo con su rama y su aislamiento; sin repo, nada; el scratch exclusivo solo en edición', () => {
  const raw = (run: Record<string, unknown>) =>
    parseClaim({
      run: { id: 7, kind: 'prompt', profile: 'edit', repo: 'okt/api', branch: 'feat/x', isolation: 'worktree', ...run },
      prompt: 'p',
      permissionMode: 'dontAsk',
      mcp: { serverName: 'duckhunt', url: 'https://d.test/mcp', token: 't' },
    }).run;
  assert.deepEqual(legacyRequests(raw({})), [{ type: REPO_TYPE, key: 'okt/api', access: ACCESS.full, params: { branch: 'feat/x', worktree: 'conversation' } }]);
  assert.equal(legacyRequests(raw({ isolation: 'checkout', profile: 'read' }))[0]?.params.worktree, 'checkout');
  assert.equal(legacyRequests(raw({ profile: 'read' }))[0]?.access, ACCESS.read);
  assert.equal(legacyRequests(raw({ kind: 'investigate', profile: undefined }))[0]?.params.worktree, 'run');
  assert.deepEqual(legacyRequests(raw({ repo: null })), []);
  assert.equal(legacyScratchExclusive(raw({})), true);
  assert.equal(legacyScratchExclusive(raw({ profile: 'read' })), false);
});

test('error legacy de /status: el del repo con el texto de siempre; el de otro recurso sin paths', (t) => {
  t.mock.method(console, 'error', () => {});
  const git = new Error('el checkout no tiene ningún commit (HEAD vacío)');
  assert.equal(legacyResourceError(new ResourceUnavailableError(REPO_TYPE, 'okt/api', UNAVAILABLE_KIND.failed, git)), 'no se pudo preparar el directorio del run: el checkout no tiene ningún commit (HEAD vacío)');
  const aws = legacyResourceError(new ResourceUnavailableError('aws', '123456789012', UNAVAILABLE_KIND.failed, new Error('EACCES /home/u/x')));
  assert.equal(aws, 'no se pudo preparar el run: recurso aws 123456789012 no disponible (materialize_failed)');
});
