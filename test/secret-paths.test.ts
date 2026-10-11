// secret_paths (0.11.0, t#465 P12) contra un home y un estado del daemon reales en un tmpdir: las rutas
// de las credenciales de la máquina (la config desviada, el estado salvo el scratch, $CLAUDE_CONFIG_DIR,
// AWS_*_FILE y los realpath de la lista genérica del server cuando hay symlinks) salen como reglas Read
// absolutas; lo que no cabe en una regla se salta y se dice.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { secretPathsDeny } from '../src/secret-paths.js';

let root = '';
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['DUCKHUNT_RUNNER_CONFIG', 'DUCKHUNT_RUNNER_HOME'] as const;

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-secrets-')));
  ENV_KEYS.forEach((k) => (saved[k] = process.env[k]));
});

after(() => {
  ENV_KEYS.forEach((k) => (saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k])));
  fs.rmSync(root, { recursive: true, force: true });
});

const rule = (p: string, dir = false): string => `Read(/${p}${dir ? '/**' : ''})`;

test('la config desviada, el estado del daemon sin su scratch y lo que el env dice', () => {
  const home = path.join(root, 'u1');
  const state = path.join(home, 'estado');
  fs.mkdirSync(path.join(state, 'scratch'), { recursive: true });
  fs.mkdirSync(path.join(state, 'run-config'));
  fs.writeFileSync(path.join(state, 'algo-nuevo.json'), '{}');
  process.env.DUCKHUNT_RUNNER_HOME = state;
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(home, 'cuentas', 'runner.json');
  const env = {
    CLAUDE_CONFIG_DIR: path.join(home, 'claude-cfg'),
    AWS_SHARED_CREDENTIALS_FILE: path.join(home, 'aws', 'creds'),
    AWS_CONFIG_FILE: path.join(home, 'aws', 'config'),
  };
  const { rules, skipped } = secretPathsDeny(env, home);
  assert.deepEqual(skipped, []);
  const expected = [
    rule(path.join(home, 'cuentas', 'runner.json')),
    rule(path.join(state, 'run-config'), true),
    rule(path.join(state, 'algo-nuevo.json')),
    rule(path.join(state, 'logs'), true),
    rule(path.join(state, 'daemon.lock')),
    rule(path.join(state, 'server-state.json')),
    rule(path.join(home, 'claude-cfg', '.credentials.json')),
    rule(path.join(home, 'aws', 'creds')),
    rule(path.join(home, 'aws', 'config')),
  ];
  assert.deepEqual([...rules].sort(), [...expected].sort());
  assert.ok(!rules.some((r) => r.includes('scratch')), 'el scratch es el cwd de los runs sin repo: no se niega');
  assert.ok(rules.every((r) => r.startsWith('Read(//')), 'rutas absolutas del sistema');
});

test('dotfiles: los realpath de la config, de ~/.aws y de las credenciales de claude cuando son symlinks', () => {
  const home = path.join(root, 'u2');
  const dotfiles = path.join(home, 'dotfiles');
  fs.mkdirSync(path.join(dotfiles, 'aws'), { recursive: true });
  fs.mkdirSync(path.join(dotfiles, 'claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ssh'));
  fs.writeFileSync(path.join(dotfiles, 'runner.json'), '{}');
  fs.writeFileSync(path.join(dotfiles, 'claude', '.credentials.json'), '{}');
  fs.symlinkSync(path.join(dotfiles, 'aws'), path.join(home, '.aws'));
  fs.symlinkSync(path.join(dotfiles, 'claude'), path.join(home, '.claude'));
  fs.symlinkSync(path.join(dotfiles, 'runner.json'), path.join(home, '.duckhunt-runner.json'));
  process.env.DUCKHUNT_RUNNER_HOME = path.join(home, '.duckhunt-runner');
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(home, '.duckhunt-runner.json');
  const { rules } = secretPathsDeny({}, home);
  [
    rule(path.join(home, '.duckhunt-runner.json')),
    rule(path.join(dotfiles, 'runner.json')),
    rule(path.join(dotfiles, 'aws'), true),
    rule(path.join(dotfiles, 'claude', '.credentials.json')),
  ].forEach((r) => assert.ok(rules.includes(r), r));
  // la lista genérica sin symlink ya la niega el server por su ruta lógica: no se repite.
  assert.ok(!rules.includes(rule(path.join(home, '.ssh'), true)));
  assert.ok(!rules.includes(rule(path.join(home, '.aws'), true)));
});

test('una ruta que no cabe en una regla de claude se salta y se dice', () => {
  const home = path.join(root, 'u3');
  fs.mkdirSync(home);
  process.env.DUCKHUNT_RUNNER_HOME = path.join(home, 'estado');
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(home, 'runner.json');
  const { rules, skipped } = secretPathsDeny({ AWS_CONFIG_FILE: path.join(home, 'aws,raro', 'config') }, home);
  assert.deepEqual(skipped, [path.join(home, 'aws,raro', 'config')]);
  assert.ok(rules.includes(rule(path.join(home, 'runner.json'))));
});
