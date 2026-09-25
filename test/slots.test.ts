// piezas de los runs en paralelo: exclusión mutua por clave (fifo dentro de una clave, claves
// distintas en paralelo, liberación aunque la sección falle, turno abandonado por un run muerto que
// se suelta al llegar), el lease de un run y el tope de slots de la config.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KeyedMutex } from '../src/keyed-mutex.js';
import { RunLease } from '../src/run-lease.js';
import { concurrency, MAX_CONCURRENT_LIMIT } from '../src/config.js';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

test('una clave: turnos en orden de llegada, sin solaparse', async () => {
  const mutex = new KeyedMutex();
  const log: string[] = [];
  const section = (name: string) => async () => {
    log.push(`${name}+`);
    await tick();
    log.push(`${name}-`);
  };
  await Promise.all([mutex.run('repo', section('a')), mutex.run('repo', section('b')), mutex.run('repo', section('c'))]);
  assert.deepEqual(log, ['a+', 'a-', 'b+', 'b-', 'c+', 'c-']);
  assert.equal(mutex.busy('repo'), false);
});

test('claves distintas no se esperan entre sí', async () => {
  const mutex = new KeyedMutex();
  const release = await mutex.acquire('a');
  let ranB = false;
  await mutex.run('b', async () => {
    ranB = true;
  });
  assert.ok(ranB);
  assert.equal(mutex.busy('a'), true);
  release();
  await tick();
  assert.equal(mutex.busy('a'), false);
});

test('una sección que falla libera el turno', async () => {
  const mutex = new KeyedMutex();
  await assert.rejects(
    mutex.run('repo', async () => {
      throw new Error('git worktree add falló');
    }),
  );
  assert.equal(await mutex.run('repo', async () => 'siguiente'), 'siguiente');
});

test('un run muerto mientras espera suelta el turno en cuanto le llega', async () => {
  const mutex = new KeyedMutex();
  const holder = await mutex.acquire('scratch');
  const lease = new RunLease(7);
  // el patrón del daemon (holdCwd): carrera entre el turno y la muerte del run.
  const acquiring = mutex.acquire('scratch');
  const waiting = Promise.race([acquiring, lease.killed.then(() => null)]);
  lease.kill('cancel');
  assert.equal(await waiting, null);
  void acquiring.then((release) => release());
  holder();
  // el tercero entra: nadie retiene el turno abandonado.
  assert.equal(await mutex.run('scratch', async () => 'ok'), 'ok');
  await tick();
  assert.equal(mutex.busy('scratch'), false);
});

test('lease: kill antes de lanzar claude se aplica al registrarlo; solo cuenta el primero', () => {
  const lease = new RunLease(9);
  lease.kill('shutdown');
  lease.kill('cancel');
  assert.equal(lease.killedBy, 'shutdown');
  const reasons: string[] = [];
  // el hijo no se toca: attach solo reenvía el motivo al kill del intento.
  lease.attach({ pid: undefined } as never, (r) => reasons.push(r));
  assert.deepEqual(reasons, ['shutdown']);
});

test('slots: ausente o inválido = 1, acotado al tope', () => {
  assert.equal(concurrency({}), 1);
  assert.equal(concurrency({ maxConcurrent: 3 }), 3);
  assert.equal(concurrency({ maxConcurrent: 0 }), 1);
  assert.equal(concurrency({ maxConcurrent: 2.5 }), 1);
  assert.equal(concurrency({ maxConcurrent: '3' as unknown as number }), 1);
  assert.equal(concurrency({ maxConcurrent: 99 }), MAX_CONCURRENT_LIMIT);
});
