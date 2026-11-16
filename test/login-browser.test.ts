// el login con navegador (t#660): la vuelta por loopback gana sin pegar nada y lleva al navegador a la página de
// duckhunt; un state ajeno no corta el login; el code pegado (suelto o la url entera) sigue valiendo; denegar en el
// navegador falla el login. el modo sin navegador lo fija legacy-login.test.ts byte a byte.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test, type TestContext } from 'node:test';
import { configPath } from '../src/config.js';
import { login, parsePastedCode, type AskCode } from '../src/oauth.js';

const BASE = 'https://duckhunt.test';
const OOB = `${BASE}/oauth/authorized`;
const CODE = 'code-1';
const ACCESS_TTL_S = 3600;
const realFetch = globalThis.fetch;
let root = '';

interface Calls {
  register: Record<string, unknown> | null;
  token: URLSearchParams | null;
}

// el server de duckhunt de mentira: dcr y token.
function fakeServer(): Calls {
  const calls: Calls = { register: null, token: null };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/oauth/register')) {
      calls.register = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ client_id: 'client-1' }, { status: 201 });
    }
    if (url.endsWith('/oauth/token')) {
      calls.token = new URLSearchParams(String(init?.body));
      return Response.json({ access_token: 'a', refresh_token: 'refresh-1', expires_in: ACCESS_TTL_S });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return calls;
}

// el navegador vuelve al loopback: status y Location de la respuesta.
function hit(url: string): Promise<{ status: number; location: string | undefined }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0, location: res.headers.location });
      })
      .on('error', reject);
  });
}

// la vuelta que haría el servidor tras aprobar: el redirect_uri de la url abierta con el code y el state dados.
function callbackOf(opened: string, params: Record<string, string>): string {
  const authorize = new URL(opened);
  const back = new URL(authorize.searchParams.get('redirect_uri')!);
  Object.entries({ state: authorize.searchParams.get('state')!, ...params }).forEach(([k, v]) => back.searchParams.set(k, v));
  return back.toString();
}

// un prompt que no responde hasta que lo corten (la persona no pega nada).
const waitingAsk: AskCode = (_prompt, signal) =>
  new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

const quiet = (t: TestContext): string[] => {
  const out: string[] = [];
  t.mock.method(console, 'log', (m: unknown) => out.push(String(m)));
  t.mock.method(console, 'warn', () => {});
  return out;
};

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-login-browser-'));
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('el navegador vuelve solo: dcr con las dos redirect_uri, canje con la del loopback y la página de duckhunt', async (t) => {
  quiet(t);
  const calls = fakeServer();
  let back: { status: number; location: string | undefined } | null = null;
  let opened = '';
  await login(BASE, 'fa', {
    browser: true,
    paste: true,
    ask: waitingAsk,
    open: async (url) => {
      opened = url;
      back = await hit(callbackOf(url, { code: CODE }));
      return true;
    },
  });
  const loopback = new URL(opened).searchParams.get('redirect_uri')!;
  assert.match(loopback, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.deepEqual(calls.register, { client_name: 'duckhunt-runner (fa)', redirect_uris: [OOB, loopback] });
  assert.ok(new URL(opened).searchParams.get('state'), 'el modo navegador lleva state');
  assert.deepEqual([calls.token!.get('code'), calls.token!.get('redirect_uri')], [CODE, loopback]);
  assert.deepEqual(back, { status: 302, location: `${OOB}?connected=1` });
  const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
  assert.deepEqual([cfg.clientId, cfg.refreshToken, cfg.label], ['client-1', 'refresh-1', 'fa']);
});

test('una vuelta con otro state recibe un 400 y el login sigue esperando la buena', async (t) => {
  quiet(t);
  const calls = fakeServer();
  const statuses: number[] = [];
  await login(BASE, 'fa', {
    browser: true,
    paste: false,
    open: async (url) => {
      statuses.push((await hit(callbackOf(url, { code: 'ajeno', state: 'otro' }))).status);
      statuses.push((await hit(callbackOf(url, { code: CODE }))).status);
      return true;
    },
  });
  assert.deepEqual(statuses, [400, 302]);
  assert.equal(calls.token!.get('code'), CODE);
});

test('sin navegador que se abra, el code pegado gana y se canjea con la redirect_uri out-of-band', async (t) => {
  const out = quiet(t);
  const calls = fakeServer();
  await login(BASE, 'fa', { browser: true, paste: true, ask: async () => CODE, open: async () => false });
  assert.deepEqual([calls.token!.get('code'), calls.token!.get('redirect_uri')], [CODE, OOB]);
  // la url que se imprime para pegar es la out-of-band (vale en otro ordenador).
  const printed = out.find((l) => l.includes('/oauth/authorize'))!;
  assert.equal(new URL(printed.trim()).searchParams.get('redirect_uri'), OOB);
});

test('la url entera del loopback pegada (el navegador estaba en otro sitio) se canjea con la del loopback', async (t) => {
  quiet(t);
  const calls = fakeServer();
  let opened = '';
  await login(BASE, 'fa', {
    browser: true,
    paste: true,
    open: async (url) => {
      opened = url;
      return true;
    },
    // la persona copia la url de la barra de un navegador que no llegó al loopback.
    ask: async () => {
      await new Promise((r) => setImmediate(r));
      return callbackOf(opened, { code: CODE });
    },
  });
  assert.deepEqual([calls.token!.get('code'), calls.token!.get('redirect_uri')], [CODE, new URL(opened).searchParams.get('redirect_uri')]);
});

test('denegar en el navegador falla el login y lleva al navegador a la página del error', async (t) => {
  quiet(t);
  fakeServer();
  let back: { status: number; location: string | undefined } | null = null;
  await assert.rejects(
    login(BASE, 'fa', {
      browser: true,
      paste: false,
      open: async (url) => {
        back = await hit(callbackOf(url, { error: 'access_denied' }));
        return true;
      },
    }),
    /autorización denegada en el navegador \(access_denied\)/,
  );
  assert.deepEqual(back, { status: 302, location: `${OOB}?error=access_denied` });
  assert.equal(fs.existsSync(configPath()), false, 'sin credencial');
});

test('lo pegado: un code suelto, la url de la página out-of-band o la del loopback; un error o una url sin code fallan', () => {
  const loop = 'http://127.0.0.1:4567/callback';
  assert.deepEqual(parsePastedCode('  abc  ', loop), { code: 'abc', loopback: false, state: null });
  assert.deepEqual(parsePastedCode(`${BASE}/authorize/code?code=abc`, loop), { code: 'abc', loopback: false, state: null });
  assert.deepEqual(parsePastedCode(`${loop}?code=abc&state=s1`, loop), { code: 'abc', loopback: true, state: 's1' });
  assert.throws(() => parsePastedCode('', loop), /código vacío/);
  assert.throws(() => parsePastedCode(`${loop}?error=access_denied&state=s1`, loop), /denegada/);
  assert.throws(() => parsePastedCode(`${BASE}/authorize/code`, loop), /no trae ningún código/);
});
