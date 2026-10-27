// catálogo de slash commands (t#555): del init del cli (verdad de lo cargado) a comandos invocables con su ayuda, sin
// built-ins, sin salir de su directorio por un symlink y con los del proyecto solo en edición; y lo que el catálogo de
// la máquina guarda y sube (una vez por huella, con reintento espaciado).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { consumeStreamLine, newStreamState } from '../src/claude.js';
import {
  parseCommandHelp,
  parseInitCatalog,
  resolveSlashCommands,
  SLASH_COMMANDS_RETRY_MS,
  SLASH_UPLOAD,
  SlashCommandCatalog,
  type InitCatalog,
} from '../src/slash-commands.js';
import type { SlashCommand } from '../src/vendor/runner-protocol/index.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-slash-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// config del usuario, un plugin, un proyecto y un secreto fuera de todos.
const configDir = path.join(tmp, 'claude');
const pluginDir = path.join(tmp, 'plugins', 'code-review');
const projectDir = path.join(tmp, 'repo');
const secret = path.join(tmp, 'secret.txt');
write(path.join(configDir, 'commands', 'bugfix.md'), '---\ndescription: arregla un bug\nargument-hint: "[descripción]"\n---\nI am reporting a bug: $ARGUMENTS\n');
write(path.join(configDir, 'commands', 'frontend', 'component.md'), '# crea un componente\n\ncuerpo');
write(path.join(configDir, 'skills', 'deep-dive', 'SKILL.md'), '---\nname: deep-dive\ndescription: >\n  investiga a fondo\n  con fuentes\n---\n');
write(path.join(pluginDir, 'commands', 'code-review.md'), '---\ndescription: \'revisa un pr\'\n---\n');
write(path.join(projectDir, '.claude', 'commands', 'deploy.md'), '---\ndescription: despliega el repo\n---\n');
write(secret, 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB\n');
fs.symlinkSync(secret, path.join(projectDir, '.claude', 'commands', 'leak.md'));

const init: InitCatalog = {
  slashCommands: ['bugfix', 'component', 'code-review:code-review', 'deploy', 'leak', 'compact', 'clear', 'deep-dive', 'deep-research', 'code-review'],
  skills: ['deep-dive', 'deep-research', 'code-review'],
  plugins: [{ name: 'code-review', path: pluginDir }],
};
const byName = (list: SlashCommand[]): Record<string, SlashCommand> => Object.fromEntries(list.map((c) => [c.name, c]));

test('el init: slash_commands, skills y plugins con ruta; sin slash_commands no hay catálogo', () => {
  const state = newStreamState();
  consumeStreamLine(state, JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', slash_commands: ['bugfix', 7], skills: ['x'], plugins: [{ name: 'p', path: '/p' }, { name: 'roto' }] }));
  assert.equal(state.initModel, 'claude-opus-5-5');
  assert.deepEqual(state.initCatalog, { slashCommands: ['bugfix'], skills: ['x'], plugins: [{ name: 'p', path: '/p' }] });
  assert.equal(parseInitCatalog({ skills: ['x'] }), null);
});

test('la ayuda: frontmatter de una línea, con comillas o en bloque; sin descripción, la primera línea del cuerpo', () => {
  assert.deepEqual(parseCommandHelp('---\ndescription: "valida la rama"\nargument-hint: [rama]\n---\ncuerpo', true), { description: 'valida la rama', argumentHint: '[rama]' });
  assert.deepEqual(parseCommandHelp('---\ndescription: |\n  línea uno\n  línea dos\nname: x\n---\n', false), { description: 'línea uno línea dos', argumentHint: null });
  assert.deepEqual(parseCommandHelp('\n\n## Crea un PR\nresto', true), { description: 'Crea un PR', argumentHint: null });
  assert.deepEqual(parseCommandHelp('solo cuerpo', false), { description: null, argumentHint: null }, 'una skill sin descripción no tiene ayuda');
  assert.equal(parseCommandHelp('---\ndescription: usa ghp_abcdefghijklmnopqrstuvwxyz0123456789AB\n---\n', true).description?.includes('ghp_'), false, 'enmascarada');
  assert.ok((parseCommandHelp(`---\ndescription: ${'x'.repeat(2000)}\n---\n`, true).description?.length ?? 0) < 2000, 'recortada');
});

test('en lectura: sin los del proyecto, sin built-ins, la skill del cli sin fichero y cada uno con su ámbito', () => {
  const list = resolveSlashCommands(init, { configDir, projectCwd: null });
  const got = byName(list);
  assert.deepEqual(Object.keys(got).sort(), ['bugfix', 'code-review', 'code-review:code-review', 'component', 'deep-dive', 'deep-research']);
  assert.equal(got['code-review']?.scope, 'bundled', 'un nombre suelto que coincide con un plugin es del cli');
  assert.deepEqual(got.bugfix, { name: 'bugfix', scope: 'user', description: 'arregla un bug', argumentHint: '[descripción]' });
  assert.equal(got.component?.description, 'crea un componente', 'comando anidado, por su nombre suelto');
  assert.equal(got['deep-dive']?.description, 'investiga a fondo con fuentes');
  assert.deepEqual(got['code-review:code-review'], { name: 'code-review:code-review', scope: 'plugin', description: 'revisa un pr', argumentHint: null });
  assert.deepEqual(got['deep-research'], { name: 'deep-research', scope: 'bundled', description: null, argumentHint: null });
});

test('en edición: los del proyecto; un symlink que sale del cwd se lista sin leerlo', () => {
  const got = byName(resolveSlashCommands(init, { configDir, projectCwd: projectDir }));
  assert.deepEqual(got.deploy, { name: 'deploy', scope: 'project', description: 'despliega el repo', argumentHint: null });
  assert.deepEqual(got.leak, { name: 'leak', scope: 'project', description: null, argumentHint: null });
});

test('un `.claude/commands` commiteado como symlink hacia fuera del cwd no se recorre ni se lee', () => {
  const outside = path.join(tmp, 'fuera');
  write(path.join(outside, 'robado.md'), '---\ndescription: secreto de fuera\n---\n');
  const repo = path.join(tmp, 'repo-symlink');
  fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
  fs.symlinkSync(outside, path.join(repo, '.claude', 'commands'));
  const got = resolveSlashCommands({ slashCommands: ['robado'], skills: [], plugins: [] }, { configDir, projectCwd: repo });
  assert.deepEqual(got, [], 'ni siquiera se indexa: sin fichero dentro no es invocable');
});

test('un fifo con forma de comando no cuelga la lectura: se lista sin ayuda', () => {
  const dir = path.join(tmp, 'claude-fifo');
  fs.mkdirSync(path.join(dir, 'commands'), { recursive: true });
  execFileSync('mkfifo', [path.join(dir, 'commands', 'tubo.md')]);
  const started = Date.now();
  const got = resolveSlashCommands({ slashCommands: ['tubo'], skills: [], plugins: [] }, { configDir: dir, projectCwd: null });
  assert.deepEqual(got, [{ name: 'tubo', scope: 'user', description: null, argumentHint: null }]);
  assert.ok(Date.now() - started < 1000, 'sin bloquear');
});

test('el catálogo: usuario desde lectura, proyecto por repo desde edición, guardado y recargado', () => {
  const file = path.join(tmp, 'catalog.json');
  const catalog = new SlashCommandCatalog(file);
  const user = (name: string): SlashCommand => ({ name, scope: 'user', description: null, argumentHint: null });
  const project = (name: string): SlashCommand => ({ name, scope: 'project', description: null, argumentHint: null });
  assert.equal(catalog.pending(), null, 'vacío: nada que subir');

  assert.equal(catalog.record({ edit: true, repo: 'okt/api', commands: [user('bugfix'), project('deploy')] }), true);
  assert.deepEqual(catalog.pending()?.catalog, { user: [user('bugfix')], repos: [{ repo: 'okt/api', commands: [project('deploy')] }] });
  // uno de lectura fija la lista del usuario; uno de edición posterior ya no la pisa.
  catalog.record({ edit: false, repo: 'okt/api', commands: [user('bugfix'), user('pr')] });
  catalog.record({ edit: true, repo: 'okt/web', commands: [user('solo-en-web')] });
  assert.equal(catalog.record({ edit: false, repo: null, commands: [user('bugfix'), user('pr')] }), false, 'sin cambios no escribe');
  const reloaded = new SlashCommandCatalog(file).pending()!.catalog;
  assert.deepEqual(reloaded.user.map((c) => c.name), ['bugfix', 'pr']);
  assert.deepEqual(reloaded.repos.map((r) => r.repo), ['okt/api'], 'un repo sin comandos de proyecto no se guarda');
  // otro de edición en okt/api sin comandos de proyecto lo saca.
  catalog.record({ edit: true, repo: 'okt/api', commands: [user('bugfix')] });
  assert.deepEqual(catalog.pending()?.catalog.repos, []);
});

test('la subida: una vez por huella, el fallo espaciado y un server sin la ruta no se reintenta', () => {
  const catalog = new SlashCommandCatalog(path.join(tmp, 'upload.json'));
  catalog.record({ edit: false, repo: null, commands: [{ name: 'bugfix', scope: 'user', description: null, argumentHint: null }] });
  const now = 1_000_000;
  const first = catalog.pending(now)!;
  catalog.settle(first.hash, SLASH_UPLOAD.failed, now);
  assert.equal(catalog.pending(now + 1), null, 'recién fallada');
  assert.ok(catalog.pending(now + SLASH_COMMANDS_RETRY_MS), 'pasado el espacio, otra vez');
  catalog.settle(first.hash, SLASH_UPLOAD.ok, now);
  assert.equal(catalog.pending(now + SLASH_COMMANDS_RETRY_MS * 2), null, 'ya la tiene');
  catalog.settle(first.hash, SLASH_UPLOAD.unsupported, now);
  assert.equal(catalog.pending(now + SLASH_COMMANDS_RETRY_MS * 2), null, 'un server sin la ruta no se reintenta');
  catalog.record({ edit: false, repo: null, commands: [{ name: 'pr', scope: 'user', description: null, argumentHint: null }] });
  assert.ok(catalog.pending(now + 1), 'con un catálogo nuevo, sí');
});

test('cada plataforma tiene su catálogo: los comandos de un repo de una no llegan a otra', () => {
  const a = new SlashCommandCatalog(path.join(tmp, 'a.json'));
  const b = new SlashCommandCatalog(path.join(tmp, 'b.json'));
  a.record({ edit: true, repo: 'cliente/privado', commands: [{ name: 'deploy', scope: 'project', description: 'despliega', argumentHint: null }] });
  assert.equal(b.pending(), null, 'la otra no tiene nada que subir');
  assert.deepEqual(a.pending()?.catalog.repos.map((r) => r.repo), ['cliente/privado']);
});
