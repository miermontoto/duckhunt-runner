// worktrees de conversación contra repos git reales en un tmpdir: base tras fetch, rama nueva,
// reutilización entre segmentos y gc que nunca borra trabajo sin guardar, también con submódulos.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { listWorktreeCandidates, removeWorktrees, selectForRemoval } from '../src/resources/repo/gc.js';
import { scrubEnv } from '../src/scrub-env.js';
import { LEGACY_PLATFORM_ID } from '../src/paths.js';
import { isUsableBranch, prepareCheckout, prepareConversationWorktree, prepareRunWorktree, removeCleanWorktree, unsavedWork, worktreeWork } from '../src/resources/repo/worktree.js';

const DAY_MS = 24 * 60 * 60_000;
// identidad y firma fuera: el test no depende de la config git de la máquina. los submódulos de los tests son
// rutas locales (protocolo file, que git solo deja clonar a un submódulo con permiso).
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

let root = '';
let clone = '';
let mainSha = '';
let featSha = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-test-'));
  const origin = path.join(root, 'origin');
  fs.mkdirSync(origin);
  git(origin, 'init', '-q', '-b', 'main');
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(origin, 'checkout', '-q', '-b', 'feat/x');
  git(origin, 'commit', '-q', '--allow-empty', '-m', 'feat');
  featSha = git(origin, 'rev-parse', 'HEAD');
  git(origin, 'checkout', '-q', 'main');
  mainSha = git(origin, 'rev-parse', 'HEAD');
  clone = path.join(root, 'clone');
  git(root, 'clone', '-q', origin, clone);
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('ramas: decide check-ref-format (ñ, + y # valen; -x, x.lock y a..b no)', async () => {
  assert.equal(await isUsableBranch(clone, 'feat/x', env), true);
  assert.equal(await isUsableBranch(clone, 'feature/OKT-12_añadir-login', env), true);
  assert.equal(await isUsableBranch(clone, 'hotfix/v1.2+1', env), true);
  assert.equal(await isUsableBranch(clone, 'feat/x#3', env), true);
  assert.equal(await isUsableBranch(clone, '-x', env), false);
  assert.equal(await isUsableBranch(clone, 'x.lock', env), false);
  assert.equal(await isUsableBranch(clone, 'a..b', env), false);
});

test('conversación sobre origin/<rama>, rama nueva sobre origin/HEAD y reutilización', async () => {
  const feat = await prepareConversationWorktree(clone, '1', 'feat/x', env, LEGACY_PLATFORM_ID);
  assert.equal(git(feat.workdir, 'rev-parse', 'HEAD'), featSha);
  assert.equal(feat.note, `origin/feat/x@${featSha.slice(0, 7)}`);
  assert.ok(!feat.note.includes(root));
  // el nombre del directorio (conv-<id>) no viaja: en la ui se leía como id del run.
  assert.ok(!/^(?:conv|run)-\d/.test(feat.note));

  const fresh = await prepareConversationWorktree(clone, '2', 'feat/nueva', env, LEGACY_PLATFORM_ID);
  assert.equal(git(fresh.workdir, 'rev-parse', 'HEAD'), mainSha);
  assert.match(fresh.note, /^feat\/nueva \(rama nueva\) sobre origin\/main@/);

  // segundo segmento: mismo directorio, con lo que el perfil edit dejó dentro.
  fs.writeFileSync(path.join(feat.workdir, 'wip.txt'), 'x');
  const again = await prepareConversationWorktree(clone, '1', 'feat/x', env, LEGACY_PLATFORM_ID);
  assert.equal(again.workdir, feat.workdir);
  assert.match(again.note, /^HEAD@\w+ \(1 cambios sin commitear\)$/);
  assert.equal(await unsavedWork(feat.workdir, env), '1 cambios sin commitear');

  // una rama que git no acepta no tumba el run: base por defecto con aviso.
  const bad = await prepareConversationWorktree(clone, '3', 'bad.lock', env, LEGACY_PLATFORM_ID);
  assert.equal(git(bad.workdir, 'rev-parse', 'HEAD'), mainSha);
  assert.match(bad.warnings[0] ?? '', /"bad\.lock" no válida para git/);
  await removeCleanWorktree(clone, bad.workdir, env);
});

