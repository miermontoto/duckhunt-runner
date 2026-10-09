// elecciones de carpeta y comandos desde duckhunt (t#463 fase 2) contra checkouts git reales: qué
// candidatos se anuncian (sin paths), y que un comando solo mueve un repo a una carpeta que este
// daemon encontró, sigue siendo de ese repo y conserva sus flags; quitar es idempotente.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { RepoConfig } from '../src/config.js';
import { applyRepoCommand, parseRepoCommands } from '../src/repo-commands.js';
import { repoChoices, scanRepos } from '../src/repo-health.js';
import { scrubEnv } from '../src/scrub-env.js';

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
const dir = (...parts: string[]): string => path.join(root, 'work', ...parts);

function checkout(rel: string, remote: string): string {
  fs.mkdirSync(path.dirname(dir(rel)), { recursive: true });
  git(root, 'clone', '-q', path.join(root, 'seed'), dir(rel));
  git(dir(rel), 'remote', 'set-url', 'origin', remote);
  return dir(rel);
}

let repos: Record<string, RepoConfig> = {};

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-commands-'));
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'init');
  checkout('a/svc', 'https://github.com/acme/svc.git');
  const copy = checkout('a/svc-copy', 'https://github.com/acme/svc.git');
  fs.writeFileSync(path.join(copy, 'wip.txt'), 'a medias');
  checkout('a/lost', 'https://github.com/acme/lost.git');
  checkout('a/other', 'https://github.com/acme/other.git');
  // dos carpetas «app» del mismo repo en padres distintos: el nombre lleva el padre.
  checkout('a/app', 'https://github.com/acme/app.git');
  checkout('b/app', 'https://github.com/acme/app.git');
  checkout('b/z', 'https://github.com/acme/z.git');
  repos = {
    'acme/svc': { path: dir('a/svc'), worktree: false },
    'acme/lost': { path: dir('a/lost-old') },
    'acme/other': { path: dir('a/other') },
    'acme/app': { path: dir('a/app') },
    'acme/z': { path: dir('b/z') },
  };
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('candidatos: solo repos con algo que elegir, con nombre de carpeta y estado git, sin paths', async () => {
  const { choices, paths } = await repoChoices(await scanRepos(repos, env), env);
  assert.deepEqual(choices.map((c) => c.repo), ['acme/svc', 'acme/lost', 'acme/app']);
  const svc = choices[0]!.candidates;
  assert.deepEqual(svc.map((c) => [c.name, c.current, c.dirty, c.branch]), [
    ['svc', true, 0, 'main'],
    ['svc-copy', false, 1, 'main'],
  ]);
  assert.ok(svc.every((c) => typeof c.lastCommitAt === 'number' && /^[0-9a-f]{16}$/.test(c.id)));
  // el repo perdido: la carpeta que encontró, ninguna actual.
  assert.deepEqual(choices[1]!.candidates.map((c) => [c.name, c.current]), [['lost', false]]);
  assert.deepEqual(choices[2]!.candidates.map((c) => c.name), [path.join('a', 'app'), path.join('b', 'app')]);
  assert.ok(!JSON.stringify(choices).includes(root), 'ningún path viaja');
  assert.equal(paths.get(svc[1]!.id)?.path, dir('a/svc-copy'));
});

test('remap: a una carpeta propia del repo, conservando flags; nada que no salga de la lista', async () => {
  const { choices, paths } = await repoChoices(await scanRepos(repos, env), env);
  const copyId = choices[0]!.candidates[1]!.id;
  const lostId = choices[1]!.candidates[0]!.id;

  const moved = await applyRepoCommand(repos, { id: 1, action: 'remap', repo: 'acme/svc', candidateId: copyId }, paths, env);
  assert.deepEqual(moved.result, { id: 1, ok: true });
  assert.deepEqual(moved.repos['acme/svc'], { path: dir('a/svc-copy'), worktree: false });
  assert.equal(repos['acme/svc']!.path, dir('a/svc'), 'el mapa de entrada no se muta');

  const unknown = await applyRepoCommand(repos, { id: 2, action: 'remap', repo: 'acme/svc', candidateId: 'f'.repeat(16) }, paths, env);
  assert.equal(unknown.result.ok, false);
  assert.equal(unknown.repos, repos);
  const foreign = await applyRepoCommand(repos, { id: 3, action: 'remap', repo: 'acme/svc', candidateId: lostId }, paths, env);
  assert.match(foreign.result.error ?? '', /desconocida para este repo/);

  // la carpeta cambió de repo entre la foto y el comando: se rechaza.
  git(dir('a/svc-copy'), 'remote', 'set-url', 'origin', 'https://github.com/acme/otro.git');
  const stale = await applyRepoCommand(repos, { id: 4, action: 'remap', repo: 'acme/svc', candidateId: copyId }, paths, env);
  assert.match(stale.result.error ?? '', /ya no es un checkout de este repo/);
  assert.ok(!(stale.result.error ?? '').includes(root));
  git(dir('a/svc-copy'), 'remote', 'set-url', 'origin', 'https://github.com/acme/svc.git');

  const fixed = await applyRepoCommand(repos, { id: 5, action: 'remap', repo: 'acme/lost', candidateId: lostId }, paths, env);
  assert.equal(fixed.repos['acme/lost']!.path, dir('a/lost'));
});

test('unmap: quita sin tocar el disco y es idempotente; los comandos mal formados se descartan', async () => {
  const removed = await applyRepoCommand(repos, { id: 6, action: 'unmap', repo: 'acme/other', candidateId: null }, new Map(), env);
  assert.ok(!('acme/other' in removed.repos));
  assert.ok(fs.existsSync(dir('a/other')));
  const again = await applyRepoCommand(removed.repos, { id: 7, action: 'unmap', repo: 'acme/other', candidateId: null }, new Map(), env);
  assert.deepEqual(again.result, { id: 7, ok: true });

  assert.deepEqual(
    parseRepoCommands({
      commands: [
        { id: 1, action: 'unmap', repo: 'acme/x' },
        { id: 2, action: 'remap', repo: 'acme/x', candidateId: 'abc' },
        { id: 3, action: 'rm -rf', repo: 'acme/x' },
        { id: 'x', action: 'unmap', repo: 'acme/x' },
        null,
      ],
    }),
    [
      { id: 1, action: 'unmap', repo: 'acme/x', candidateId: null },
      { id: 2, action: 'remap', repo: 'acme/x', candidateId: 'abc' },
    ],
  );
  assert.deepEqual(parseRepoCommands(null), []);
});
