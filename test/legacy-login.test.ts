// el `login` de siempre fijado (t#495, M6.4): cuando el flujo oauth se generalizó para otras plataformas, `login
// <url>` siguió mandando las mismas peticiones a los mismos endpoints de duckhunt y escribiendo solo sus claves de
// siempre. este test solo importa oauth.ts: pasa igual contra el de antes de la generalización.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { configPath } from '../src/config.js';
import { login } from '../src/oauth.js';

const BASE = 'https://duckhunt.test';
const CODE = 'code-1';
const ACCESS_TTL_S = 3600;
const realFetch = globalThis.fetch;
let root = '';

interface Call {
  url: string;
  body: Record<string, unknown> | null;
  form: URLSearchParams | null;
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-legacy-login-'));
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  fs.writeFileSync(configPath(), `${JSON.stringify({ baseUrl: BASE, clientId: 'c1', refreshToken: 'r1', label: 'fa', repos: {}, aws: {}, defaults: {} }, null, 2)}\n`, { mode: 0o600 });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('login a secas: dcr, autorización y token bajo la base de duckhunt, con los mismos campos y en el mismo orden', async (t) => {
  const logged: string[] = [];
  t.mock.method(console, 'log', (m: unknown) => logged.push(String(m)));
  t.mock.method(console, 'warn', () => {});
  t.mock.method(readline.Interface.prototype, 'question', async () => CODE);
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const isForm = new Headers(init?.headers).get('content-type') === 'application/x-www-form-urlencoded';
    calls.push({ url, body: !isForm && init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null, form: isForm ? new URLSearchParams(String(init?.body)) : null });
    if (url.endsWith('/oauth/register')) return Response.json({ client_id: 'client-1' }, { status: 201 });
    if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'a', refresh_token: 'refresh-1', expires_in: ACCESS_TTL_S });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  await login(`${BASE}/`, 'portatil');
  assert.deepEqual(calls.map((c) => c.url), [`${BASE}/oauth/register`, `${BASE}/oauth/token`], 'ni discovery ni metadata');
  assert.deepEqual(calls[0]!.body, { client_name: 'duckhunt-runner (portatil)', redirect_uris: [`${BASE}/oauth/authorized`] });
  const authorize = new URL(logged.find((l) => l.includes('/oauth/authorize'))!.trim());
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${BASE}/oauth/authorize`);
  assert.deepEqual([...authorize.searchParams.keys()], ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'resource']);
  assert.deepEqual(
    ['response_type', 'client_id', 'redirect_uri', 'code_challenge_method', 'resource'].map((k) => authorize.searchParams.get(k)),
    ['code', 'client-1', `${BASE}/oauth/authorized`, 'S256', `${BASE}/api/runner`],
  );
  const form = calls[1]!.form!;
  assert.deepEqual([...form.keys()], ['grant_type', 'code', 'code_verifier', 'redirect_uri', 'client_id', 'resource']);
  assert.deepEqual([form.get('grant_type'), form.get('code'), form.get('redirect_uri'), form.get('client_id'), form.get('resource')], ['authorization_code', CODE, `${BASE}/oauth/authorized`, 'client-1', `${BASE}/api/runner`]);
  const j = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
  // sin machine id en la config (una copiada, o de 0.10): no reemplaza a la credencial anterior (machine.ts).
  assert.deepEqual([j.baseUrl, j.clientId, j.refreshToken, j.replacesClientId, j.label], [BASE, 'client-1', 'refresh-1', undefined, 'portatil']);
  assert.deepEqual([j.platforms, j.version], [undefined, undefined], 'la config de siempre');
});
