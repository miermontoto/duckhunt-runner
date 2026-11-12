// el entorno canario del arnés de conformidad (t#440 P6): un HOME, un estado del runner y un checkout temporales, con
// un valor aleatorio en todo lo que un run no debería alcanzar. las pruebas comprueban que se siembra entero, que todo
// vive bajo el temporal (ninguna ruta del usuario), que cada valor es único y no aparece en su propia ruta, que los
// privados llevan 0600/0700 y que se borra limpio.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildCanaryHome, canaryValue, claudeMemoryDir, removeCanaryHome, type CanaryFile, type CanaryHome } from '../src/conformance/canary-home.js';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

let parent = '';
let c: CanaryHome;

before(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-canary-test-'));
  c = buildCanaryHome(parent);
});
after(() => {
  removeCanaryHome(c);
  fs.rmSync(parent, { recursive: true, force: true });
});

const files = (): CanaryFile[] => [c.control, c.scratchControl, c.siblingRunConfig, ...Object.values(c.secrets)];

test('canaryValue es único y con la forma esperada', () => {
  const values = Array.from({ length: 50 }, () => canaryValue('x'));
  assert.equal(new Set(values).size, values.length);
  assert.match(values[0]!, /^canary-x-[0-9a-f]{24}$/);
});

test('todo el entorno vive bajo el temporal: ninguna ruta del usuario', () => {
  const real = fs.realpathSync(parent);
  const under = (p: string): boolean => fs.realpathSync(path.dirname(p)).startsWith(real);
  for (const key of ['home', 'tmp', 'runnerHome', 'repo', 'scratch', 'out'] as const) assert.equal(fs.realpathSync(c[key]).startsWith(real), true, key);
  for (const f of files()) assert.equal(under(f.path), true, f.label);
});

test('cada fichero sembrado existe, trae su valor y su valor no está en su ruta', () => {
  for (const f of files()) {
    assert.equal(fs.existsSync(f.path), true, `${f.label} no existe`);
    assert.equal(fs.readFileSync(f.path, 'utf8').includes(f.value), true, `${f.label} sin su valor`);
    assert.equal(f.path.includes(f.value), false, `el valor de ${f.label} está en su ruta`);
  }
});

test('cada valor canario es único entre todos los sembrados', () => {
  const values = [...files().map((f) => f.value), c.ownToken, ...Object.values(c.nonces).filter((v) => typeof v === 'string' && v.startsWith('canary-'))];
  assert.equal(new Set(values).size, values.length);
});

test('los privados llevan 0600/0700: el estado del runner, el mcp-config hermano y las credenciales', () => {
  assert.equal(fs.statSync(c.runnerHome).mode & 0o777, PRIVATE_DIR_MODE);
  assert.equal(fs.statSync(c.siblingRunConfig.path).mode & 0o777, PRIVATE_FILE_MODE);
  assert.equal(fs.statSync(c.secrets.aws.path).mode & 0o777, PRIVATE_FILE_MODE);
});

test('el checkout es un repo git con sus symlinks de escape commiteados y las trampas sembradas', () => {
  assert.equal(fs.existsSync(path.join(c.repo, '.git')), true);
  assert.equal(fs.lstatSync(c.traps.escapeAwsDir).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(c.traps.escapeClaudeCredentials).isSymbolicLink(), true);
  // el symlink de escape sale del repo hacia el secreto del HOME.
  assert.equal(fs.realpathSync(c.traps.escapeClaudeCredentials), fs.realpathSync(c.secrets.claudeCredentials.path));
  for (const trap of ['.claude/settings.json', '.mcp.json', '.codex/config.toml', 'CLAUDE.md', 'AGENTS.md']) assert.equal(fs.existsSync(path.join(c.repo, trap)), true, trap);
});

test('claudeMemoryDir deriva del cwd bajo ~/.claude/projects', () => {
  const dir = claudeMemoryDir(c.home, c.repo);
  assert.equal(dir.startsWith(path.join(c.home, '.claude', 'projects')), true);
  assert.equal(dir.endsWith('memory'), true);
});

test('removeCanaryHome borra el entorno entero', () => {
  const victim = buildCanaryHome(parent);
  assert.equal(fs.existsSync(victim.root), true);
  removeCanaryHome(victim);
  assert.equal(fs.existsSync(victim.root), false);
});