test('checkout: cwd = el checkout, la nota describe rama y cambios, y los worktrees del daemon no cuentan', async () => {
  // la conversación del test anterior dejó .duckhunt/worktrees/ dentro del checkout.
  assert.ok(fs.existsSync(path.join(clone, '.duckhunt')));
  const co = await prepareCheckout(clone, env, LEGACY_PLATFORM_ID);
  assert.equal(co.workdir, clone);
  assert.equal(co.note, `checkout · main@${mainSha.slice(0, 7)}`);
  assert.equal(git(clone, 'status', '--porcelain'), '', '.duckhunt/ queda en info/exclude');
  await prepareCheckout(clone, env, LEGACY_PLATFORM_ID);
  const exclude = fs.readFileSync(path.join(clone, '.git', 'info', 'exclude'), 'utf-8');
  assert.equal(exclude.split('\n').filter((l) => l === '/.duckhunt/').length, 1, 'idempotente');

  fs.writeFileSync(path.join(clone, 'wip-checkout.txt'), 'x');
  const dirty = await prepareCheckout(clone, env, LEGACY_PLATFORM_ID);
  fs.rmSync(path.join(clone, 'wip-checkout.txt'));
  assert.match(dirty.note, /^checkout · main@\w+ \(1 cambios sin commitear\)$/);
  assert.ok(!dirty.note.includes(root));
});

test('run de reglas: rama local u origin, si no HEAD', async () => {
  const run = await prepareRunWorktree(clone, '10', 'feat/x', env, LEGACY_PLATFORM_ID);
  assert.equal(git(run.workdir, 'rev-parse', 'HEAD'), featSha);
  const missing = await prepareRunWorktree(clone, '11', 'no-existe', env, LEGACY_PLATFORM_ID);
  assert.deepEqual(missing.warnings, ['branch no-existe no existe localmente: worktree sobre HEAD']);
});

test('run de reglas: un .git a medias no es "HEAD vacío" y el error no lleva el path', async () => {
  // lo que dejó mover un checkout: .git sin HEAD ni config, git ya no lo reconoce.
  const gutted = path.join(root, 'gutted');
  fs.mkdirSync(path.join(gutted, '.git', 'refs'), { recursive: true });
  await assert.rejects(prepareRunWorktree(gutted, '30', null, env, LEGACY_PLATFORM_ID), (err: Error) => {
    assert.match(err.message, /^el checkout no es un repositorio git usable \(not a git repository/);
    assert.ok(!err.message.includes(root));
    return true;
  });
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty);
  git(empty, 'init', '-q');
  await assert.rejects(prepareRunWorktree(empty, '31', null, env, LEGACY_PLATFORM_ID), /HEAD vacío/);
});

test('gc: borra cerradas y limpias, conserva cambios sin commitear y commits huérfanos', async () => {
  const committed = await prepareConversationWorktree(clone, '4', null, env, LEGACY_PLATFORM_ID);
  git(committed.workdir, 'commit', '-q', '--allow-empty', '-m', 'solo aquí');
  git(committed.workdir, 'commit', '-q', '--allow-empty', '-m', 'y otro');
  fs.writeFileSync(path.join(committed.workdir, 'a-medias.txt'), 'x');
  fs.writeFileSync(path.join(committed.workdir, 'otro.txt'), 'y');
  const clean = await prepareConversationWorktree(clone, '5', null, env, LEGACY_PLATFORM_ID);
  const openOld = await prepareConversationWorktree(clone, '6', null, env, LEGACY_PLATFORM_ID);
  const old = new Date(Date.now() - 8 * DAY_MS);
  fs.utimesSync(openOld.workdir, old, old);

  const candidates = listWorktreeCandidates([clone, clone], LEGACY_PLATFORM_ID);
  assert.deepEqual(
    candidates.map((c) => `${c.kind}:${c.runId}`).sort(),
    ['conversation:1', 'conversation:2', 'conversation:4', 'conversation:5', 'conversation:6', 'run:10', 'run:11'],
  );
  // el server da por abiertas 1, 2 y 6; 6 lleva 8 días sin uso.
  const targets = selectForRemoval(candidates, new Set(['1', '2', '6']), Date.now());
  assert.deepEqual(targets.map((c) => c.runId).sort(), ['4', '5', '6']);
  // un run en vuelo en otro slot no se toca aunque el server lo dé por cerrado.
  assert.deepEqual(
    selectForRemoval(candidates, new Set(['1', '2', '6']), Date.now(), new Set(['5', '6'])).map((c) => c.runId),
    ['4'],
  );

  const { removed, kept } = await removeWorktrees(targets, env);
  assert.equal(removed, 2);
  assert.ok(fs.existsSync(committed.workdir), 'cambios y commits sin rama ni remoto: se conserva');
  assert.ok(!fs.existsSync(clean.workdir));
  assert.ok(!fs.existsSync(openOld.workdir));
  // worktree_report (0.11.0): lo conservado, en recuentos por run y sin paths.
  assert.deepEqual(kept, [{ runId: '4', dirtyFiles: 2, unpushedCommits: 2 }]);
  assert.equal(await unsavedWork(committed.workdir, env), '2 cambios sin commitear');
  fs.rmSync(path.join(committed.workdir, 'a-medias.txt'));
  fs.rmSync(path.join(committed.workdir, 'otro.txt'));
  assert.deepEqual(await worktreeWork(committed.workdir, env), { dirtyFiles: 0, unpushedCommits: 2 });
  assert.equal(await unsavedWork(committed.workdir, env), 'commits que ninguna rama ni remoto contiene');
});

