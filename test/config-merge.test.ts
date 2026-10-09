// escritura segura de la config (0.10.1): cada escritor relee el fichero y cambia solo sus claves, de
// forma atómica. el refresh del daemon ya no deshace un `login`, `repos add` o `aws add` hechos con el
// daemon en marcha, adopta la credencial de un `login` nuevo de la misma instancia y, si no puede
// guardar el refresh rotado, lo conserva en memoria. el daemon recarga mapas y credencial antes del claim.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { configPath, loadConfig, mergeEntries, saveConfig, type RepoConfig, type RunnerConfig, type RunnerCredential } from '../src/config.js';
import { refreshAccess } from '../src/oauth.js';
import { RunnerDaemon } from '../src/daemon.js';

const BASE = 'https://duckhunt.test';
const OTHER_BASE = 'https://otra.test';
const ACCESS_TTL_S = 3600;

let root = '';
const realFetch = globalThis.fetch;

// token endpoint falso: cada refresh rota a `<refresh>+` y devuelve `access:<client>`; /api/runner/claim
// responde 204. `onToken` corre antes de responder (un `login` durante el refresh).
interface FakeServer {
  tokenForms: URLSearchParams[];
  claims: Array<{ auth: string | null; body: { repos?: string[]; awsAccounts?: string[]; runnerLabel?: string; slots?: number } }>;
  onToken?: () => void;
}

function fakeServer(): FakeServer {
  const server: FakeServer = { tokenForms: [], claims: [] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/oauth/token')) {
      const form = new URLSearchParams(String(init?.body));
      server.tokenForms.push(form);
      server.onToken?.();
      return Response.json({ access_token: `access:${form.get('client_id')}`, refresh_token: `${form.get('refresh_token')}+`, expires_in: ACCESS_TTL_S });
    }
    if (url.endsWith('/api/runner/claim')) {
      server.claims.push({ auth: new Headers(init?.headers).get('authorization'), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return server;
}

const writeConfig = (cfg: object): void => fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
const readJson = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
const repo = (p: string, extra: Partial<RepoConfig> = {}): RepoConfig => ({ path: p, ...extra });

const initial: RunnerConfig = {
  baseUrl: BASE,
  clientId: 'c1',
  refreshToken: 'r1',
  label: 'fa',
  repos: { 'acme/api': repo('/dev/api') },
  aws: {},
  defaults: {},
};
const credentialOf = (cfg: RunnerConfig): RunnerCredential => ({ baseUrl: cfg.baseUrl, clientId: cfg.clientId, refreshToken: cfg.refreshToken });

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-config-'));
  process.env.DUCKHUNT_RUNNER_HOME = path.join(root, 'home');
});

beforeEach(() => {
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(fs.mkdtempSync(path.join(root, 'case-')), 'runner.json');
  writeConfig(initial);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('el refresh del daemon solo escribe su refreshToken: no deshace `repos add`, `aws add` ni la etiqueta', async () => {
  const server = fakeServer();
  // la cli edita el fichero con el daemon en marcha (su copia en memoria es `initial`).
  saveConfig((current) => ({ repos: { ...current.repos, 'acme/web': repo('/dev/web') } }));
  saveConfig((current) => ({ aws: { ...current.aws, '123456789012': { profile: 'prod' } }, label: 'portatil' }));
  const result = await refreshAccess(credentialOf(initial));
  assert.equal(server.tokenForms[0]!.get('refresh_token'), 'r1');
  assert.deepEqual(result.credential, { baseUrl: BASE, clientId: 'c1', refreshToken: 'r1+' });
  assert.equal(result.saved, true);
  assert.deepEqual(loadConfig(), {
    ...initial,
    refreshToken: 'r1+',
    label: 'portatil',
    repos: { 'acme/api': repo('/dev/api'), 'acme/web': repo('/dev/web') },
    aws: { '123456789012': { profile: 'prod' } },
  });
});

test('`login` con el daemon en marcha: el refresh adopta la credencial nueva de la misma instancia', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  const server = fakeServer();
  saveConfig(() => ({ clientId: 'c2', refreshToken: 'u1' }));
  const result = await refreshAccess({ baseUrl: BASE, clientId: 'c1', refreshToken: 'r7' });
  assert.equal(server.tokenForms[0]!.get('client_id'), 'c2');
  assert.equal(server.tokenForms[0]!.get('refresh_token'), 'u1');
  assert.deepEqual(result.credential, { baseUrl: BASE, clientId: 'c2', refreshToken: 'u1+' });
  assert.equal(result.access.token, 'access:c2');
  assert.equal(loadConfig()?.refreshToken, 'u1+');
  assert.equal(log.mock.callCount(), 1);
});

test('un `login` hecho DURANTE el refresh gana: el refresh rotado no lo pisa', async () => {
  const server = fakeServer();
  server.onToken = () => saveConfig(() => ({ clientId: 'c3', refreshToken: 'v1' }));
  const result = await refreshAccess(credentialOf(initial));
  // el daemon sigue con su cadena en memoria hasta el siguiente refresh, que adoptará c3.
  assert.deepEqual(result.credential, { baseUrl: BASE, clientId: 'c1', refreshToken: 'r1+' });
  assert.equal(result.saved, true);
  const disk = loadConfig();
  assert.equal(disk?.clientId, 'c3');
  assert.equal(disk?.refreshToken, 'v1');
});

test('`login` contra otra instancia no se adopta en caliente ni se pisa', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const server = fakeServer();
  saveConfig(() => ({ baseUrl: OTHER_BASE, clientId: 'c9', refreshToken: 'w1' }));
  const result = await refreshAccess(credentialOf(initial));
  assert.equal(server.tokenForms[0]!.get('client_id'), 'c1');
  assert.deepEqual(result.credential, { baseUrl: BASE, clientId: 'c1', refreshToken: 'r1+' });
  assert.deepEqual(credentialOf(loadConfig()!), { baseUrl: OTHER_BASE, clientId: 'c9', refreshToken: 'w1' });
  assert.equal(warn.mock.callCount(), 1);
});

test('un fichero ilegible no tumba el refresh: la credencial rotada vuelve en memoria sin guardar', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  fakeServer();
  fs.writeFileSync(configPath(), '{ "baseUrl": a medias');
  const result = await refreshAccess(credentialOf(initial));
  assert.deepEqual(result.credential, { baseUrl: BASE, clientId: 'c1', refreshToken: 'r1+' });
  assert.equal(result.saved, false);
  assert.equal(fs.readFileSync(configPath(), 'utf-8'), '{ "baseUrl": a medias');
  assert.ok(error.mock.callCount() >= 1);
});

