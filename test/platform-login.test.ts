// otras plataformas desde la cli (t#495, M6.4) contra un server falso: `login <url> --as [id]` con discovery (v0 y el
// oauth de su metadata rfc 8414, todo en su origen), sin discovery solo con --trusted (duckhunt-42), el id derivado
// y los reservados, renovar la misma plataforma sin perder su exposición y rechazar otra con el mismo id; los
// subcomandos de `platforms` y `logout <id>`, que solo tocan su plataforma. `login` y `logout` a secas no cambian.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test, type TestContext } from 'node:test';
import { configPath, loadConfigV2, type RunnerConfig } from '../src/config.js';
import { logoutCommand } from '../src/logout.js';
import { refreshAccess } from '../src/oauth.js';
import { parsePlatformLoginArgs, platformIdOf, platformLogin, type PlatformLoginArgs } from '../src/platform-login.js';
import { platformsCommand } from '../src/platforms-cli.js';
import { credentialStore } from '../src/platforms/credentials.js';
import { DEFAULT_CEILING } from '../src/platforms/types.js';
import { V0_ENDPOINT } from '../src/vendor/runner-protocol/index.js';

const LEGACY = 'https://duckhunt.test';
const BETA = 'https://beta.test';
const ACCESS_TTL_S = 3600;
const CODE = 'code-1';
const realFetch = globalThis.fetch;
let root = '';

type Obj = Record<string, unknown>;

interface Call {
  url: URL;
  auth: string | null;
  body: Obj | null;
  form: URLSearchParams | null;
}

// server falso de una plataforma: discovery, metadata, dcr (un client_id nuevo por registro), token (code y
// refresh rotado) y unpair, en el cable que toque.
interface FakePlatform {
  calls: Call[];
  discovery: () => Response;
  metadata: () => Response;
  unpair: () => Response;
}

const LIMITS = { announceMax: 64, eventBatchMax: 50, eventBodyMaxChars: 4000, eventToolMaxChars: 120, resultMaxChars: 20000, errorMaxChars: 2000, stderrTailMaxChars: 8000, requestBytesMax: 1048576 };

const discoveryDoc = (base: string, patch: Obj = {}): Obj => ({
  protocol: 'agent-runner',
  protocol_versions: ['0'],
  issuer: base,
  authorization_server_metadata: `${base}/.well-known/oauth-authorization-server`,
  resource: `${base}/api/runner`,
  oob_redirect_uri: `${base}/oauth/authorized`,
  endpoints: { ...V0_ENDPOINT },
  features: [],
  backends: ['claude_code'],
  extensions: [],
  limits: LIMITS,
  ...patch,
});

const metadataDoc = (base: string, patch: Obj = {}): Obj => ({
  issuer: base,
  authorization_endpoint: `${base}/oauth/authorize`,
  token_endpoint: `${base}/oauth/token`,
  registration_endpoint: `${base}/oauth/register`,
  code_challenge_methods_supported: ['S256'],
  ...patch,
});

