// salud de los repos mapeados contra checkouts git reales en un tmpdir: cada código de aviso, que un
// worktree enlazado no cuenta como duplicado, la key de un remote copiado del navegador y que
// `repos discover` no elige entre dos checkouts del mismo repo.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { RepoConfig } from '../src/config.js';
import { checkRepoHealth, repoIssues, type RepoFinding } from '../src/repo-health.js';
import { repoKeyFromRemote } from '../src/repo-key.js';
import { reposCommand } from '../src/repos.js';
import { scrubEnv } from '../src/scrub-env.js';

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
let work = '';
const dir = (name: string): string => path.join(work, name);

// clon del seed con el origin apuntando a `remote` (el chequeo nunca hace fetch).
function checkout(name: string, remote: string | null): string {
  git(root, 'clone', '-q', path.join(root, 'seed'), dir(name));
  if (remote) git(dir(name), 'remote', 'set-url', 'origin', remote);
  else git(dir(name), 'remote', 'remove', 'origin');
  return dir(name);
}

const issuesOf = (findings: RepoFinding[], repo: string | null): string[] =>
  findings.filter((f) => f.issue.repo === repo).map((f) => `${f.issue.kind}${f.issue.count !== undefined ? `:${f.issue.count}` : ''}`);

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-health-'));
  work = path.join(root, 'work');
  fs.mkdirSync(work);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'init');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('key del remote: github y bitbucket por los dos primeros segmentos, el resto por los dos últimos', () => {
  assert.equal(repoKeyFromRemote('git@bitbucket.org:okticket/okt-api.git'), 'okticket/okt-api');
  assert.equal(repoKeyFromRemote('https://juan@bitbucket.org/okticket/new-boilerplate/src/main/'), 'okticket/new-boilerplate');
  assert.equal(repoKeyFromRemote('ssh://git@github.com/acme/app.git'), 'acme/app');
  assert.equal(repoKeyFromRemote('https://github.com/acme/app/tree/main'), 'acme/app');
  assert.equal(repoKeyFromRemote('https://gitlab.com/group/sub/repo.git'), 'sub/repo');
  assert.equal(repoKeyFromRemote('https://github.com/acme'), null);
  assert.equal(repoKeyFromRemote('/srv/git/app'), null);
});

