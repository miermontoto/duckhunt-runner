// sesiones de navegador (t#495, M7 fase 1): los patrones de origen y qué cookies y orígenes van en la copia de un run
// (subdominio, comodín, puerto, esquema, caducadas, cookie de dominio padre), el write-back de una sesión exclusiva, la
// config v2 (`resources.browser`, `providers`), odysea por su cli (con un binario falso), la salud, el esqueleto del
// proveedor, la cli `browser` y el deny del vault (sin navegador, el de siempre).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { configPath, loadConfigV2, saveConfigV2 } from '../src/config.js';
import { KeyedMutex } from '../src/keyed-mutex.js';
import { defaultBrowserVaultPath, runConfigDir } from '../src/paths.js';
import { browserCommand } from '../src/browser-cli.js';
import { resourceCommand } from '../src/resource.js';
import { parseBrowserRef, vaultFileOf, type BrowserRef } from '../src/resources/browser/config.js';
import { BROWSER_HEALTH, browserHealth, PROBE_INTERVAL_MS, PROBE_MODE, probeDue, stateHealth } from '../src/resources/browser/health.js';
import { detectOdysea, findOdysea, odyseaProbe, versionAtLeast } from '../src/resources/browser/odysea-cli.js';
import { cookieAllowed, originAllowed, parseOriginPattern } from '../src/resources/browser/origins.js';
import {
  BROWSER_DENIED_TOOLS,
  BROWSER_TOOLS,
  browserLockKey,
  browserMcpServer,
  browserServerName,
  clearRunBrowserCopies,
  dropCopy,
  materializeCopy,
  writeBack,
} from '../src/resources/browser/provider.js';
import { filterState, mergeBack, parseStorageState, type StateCookie, type StorageState } from '../src/resources/browser/state-filter.js';
import { browserVaultDeny, secretPathsDeny } from '../src/secret-paths.js';
import { LEGACY_PLATFORM_ID } from '../src/paths.js';

const NOW_MS = Date.UTC(2026, 9, 20);
const NOW_S = NOW_MS / 1000;
const DAY_S = 86_400;
let root = '';
let dir = '';
let bin = '';
const savedPath = process.env.PATH;

const cookie = (domain: string, extra: Partial<StateCookie> = {}): StateCookie => ({ name: `c-${domain}`, value: 'v', domain, path: '/', expires: -1, ...extra });
const state = (cookies: StateCookie[], origins: string[] = []): StorageState => ({ cookies, origins: origins.map((origin) => ({ origin, localStorage: [{ name: 'k', value: 'v' }] })) });
const patterns = (...raw: string[]) => raw.map(parseOriginPattern);

// odysea falso: --version, login (escribe FAKE_ODYSEA_LOGIN_STATE en el state file) y probe (imprime FAKE_ODYSEA_PROBE_OUT).
const FAKE_ODYSEA = `#!/bin/sh
case "$1" in
  --version) echo "\${FAKE_ODYSEA_VERSION:-0.5.0}" ;;
  login) [ -n "$FAKE_ODYSEA_LOGIN_STATE" ] && printf '%s' "$FAKE_ODYSEA_LOGIN_STATE" > "$3"; exit "\${FAKE_ODYSEA_LOGIN_EXIT:-0}" ;;
  probe) [ -n "$FAKE_ODYSEA_PROBE_SEEN" ] && cat "$3" > "$FAKE_ODYSEA_PROBE_SEEN"; echo "$FAKE_ODYSEA_PROBE_OUT"; exit "\${FAKE_ODYSEA_PROBE_EXIT:-0}" ;;
esac
`;
const FAKE_ENV = ['FAKE_ODYSEA_VERSION', 'FAKE_ODYSEA_LOGIN_STATE', 'FAKE_ODYSEA_LOGIN_EXIT', 'FAKE_ODYSEA_PROBE_SEEN', 'FAKE_ODYSEA_PROBE_OUT', 'FAKE_ODYSEA_PROBE_EXIT'];

