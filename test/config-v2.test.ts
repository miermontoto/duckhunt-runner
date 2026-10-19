// config v2 (t#495, M2) sobre el mismo fichero: fromLegacy (la legacy con lo de siempre, nunca aws.default), una
// config de siempre que no cambia ni un byte, lo solo-v2 aparte (y lo que un lector v1 sigue viendo), la rotación
// del refresh token de un daemon ≤ 0.12 que el modelo v2 ve al instante, lo que pierde un daemon anterior a 0.10.1,
// claves desconocidas que sobreviven, partes v2 inválidas y la cli `resource` con `repos`/`aws` como sus tipos.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { CONFIG_VERSION, configPath, loadConfigV2, loadStoredConfig, parseConfig, saveConfig, saveConfigV2, type RunnerConfig } from '../src/config.js';
import { fromLegacy } from '../src/config-legacy.js';
import { LEGACY_PLATFORM_ID } from '../src/paths.js';
import { LEGACY_CEILING, LEGACY_EXPOSE, SHELL } from '../src/platforms/types.js';
import { resourceCommand } from '../src/resource.js';
import { reposCommand } from '../src/repos.js';
import { awsCommand } from '../src/aws.js';

const ACCOUNT = '123456789012';
let root = '';
let dir = '';

const v1: RunnerConfig = {
  baseUrl: 'https://duckhunt.test',
  clientId: 'c1',
  refreshToken: 'r1',
  label: 'fa',
  machineId: '6f1d7c1e-5b0a-4c34-9b8e-2a3f7c1d9e01',
  machineHost: 'fa',
  repos: { 'acme/api': { path: '/dev/api' } },
  aws: { [ACCOUNT]: { profile: 'prod', region: 'eu-west-1' } },
  defaults: { maxConcurrent: 2 },
};
const writeText = (text: string): void => fs.writeFileSync(configPath(), text, { mode: 0o600 });
const writeJson = (cfg: object): void => writeText(`${JSON.stringify(cfg, null, 2)}\n`);
const readJson = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown>;

// salida de un comando de la cli (log + error) y su exit code.
async function cli(t: { mock: { method: typeof import('node:test').mock.method } }, run: () => Promise<void> | void): Promise<{ out: string[]; code: number }> {
  const out: string[] = [];
  t.mock.method(console, 'log', (...a: unknown[]) => out.push(a.join(' ')));
  t.mock.method(console, 'warn', (...a: unknown[]) => out.push(a.join(' ')));
  t.mock.method(console, 'error', (...a: unknown[]) => out.push(a.join(' ')));
  process.exitCode = undefined;
  await run();
  const code = Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return { out, code };
}

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-config-v2-'));
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  writeJson(v1);
});

