// diff de cada turno (t#514) contra repos git reales en un tmpdir: la foto no toca el índice del usuario y respeta
// .gitignore, el diff cuenta lo creado con la shell, renombrados y binarios, y los topes dejan ficheros sin cuerpo
// (o fuera) sin romper el patch ni pasar de patchMaxChars, también con varios repos adicionales. más el parseo del
// bloque `changes` del claim y la capability anunciada.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { announcedCapabilities } from '../src/announced-capabilities.js';
import { parseClaim } from '../src/claim.js';
import { withExtraChanges } from '../src/daemon.js';
import { scrubEnv } from '../src/scrub-env.js';
import { maskDiffChunk, maskDiffSecrets, maskSecrets, SECRET_MASK } from '../src/secret-mask.js';
import { budgetPatch, cutPatchAtFile, parseNameStatus, parseNumstat, snapshotTree, turnChanges } from '../src/turn-changes.js';
import {
  RUN_CHANGES_FILE_PATCH_MAX_CHARS,
  RUN_CHANGES_FILES_MAX,
  RUN_CHANGES_PATCH_HARD_MAX_CHARS,
  RUN_CHANGES_PATCH_MAX_CHARS,
  RUNNER_CAPABILITY,
} from '../src/vendor/runner-protocol/index.js';

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