// salida de un comando de la cli (log + error) y su exit code.
async function cli(t: { mock: { method: typeof import('node:test').mock.method } }, run: () => Promise<void> | void): Promise<{ out: string; code: number }> {
  const out: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => out.push(a.join(' ')));
  t.mock.method(console, 'warn', (...a: unknown[]) => out.push(a.join(' ')));
  t.mock.method(console, 'error', (...a: unknown[]) => out.push(a.join(' ')));
  process.exitCode = undefined;
  await run();
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out: out.join('\n'), code };
}

const writeConfig = (cfg: object): void => fs.writeFileSync(configPath(), `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
const ref: BrowserRef = { session: 'jira', origins: ['https://acme.atlassian.net', 'https://id.atlassian.com'] };

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-browser-'));
  const binDir = path.join(root, 'bin');
  fs.mkdirSync(binDir);
  bin = path.join(binDir, 'odysea');
  fs.writeFileSync(bin, FAKE_ODYSEA, { mode: 0o755 });
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  process.env.PATH = `${path.dirname(bin)}${path.delimiter}${savedPath}`;
  writeConfig({ baseUrl: 'https://duckhunt.test', clientId: 'c1', refreshToken: 'r1', repos: {}, aws: {}, defaults: {} });
});

afterEach(() => {
  FAKE_ENV.forEach((k) => delete process.env[k]);
  process.env.PATH = savedPath;
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('patrones de origen: la sintaxis de odysea, comodín con dos etiquetas y el puerto del esquema', () => {
  assert.deepEqual(parseOriginPattern('HTTPS://Acme.Atlassian.net:443'), { scheme: 'https:', host: 'acme.atlassian.net', wildcard: false, port: '' });
  assert.deepEqual(parseOriginPattern('http://localhost:5173'), { scheme: 'http:', host: 'localhost', wildcard: false, port: '5173' });
  assert.equal(parseOriginPattern('https://*.atlassian.net').wildcard, true);
  assert.throws(() => parseOriginPattern('https://*.net'), /demasiado amplio/);
  assert.throws(() => parseOriginPattern('ftp://x.com'), /no válido/);
  assert.throws(() => parseOriginPattern('https://x.com/path'), /no válido/);
  assert.throws(() => parseOriginPattern('https://x.com:70000'), /puerto/);
  const p = patterns('https://acme.atlassian.net', 'https://*.example.com', 'http://localhost:5173');
  assert.equal(originAllowed('https://acme.atlassian.net', p), true);
  assert.equal(originAllowed('https://acme.atlassian.net:443', p), true, 'el puerto por defecto es el mismo origen');
  assert.equal(originAllowed('http://acme.atlassian.net', p), false, 'otro esquema');
  assert.equal(originAllowed('https://acme.atlassian.net:8443', p), false, 'otro puerto');
  assert.equal(originAllowed('https://other.atlassian.net', p), false, 'un hermano');
  assert.equal(originAllowed('https://a.b.example.com', p), true, 'comodín: cualquier subdominio');
  assert.equal(originAllowed('https://example.com', p), false, 'comodín: nunca el apex');
  assert.equal(originAllowed('http://localhost:5173', p), true);
  assert.equal(originAllowed('http://localhost:5174', p), false);
});

test('cookies de la copia: dentro del host, de dominio padre, nunca de hermanos', () => {
  const exact = patterns('https://acme.atlassian.net');
  const table: [string, boolean, string][] = [
    ['acme.atlassian.net', true, 'el host'],
    ['.acme.atlassian.net', true, 'cookie de dominio del host'],
    ['eu.acme.atlassian.net', true, 'un subdominio del host'],
    ['.atlassian.net', true, 'cookie de dominio de un padre: también va al host'],
    ['atlassian.net', false, 'cookie de host del padre: no va al host'],
    ['other.atlassian.net', false, 'un hermano'],
    ['.other.atlassian.net', false, 'cookie de dominio de un hermano'],
    ['evil.com', false, 'otro dominio'],
  ];
  table.forEach(([domain, kept, why]) => assert.equal(cookieAllowed(domain, exact), kept, why));
  const wild = patterns('https://*.example.com');
  assert.equal(cookieAllowed('a.example.com', wild), true, 'comodín: un subdominio');
  assert.equal(cookieAllowed('example.com', wild), false, 'comodín: la de host del apex no');
  assert.equal(cookieAllowed('.example.com', wild), true, 'comodín: la de dominio del apex va a sus subdominios');
});

test('copia filtrada: sin caducadas, orígenes exactos; el write-back solo toca la allowlist', () => {
  const p = patterns('https://acme.atlassian.net');
  const vault = state(
    [cookie('acme.atlassian.net', { name: 'sid', value: 'viejo' }), cookie('.atlassian.net', { name: 'old', expires: NOW_S - DAY_S }), cookie('github.com', { name: 'gh' })],
    ['https://acme.atlassian.net', 'http://acme.atlassian.net', 'https://github.com'],
  );
  const copy = filterState(vault, p, NOW_MS);
  assert.deepEqual(copy.cookies.map((c) => c.name), ['sid'], 'ni la caducada ni la de otro sitio');
  assert.deepEqual(copy.origins.map((o) => o.origin), ['https://acme.atlassian.net'], 'solo el origen exacto (esquema incluido)');
  const run = state([cookie('acme.atlassian.net', { name: 'sid', value: 'rotado' }), cookie('tracker.io', { name: 'tr' })], ['https://acme.atlassian.net', 'https://tracker.io']);
  const merged = mergeBack(vault, run, p, NOW_MS);
  assert.deepEqual(merged.cookies.map((c) => `${c.name}=${c.value}`).sort(), ['gh=v', 'sid=rotado'], 'lo de github se queda, el sid rotado entra, lo de tracker.io nunca');
  assert.deepEqual(merged.origins.map((o) => o.origin).sort(), ['http://acme.atlassian.net', 'https://acme.atlassian.net', 'https://github.com']);
  assert.throws(() => parseStorageState('{"cookies":[{"name":1}],"origins":[]}'), /cookie/);
  assert.throws(() => parseStorageState('[]'), /storage state/);
});

test('config: la entrada y providers se validan y sobreviven a una escritura v2', () => {
  assert.deepEqual(parseBrowserRef('jira', { session: 'jira', origins: ['https://x.com'], exclusive: true, probe: { url: 'https://x.com/me', loginPattern: '/login' } }, 'w'), {
    session: 'jira',
    origins: ['https://x.com'],
    exclusive: true,
    probe: { url: 'https://x.com/me', loginPattern: '/login' },
  });
  const bad: [string, unknown, RegExp][] = [
    ['Jira', { session: 'j', origins: ['https://x.com'] }, /clave/],
    ['a'.repeat(17), { session: 'j', origins: ['https://x.com'] }, /clave/],
    ['jira', { session: '../x', origins: ['https://x.com'] }, /session/],
    ['jira', { session: 'j', origins: [] }, /origins/],
    ['jira', { session: 'j', origins: ['https://*.net'] }, /amplio/],
    ['jira', { session: 'j', origins: ['https://x.com'], probe: { url: 'file:///etc/passwd' } }, /probe\.url/],
    ['jira', { session: 'j', origins: ['https://x.com'], probe: { url: 'https://x.com', loginPattern: '(' } }, /regex/],
  ];
  bad.forEach(([key, raw, re]) => assert.throws(() => parseBrowserRef(key, raw, 'w'), re));
  saveConfigV2((cfg) => ({ ...cfg, resources: { ...cfg.resources, browser: { jira: ref } }, providers: { browser: { bin } } }));
  const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;
  assert.equal(raw.version, 2);
  assert.deepEqual(raw.resources, { browser: { jira: ref } });
  assert.deepEqual(raw.providers, { browser: { bin } });
  assert.deepEqual(loadConfigV2()!.resources.browser, { jira: ref });
  writeConfig({ ...raw, resources: { browser: { jira: { session: 'jira', origins: ['nope'] } } } });
  assert.throws(() => loadConfigV2(), /config v2 inválida: resources\.browser\.jira\.origins/);
  writeConfig({ ...raw, providers: { browser: { bin: 'relativo' } } });
  assert.throws(() => loadConfigV2(), /providers\.browser\.bin/);
});

test('odysea por su cli: el binario del PATH o el de la config, su versión y el json del probe', async () => {
  assert.equal(findOdysea(undefined), bin);
  assert.equal(findOdysea(bin), bin);
  assert.equal(findOdysea(path.join(dir, 'no-existe')), null);
  assert.equal(findOdysea(undefined, { PATH: dir }), null);
  assert.equal(versionAtLeast('0.5.0', '0.5.0'), true);
  assert.equal(versionAtLeast('0.10.1', '0.5.0'), true);
  assert.equal(versionAtLeast('0.4.9', '0.5.0'), false);
  assert.equal(versionAtLeast('1.0.0\n', '0.5.0'), true);
  assert.equal(versionAtLeast('nope', '0.5.0'), false);
  assert.deepEqual(await detectOdysea(undefined), { ok: true, info: { bin, version: '0.5.0' } });
  process.env.FAKE_ODYSEA_VERSION = '0.4.0';
  const old = await detectOdysea(undefined);
  assert.equal(old.ok, false);
  assert.match(old.ok ? '' : old.reason, /0\.5\.0 o posterior/);
  assert.match((await detectOdysea(undefined, { PATH: dir })).ok ? '' : 'sin', /sin/);
  process.env.FAKE_ODYSEA_PROBE_OUT = JSON.stringify({ ok: true, status: 200, finalUrl: 'https://x.com/login?t=1', loggedOut: true, reason: 'redirected to login' });
  assert.equal((await odyseaProbe(bin, '/tmp/x.json', 'https://x.com')).loggedOut, true);
  process.env.FAKE_ODYSEA_PROBE_OUT = JSON.stringify({ ok: false, status: null, finalUrl: null, loggedOut: false, reason: 'state file x not found' });
  process.env.FAKE_ODYSEA_PROBE_EXIT = '1';
  assert.deepEqual(await odyseaProbe(bin, '/tmp/x.json', 'https://x.com'), { ok: false, status: null, finalUrl: null, loggedOut: false, reason: 'state file x not found' });
  process.env.FAKE_ODYSEA_PROBE_OUT = 'no es json';
  assert.equal((await odyseaProbe(bin, '/tmp/x.json', 'https://x.com')).ok, false);
});

test('salud: missing, invalid y expired por el json; logged_out por el probe, como mucho una vez al día', async () => {
  assert.equal(stateHealth('jira', ref, null, NOW_MS).findings[0]?.kind, BROWSER_HEALTH.missing);
  assert.equal(stateHealth('jira', ref, '{', NOW_MS).findings[0]?.kind, BROWSER_HEALTH.invalid);
  const expired = JSON.stringify(state([cookie('acme.atlassian.net', { expires: NOW_S - 1 }), cookie('github.com')]));
  assert.equal(stateHealth('jira', ref, expired, NOW_MS).findings[0]?.kind, BROWSER_HEALTH.expired, 'las de la allowlist caducaron (la de github no cuenta)');
  const alive = JSON.stringify(state([cookie('acme.atlassian.net', { expires: NOW_S + DAY_S }), cookie('acme.atlassian.net', { name: 'x', expires: NOW_S - 1 })]));
  assert.deepEqual(stateHealth('jira', ref, alive, NOW_MS).findings, [], 'con una viva basta');
  assert.equal(probeDue(undefined, NOW_MS, PROBE_MODE.due), true);
  assert.equal(probeDue(NOW_MS - PROBE_INTERVAL_MS + 1, NOW_MS, PROBE_MODE.due), false);
  assert.equal(probeDue(NOW_MS - PROBE_INTERVAL_MS, NOW_MS, PROBE_MODE.due), true);
  assert.equal(probeDue(NOW_MS, NOW_MS, PROBE_MODE.force), true);
  assert.equal(probeDue(undefined, NOW_MS, PROBE_MODE.never), false);

  const vaultDir = path.join(dir, 'vault');
  fs.mkdirSync(vaultDir, { mode: 0o700 });
  fs.writeFileSync(vaultFileOf(vaultDir, 'jira'), JSON.stringify(state([cookie('acme.atlassian.net'), cookie('github.com', { name: 'gh' })])), { mode: 0o600 });
  const probed = { ...ref, probe: { url: 'https://acme.atlassian.net/rest/me' } };
  const seen = path.join(dir, 'seen.json');
  process.env.FAKE_ODYSEA_PROBE_SEEN = seen;
  process.env.FAKE_ODYSEA_PROBE_OUT = JSON.stringify({ ok: true, status: 401, finalUrl: null, loggedOut: true, reason: 'http 401' });
  const odysea = await detectOdysea(undefined);
  const lastProbe = new Map<string, number>();
  const input = { entries: { jira: probed }, vaultDir, odysea, probe: PROBE_MODE.due, lastProbe, nowMs: NOW_MS };
  assert.deepEqual((await browserHealth(input)).map((f) => f.kind), [BROWSER_HEALTH.loggedOut]);
  assert.deepEqual((JSON.parse(fs.readFileSync(seen, 'utf-8')) as StorageState).cookies.map((c) => c.name), ['c-acme.atlassian.net'], 'el probe ve la copia filtrada, no el vault');
  assert.deepEqual(fs.readdirSync(vaultDir), ['jira.json'], 'la copia del probe se borra');
  fs.rmSync(seen);
  assert.deepEqual(await browserHealth(input), [], 'antes de 24 h no se vuelve a probar');
  assert.equal(fs.existsSync(seen), false);
  process.env.FAKE_ODYSEA_PROBE_EXIT = '1';
  process.env.FAKE_ODYSEA_PROBE_OUT = 'roto';
  assert.deepEqual((await browserHealth({ ...input, probe: PROBE_MODE.force })).map((f) => f.kind), [BROWSER_HEALTH.unverifiable]);
  const missingTool = await browserHealth({ ...input, odysea: { ok: false, reason: 'sin odysea' } });
  assert.deepEqual(missingTool.map((f) => f.kind), [BROWSER_HEALTH.toolMissing]);
});

test('proveedor: tools por nivel sin `session`, turno solo si es exclusiva, copia 0600 en el run-config y write-back', async () => {
  assert.ok(BROWSER_TOOLS.read.every((t) => BROWSER_TOOLS.interact.includes(t)) && BROWSER_TOOLS.interact.every((t) => BROWSER_TOOLS.full.includes(t)), 'acumulativas');
  assert.deepEqual(BROWSER_TOOLS.interact.filter((t) => !BROWSER_TOOLS.read.includes(t)), ['click', 'fill', 'press_key', 'select_option', 'handle_dialog']);
  assert.deepEqual(BROWSER_TOOLS.full.filter((t) => !BROWSER_TOOLS.interact.includes(t)), ['evaluate', 'network_details']);
  assert.ok(Object.values(BROWSER_TOOLS).every((tools) => BROWSER_DENIED_TOOLS.every((t) => !tools.includes(t))));
  const longest = Math.max(...BROWSER_TOOLS.full.map((t) => `mcp__${browserServerName('a'.repeat(16))}__${t}`.length));
  assert.ok(longest <= 64, `el nombre de tool más largo cabe en 64 (${longest})`);
  assert.equal(browserLockKey('jira', ref), null);
  assert.equal(browserLockKey('jira', { ...ref, exclusive: true }), 'browser:jira');

  const vaultFile = path.join(dir, 'jira.json');
  fs.writeFileSync(vaultFile, JSON.stringify(state([cookie('acme.atlassian.net', { name: 'sid' }), cookie('github.com', { name: 'gh' })])), { mode: 0o600 });
  const copy = materializeCopy(LEGACY_PLATFORM_ID, '42', vaultFile, ref, NOW_MS);
  assert.equal(path.dirname(copy.dir), runConfigDir(LEGACY_PLATFORM_ID));
  assert.equal(fs.statSync(copy.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(copy.stateFile).mode & 0o777, 0o600);
  assert.deepEqual(parseStorageState(fs.readFileSync(copy.stateFile, 'utf-8')).cookies.map((c) => c.name), ['sid']);
  const server = browserMcpServer(bin, copy, ref);
  assert.deepEqual(server, {
    type: 'stdio',
    command: bin,
    args: [],
    env: { ODYSEA_STATE_FILE: copy.stateFile, ODYSEA_ALLOWED_ORIGINS: 'https://acme.atlassian.net,https://id.atlassian.com', ODYSEA_SESSION_TOOL: '0' },
  });
  assert.equal(browserMcpServer(bin, copy, { ...ref, exclusive: true }).env.ODYSEA_AUTOSAVE_MS, '30000', 'exclusiva: autosave');
  fs.writeFileSync(copy.stateFile, JSON.stringify(state([cookie('acme.atlassian.net', { name: 'sid', value: 'rotado' }), cookie('evil.com', { name: 'ev' })])));
  await writeBack(vaultFile, copy, ref, new KeyedMutex(), NOW_MS);
  assert.deepEqual(parseStorageState(fs.readFileSync(vaultFile, 'utf-8')).cookies.map((c) => `${c.name}=${c.value}`).sort(), ['gh=v', 'sid=rotado']);
  assert.equal(fs.statSync(vaultFile).mode & 0o777, 0o600);
  const stale = materializeCopy(LEGACY_PLATFORM_ID, '43', vaultFile, ref, NOW_MS);
  dropCopy(copy);
  assert.equal(fs.existsSync(copy.dir), false);
  assert.equal(clearRunBrowserCopies(LEGACY_PLATFORM_ID), 1);
  assert.equal(fs.existsSync(stale.dir), false);
  assert.throws(() => materializeCopy(LEGACY_PLATFORM_ID, '44', path.join(dir, 'nada.json'), ref, NOW_MS), /ENOENT/);
});

test('cli: login guarda la entrada tras el login de odysea; list, check, remove --purge y `resource … browser`', async (t) => {
  process.env.FAKE_ODYSEA_LOGIN_STATE = JSON.stringify(state([cookie('acme.atlassian.net', { name: 'sid' })]));
  const added = await cli(t, () => browserCommand(['login', 'jira', 'https://acme.atlassian.net/jira']));
  assert.equal(added.code, 0, added.out);
  assert.match(added.out, /añadida la sesión de navegador/);
  assert.match(added.out, /platforms expose <id> browser jira/);
  assert.deepEqual(loadConfigV2()!.resources.browser, { jira: { session: 'jira', origins: ['https://acme.atlassian.net'] } }, 'sin --origin, el de la url');
  const vault = defaultBrowserVaultPath();
  assert.equal(fs.statSync(vault).mode & 0o777, 0o700);
  assert.ok(fs.existsSync(path.join(vault, 'jira.json')));

  const updated = await cli(t, () =>
    browserCommand(['login', 'jira', 'https://acme.atlassian.net', '--origin', 'https://acme.atlassian.net', '--origin', 'https://id.atlassian.com', '--exclusive']),
  );
  assert.match(updated.out, /actualizada/);
  assert.deepEqual(loadConfigV2()!.resources.browser!.jira, { session: 'jira', origins: ['https://acme.atlassian.net', 'https://id.atlassian.com'], exclusive: true });

  delete process.env.FAKE_ODYSEA_LOGIN_STATE;
  process.env.FAKE_ODYSEA_LOGIN_EXIT = '3';
  const aborted = await cli(t, () => browserCommand(['login', 'gh', 'https://github.com']));
  assert.equal(aborted.code, 1);
  assert.match(aborted.out, /no guardó la sesión/);
  assert.equal(loadConfigV2()!.resources.browser!.gh, undefined, 'sin sesión guardada no hay entrada');
  delete process.env.FAKE_ODYSEA_LOGIN_EXIT;

  assert.equal((await cli(t, () => browserCommand(['login', 'Mal', 'https://x.com']))).code, 1);
  assert.equal((await cli(t, () => browserCommand(['login', 'x', 'file:///etc']))).code, 1);
  assert.equal((await cli(t, () => browserCommand(['login', 'x', 'https://x.com', '--origin', 'https://*.com']))).code, 1);

  const listed = await cli(t, () => browserCommand(['list']));
  assert.match(listed.out, /jira → sesión jira · https:\/\/acme\.atlassian\.net, https:\/\/id\.atlassian\.com · exclusiva/);
  assert.equal((await cli(t, () => browserCommand(['check']))).code, 0);
  fs.rmSync(path.join(vault, 'jira.json'));
  const broken = await cli(t, () => resourceCommand(['check', 'browser']));
  assert.equal(broken.code, 1);
  assert.match(broken.out, /missing/);

  saveConfigV2((cfg) => ({ ...cfg, resources: { ...cfg.resources, browser: { ...cfg.resources.browser, wiki: { session: 'jira', origins: ['https://acme.atlassian.net'] } } } }));
  fs.writeFileSync(path.join(vault, 'jira.json'), '{"cookies":[],"origins":[]}', { mode: 0o600 });
  const kept = await cli(t, () => browserCommand(['remove', 'jira', '--purge']));
  assert.match(kept.out, /otra clave lo usa/);
  assert.ok(fs.existsSync(path.join(vault, 'jira.json')));
  const purged = await cli(t, () => resourceCommand(['remove', 'browser', 'wiki', '--purge']));
  assert.match(purged.out, /borrado el fichero/);
  assert.equal(fs.existsSync(path.join(vault, 'jira.json')), false);
  assert.deepEqual(loadConfigV2()!.resources.browser ?? {}, {});
  assert.equal((await cli(t, () => browserCommand(['remove', 'nada']))).code, 1);
  assert.equal((await cli(t, () => browserCommand(['otro']))).code, 1);
});

test('`resource list` y `check` sin tipo: browser solo si hay sesiones', async (t) => {
  const before = await cli(t, () => resourceCommand(['list']));
  assert.doesNotMatch(before.out, /browser/);
  const checked = await cli(t, () => resourceCommand(['check']));
  assert.doesNotMatch(checked.out, /browser/);
  saveConfigV2((cfg) => ({ ...cfg, resources: { ...cfg.resources, browser: { jira: ref } } }));
  const after = await cli(t, () => resourceCommand(['list']));
  assert.match(after.out, /^browser:$/m);
});

test('deny del vault: sin navegador, el de siempre; con sesiones, el vault (y uno en otra ruta, detrás de todo)', () => {
  const home = path.join(dir, 'user-home');
  const baseline = secretPathsDeny({}, home).rules;
  assert.deepEqual(browserVaultDeny(), [], 'sin navegador nada');
  const vaultDir = path.join(dir, 'otra-ruta', 'vault');
  saveConfigV2((cfg) => ({ ...cfg, resources: { ...cfg.resources, browser: { jira: ref } }, providers: { browser: { vaultDir } } }));
  const rule = `Read(/${vaultDir}/**)`;
  assert.deepEqual(browserVaultDeny(), [rule]);
  const withVault = secretPathsDeny({}, home).rules;
  assert.deepEqual(withVault.slice(0, baseline.length), baseline, 'lo de siempre, en el mismo orden');
  assert.deepEqual(withVault.slice(baseline.length), [rule]);
  saveConfigV2((cfg) => ({ ...cfg, resources: { ...cfg.resources, browser: {} }, providers: {} }));
  assert.deepEqual(secretPathsDeny({}, home).rules, baseline);
  fs.mkdirSync(defaultBrowserVaultPath(), { recursive: true });
  assert.ok(secretPathsDeny({}, home).rules.includes(`Read(/${defaultBrowserVaultPath()}/**)`), 'el de por defecto, en cuanto existe');
});