test('saveConfig conserva las claves desconocidas, escribe con 600 y no deja temporales', () => {
  writeConfig({ ...initial, future: { keep: true } });
  fs.chmodSync(configPath(), 0o644);
  const written = saveConfig((current) => ({ aws: { ...current.aws, '210987654321': { profile: 'dev', region: 'eu-west-1' } } }));
  assert.deepEqual(readJson().future, { keep: true });
  assert.deepEqual(written.aws, { '210987654321': { profile: 'dev', region: 'eu-west-1' } });
  assert.equal(fs.statSync(configPath()).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(configPath())), ['runner.json']);
});

test('saveConfig sin cambios no escribe', () => {
  const before = fs.statSync(configPath());
  const text = fs.readFileSync(configPath(), 'utf-8');
  saveConfig(() => null);
  assert.equal(fs.statSync(configPath()).ino, before.ino);
  assert.equal(fs.readFileSync(configPath(), 'utf-8'), text);
});

test('saveConfig a través de un symlink (dotfiles) escribe el fichero real y deja el enlace', () => {
  const real = path.join(path.dirname(configPath()), 'real.json');
  fs.renameSync(configPath(), real);
  fs.symlinkSync(real, configPath());
  saveConfig(() => ({ label: 'enlazado' }));
  assert.ok(fs.lstatSync(configPath()).isSymbolicLink());
  assert.equal((JSON.parse(fs.readFileSync(real, 'utf-8')) as RunnerConfig).label, 'enlazado');
});

test('saveConfig a través de un symlink colgante crea su destino y deja el enlace', () => {
  const real = path.join(path.dirname(configPath()), 'aun-no.json');
  fs.rmSync(configPath());
  fs.symlinkSync(real, configPath());
  saveConfig(() => ({ label: 'nuevo' }));
  assert.ok(fs.lstatSync(configPath()).isSymbolicLink());
  assert.equal((JSON.parse(fs.readFileSync(real, 'utf-8')) as RunnerConfig).label, 'nuevo');
});