test('una ruta no es código: un secreto en el nombre de un fichero sale enmascarado, en la lista y en el diff', async () => {
  const dir = repo();
  const from = await snapshotTree(dir, env);
  assert.ok(from);
  fs.mkdirSync(path.join(dir, 'dumps'));
  fs.writeFileSync(path.join(dir, 'dumps', 'token=abc123def.txt'), 'x\n');
  const report = await turnChanges(dir, env, from, LIMITS);
  assert.ok(report);
  assert.deepEqual(report.files.map((f) => f.path), [`dumps/${SECRET_MASK}`]);
  assert.doesNotMatch(report.patch, /abc123def/);
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

// los trozos de un patch: uno por `diff --git` (ningún cuerpo de estos tests tiene una línea que empiece así).
const piecesOf = (patch: string): string[] => (patch === '' ? [] : patch.split(/(?=^diff --git )/m));
const headerLine = (name: string): string => `diff --git a/${name} b/${name}\n`;

test('budgetPatch: cada fichero entero o su cabecera, el presupuesto se agota en orden', () => {
  const file = (name: string, body: string): string => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${body}\n`;
  const patch = file('a', '+uno') + file('b', '+dos') + file('c', '+tres');
  assert.equal(budgetPatch(patch, { filePatchMaxChars: 1000, patchMaxChars: 1000 }), patch);
  const tight = budgetPatch(patch, { filePatchMaxChars: 1000, patchMaxChars: file('a', '+uno').length + 40 });
  assert.equal(tight, `${file('a', '+uno')}diff --git a/b b/b\ndiff --git a/c b/c\n`);
  // la cabecera también cuenta: la de c ya no cabe y se queda fuera.
  const tighter = budgetPatch(patch, { filePatchMaxChars: 1000, patchMaxChars: file('a', '+uno').length + 30 });
  assert.equal(tighter, `${file('a', '+uno')}diff --git a/b b/b\n`);
});

test('budgetPatch: miles de ficheros con rutas largas (un cambio de rama) nunca pasan de patchMaxChars; cada trozo, un fichero entero o su cabecera', () => {
  const FILES = 3000;
  const name = (i: number): string => `src/${'carpeta-con-un-nombre-largo/'.repeat(12)}fichero-${i}.ts`;
  const file = (i: number): string => {
    const lines = (i % 7) * 40;
    return `${headerLine(name(i))}--- a/${name(i)}\n+++ b/${name(i)}\n@@ -1 +1,${lines} @@\n${'+const linea = 1;\n'.repeat(lines)}`;
  };
  const whole = Array.from({ length: FILES }, (_, i) => file(i));
  assert.ok(whole.map((_, i) => headerLine(name(i))).join('').length > RUN_CHANGES_PATCH_HARD_MAX_CHARS, 'solo las cabeceras pasan del tope duro del server');
  const out = budgetPatch(whole.join(''), LIMITS);
  assert.ok(out.length <= RUN_CHANGES_PATCH_MAX_CHARS, `${out.length} > ${RUN_CHANGES_PATCH_MAX_CHARS}`);
  const indexes = piecesOf(out).map((piece) => {
    const i = Number(/fichero-(\d+)\.ts b\//.exec(piece)?.[1]);
    assert.ok(piece === whole[i] || piece === headerLine(name(i)), `el trozo ${i} no es un fichero entero ni su cabecera`);
    return i;
  });
  assert.ok(indexes.length > 0);
  assert.ok(indexes.every((i, k) => k === 0 || i > indexes[k - 1]!), 'en el orden del diff');
  assert.ok(indexes.some((i) => out.includes(whole[i]!)) && indexes.length < FILES, 'unos enteros y el resto fuera');
});

test('budgetPatch: lo que no cabe se queda fuera y un fichero posterior más corto aún entra', () => {
  const file = (name: string, body: string): string => `${headerLine(name)}--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${body}\n`;
  const long = `docs/${'x'.repeat(300)}.md`;
  const [a, big, longOne, d] = [file('a.ts', '+uno'), file('big.ts', `+${'y'.repeat(500)}`), file(long, '+dos'), file('d.ts', '+tres')];
  const max = a!.length + headerLine('big.ts').length + d!.length;
  // big entra con su cabecera sola, la cabecera larga ya no cabe y d entra entero con lo que queda.
  const out = budgetPatch(a! + big! + longOne! + d!, { filePatchMaxChars: 1000, patchMaxChars: max });
  assert.equal(out, a! + headerLine('big.ts') + d!);
  assert.ok(out.length <= max);
  assert.equal(budgetPatch(a!, { filePatchMaxChars: 1000, patchMaxChars: headerLine('a.ts').length - 1 }), '', 'ni la cabecera cabe');
});

test('repos adicionales: el informe del principal más varios adicionales no pasa de filesMax ni de patchMaxChars', async () => {
  const FILES_PER_REPO = 30;
  const dirs = [repo(), repo(), repo(), repo()];
  const froms = await Promise.all(dirs.map((d) => snapshotTree(d, env)));
  dirs.forEach((d) =>
    Array.from({ length: FILES_PER_REPO }, (_, i) => fs.writeFileSync(path.join(d, `fichero-${String(i).padStart(2, '0')}.ts`), `export const n = ${i};\n`.repeat(5))),
  );
  const limits = { filesMax: 70, filePatchMaxChars: 1000, patchMaxChars: 4000 };
  const [main, ...extras] = dirs;
  const primary = await turnChanges(main!, env, froms[0]!, limits);
  const report = await withExtraChanges(primary, extras.map((dir, i) => ({ repo: `acme/lib-${i}`, dir, tree: froms[i + 1]! })), limits, env);
  assert.ok(report);
  assert.equal(report.files.length, limits.filesMax);
  assert.ok(report.patch.length <= limits.patchMaxChars, `${report.patch.length} > ${limits.patchMaxChars}`);
  const byRepo = report.files.reduce<Record<string, number>>((acc, f) => ({ ...acc, [f.repo ?? '']: (acc[f.repo ?? ''] ?? 0) + 1 }), {});
  assert.deepEqual(byRepo, { '': FILES_PER_REPO, 'acme/lib-0': FILES_PER_REPO, 'acme/lib-1': limits.filesMax - 2 * FILES_PER_REPO });
  assert.equal(report.filesTotal, FILES_PER_REPO * dirs.length, 'el repo que ya no cabe en la lista también cuenta');
  // cada trozo, un fichero entero (sus 5 líneas) o su cabecera sola; los de un adicional, bajo su repo.
  const pieces = piecesOf(report.patch);
  assert.ok(pieces.length > 0);
  pieces.forEach((piece) => {
    assert.ok(/^diff --git [^\n]*\n$/.test(piece) || piece.match(/^\+export const n/gm)?.length === 5, piece);
    assert.ok(/^diff --git a\/(?:fichero-|acme\/lib-[01]\/fichero-)/.test(piece), piece);
  });
});

test('repos adicionales: un adicional sin sitio en la lista no añade ficheros ni patch, y cuenta en filesTotal', async () => {
  const [main, extra] = [repo(), repo()];
  const [fromMain, fromExtra] = await Promise.all([snapshotTree(main, env), snapshotTree(extra, env)]);
  fs.writeFileSync(path.join(main, 'uno.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(extra, 'otro.ts'), 'export const b = 2;\n');
  const limits = { filesMax: 1, filePatchMaxChars: 1000, patchMaxChars: 4000 };
  const primary = await turnChanges(main, env, fromMain!, limits);
  const report = await withExtraChanges(primary, [{ repo: 'acme/lib', dir: extra, tree: fromExtra! }], limits, env);
  assert.deepEqual(report?.files.map((f) => f.path), ['uno.ts']);
  assert.equal(report?.filesTotal, 2);
  assert.ok(!report?.patch.includes('otro.ts'), 'su patch no lo encontraría nadie');
});

test('un patch más largo que el buffer de git no deja el turno sin diff: lista entera, lo que cabe y el resto sin cuerpo', async () => {
  const dir = repo();
  const from = await snapshotTree(dir, env);
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
  // 70 MB en líneas de texto (más que GIT_MAX_BUFFER): el patch se corta dentro de este fichero, antes de z.ts.
  fs.writeFileSync(path.join(dir, 'big.txt'), `${'x'.repeat(99)}\n`.repeat(700_000));
  fs.writeFileSync(path.join(dir, 'z.ts'), 'export const z = 1;\n');
  const report = await turnChanges(dir, env, from!, { filesMax: 10, filePatchMaxChars: 1000, patchMaxChars: 4000 });
  assert.ok(report, 'el turno conserva su diff');
  assert.deepEqual(report.files.map((f) => f.path), ['a.ts', 'big.txt', 'z.ts']);
  assert.equal(report.files.find((f) => f.path === 'big.txt')?.additions, 700_000);
  const pieces = piecesOf(report.patch);
  assert.equal(pieces.length, 2, 'z.ts quedó detrás del corte: sigue en la lista');
  assert.match(pieces[0]!, /\+export const a = 1;/);
  assert.equal(pieces[1], headerLine('big.txt'));
});

test('cutPatchAtFile: el fichero cortado a media se queda en su cabecera; una cabecera a medias, fuera', () => {
  const whole = `${headerLine('a.ts')}--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n+uno\n`;
  assert.equal(cutPatchAtFile(`${whole}${headerLine('b.ts')}--- a/b.ts\n+++ b/b.ts\n@@ -1,9 +1,9`), `${whole}${headerLine('b.ts')}`);
  assert.equal(cutPatchAtFile(`${whole}diff --git a/b.t`), whole);
  assert.equal(cutPatchAtFile(`${headerLine('a.ts')}--- a/a.ts`), headerLine('a.ts'), 'un solo fichero');
  assert.equal(cutPatchAtFile('diff --git a/a.t'), '');
});

test('maskDiffSecrets: el código sigue legible; los literales, los .env y los tokens no salen', () => {
  ['+export async function login(email: string, password: string) {', '+  const token = getToken();', ' api_key: process.env.API_KEY,'].forEach((line) => {
    assert.equal(maskDiffSecrets(line), line);
    assert.notEqual(maskSecrets(line), line, 'el feed sigue con su asignación genérica');
  });
  assert.equal(maskDiffSecrets('+const password = "hunter2";'), `+const ${SECRET_MASK};`);
  assert.equal(maskDiffSecrets('+DB_PASSWORD=hunter2'), `+${SECRET_MASK}`);
  assert.equal(maskDiffSecrets(' export API_TOKEN=abc123'), ` export ${SECRET_MASK}`);
  assert.equal(maskDiffSecrets('+secret=x\n+NEXT=1'), `+${SECRET_MASK}\n+NEXT=1`, 'por línea');
  assert.equal(maskDiffSecrets('+    - DB_PASSWORD=hunter2'), `+    - ${SECRET_MASK}`, 'sangría y lista');
});

test('maskDiffSecrets es lineal: una línea enorme sin secreto ni comillas cerradas no bloquea', () => {
  const inputs = [' '.repeat(200_000), 'a'.repeat(200_000), `+${' '.repeat(100_000)}x${'_'.repeat(100_000)}=`, `password="${'a'.repeat(200_000)}`, 'token: '.repeat(30_000)];
  inputs.forEach((text) => {
    const start = performance.now();
    maskDiffSecrets(text);
    assert.ok(performance.now() - start < 500, `${text.slice(0, 12)}… tardó demasiado`);
  });
});

test('maskDiffChunk: solo los hunks de un fichero de código llevan el enmascarado del diff; todo lo demás, el entero', () => {
  const chunk = (file: string, line: string): string => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n${line}\n`;
  // configuración, scripts, texto y lo que no lleva extensión de código.
  ['config/app.yml', 'deploy/values.yaml', '.env.example', 'app.properties', 'Dockerfile', 'my.cnf.conf', 'deploy.sh', 'notes.md', 'package.json', 'credentials'].forEach((file) =>
    assert.equal(maskDiffChunk(chunk(file, '+  password: hunter2')), chunk(file, `+  ${SECRET_MASK}`), file),
  );
  assert.equal(maskDiffChunk(chunk('deploy.sh', '+mysql -u root --password=hunter2 db')), chunk('deploy.sh', `+mysql -u root --${SECRET_MASK} db`));
  // el código sigue legible, también con espacios en la ruta.
  ['src/login.ts', 'app/models.py', 'cmd/main.go', 'src/My Page.tsx'].forEach((file) =>
    assert.equal(maskDiffChunk(chunk(file, '+  password: string;')), chunk(file, '+  password: string;'), file),
  );
  // la cabecera de un fichero de código no es código: un secreto en su ruta no sale y sus hunks siguen legibles.
  const pathSecret = maskDiffChunk(chunk('dumps/token=abc123def.ts', '+  password: string;'));
  assert.doesNotMatch(pathSecret, /abc123def/);
  assert.match(pathSecret, /\n\+ {2}password: string;\n$/);
  // renombrados: desde un .yml (sus líneas quitadas) y de texto a código, el entero; y una ruta entre las comillas de git.
  const renamed = 'diff --git a/config.yml b/notes.txt\nrename from config.yml\nrename to notes.txt\n@@ -1 +0,0 @@\n-password: hunter2\n';
  assert.equal(maskDiffChunk(renamed), renamed.replace('-password: hunter2', `-${SECRET_MASK}`));
  const toCode = 'diff --git a/notes.md b/notes.ts\nrename from notes.md\nrename to notes.ts\n@@ -1 +0,0 @@\n-password: hunter2\n';
  assert.equal(maskDiffChunk(toCode), toCode.replace('-password: hunter2', `-${SECRET_MASK}`));
  // una ruta con el separador dentro hace ambigua la cabecera: el entero.
  const ambiguous = 'diff --git a/x b/y.ts b/x b/y.ts\n@@ -0,0 +1 @@\n+password: hunter2\n';
  assert.equal(maskDiffChunk(ambiguous), ambiguous.replace('+password: hunter2', `+${SECRET_MASK}`));
  const quoted = 'diff --git "a/x\\"y.yml" "b/x\\"y.yml"\n@@ -0,0 +1 @@\n+password: hunter2\n';
  assert.equal(maskDiffChunk(quoted), quoted.replace('+password: hunter2', `+${SECRET_MASK}`));
  // en un .env, también las claves que el enmascarado del feed no reconoce.
  assert.equal(maskDiffChunk(chunk('.env', '+SECRET_KEY=abc')), chunk('.env', `+${SECRET_MASK}`));
  assert.equal(maskDiffChunk(chunk('.env', '+AWS_SECRET_ACCESS_KEY=abc')), chunk('.env', `+${SECRET_MASK}`));
  // sin cabecera reconocible, los dos.
  assert.equal(maskDiffChunk('+password: hunter2\n'), `+${SECRET_MASK}\n`);
});

test('la foto no pierde una edición del mismo tamaño en el mismo segundo que el último stat (racy git)', async () => {
  const dir = repo();
  const file = path.join(dir, 'login.ts');
  // el último stat del índice real y la edición del turno caen en el mismo segundo; la foto se hace en el siguiente.
  const second = new Date(Math.floor(Date.now() / 1000) * 1000 - 5000);
  fs.utimesSync(file, second, second);
  git(dir, 'add', 'login.ts');
  fs.utimesSync(path.join(dir, '.git', 'index'), second, second);
  const from = (await snapshotTree(dir, env))!;
  fs.writeFileSync(file, 'const a = 9;\nexport { a };\n');
  fs.utimesSync(file, second, second);
  const report = await turnChanges(dir, env, from, LIMITS);
  assert.deepEqual(report?.files.map((f) => f.path), ['login.ts']);
});

test('maskDiffSecrets: un literal largo o sin cerrar, y un identificador que lleva la palabra', () => {
  assert.equal(maskDiffSecrets('+  secretKey: "abc",'), `+  ${SECRET_MASK},`);
  assert.equal(maskDiffSecrets('+const name = "duck";'), '+const name = "duck";');
  assert.equal(maskDiffSecrets(`+  headers: { 'x-api-key': 'abc' },`), `+  headers: { '${SECRET_MASK} },`, 'con guiones');
  assert.equal(maskDiffSecrets('-password = "x"'), `-${SECRET_MASK}`, 'el prefijo de una línea quitada se conserva');
  assert.equal(maskDiffSecrets(`+const token = "${'a'.repeat(2000)}";`), `+const ${SECRET_MASK};`);
  assert.equal(maskDiffSecrets('+password = "sin cerrar\n+siguiente'), `+${SECRET_MASK}\n+siguiente`);
  assert.equal(maskDiffSecrets(`+api_key:${' '.repeat(40)}'x'`), `+${SECRET_MASK}`);
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
