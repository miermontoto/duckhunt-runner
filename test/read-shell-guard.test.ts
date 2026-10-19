// shell de lectura y symlinks commiteados (0.10.2, t#465) contra repos git reales en un tmpdir: un
// symlink commiteado o en el índice que sale del cwd (a un fichero, colgante, por realpath del kernel,
// en un submódulo o en un worktree del daemon dentro del checkout) deja el segmento sin shell, igual
// que un worktree del daemon que ya no se puede listar; los internos no; un kit de edición ni se
// revisa. y withoutShell quita Bash del kit sin tocar el resto.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { buildClaudeArgs } from '../src/claude-args.js';
import { parseClaim, type ClaimResponse } from '../src/claim.js';
import { OPTIONAL_FLAGS } from '../src/claude.js';
import { escapingSymlinks, hasReadShell, isInside, readShellGuard, readShellLog, readShellNote } from '../src/read-shell-guard.js';
import { scrubEnv } from '../src/scrub-env.js';
import { LEGACY_PLATFORM_ID } from '../src/paths.js';
import { prepareConversationWorktree } from '../src/worktree.js';

// identidad, firma y submódulos locales: el test no depende de la config git de la máquina.
const env: NodeJS.ProcessEnv = {
  ...scrubEnv(process.env),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'protocol.file.allow',
  GIT_CONFIG_VALUE_1: 'always',
};
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf-8' }).trim();
const fixture = (name: string): ClaimResponse =>
  parseClaim(JSON.parse(fs.readFileSync(new URL(`../../test/fixtures/claim-kits/${name}.json`, import.meta.url), 'utf8')) as unknown);

// kits reales del server: lectura con shell y aws, lectura sin shell (daemon sin read_shell) y edición.
const readKit = fixture('prompt-read-full');
const noShellKit = fixture('prompt-read-no-read-shell');
const editKit = fixture('prompt-edit-full');
const awsKit = fixture('template-full-aws-announced');

let root = '';
let outside = '';
let secret = '';

// repo con los ficheros/symlinks dados (destino de cada symlink tal cual) commiteados.
function repoWith(name: string, links: Record<string, string>, files: Record<string, string> = {}): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  Object.entries({ 'README.md': 'x', ...files }).forEach(([file, body]) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), body);
  });
  Object.entries(links).forEach(([link, target]) => {
    fs.mkdirSync(path.dirname(path.join(dir, link)), { recursive: true });
    fs.symlinkSync(target, path.join(dir, link));
  });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

before(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-symlinks-')));
  outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, 'DUMMY_SECRET=not-a-real-one\n');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('hasReadShell: solo la shell de solo lectura (ni Bash entera, ni negada, ni escritura permitida)', () => {
  assert.equal(hasReadShell(readKit.tools), true);
  assert.equal(hasReadShell(awsKit.tools), true);
  assert.equal(hasReadShell(noShellKit.tools), false, 'Bash negada entera: no hay shell que revisar');
  assert.equal(hasReadShell(editKit.tools), false, 'edición tiene Bash entera');
  assert.equal(hasReadShell(readKit.tools, ['Bash']), false, 'settings ilegibles: el deny espejado ya niega Bash');
  assert.equal(hasReadShell({ allowed: ['Read', 'Write(src/**)'], disallowed: [] }), false);
});

test('isInside: el propio cwd y lo que cuelga de él; `..x` es un nombre, `..` sale', () => {
  assert.equal(isInside('/a/b', '/a/b'), true);
  assert.equal(isInside('/a/b', '/a/b/..x/c'), true);
  assert.equal(isInside('/a/b', '/a'), false);
  assert.equal(isInside('/a/b', '/a/bc'), false);
});

test('(a) un symlink commiteado a un fichero de fuera deja el segmento sin shell (relativo o absoluto)', async () => {
  const repo = repoWith('escape', { 'docs/leak': path.relative(path.join(root, 'escape', 'docs'), secret), abs: secret });
  const verdict = await readShellGuard(repo, readKit.tools, [], env);
  assert.equal(verdict.dropShell, true);
  assert.deepEqual(verdict.escaping.map((l) => l.path).sort(), ['abs', path.join('docs', 'leak')]);
  // el feed solo lleva el recuento; los paths quedan en el log local.
  const note = readShellNote(verdict)!;
  assert.match(note, /2 symlink\(s\) commiteado\(s\)/);
  assert.ok(!note.includes('leak') && !note.includes(root));
  assert.match(readShellLog(verdict)!, /docs\/leak → \.\.\/\.\.\/outside\/secret\.txt/);
  // con aws: la plantilla también pierde la shell.
  assert.equal((await readShellGuard(repo, awsKit.tools, [], env)).dropShell, true);
});