function fakePlatform(base = BETA): FakePlatform {
  let clients = 0;
  const fake: FakePlatform = {
    calls: [],
    discovery: () => Response.json(discoveryDoc(base)),
    metadata: () => Response.json(metadataDoc(base)),
    unpair: () => Response.json({ ok: true, runnerId: '9', canceled: ['r_a'] }),
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const raw = init?.body === undefined ? null : String(init.body);
    const isForm = new Headers(init?.headers).get('content-type') === 'application/x-www-form-urlencoded';
    const call: Call = { url, auth: new Headers(init?.headers).get('authorization'), body: raw && !isForm ? (JSON.parse(raw) as Obj) : null, form: isForm ? new URLSearchParams(raw ?? '') : null };
    fake.calls.push(call);
    if (url.pathname === '/.well-known/agent-runner') return fake.discovery();
    if (url.pathname === '/.well-known/oauth-authorization-server') return fake.metadata();
    if (url.pathname.endsWith('/register')) return Response.json({ client_id: `client-${++clients}` }, { status: 201 });
    if (url.pathname.endsWith('/token')) {
      const refresh = call.form!.get('grant_type') === 'refresh_token' ? `${call.form!.get('refresh_token')}+` : `refresh-${call.form!.get('client_id')}`;
      return Response.json({ access_token: `access:${call.form!.get('client_id')}`, refresh_token: refresh, expires_in: ACCESS_TTL_S });
    }
    if (url.pathname === V0_ENDPOINT.unpair || url.pathname === '/api/runner/unpair') return fake.unpair();
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return fake;
}

const legacyCfg: RunnerConfig = {
  baseUrl: LEGACY,
  clientId: 'c1',
  refreshToken: 'r1',
  label: 'fa',
  repos: { 'acme/api': { path: '/dev/api' }, 'acme/web': { path: '/dev/web' } },
  aws: { '123456789012': { profile: 'prod' } },
  defaults: {},
};
const writeConfig = (cfg: object): void => fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
const readJson = (): Obj => JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Obj;
const ask = async (): Promise<string> => CODE;
const args = (patch: Partial<PlatformLoginArgs> = {}): PlatformLoginArgs => ({ baseUrl: BETA, id: 'beta', trusted: false, ...patch });
const platformOf = (id: string): Obj | undefined => (readJson().platforms as Obj | undefined)?.[id] as Obj | undefined;
const quiet = (t: TestContext): { log: string[]; err: string[] } => {
  const out = { log: [] as string[], err: [] as string[] };
  t.mock.method(console, 'log', (m: unknown) => out.log.push(String(m)));
  t.mock.method(console, 'warn', (m: unknown) => out.err.push(String(m)));
  t.mock.method(console, 'error', (m: unknown) => out.err.push(String(m)));
  return out;
};
// la legacy, tal cual estaba: sus claves de siempre no se tocan.
const legacyKeys = (): unknown[] => {
  const j = readJson();
  return [j.baseUrl, j.clientId, j.refreshToken, j.label, j.repos, j.aws];
};
const LEGACY_KEYS = [LEGACY, 'c1', 'r1', 'fa', legacyCfg.repos, legacyCfg.aws];

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-platform-login-'));
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  writeConfig(legacyCfg);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  process.exitCode = undefined;
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

// --- argumentos e id ---

test('login sin --as es el de siempre; con --as, url, id, nombre y confianza; https salvo en loopback', () => {
  assert.equal(parsePlatformLoginArgs([]), null);
  assert.equal(parsePlatformLoginArgs(['https://duckhunt.info', 'portatil']), null);
  assert.equal(parsePlatformLoginArgs(['--trusted']), null, 'sin --as nada cambia, ni con otros flags');
  assert.deepEqual(parsePlatformLoginArgs(['beta.test', '--as', 'beta', '--name', 'Beta', '--trusted']), { baseUrl: BETA, id: 'beta', name: 'Beta', trusted: true });
  assert.deepEqual(parsePlatformLoginArgs(['--as', 'https://beta.test/']), { baseUrl: BETA, id: null, trusted: false }, '--as sin id: lo que sigue es la url');
  assert.deepEqual(parsePlatformLoginArgs(['http://127.0.0.1:4000', '--as']), { baseUrl: 'http://127.0.0.1:4000', id: null, trusted: false });
  assert.throws(() => parsePlatformLoginArgs(['http://beta.test', '--as', 'beta']), /https/);
  assert.throws(() => parsePlatformLoginArgs(['--as', 'beta']), /uso:/);
  assert.throws(() => parsePlatformLoginArgs([BETA, 'otra', '--as', 'beta']), /uso:/);
  assert.throws(() => parsePlatformLoginArgs([BETA, '--as', 'beta', '--name']), /uso:/);
  assert.throws(() => parsePlatformLoginArgs([BETA, '--as', 'beta', '--slots', '2']), /uso:/);
});

test('el id derivado del host del issuer: minúsculas y guiones, hasta 32; nunca uno reservado', () => {
  assert.equal(platformIdOf('https://duckhunt.info'), 'duckhunt-info');
  assert.equal(platformIdOf('https://Agents.Example.COM:8443/x'), 'agents-example-com');
  assert.equal(platformIdOf(`https://${'a'.repeat(40)}.test`), 'a'.repeat(32));
  assert.equal(platformIdOf('https://localhost'), 'localhost');
  assert.equal(platformIdOf('https://duckhunt'), null, 'reservado');
  assert.equal(platformIdOf('https://local'), null, 'reservado');
  assert.equal(platformIdOf('no es una url'), null);
});

// --- login ---

test('login --as con discovery: v0, el oauth de su metadata y la plataforma nueva sin nada expuesto; la legacy, intacta', async (t) => {
  const out = quiet(t);
  const fake = fakePlatform();
  await platformLogin(args({ name: 'Beta' }), ask);
  const register = fake.calls.find((c) => c.url.pathname === '/oauth/register')!;
  assert.deepEqual(register.body, { client_name: 'duckhunt-runner (fa)', redirect_uris: [`${BETA}/oauth/authorized`] });
  const token = fake.calls.find((c) => c.form?.get('grant_type') === 'authorization_code')!;
  assert.deepEqual(Object.fromEntries(token.form!), {
    grant_type: 'authorization_code',
    code: CODE,
    code_verifier: token.form!.get('code_verifier'),
    redirect_uri: `${BETA}/oauth/authorized`,
    client_id: 'client-1',
    resource: `${BETA}/api/runner`,
  });
  const authorize = out.log.find((l) => l.includes('/oauth/authorize'))!;
  assert.match(authorize, /code_challenge_method=S256/);
  assert.match(authorize, /resource=https%3A%2F%2Fbeta\.test%2Fapi%2Frunner/);
  assert.deepEqual(platformOf('beta'), {
    trusted: false,
    expose: {},
    ceiling: DEFAULT_CEILING,
    slots: 1,
    credential: { baseUrl: BETA, clientId: 'client-1', refreshToken: 'refresh-client-1' },
    protocol: 'agent-runner/0',
    issuer: BETA,
    name: 'Beta',
  });
  assert.deepEqual(legacyKeys(), LEGACY_KEYS);
  assert.ok(out.log.some((l) => l.includes('platforms expose beta repo')), 'dice qué hacer después');
});

test('un token endpoint que no es el de siempre se guarda y el refresh va a él', async (t) => {
  quiet(t);
  const fake = fakePlatform();
  fake.metadata = () => Response.json(metadataDoc(BETA, { token_endpoint: `${BETA}/auth/token`, registration_endpoint: `${BETA}/auth/register` }));
  await platformLogin(args(), ask);
  const credential = loadConfigV2()!.platforms.beta!.credential!;
  assert.equal(credential.tokenEndpoint, `${BETA}/auth/token`);
  const { credential: rotated } = await refreshAccess(credential, credentialStore('beta'));
  assert.equal(fake.calls.at(-1)!.url.pathname, '/auth/token');
  assert.equal(rotated.tokenEndpoint, `${BETA}/auth/token`, 'el refresh no lo pierde');
  assert.equal(loadConfigV2()!.platforms.beta!.credential!.refreshToken, 'refresh-client-1+');
});

test('--as sin id: el del host del issuer', async (t) => {
  quiet(t);
  fakePlatform();
  await platformLogin(args({ id: null }), ask);
  assert.equal((platformOf('beta-test')?.credential as Obj).clientId, 'client-1');
});

test('renovar la misma plataforma conserva exposición, techo y cuota; otra con el mismo id se rechaza antes del oauth', async (t) => {
  quiet(t);
  fakePlatform();
  await platformLogin(args(), ask);
  await platformsCommand(['expose', 'beta', 'repo', 'acme/api']);
  await platformLogin(args(), ask);
  const beta = platformOf('beta')!;
  assert.deepEqual(beta.expose, { repo: ['acme/api'] });
  assert.equal(beta.slots, 1);
  assert.deepEqual(beta.credential, { baseUrl: BETA, clientId: 'client-2', refreshToken: 'refresh-client-2', replacesClientId: 'client-1' }, 'la nueva reemplaza a la vieja en el server');
  const other = fakePlatform('https://otra.test');
  await assert.rejects(platformLogin(args({ baseUrl: 'https://otra.test' }), ask), /ya es la de https:\/\/beta\.test/);
  assert.equal(other.calls.filter((c) => c.url.pathname.endsWith('/register')).length, 0, 'sin registrar un cliente');
});

test('sin discovery (404): solo con --trusted y en el cable de duckhunt', async (t) => {
  quiet(t);
  const fake = fakePlatform();
  fake.discovery = () => new Response('not found', { status: 404 });
  await assert.rejects(platformLogin(args(), ask), /--trusted/);
  assert.equal(fake.calls.filter((c) => c.url.pathname.endsWith('/register')).length, 0);
  assert.equal(platformOf('beta'), undefined);
  await platformLogin(args({ trusted: true }), ask);
  const beta = platformOf('beta')!;
  assert.deepEqual([beta.protocol, beta.trusted, beta.issuer], ['duckhunt-42', true, BETA]);
  assert.ok(fake.calls.some((c) => c.url.href === `${BETA}/oauth/register`), 'el oauth de siempre bajo su base');
});

test('un discovery o una metadata que no valen no dan de alta nada', async (t) => {
  quiet(t);
  const fake = fakePlatform();
  fake.discovery = () => Response.json(discoveryDoc(BETA, { protocol_versions: ['1'] }));
  await assert.rejects(platformLogin(args(), ask), /discovery v0 inválido/);
  fake.discovery = () => Response.json(discoveryDoc(BETA, { authorization_server_metadata: 'https://otro.test/.well-known/oauth-authorization-server' }));
  await assert.rejects(platformLogin(args(), ask), /authorization_server_metadata fuera del origen/);
  fake.discovery = () => Response.json(discoveryDoc(BETA));
  fake.metadata = () => Response.json(metadataDoc(BETA, { token_endpoint: 'https://otro.test/oauth/token' }));
  await assert.rejects(platformLogin(args(), ask), /token_endpoint fuera del origen/);
  fake.metadata = () => Response.json(metadataDoc(BETA, { code_challenge_methods_supported: ['plain'] }));
  await assert.rejects(platformLogin(args(), ask), /pkce S256/);
  fake.discovery = () => new Response('caído', { status: 503 });
  await assert.rejects(platformLogin(args(), ask), /discovery: http 503/);
  assert.equal(fake.calls.filter((c) => c.url.pathname.endsWith('/register')).length, 0);
  assert.equal(platformOf('beta'), undefined);
});

test('ids reservados o no válidos se rechazan antes de hablar con nadie', async (t) => {
  quiet(t);
  const fake = fakePlatform();
  await assert.rejects(platformLogin(args({ id: 'duckhunt' }), ask), /reservado: `login <url>` sin --as es el de duckhunt/);
  await assert.rejects(platformLogin(args({ id: 'local' }), ask), /reservado/);
  await assert.rejects(platformLogin(args({ id: 'Beta' }), ask), /no válido/);
  assert.equal(fake.calls.length, 0);
});

// --- platforms ---

async function withBeta(t: TestContext): Promise<{ out: { log: string[]; err: string[] }; fake: FakePlatform }> {
  const out = quiet(t);
  const fake = fakePlatform();
  await platformLogin(args(), ask);
  out.log.length = 0;
  return { out, fake };
}

test('platforms list: la legacy primero, cada una con su protocolo, a quién habla, confianza, estado, cuota y lo que ve', async (t) => {
  const { out } = await withBeta(t);
  await platformsCommand(['list']);
  assert.deepEqual(out.log, [
    `duckhunt · duckhunt-42 · ${LEGACY} · trusted · activa · slots todo el pool`,
    '  expone: repo * · aws *',
    `beta · agent-runner/0 · ${BETA} · no trusted · activa · slots 1`,
    '  expone: nada',
  ]);
});

test('platforms pause y resume: solo cambian `paused`', async (t) => {
  const { out } = await withBeta(t);
  await platformsCommand(['pause', 'beta']);
  assert.equal(platformOf('beta')!.paused, true);
  await platformsCommand(['pause', 'beta']);
  assert.ok(out.log.includes('beta ya está en pausa'));
  await platformsCommand(['resume', 'beta']);
  assert.equal(Object.hasOwn(platformOf('beta')!, 'paused'), false);
  await platformsCommand(['pause', 'duckhunt']);
  assert.equal(platformOf('duckhunt')!.paused, true, 'la legacy también se pausa');
  assert.deepEqual(legacyKeys(), LEGACY_KEYS);
});

test('platforms expose y unexpose: solo claves mapeadas, `*` para todas, y un `*` no se recorta clave a clave', async (t) => {
  const { out } = await withBeta(t);
  await platformsCommand(['expose', 'beta', 'repo', 'acme/web']);
  await platformsCommand(['expose', 'beta', 'repo', 'acme/api']);
  assert.deepEqual((platformOf('beta')!.expose as Obj).repo, ['acme/api', 'acme/web']);
  await platformsCommand(['expose', 'beta', 'repo', 'otro/repo']);
  assert.equal(process.exitCode, 1);
  assert.match(out.err.at(-1)!, /no está mapeado/);
  process.exitCode = undefined;
  await platformsCommand(['expose', 'beta', 'kube', 'prod']);
  assert.equal(process.exitCode, 1, 'tipo desconocido');
  process.exitCode = undefined;
  await platformsCommand(['unexpose', 'beta', 'repo', 'acme/web']);
  assert.deepEqual((platformOf('beta')!.expose as Obj).repo, ['acme/api']);
  await platformsCommand(['expose', 'beta', 'aws', '*']);
  await platformsCommand(['unexpose', 'beta', 'aws', '123456789012']);
  assert.equal(process.exitCode, 1, 'un * no se recorta');
  process.exitCode = undefined;
  await platformsCommand(['unexpose', 'beta', 'aws', '*']);
  await platformsCommand(['unexpose', 'beta', 'repo', 'acme/api']);
  assert.deepEqual(platformOf('beta')!.expose, {});
});

test('platforms trust y untrust: quitar la confianza baja una shell entera; la legacy no deja de ser trusted', async (t) => {
  const { out } = await withBeta(t);
  await platformsCommand(['trust', 'beta']);
  const cfg = readJson();
  ((cfg.platforms as Obj).beta as Obj).ceiling = { ...DEFAULT_CEILING, shell: 'full' };
  writeConfig(cfg);
  await platformsCommand(['untrust', 'beta']);
  const beta = platformOf('beta')!;
  assert.equal(beta.trusted, false);
  assert.equal((beta.ceiling as Obj).shell, 'read');
  assert.ok(out.log.some((l) => l.includes('baja de shell entera')));
  assert.ok(loadConfigV2(), 'la config sigue siendo válida');
  await platformsCommand(['untrust', 'duckhunt']);
  assert.equal(process.exitCode, 1);
  assert.equal(platformOf('duckhunt'), undefined, 'la legacy, sin tocar');
});

test('platforms remove: desvincula en su server y quita la entrada; la legacy no se quita', async (t) => {
  const { fake, out } = await withBeta(t);
  await platformsCommand(['remove', 'duckhunt']);
  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
  await platformsCommand(['remove', 'beta']);
  const unpair = fake.calls.find((c) => c.url.pathname === V0_ENDPOINT.unpair)!;
  assert.equal(unpair.auth, 'Bearer access:client-1');
  assert.equal(platformOf('beta'), undefined);
  assert.ok(out.log.includes('beta desvinculada: 1 run(s) en marcha cancelado(s)'));
  assert.deepEqual(legacyKeys(), LEGACY_KEYS);
  await platformsCommand(['remove', 'beta']);
  assert.equal(process.exitCode, 1, 'ya no está');
});

test('platforms: uso y plataformas que no existen', async (t) => {
  const { out } = await withBeta(t);
  await platformsCommand(['pause']);
  assert.equal(process.exitCode, 1);
  assert.match(out.err.at(-1)!, /uso:/);
  process.exitCode = undefined;
  await platformsCommand(['pause', 'nadie']);
  assert.equal(process.exitCode, 1);
  assert.match(out.err.at(-1)!, /no hay ninguna plataforma nadie/);
});

// --- logout <id> ---

test('logout <id>: desvincula esa plataforma y borra solo su credencial; la legacy, intacta', async (t) => {
  const { fake } = await withBeta(t);
  await platformsCommand(['expose', 'beta', 'repo', 'acme/api']);
  await logoutCommand('beta');
  assert.ok(fake.calls.some((c) => c.url.pathname === V0_ENDPOINT.unpair));
  const beta = platformOf('beta')!;
  assert.equal(beta.credential, undefined);
  assert.deepEqual(beta.expose, { repo: ['acme/api'] }, 'su exposición se queda');
  assert.deepEqual(legacyKeys(), LEGACY_KEYS);
  assert.equal(fake.calls.filter((c) => c.url.pathname === '/api/runner/unpair').length, 0, 'duckhunt ni se entera');
  const before = fake.calls.length;
  await logoutCommand('beta');
  assert.equal(fake.calls.length, before, 'sin credencial no llama a nadie');
  await logoutCommand('nadie');
  assert.equal(process.exitCode, 1);
});

test('logout <id>: un fallo del server no borra nada', async (t) => {
  const { fake } = await withBeta(t);
  fake.unpair = () => new Response('caído', { status: 500 });
  await assert.rejects(logoutCommand('beta'), /500/);
  assert.equal((platformOf('beta')!.credential as Obj).clientId, 'client-1');
});
