// worktrees de conversación contra repos git reales en un tmpdir: base tras fetch, rama nueva,
// reutilización entre segmentos y gc que nunca borra trabajo sin guardar.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { listWorktreeCandidates, removeWorktrees, selectForRemoval } from '../src/conversation-gc.js';
import { scrubEnv } from '../src/scrub-env.js';
import { isUsableBranch, prepareConversationWorktree, prepareRunWorktree, removeCleanWorktree, unsavedWork } from '../src/worktree.js';

const DAY_MS = 24 * 60 * 60_000;
// identidad y firma fuera: el test no depende de la config git de la máquina.
const env: NodeJS.ProcessEnv = {
  ...scrubEnv(process.env),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
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
  const feat = await prepareConversationWorktree(clone, 1, 'feat/x', env);
  assert.equal(git(feat.workdir, 'rev-parse', 'HEAD'), featSha);
  assert.equal(feat.note, `conv-1 · origin/feat/x@${featSha.slice(0, 7)}`);
  assert.ok(!feat.note.includes(root));

  const fresh = await prepareConversationWorktree(clone, 2, 'feat/nueva', env);
  assert.equal(git(fresh.workdir, 'rev-parse', 'HEAD'), mainSha);
  assert.match(fresh.note, /^conv-2 · feat\/nueva \(rama nueva\) sobre origin\/main@/);

  // segundo segmento: mismo directorio, con lo que el perfil edit dejó dentro.
  fs.writeFileSync(path.join(feat.workdir, 'wip.txt'), 'x');
  const again = await prepareConversationWorktree(clone, 1, 'feat/x', env);
  assert.equal(again.workdir, feat.workdir);
  assert.match(again.note, /^conv-1 · HEAD@\w+ \(1 cambios sin commitear\)$/);
  assert.equal(await unsavedWork(feat.workdir, env), '1 cambios sin commitear');

  // una rama que git no acepta no tumba el run: base por defecto con aviso.
  const bad = await prepareConversationWorktree(clone, 3, 'bad.lock', env);
  assert.equal(git(bad.workdir, 'rev-parse', 'HEAD'), mainSha);
  assert.match(bad.warnings[0] ?? '', /"bad\.lock" no válida para git/);
  await removeCleanWorktree(clone, bad.workdir, env);
});

test('run de reglas: rama local u origin, si no HEAD', async () => {
  const run = await prepareRunWorktree(clone, 10, 'feat/x', env);
  assert.equal(git(run.workdir, 'rev-parse', 'HEAD'), featSha);
  const missing = await prepareRunWorktree(clone, 11, 'no-existe', env);
  assert.deepEqual(missing.warnings, ['branch no-existe no existe localmente: worktree sobre HEAD']);
});

test('gc: borra cerradas y limpias, conserva cambios sin commitear y commits huérfanos', async () => {
  const committed = await prepareConversationWorktree(clone, 4, null, env);
  git(committed.workdir, 'commit', '-q', '--allow-empty', '-m', 'solo aquí');
  const clean = await prepareConversationWorktree(clone, 5, null, env);
  const openOld = await prepareConversationWorktree(clone, 6, null, env);
  const old = new Date(Date.now() - 8 * DAY_MS);
  fs.utimesSync(openOld.workdir, old, old);

  const candidates = listWorktreeCandidates([clone, clone]);
  assert.deepEqual(
    candidates.map((c) => `${c.kind}:${c.runId}`).sort(),
    ['conversation:1', 'conversation:2', 'conversation:4', 'conversation:5', 'conversation:6', 'run:10', 'run:11'],
  );
  // el server da por abiertas 1, 2 y 6; 6 lleva 8 días sin uso.
  const targets = selectForRemoval(candidates, new Set([1, 2, 6]), Date.now());
  assert.deepEqual(targets.map((c) => c.runId).sort(), [4, 5, 6]);

  const removed = await removeWorktrees(targets, env);
  assert.equal(removed, 2);
  assert.ok(fs.existsSync(committed.workdir), 'commits sin rama ni remoto: se conserva');
  assert.ok(!fs.existsSync(clean.workdir));
  assert.ok(!fs.existsSync(openOld.workdir));
  assert.equal(await unsavedWork(committed.workdir, env), 'commits que ninguna rama ni remoto contiene');
});

test('conv-<id> borrado a mano sin git worktree remove: el siguiente segmento lo recrea', async () => {
  const conv = await prepareConversationWorktree(clone, 20, null, env);
  fs.rmSync(conv.workdir, { recursive: true, force: true });
  const again = await prepareConversationWorktree(clone, 20, null, env);
  assert.equal(again.workdir, conv.workdir);
  assert.equal(git(again.workdir, 'rev-parse', 'HEAD'), mainSha);
});