test('conv-<id> borrado a mano sin git worktree remove: el siguiente segmento lo recrea', async () => {
  const conv = await prepareConversationWorktree(clone, '20', null, env, LEGACY_PLATFORM_ID);
  fs.rmSync(conv.workdir, { recursive: true, force: true });
  const again = await prepareConversationWorktree(clone, '20', null, env, LEGACY_PLATFORM_ID);
  assert.equal(again.workdir, conv.workdir);
  assert.equal(git(again.workdir, 'rev-parse', 'HEAD'), mainSha);
});

test('gc con submódulos: limpio se borra (forzado); lo sin commitear o los commits que solo guarda el submódulo (rama, tag o stash) lo conservan', async () => {
  const subOrigin = path.join(root, 'sub-origin');
  fs.mkdirSync(subOrigin);
  git(subOrigin, 'init', '-q', '-b', 'main');
  git(subOrigin, 'commit', '-q', '--allow-empty', '-m', 'sub');
  // un tag del remoto sobre un commit de su rama: lo guarda el remoto, no cuenta.
  git(subOrigin, 'tag', 'v1');
  const superOrigin = path.join(root, 'super-origin');
  fs.mkdirSync(superOrigin);
  git(superOrigin, 'init', '-q', '-b', 'main');
  git(superOrigin, 'submodule', 'add', '-q', subOrigin, 'lib');
  git(superOrigin, 'commit', '-q', '-m', 'con submódulo');
  const superClone = path.join(root, 'super-clone');
  git(root, 'clone', '-q', superOrigin, superClone);
  // cada conversación con el submódulo poblado, como lo deja un agente que corre `git submodule update --init`.
  const conv = async (id: string): Promise<string> => {
    const { workdir } = await prepareConversationWorktree(superClone, id, null, env, LEGACY_PLATFORM_ID);
    git(workdir, 'submodule', 'update', '-q', '--init');
    return workdir;
  };
  // un commit en una rama local del submódulo, con su HEAD de vuelta en el commit que registra el padre.
  const localBranchCommit = (workdir: string): void => {
    const lib = path.join(workdir, 'lib');
    git(lib, 'checkout', '-q', '-b', 'trabajo');
    git(lib, 'commit', '-q', '--allow-empty', '-m', 'solo en el submódulo');
    git(lib, 'checkout', '-q', '--detach', 'HEAD~1');
  };

  const clean = await conv('40');
  assert.deepEqual(await worktreeWork(clean, env), { dirtyFiles: 0, unpushedCommits: 0, submodules: 1 });
  // git solo, sin la cuenta del daemon: se niega aunque esté limpio.
  await assert.rejects(removeCleanWorktree(superClone, clean, env), /submodules/);

  const untracked = await conv('41');
  fs.writeFileSync(path.join(untracked, 'lib', 'a-medias.txt'), 'x');
  const branched = await conv('42');
  localBranchCommit(branched);
  assert.equal(git(branched, 'status', '--porcelain'), '', 'el status del padre no ve la rama local del submódulo');
  // de-inicializado: el foreach ya no lo visita, pero su repo (y su commit) sigue bajo el admin del worktree.
  const parked = await conv('43');
  localBranchCommit(parked);
  git(parked, 'submodule', 'deinit', '-q', '--all');
  const parkedClean = await conv('44');
  git(parkedClean, 'submodule', 'deinit', '-q', '--all');
  // un .gitmodules con ignore = all no esconde lo sin commitear del submódulo.
  const ignored = await conv('45');
  git(ignored, 'config', '-f', '.gitmodules', 'submodule.lib.ignore', 'all');
  git(ignored, 'commit', '-q', '-am', 'ignora el submódulo');
  fs.writeFileSync(path.join(ignored, 'lib', 'a-medias.txt'), 'x');
  // un stash del submódulo y un commit que solo guarda un tag local suyo: se irían con su repo.
  const stashed = await conv('46');
  fs.writeFileSync(path.join(stashed, 'lib', 'a-medias.txt'), 'x');
  git(path.join(stashed, 'lib'), 'stash', 'push', '-q', '--include-untracked');
  const tagged = await conv('47');
  git(path.join(tagged, 'lib'), 'commit', '-q', '--allow-empty', '-m', 'solo en un tag local');
  git(path.join(tagged, 'lib'), 'tag', 'mi-tag');
  git(path.join(tagged, 'lib'), 'checkout', '-q', '--detach', 'HEAD~1');
  [stashed, tagged].forEach((dir) => assert.equal(git(dir, 'status', '--porcelain'), '', `${path.basename(dir)}: el status del padre no lo ve`));

  const targets = selectForRemoval(listWorktreeCandidates([superClone], LEGACY_PLATFORM_ID), new Set(), Date.now());
  assert.deepEqual(targets.map((c) => c.runId).sort(), ['40', '41', '42', '43', '44', '45', '46', '47']);
  const { removed, kept } = await removeWorktrees(targets, env);
  assert.equal(removed, 2);
  assert.ok(!fs.existsSync(clean), 'limpio con un submódulo poblado: borrado');
  assert.ok(!fs.existsSync(parkedClean), 'limpio con un submódulo de-inicializado: borrado');
  [untracked, branched, parked, ignored, stashed, tagged].forEach((dir) => assert.ok(fs.existsSync(dir), `${path.basename(dir)} se conserva`));
  // worktree_report: recuentos, sin paths ni el número de submódulos.
  assert.deepEqual(
    [...kept].sort((a, b) => a.runId.localeCompare(b.runId)),
    [
      { runId: '41', dirtyFiles: 1, unpushedCommits: 0 },
      { runId: '42', dirtyFiles: 0, unpushedCommits: 1 },
      { runId: '43', dirtyFiles: 0, unpushedCommits: 1 },
      // su commit de .gitmodules también cuenta; el fichero del submódulo, aunque ese .gitmodules lo ignore.
      { runId: '45', dirtyFiles: 1, unpushedCommits: 1 },
      // el stash son sus commits (el de los cambios, el del índice y el de lo no versionado).
      { runId: '46', dirtyFiles: 0, unpushedCommits: 3 },
      { runId: '47', dirtyFiles: 0, unpushedCommits: 1 },
    ],
  );
  assert.equal(git(superClone, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 7, 'el checkout y los 6 conservados');
});

test('sin submódulos el borrado sigue sin --force: git hace de red aunque la cuenta diga limpio', async () => {
  const conv = await prepareConversationWorktree(clone, '50', null, env, LEGACY_PLATFORM_ID);
  fs.writeFileSync(path.join(conv.workdir, 'a-medias.txt'), 'x');
  // una cuenta que miente (limpio): sin submódulos no fuerza y git se niega.
  await assert.rejects(removeCleanWorktree(clone, conv.workdir, env, { dirtyFiles: 0, unpushedCommits: 0 }), /untracked/);
  // con submódulos pero con trabajo: tampoco fuerza.
  await assert.rejects(removeCleanWorktree(clone, conv.workdir, env, { dirtyFiles: 1, unpushedCommits: 0, submodules: 1 }), /untracked/);
  assert.ok(fs.existsSync(path.join(conv.workdir, 'a-medias.txt')));
  fs.rmSync(path.join(conv.workdir, 'a-medias.txt'));
  const work = await worktreeWork(conv.workdir, env);
  assert.deepEqual(work, { dirtyFiles: 0, unpushedCommits: 0 });
  await removeCleanWorktree(clone, conv.workdir, env, work);
  assert.ok(!fs.existsSync(conv.workdir));
});