test('(b) solo symlinks internos (fichero, directorio, el propio cwd): la shell se queda', async () => {
  const repo = repoWith('internal', { link: 'a.txt', 'sub/up': '../a.txt', dirlink: 'sub', self: '.' }, { 'a.txt': 'a' });
  const verdict = await readShellGuard(repo, readKit.tools, [], env);
  assert.deepEqual(verdict, { dropShell: false, escaping: [], contains: [], error: null });
  assert.equal(readShellNote(verdict), null);
});

test('(c) un symlink colgante que sale cuenta: su destino puede aparecer', async () => {
  const repo = repoWith('dangling', { ghost: '../../no-existe/.aws/credentials' });
  const verdict = await readShellGuard(repo, readKit.tools, [], env);
  assert.equal(verdict.dropShell, true);
  assert.deepEqual(verdict.escaping, [{ path: 'ghost', target: '../../no-existe/.aws/credentials' }]);
});

test('un symlink léxicamente interno que sale por realpath (a través de un symlink local) cuenta', async () => {
  const repo = repoWith('via-local', { inner: 'local/secret.txt' });
  // `local` es estado del usuario (sin commitear): solo cuenta porque el commiteado sale por él.
  fs.symlinkSync(outside, path.join(repo, 'local'));
  const verdict = await readShellGuard(repo, readKit.tools, [], env);
  assert.deepEqual(verdict.escaping.map((l) => l.path), ['inner']);
});

test('(d) un kit de edición no se revisa; uno de lectura sin shell tampoco; el scratch tampoco', async () => {
  const repo = path.join(root, 'escape');
  const keep = { dropShell: false, escaping: [], contains: [], error: null };
  assert.deepEqual(await readShellGuard(repo, editKit.tools, [], env), keep);
  assert.deepEqual(await readShellGuard(repo, noShellKit.tools, [], env), keep);
  assert.deepEqual(await readShellGuard(null, readKit.tools, [], env), keep, 'scratch: no es un checkout');
  // prueba de que ni se mira: un directorio que no es repo tumbaría el escaneo.
  const notGit = fs.mkdtempSync(path.join(root, 'not-git-'));
  assert.deepEqual(await readShellGuard(notGit, editKit.tools, [], env), keep);
  // el argv de edición sale idéntico con o sin la revisión (nunca se pide withoutShell para él).
  const base = { claim: editKit, prompt: 'p', mcpConfigFile: '/m.json', supported: new Set(OPTIONAL_FLAGS), resumeSessionId: null, skipPermissions: false, payingWithApiKey: false, runConfigDeny: ['Read(//r/**)'] };
  const verdict = await readShellGuard(repo, editKit.tools, [], env);
  assert.deepEqual(buildClaudeArgs({ ...base, withoutShell: verdict.dropShell }), buildClaudeArgs(base));
});

test('fail-closed: un checkout que git no puede listar va sin shell', async () => {
  const notGit = fs.mkdtempSync(path.join(root, 'broken-'));
  const verdict = await readShellGuard(notGit, readKit.tools, [], env);
  assert.equal(verdict.dropShell, true);
  assert.match(verdict.error ?? '', /git ls-files falló/);
  assert.equal(readShellNote(verdict), 'sin shell de lectura en este turno: no se pudieron revisar los symlinks del repo');
});

test('submódulos: un symlink commiteado en uno que sale del cwd cuenta', async () => {
  const sub = repoWith('sub-src', { leak: secret });
  const repo = repoWith('with-sub', {});
  git(repo, 'submodule', 'add', '-q', sub, 'vendor/sub');
  git(repo, 'commit', '-q', '-m', 'sub');
  assert.deepEqual((await escapingSymlinks(repo, env)).map((l) => l.path), [path.join('vendor', 'sub', 'leak')]);
});

test('checkout con conversaciones dentro: cuentan los worktrees del daemon, juzgados contra el cwd del run', async () => {
  // la rama `evil` (que cualquiera pudo empujar) commitea un symlink a la raíz del checkout y otro a fuera.
  const origin = repoWith('origin', {});
  git(origin, 'checkout', '-q', '-b', 'evil');
  fs.symlinkSync('../../..', path.join(origin, 'up'));
  git(origin, 'add', '-A');
  git(origin, 'commit', '-q', '-m', 'evil');
  git(origin, 'checkout', '-q', 'main');
  const clone = path.join(root, 'clone');
  git(root, 'clone', '-q', origin, clone);
  const wt = await prepareConversationWorktree(clone, '7', 'evil', env, LEGACY_PLATFORM_ID);
  // desde el worktree, `up` sube al checkout: sale.
  assert.deepEqual((await readShellGuard(wt.workdir, readKit.tools, [], env)).escaping.map((l) => l.path), ['up']);
  // desde el checkout, `up` cae en el propio checkout: dentro.
  assert.equal((await readShellGuard(clone, readKit.tools, [], env)).dropShell, false);
  // un symlink a fuera en un worktree del daemon sí cuenta para el checkout (grep -R entra en .duckhunt/).
  fs.symlinkSync(secret, path.join(wt.workdir, 'leak'));
  git(wt.workdir, 'add', 'leak');
  git(wt.workdir, 'commit', '-q', '-m', 'leak');
  const verdict = await readShellGuard(clone, readKit.tools, [], env);
  assert.deepEqual(verdict.escaping.map((l) => l.path), [path.join('.duckhunt', 'worktrees', 'conv-7', 'leak')]);
});

