// diff de cada turno (t#514) contra repos git reales en un tmpdir: la foto no toca el índice del usuario y respeta
// .gitignore, el diff cuenta lo creado con la shell, renombrados y binarios, y los topes dejan ficheros sin cuerpo
// sin romper el patch. más el parseo del bloque `changes` del claim y la capability anunciada.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { announcedCapabilities } from '../src/announced-capabilities.js';
import { parseClaim } from '../src/claim.js';
import { scrubEnv } from '../src/scrub-env.js';
import { budgetPatch, parseNameStatus, parseNumstat, snapshotTree, turnChanges } from '../src/turn-changes.js';
import { RUN_CHANGES_FILE_PATCH_MAX_CHARS, RUN_CHANGES_FILES_MAX, RUN_CHANGES_PATCH_MAX_CHARS, RUNNER_CAPABILITY } from '../src/vendor/runner-protocol/index.js';

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
const LIMITS = { filesMax: RUN_CHANGES_FILES_MAX, filePatchMaxChars: RUN_CHANGES_FILE_PATCH_MAX_CHARS, patchMaxChars: RUN_CHANGES_PATCH_MAX_CHARS };
const roots: string[] = [];
after(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

// un repo con un commit: login.ts, old.ts, .gitignore (ignora .env) y un .env.
function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-turn-changes-'));
  roots.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'login.ts'), 'const a = 1;\nexport { a };\n');
  fs.writeFileSync(path.join(dir, 'old.ts'), 'uno\ndos\ntres\ncuatro\ncinco\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(dir, '.env'), 'DB_PASSWORD=hunter2\n');
  return dir;
}

test('la foto y el diff de un turno: lo creado con la shell, renombrados, binarios; nunca lo ignorado ni el índice del usuario', async () => {
  const dir = repo();
  // algo ya preparado por el usuario en su índice antes del turno: debe seguir igual.
  fs.writeFileSync(path.join(dir, 'staged.ts'), 'x\n');
  git(dir, 'add', 'staged.ts');
  const indexBefore = git(dir, 'diff', '--cached', '--name-only');
  const from = await snapshotTree(dir, env);
  assert.ok(from);

  fs.writeFileSync(path.join(dir, 'login.ts'), 'const a = 2;\nexport { a };\n');
  fs.renameSync(path.join(dir, 'old.ts'), path.join(dir, 'new name.ts'));
  fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0, 1, 2, 3, 0, 255]));
  fs.writeFileSync(path.join(dir, '.env'), 'DB_PASSWORD=otra\n');
  fs.writeFileSync(path.join(dir, 'token.ts'), 'const api_key = "sk-ant-abcdefghijklmnopqrstuvwxyz";\n');

  const report = await turnChanges(dir, env, from, LIMITS);
  assert.ok(report);
  assert.deepEqual(
    report.files.map((f) => [f.status, f.path, f.oldPath ?? null, f.additions, f.deletions]),
    [
      ['M', 'login.ts', null, 1, 1],
      ['A', 'logo.png', null, null, null],
      ['R', 'new name.ts', 'old.ts', 0, 0],
      ['A', 'token.ts', null, 1, 0],
    ],
  );
  assert.equal(report.filesTotal, 4);
  assert.match(report.patch, /^diff --git a\/login\.ts b\/login\.ts$/m);
  assert.match(report.patch, /^-const a = 1;\n\+const a = 2;$/m);
  assert.match(report.patch, /^diff --git a\/old\.ts b\/new name\.ts$/m, 'rutas sin comillas: la web casa la cabecera');
  assert.doesNotMatch(report.patch, /\.env|hunter2|sk-ant-/, 'ni lo ignorado ni el secreto');
  assert.equal(git(dir, 'diff', '--cached', '--name-only'), indexBefore, 'el índice del usuario sigue igual');
  assert.equal(await turnChanges(dir, env, (await snapshotTree(dir, env))!, LIMITS), null, 'sin cambios, nada que subir');
});

test('topes: un fichero enorme o fuera del presupuesto viaja con su cabecera sola; filesMax corta la lista', async () => {
  const dir = repo();
  const from = (await snapshotTree(dir, env))!;
  fs.writeFileSync(path.join(dir, 'big.lock'), 'x\n'.repeat(5000));
  fs.writeFileSync(path.join(dir, 'login.ts'), 'const a = 3;\nexport { a };\n');
  const report = (await turnChanges(dir, env, from, { filesMax: 1, filePatchMaxChars: 1000, patchMaxChars: 2000 }))!;
  assert.equal(report.filesTotal, 2);
  assert.deepEqual(report.files.map((f) => f.path), ['big.lock']);
  assert.match(report.patch, /^diff --git a\/big\.lock b\/big\.lock\ndiff --git a\/login\.ts/m, 'big.lock sin cuerpo, login.ts entero');
  assert.match(report.patch, /\+const a = 3;/);
});

test('budgetPatch: cada fichero entero o su cabecera, el presupuesto se agota en orden', () => {
  const file = (name: string, body: string): string => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${body}\n`;
  const patch = file('a', '+uno') + file('b', '+dos') + file('c', '+tres');
  assert.equal(budgetPatch(patch, { filePatchMaxChars: 1000, patchMaxChars: 1000 }), patch);
  const tight = budgetPatch(patch, { filePatchMaxChars: 1000, patchMaxChars: file('a', '+uno').length + 30 });
  assert.equal(tight, `${file('a', '+uno')}diff --git a/b b/b\ndiff --git a/c b/c\n`);
});

test('parseo de -z: name-status y numstat con renombrados y binarios', () => {
  assert.deepEqual(parseNameStatus('M\0a.ts\0R087\0viejo.ts\0nuevo.ts\0A\0b.png\0'), [
    { status: 'M', path: 'a.ts' },
    { status: 'R', oldPath: 'viejo.ts', path: 'nuevo.ts' },
    { status: 'A', path: 'b.png' },
  ]);
  assert.deepEqual(
    [...parseNumstat('3\t1\ta.ts\0' + '2\t0\t\0viejo.ts\0nuevo.ts\0' + '-\t-\tb.png\0')],
    [
      ['a.ts', { additions: 3, deletions: 1 }],
      ['nuevo.ts', { additions: 2, deletions: 0 }],
      ['b.png', { additions: null, deletions: null }],
    ],
  );
});

test('el claim: el bloque changes se lee con los topes del protocolo como techo; sin él, ausente', () => {
  const base = JSON.parse(fs.readFileSync(new URL('../../test/fixtures/claims/prompt-edit-turn-changes.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(parseClaim(base).changes, LIMITS);
  assert.deepEqual(parseClaim({ ...base, changes: { filesMax: 10, filePatchMaxChars: 10 ** 9, patchMaxChars: 100 } }).changes, { filesMax: 10, filePatchMaxChars: RUN_CHANGES_FILE_PATCH_MAX_CHARS, patchMaxChars: 100 });
  const { changes: _dropped, ...without } = base;
  assert.equal(parseClaim(without).changes, undefined);
  assert.ok(announcedCapabilities({ hasAws: false, supported: new Set() }).includes(RUNNER_CAPABILITY.turnChanges));
});
