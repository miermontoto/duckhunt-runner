// rutas por plataforma (t#495, M1): la legacy (duckhunt) conserva EXACTAS las de siempre, cualquier otra va a su
// espacio (<runnerHome>/platforms/<id>/ y <checkout>/.runner/worktrees/<id>/), un id inválido nunca llega a una
// ruta, el deny de run-config cubre el de cada plataforma con estado y secret_paths niega lo privado de cada
// plataforma salvo su scratch.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import {
  allRunConfigDirs,
  checkoutExcludePattern,
  LEGACY_PLATFORM_ID,
  logsDir,
  PLATFORM_ID_RE,
  platformHome,
  runConfigDir,
  scratchDir,
  serverStatePath,
  worktreesDir,
} from '../src/paths.js';
import { secretPathsDeny } from '../src/secret-paths.js';

const OTHER = 'acme-1';
const CHECKOUT = '/dev/api';
let root = '';
let home = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['DUCKHUNT_RUNNER_CONFIG', 'DUCKHUNT_RUNNER_HOME'] as const;

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-paths-')));
  ENV_KEYS.forEach((k) => (saved[k] = process.env[k]));
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(root, 'home-'));
  process.env.DUCKHUNT_RUNNER_HOME = home;
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(root, 'runner.json');
});

after(() => {
  ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  fs.rmSync(root, { recursive: true, force: true });
});

test('la plataforma legacy conserva exactas las rutas de siempre', () => {
  assert.deepEqual(
    [platformHome(LEGACY_PLATFORM_ID), scratchDir(LEGACY_PLATFORM_ID), logsDir(LEGACY_PLATFORM_ID), runConfigDir(LEGACY_PLATFORM_ID), serverStatePath(LEGACY_PLATFORM_ID)],
    [home, path.join(home, 'scratch'), path.join(home, 'logs'), path.join(home, 'run-config'), path.join(home, 'server-state.json')],
  );
  assert.equal(worktreesDir(CHECKOUT, LEGACY_PLATFORM_ID), path.join(CHECKOUT, '.duckhunt', 'worktrees'));
  assert.equal(checkoutExcludePattern(LEGACY_PLATFORM_ID), '/.duckhunt/');
  assert.equal(fs.statSync(runConfigDir(LEGACY_PLATFORM_ID)).mode & 0o777, 0o700);
});

test('otra plataforma: su espacio en el estado y en cada checkout', () => {
  const own = path.join(home, 'platforms', OTHER);
  assert.deepEqual(
    [platformHome(OTHER), scratchDir(OTHER), logsDir(OTHER), runConfigDir(OTHER), serverStatePath(OTHER)],
    [own, path.join(own, 'scratch'), path.join(own, 'logs'), path.join(own, 'run-config'), path.join(own, 'server-state.json')],
  );
  assert.equal(worktreesDir(CHECKOUT, OTHER), path.join(CHECKOUT, '.runner', 'worktrees', OTHER));
  assert.equal(checkoutExcludePattern(OTHER), '/.runner/');
  assert.equal(fs.statSync(runConfigDir(OTHER)).mode & 0o777, 0o700);
});

test('PLATFORM_ID_RE: minúsculas, dígitos y guiones; un id inválido nunca llega a una ruta', () => {
  ['duckhunt', 'acme-1', 'a', '0x', 'a'.repeat(32)].forEach((id) => assert.ok(PLATFORM_ID_RE.test(id), id));
  ['', 'Acme', '-a', '../x', 'a/b', 'a.b', 'a b', 'a'.repeat(33)].forEach((id) => {
    assert.ok(!PLATFORM_ID_RE.test(id), JSON.stringify(id));
    assert.throws(() => platformHome(id), /id de plataforma inválido/);
    assert.throws(() => worktreesDir(CHECKOUT, id), /id de plataforma inválido/);
  });
});

test('el deny de run-config cubre el de cada plataforma con estado (hoy, solo la legacy)', () => {
  assert.deepEqual(allRunConfigDirs(), [path.join(home, 'run-config')]);
  runConfigDir(OTHER);
  // un directorio que no es un id de plataforma no cuenta.
  fs.mkdirSync(path.join(home, 'platforms', 'No Valida', 'run-config'), { recursive: true });
  assert.deepEqual(allRunConfigDirs(), [path.join(home, 'run-config'), path.join(home, 'platforms', OTHER, 'run-config')]);
});

test('secret_paths: lo privado de cada plataforma, nunca su scratch ni platforms/ entero', () => {
  scratchDir(LEGACY_PLATFORM_ID);
  scratchDir(OTHER);
  logsDir(OTHER);
  const own = path.join(home, 'platforms', OTHER);
  const { rules } = secretPathsDeny({}, root);
  [`Read(/${path.join(own, 'logs')}/**)`, `Read(/${path.join(own, 'run-config')}/**)`, `Read(/${path.join(own, 'server-state.json')})`].forEach((r) =>
    assert.ok(rules.includes(r), r),
  );
  assert.ok(!rules.some((r) => r.includes('scratch')), 'el scratch de cada plataforma es el cwd de sus runs sin repo');
  assert.ok(!rules.includes(`Read(/${path.join(home, 'platforms')}/**)`), 'platforms/ no se niega entero');
  // la legacy, como siempre.
  [`Read(/${path.join(home, 'logs')}/**)`, `Read(/${path.join(home, 'daemon.lock')})`, `Read(/${path.join(home, 'server-state.json')})`].forEach((r) =>
    assert.ok(rules.includes(r), r),
  );
});