test('un cwd que contiene el estado del runner (o el home) va sin shell', async () => {
  const repo = repoWith('holds-home', {});
  const prev = process.env.DUCKHUNT_RUNNER_HOME;
  process.env.DUCKHUNT_RUNNER_HOME = path.join(repo, '.runner-home');
  try {
    const verdict = await readShellGuard(repo, readKit.tools, [], env);
    assert.equal(verdict.dropShell, true);
    assert.deepEqual(verdict.contains, [path.join(repo, '.runner-home')]);
    assert.match(readShellNote(verdict)!, /contiene tu home o el estado del runner/);
  } finally {
    if (prev === undefined) delete process.env.DUCKHUNT_RUNNER_HOME;
    else process.env.DUCKHUNT_RUNNER_HOME = prev;
  }
});

test('withoutShell: Bash entera al deny y ningún Bash(...) en el allow; el resto del kit intacto', () => {
  const base = { claim: awsKit, prompt: 'p', mcpConfigFile: '/m.json', supported: new Set(OPTIONAL_FLAGS), resumeSessionId: null, skipPermissions: false, payingWithApiKey: false, runConfigDeny: ['Read(//r/**)'] };
  const flag = (args: string[], name: string): string[] => args[args.indexOf(name) + 1]!.split(',');
  const kept = buildClaudeArgs(base);
  const dropped = buildClaudeArgs({ ...base, withoutShell: true });
  assert.ok(flag(kept, '--allowedTools').some((t) => t.startsWith('Bash(aws ')));
  assert.ok(!flag(kept, '--disallowedTools').includes('Bash'));
  assert.deepEqual(flag(dropped, '--allowedTools'), flag(kept, '--allowedTools').filter((t) => !t.startsWith('Bash(')));
  assert.deepEqual(flag(dropped, '--disallowedTools'), [...flag(kept, '--disallowedTools').filter((t) => t !== 'Read(//r/**)'), 'Bash', 'Read(//r/**)']);
  assert.equal(hasReadShell({ allowed: flag(dropped, '--allowedTools'), disallowed: flag(dropped, '--disallowedTools') }), false);
});

test('el realpath es el del kernel: un `..` tras un symlink interno que en disco sale cuenta', async () => {
  // `inner` apunta (absoluto) a la raíz del repo: dentro. `x` sube desde él con `..`; leído a mano cae
  // dentro, pero el kernel resuelve cada `..` tras seguir `inner` y acaba fuera del repo.
  const name = 'physical';
  const repo = repoWith(name, { 'p/q/inner': path.join(root, name), x: 'p/q/inner/../..' });
  assert.notEqual(fs.realpathSync(path.join(repo, 'x')), fs.realpathSync.native(path.join(repo, 'x')), 'el realpath de js no lo ve');
  const verdict = await readShellGuard(repo, readKit.tools, [], env);
  assert.equal(verdict.dropShell, true);
  assert.deepEqual(verdict.escaping.map((l) => l.path), ['x']);
});

test('un symlink que un segmento de edición metió en el índice sin commitear cuenta', async () => {
  const repo = repoWith('staged', {});
  fs.symlinkSync(secret, path.join(repo, 'staged-link'));
  git(repo, 'add', 'staged-link');
  assert.deepEqual((await readShellGuard(repo, readKit.tools, [], env)).escaping.map((l) => l.path), ['staged-link']);
});

test('un directorio de .duckhunt/worktrees con contenido que ya no es un worktree: sin shell; uno vacío no cuenta', async () => {
  const origin = repoWith('orphan-origin', {});
  const clone = path.join(root, 'orphan-clone');
  git(root, 'clone', '-q', origin, clone);
  const wt = await prepareConversationWorktree(clone, '11', null, env, LEGACY_PLATFORM_ID);
  fs.mkdirSync(path.join(clone, '.duckhunt', 'worktrees', 'conv-12'));
  assert.equal((await readShellGuard(clone, readKit.tools, [], env)).dropShell, false, 'vacío: nada que seguir');
  // alguien le borró el .git al worktree: lo que trajo su rama ya no sale en ningún índice.
  fs.rmSync(path.join(wt.workdir, '.git'));
  const verdict = await readShellGuard(clone, readKit.tools, [], env);
  assert.equal(verdict.dropShell, true);
  assert.match(verdict.error ?? '', /conv-11 tiene contenido pero no es un worktree git/);
});