afterEach(() => {
  process.exitCode = undefined;
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('fromLegacy: la legacy con su credencial, todo expuesto y el techo de hoy; repos y aws tal cual, nunca aws.default', () => {
  const cfg = fromLegacy(v1 as unknown as Record<string, unknown>);
  assert.equal(cfg.version, CONFIG_VERSION);
  assert.deepEqual(cfg.platforms[LEGACY_PLATFORM_ID], {
    credential: { baseUrl: v1.baseUrl, clientId: 'c1', refreshToken: 'r1' },
    trusted: true,
    expose: LEGACY_EXPOSE,
    ceiling: LEGACY_CEILING,
  });
  assert.deepEqual(cfg.resources, { repo: v1.repos, aws: v1.aws });
  assert.equal(Object.hasOwn(cfg.resources.aws!, 'default'), false, 'la identidad por defecto la expone el usuario');
  assert.equal(Object.hasOwn(fromLegacy({}).resources.aws!, 'default'), false);
  assert.equal(fromLegacy({ baseUrl: v1.baseUrl }).platforms[LEGACY_PLATFORM_ID]!.credential, undefined, 'tras logout: sin credencial');
  assert.equal(LEGACY_CEILING.shell, SHELL.full);
});

test('una config de siempre pasa por el modelo v2 sin cambiar ni un byte', () => {
  const text = `${JSON.stringify(v1, null, 2)}\n`;
  writeText(text);
  saveConfigV2((cfg) => ({ ...cfg }));
  assert.equal(fs.readFileSync(configPath(), 'utf-8'), text, 'sin cambios no se escribe');
  saveConfigV2((cfg) => ({ ...cfg, label: 'fa' }));
  assert.equal(fs.readFileSync(configPath(), 'utf-8'), text, 'mismo valor, nada que escribir');
  assert.equal(readJson().version, undefined, 'sin parte v2 no hay `version`');
});

test('lo solo-v2 va aparte, y un lector v1 (≤ 0.12) sigue viendo su credencial, sus mapas y sus defaults', () => {
  const acme = { baseUrl: 'https://acme.test', clientId: 'a1', refreshToken: 'ar1' };
  saveConfigV2((cfg) => ({
    ...cfg,
    platforms: {
      ...cfg.platforms,
      [LEGACY_PLATFORM_ID]: { ...cfg.platforms[LEGACY_PLATFORM_ID]!, expose: { repo: ['acme/api'] } },
      acme: { credential: acme, trusted: false, expose: {}, ceiling: { ...LEGACY_CEILING, shell: SHELL.read, access: {} } },
    },
  }));
  const raw = readJson();
  assert.equal(raw.version, CONFIG_VERSION);
  assert.deepEqual(Object.keys(raw.platforms as object), [LEGACY_PLATFORM_ID, 'acme']);
  assert.equal((raw.platforms as Record<string, { credential?: unknown }>)[LEGACY_PLATFORM_ID]!.credential, undefined, 'la de duckhunt sigue arriba, sin copia');
  assert.deepEqual((raw.platforms as Record<string, { credential?: unknown }>).acme!.credential, acme);
  const reader = parseConfig(fs.readFileSync(configPath(), 'utf-8'));
  assert.deepEqual(
    [reader.baseUrl, reader.clientId, reader.refreshToken, reader.repos, reader.aws, reader.defaults],
    [v1.baseUrl, 'c1', 'r1', v1.repos, v1.aws, v1.defaults],
  );
  const back = loadConfigV2()!;
  assert.deepEqual(back.platforms[LEGACY_PLATFORM_ID]!.expose, { repo: ['acme/api'] });
  assert.deepEqual(back.platforms.acme!.credential, acme);
});

test('el refresh rotado por un daemon ≤ 0.12 sobre un fichero v2: el modelo v2 lo ve al instante y conserva lo suyo', () => {
  saveConfigV2((cfg) => ({ ...cfg, platforms: { ...cfg.platforms, [LEGACY_PLATFORM_ID]: { ...cfg.platforms[LEGACY_PLATFORM_ID]!, expose: { repo: [] } } } }));
  // lo que escribe el refresh de un daemon 0.10.1–0.12: solo su clave, sobre el fichero de ahora.
  saveConfig((current) => (current.clientId === 'c1' ? { refreshToken: 'r2' } : null));
  const cfg = loadConfigV2()!;
  assert.equal(cfg.platforms[LEGACY_PLATFORM_ID]!.credential?.refreshToken, 'r2', 'un único refresh token, nunca uno ya rotado');
  assert.deepEqual(cfg.platforms[LEGACY_PLATFORM_ID]!.expose, { repo: [] });
  // y al revés: lo que rota el modelo v2 es lo que lee un daemon ≤ 0.12.
  saveConfigV2((c) => ({
    ...c,
    platforms: { ...c.platforms, [LEGACY_PLATFORM_ID]: { ...c.platforms[LEGACY_PLATFORM_ID]!, credential: { ...c.platforms[LEGACY_PLATFORM_ID]!.credential!, refreshToken: 'r3' } } },
  }));
  assert.equal(parseConfig(fs.readFileSync(configPath(), 'utf-8')).refreshToken, 'r3');
  assert.equal(readJson().refreshToken, 'r3');
});

test('un daemon anterior a 0.10.1 reescribe el fichero entero: lo solo-v2 se pierde y la legacy vuelve a sus valores por defecto', () => {
  saveConfigV2((cfg) => ({ ...cfg, platforms: { ...cfg.platforms, [LEGACY_PLATFORM_ID]: { ...cfg.platforms[LEGACY_PLATFORM_ID]!, expose: {} } } }));
  const { version: _, platforms: __, ...old } = readJson();
  writeJson({ ...old, refreshToken: 'r9' });
  const cfg = loadConfigV2()!;
  assert.deepEqual(cfg.platforms[LEGACY_PLATFORM_ID]!.expose, LEGACY_EXPOSE);
  assert.equal(cfg.platforms[LEGACY_PLATFORM_ID]!.credential?.refreshToken, 'r9');
});

test('claves desconocidas sobreviven a las escrituras v1 y v2', () => {
  writeJson({ ...v1, futureKey: { a: 1 }, defaults: { ...v1.defaults, futureDefault: true } });
  saveConfigV2((cfg) => ({ ...cfg, platforms: { ...cfg.platforms, [LEGACY_PLATFORM_ID]: { ...cfg.platforms[LEGACY_PLATFORM_ID]!, trusted: false, ceiling: { ...LEGACY_CEILING, shell: SHELL.read } } } }));
  saveConfig(() => ({ label: 'otra' }));
  const raw = readJson();
  assert.deepEqual(raw.futureKey, { a: 1 });
  assert.equal((raw.defaults as Record<string, unknown>).futureDefault, true);
  assert.equal(raw.label, 'otra');
  assert.equal(loadConfigV2()!.platforms[LEGACY_PLATFORM_ID]!.trusted, false);
});

test('partes v2 inválidas o de otra versión: no se leen', () => {
  const v2 = (extra: object): void => writeJson({ ...v1, version: CONFIG_VERSION, ...extra });
  v2({ platforms: { acme: { trusted: false, ceiling: { shell: SHELL.full } } } });
  assert.throws(() => loadConfigV2(), /shell 'full' solo en una plataforma trusted/);
  v2({ platforms: { [LEGACY_PLATFORM_ID]: { trusted: false } } });
  assert.throws(() => loadConfigV2(), /shell 'full' solo en una plataforma trusted/, 'quitarle trusted a la legacy exige bajarle la shell');
  v2({ resources: { repo: {} } });
  assert.throws(() => loadConfigV2(), /resources\.repo: vive en repos/);
  v2({ platforms: { 'No-Valido': {} } });
  assert.throws(() => loadConfigV2(), /id de plataforma no válido/);
  v2({ platforms: { [LEGACY_PLATFORM_ID]: { credential: { baseUrl: 'x', clientId: 'y', refreshToken: 'z' } } } });
  assert.throws(() => loadConfigV2(), /vive en baseUrl\/clientId\/refreshToken/);
  v2({ platforms: { acme: { ceiling: { access: { repo: 'todo' } } } } });
  assert.throws(() => loadConfigV2(), /access/);
  writeJson({ ...v1, version: CONFIG_VERSION + 1 });
  assert.throws(() => loadConfigV2(), /de otra versión/);
  assert.throws(() => loadStoredConfig(), /de otra versión/, 'tampoco por la vista v1');
  v2({ platforms: { acme: { credential: { baseUrl: 'https://acme.test', clientId: 'a1', refreshToken: 'ar1' } } } });
  const acme = loadConfigV2()!.platforms.acme!;
  assert.deepEqual([acme.trusted, acme.expose, acme.ceiling.shell], [false, {}, SHELL.none], 'una plataforma nueva arranca sin nada');
});

test('resource: repos y aws son sus tipos, con la misma salida y el mismo exit code', async (t) => {
  const checkout = path.join(dir, 'app');
  fs.mkdirSync(checkout);
  const viaRepos = await cli(t, () => reposCommand(['add', 'acme/app', checkout]));
  writeJson(v1);
  const viaResource = await cli(t, () => resourceCommand(['add', 'repo', 'acme/app', checkout]));
  assert.deepEqual(viaResource, viaRepos);
  assert.equal(loadStoredConfig()!.repos['acme/app']?.path, checkout);
  const removed = await cli(t, () => resourceCommand(['remove', 'aws', ACCOUNT]));
  assert.deepEqual(removed, { out: [`eliminada la cuenta ${ACCOUNT}`], code: 0 });
  const missing = await cli(t, () => resourceCommand(['remove', 'aws', ACCOUNT]));
  assert.deepEqual(missing, { out: [`cuenta no mapeada: ${ACCOUNT}`], code: 1 });
});

test('resource add aws default: la identidad por defecto se expone a mano (y `aws add` sigue pidiendo una cuenta)', async (t) => {
  const old = await cli(t, () => awsCommand(['add', 'default', 'personal']));
  assert.deepEqual(old, { out: ['id de cuenta inválido: "default" (12 dígitos)'], code: 1 });
  const added = await cli(t, () => resourceCommand(['add', 'aws', 'default', 'personal']));
  assert.equal(added.code, 0);
  assert.deepEqual(loadStoredConfig()!.aws.default, { profile: 'personal' });
  const bad = await cli(t, () => resourceCommand(['add', 'aws', 'otra', 'x']));
  assert.deepEqual(bad, { out: ['id de cuenta inválido: "otra" (12 dígitos o `default`)'], code: 1 });
});

test('resource list, check y uso', async (t) => {
  const listed = await cli(t, () => resourceCommand(['list']));
  assert.equal(listed.code, 0);
  assert.equal(listed.out[0], 'repo:');
  assert.ok(listed.out.includes('aws:'));
  assert.ok(listed.out.some((l) => l.includes(`${ACCOUNT} → perfil prod (eu-west-1)`)));
  // el checkout de acme/api (/dev/api) no existe: bloquea un run.
  const checked = await cli(t, () => resourceCommand(['check', 'repo']));
  assert.equal(checked.code, 1);
  assert.ok(checked.out.some((l) => l.includes('acme/api')));
  writeJson({ ...v1, repos: {} });
  assert.deepEqual(await cli(t, () => resourceCommand(['check'])), { out: ['repo: sin avisos'], code: 0 });
  assert.equal((await cli(t, () => resourceCommand(['add', 'kube', 'x']))).code, 1);
  assert.equal((await cli(t, () => resourceCommand(['check', 'aws']))).code, 1, 'aws no tiene chequeo de salud');
});