test('saveConfig en un directorio sin escritura cae a escribir en sitio (no pierde el refresh rotado)', { skip: process.getuid?.() === 0 }, (t) => {
  const dir = path.dirname(configPath());
  fs.chmodSync(dir, 0o500);
  t.after(() => fs.chmodSync(dir, 0o700));
  saveConfig(() => ({ refreshToken: 'r2' }));
  assert.equal(loadConfig()?.refreshToken, 'r2');
  assert.deepEqual(fs.readdirSync(dir), ['runner.json']);
});

test('mergeEntries: lo que cambiaron los comandos, sobre el mapa del fichero y sin perder lo de la cli', () => {
  const before = { a: repo('/a'), b: repo('/b'), d: repo('/d'), e: repo('/e') };
  // comandos de duckhunt: quitar d, mover b.
  const after = { a: before.a, b: repo('/b2'), e: before.e };
  // la cli, mientras tanto: añadió c y quitó e.
  const current = { a: repo('/a'), b: repo('/b'), c: repo('/c'), d: repo('/d') };
  assert.deepEqual(mergeEntries(current, before, after), { a: repo('/a'), c: repo('/c'), b: repo('/b2') });
});

// el loop de claim por dentro: recarga + claim, sin `claude` ni slots.
interface DaemonInternals {
  reloadConfig(): Promise<void>;
  claim(): Promise<unknown>;
}

test('el daemon en marcha toma `repos add`, `aws add` y la etiqueta en el siguiente claim', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const server = fakeServer();
  const daemon = new RunnerDaemon(loadConfig()!) as unknown as DaemonInternals;
  await daemon.reloadConfig();
  await daemon.claim();
  assert.deepEqual(server.claims[0]!.body.repos, ['acme/api']);
  saveConfig((current) => ({ repos: { ...current.repos, 'acme/web': repo(path.join(root, 'no-existe')) }, aws: { '123456789012': { profile: 'prod' } }, label: 'portatil', defaults: { maxConcurrent: 3 } }));
  await daemon.reloadConfig();
  await daemon.claim();
  const { body } = server.claims[1]!;
  assert.deepEqual(body.repos, ['acme/api', 'acme/web']);
  assert.deepEqual(body.awsAccounts, ['123456789012']);
  assert.equal(body.runnerLabel, 'portatil');
  assert.equal(body.slots, 3);
  // un solo refresh: la recarga no tocó la credencial y el refresh no deshizo la edición.
  assert.equal(server.tokenForms.length, 1);
  assert.deepEqual(Object.keys(loadConfig()!.repos), ['acme/api', 'acme/web']);
});

test('`login` con el daemon en marcha: el siguiente claim ya va con la credencial nueva', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const server = fakeServer();
  const daemon = new RunnerDaemon(loadConfig()!) as unknown as DaemonInternals;
  await daemon.reloadConfig();
  await daemon.claim();
  assert.equal(server.claims[0]!.auth, 'Bearer access:c1');
  saveConfig(() => ({ clientId: 'c2', refreshToken: 'u1' }));
  await daemon.reloadConfig();
  await daemon.claim();
  assert.equal(server.claims[1]!.auth, 'Bearer access:c2');
  assert.equal(server.tokenForms[1]!.get('refresh_token'), 'u1');
  assert.equal(loadConfig()?.refreshToken, 'u1+');
});

test('un fichero ilegible a medias de edición: el daemon sigue con la config cargada', async (t) => {
  const error = t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'log', () => {});
  const server = fakeServer();
  const daemon = new RunnerDaemon(loadConfig()!) as unknown as DaemonInternals;
  fs.writeFileSync(configPath(), '{ "repos": ');
  await daemon.reloadConfig();
  await daemon.reloadConfig();
  await daemon.claim();
  assert.deepEqual(server.claims[0]!.body.repos, ['acme/api']);
  // un aviso por cambio del fichero, no uno por claim.
  assert.equal(error.mock.calls.filter((c) => String(c.arguments[0]).includes('sigo con la config cargada')).length, 1);
});
