// refresh single-flight: N llamadas cerca de la caducidad comparten UN refresh (el server revoca la
// cadena si ve dos veces el mismo refresh token) y un 401 tardío no fuerza un segundo refresh.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccessTokenSource, TOKEN_REFRESH_MARGIN_MS } from '../src/access-token.js';
import type { AccessState } from '../src/oauth.js';

const HOUR_MS = 60 * 60_000;

// refresh falso: cuenta llamadas y resuelve cuando el test lo libera.
function fakeRefresh(now: () => number) {
  let calls = 0;
  const pending: Array<() => void> = [];
  const refresh = (): Promise<AccessState> => {
    calls++;
    const token = `t${calls}`;
    return new Promise((resolve) => pending.push(() => resolve({ token, expiresAt: now() + HOUR_MS })));
  };
  return { refresh, calls: () => calls, release: () => pending.splice(0).forEach((r) => r()) };
}

test('llamadas concurrentes sin token comparten un único refresh', async () => {
  let clock = 0;
  const now = () => clock;
  const f = fakeRefresh(now);
  const src = new AccessTokenSource(f.refresh, now);
  const tokens = Promise.all([src.token(), src.token(), src.token()]);
  f.release();
  assert.deepEqual(await tokens, ['t1', 't1', 't1']);
  assert.equal(f.calls(), 1);
  // vigente: no refresca.
  assert.equal(await src.token(), 't1');
  assert.equal(f.calls(), 1);
  // dentro del margen de caducidad: un solo refresh nuevo para todas.
  clock = HOUR_MS - TOKEN_REFRESH_MARGIN_MS + 1;
  const again = Promise.all([src.token(), src.token()]);
  f.release();
  assert.deepEqual(await again, ['t2', 't2']);
  assert.equal(f.calls(), 2);
});

test('un 401 invalida solo el token que lo recibió', async () => {
  const now = () => 0;
  const f = fakeRefresh(now);
  const src = new AccessTokenSource(f.refresh, now);
  const first = src.token();
  f.release();
  assert.equal(await first, 't1');
  // dos llamadas con t1 reciben 401: la primera fuerza el refresh, la segunda ya ve t2 vigente.
  src.invalidate('t1');
  const second = src.token();
  f.release();
  assert.equal(await second, 't2');
  src.invalidate('t1');
  assert.equal(await src.token(), 't2');
  assert.equal(f.calls(), 2);
});

test('un refresh fallido se propaga a todos y el siguiente vuelve a intentarlo', async () => {
  let calls = 0;
  const src = new AccessTokenSource(async () => {
    calls++;
    if (calls === 1) throw new Error('token endpoint: invalid_grant');
    return { token: 'ok', expiresAt: HOUR_MS };
  }, () => 0);
  const results = await Promise.allSettled([src.token(), src.token()]);
  assert.deepEqual(
    results.map((r) => r.status),
    ['rejected', 'rejected'],
  );
  assert.equal(calls, 1);
  assert.equal(await src.token(), 'ok');
});