test('cada aviso con su código, sin contar worktrees enlazados ni los registrados', async () => {
  const app = checkout('app', 'https://github.com/acme/app.git');
  checkout('app-copy', 'git@github.com:acme/app.git');
  // worktree enlazado del mismo repo junto a él (mismo git-common-dir) y uno del daemon registrado.
  git(app, 'worktree', 'add', '-q', '--detach', dir('app-linked'));
  git(app, 'worktree', 'add', '-q', '--detach', path.join(app, '.duckhunt', 'worktrees', 'conv-8'));
  // y uno que git no registra (borrado a medias).
  fs.mkdirSync(path.join(app, '.duckhunt', 'worktrees', 'conv-9'), { recursive: true });
  checkout('other', 'https://bitbucket.org/acme/other/src/main/');
  checkout('local', null);
  // lo que deja mover un checkout: .git sin HEAD ni config, con worktrees del daemon dentro.
  fs.mkdirSync(path.join(dir('gutted'), '.git', 'refs'), { recursive: true });
  fs.mkdirSync(path.join(dir('gutted'), '.duckhunt', 'worktrees', 'conv-1'), { recursive: true });
  // checkout sin mapear con worktrees del daemon: nadie los recogerá.
  fs.mkdirSync(path.join(dir('parked'), '.duckhunt', 'worktrees', 'conv-3'), { recursive: true });

  const repos: Record<string, RepoConfig> = {
    'acme/app': { path: app },
    'acme/alias': { path: app },
    'acme/wrong': { path: dir('other') },
    'acme/local': { path: dir('local') },
    'acme/gone': { path: dir('gone') },
    'acme/gutted': { path: dir('gutted') },
  };
  const findings = await checkRepoHealth(repos, env);
  assert.deepEqual(issuesOf(findings, 'acme/app'), ['duplicate:1', 'orphan_worktrees:1', 'shared_path:2']);
  assert.ok(findings.find((f) => f.issue.repo === 'acme/app' && f.issue.kind === 'duplicate')!.detail.includes('app-copy'));
  assert.deepEqual(issuesOf(findings, 'acme/alias'), ['remote_mismatch', 'shared_path:2']);
  assert.deepEqual(issuesOf(findings, 'acme/wrong'), ['remote_mismatch']);
  assert.deepEqual(issuesOf(findings, 'acme/local'), ['no_origin']);
  assert.deepEqual(issuesOf(findings, 'acme/gone'), ['missing']);
  assert.deepEqual(issuesOf(findings, 'acme/gutted'), ['not_git', 'orphan_worktrees:1']);
  assert.deepEqual(issuesOf(findings, null), ['orphan_worktrees:1']);
  // el repo roto con el repo bueno en otro directorio: aviso + sugerencia, nunca "duplicado".
  const misplaced = await checkRepoHealth({ 'acme/other': { path: dir('gone') } }, env);
  assert.deepEqual(issuesOf(misplaced, 'acme/other'), ['missing']);
  assert.match(misplaced[0]!.detail, /repos add acme\/other .*other`\)$/);
});

test('al server: sin paths, agrupados por (repo, código) y con los recuentos sumados', () => {
  const issues = repoIssues([
    { issue: { repo: 'acme/app', kind: 'orphan_worktrees', count: 2 }, detail: '/home/x/app' },
    { issue: { repo: 'acme/app', kind: 'orphan_worktrees', count: 1 }, detail: '/home/x/old-app' },
    { issue: { repo: null, kind: 'orphan_worktrees', count: 1 }, detail: '/home/x/parked' },
    { issue: { repo: 'acme/gone', kind: 'missing' }, detail: '/home/x/gone' },
  ]);
  assert.deepEqual(issues, [
    { repo: 'acme/app', kind: 'orphan_worktrees', count: 3 },
    { repo: null, kind: 'orphan_worktrees', count: 1 },
    { repo: 'acme/gone', kind: 'missing' },
  ]);
  assert.ok(!JSON.stringify(issues).includes('/home'));
});

test('discover: dos checkouts del mismo repo no se mapean solos; un worktree enlazado sí es el mismo', async () => {
  const base = path.join(root, 'discover');
  fs.mkdirSync(base);
  const one = path.join(base, 'svc');
  const two = path.join(base, 'svc-parked');
  [one, two].forEach((d) => {
    git(root, 'clone', '-q', path.join(root, 'seed'), d);
    git(d, 'remote', 'set-url', 'origin', 'https://github.com/acme/svc.git');
  });
  const lib = path.join(base, 'lib');
  git(root, 'clone', '-q', path.join(root, 'seed'), lib);
  git(lib, 'remote', 'set-url', 'origin', 'https://github.com/acme/lib.git');
  git(lib, 'worktree', 'add', '-q', '--detach', path.join(base, 'lib-feature'));

  const cfgFile = path.join(root, 'runner.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ baseUrl: 'http://x', clientId: 'c', refreshToken: 'r', repos: {}, aws: {}, defaults: {} }));
  const prev = process.env.DUCKHUNT_RUNNER_CONFIG;
  process.env.DUCKHUNT_RUNNER_CONFIG = cfgFile;
  const log = console.log;
  console.log = () => {};
  try {
    await reposCommand(['discover', base]);
  } finally {
    console.log = log;
    if (prev === undefined) delete process.env.DUCKHUNT_RUNNER_CONFIG;
    else process.env.DUCKHUNT_RUNNER_CONFIG = prev;
  }
  const saved = JSON.parse(fs.readFileSync(cfgFile, 'utf-8')) as { repos: Record<string, RepoConfig> };
  assert.deepEqual(saved.repos, { 'acme/lib': { path: lib } });
});
