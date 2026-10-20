// feed de progreso: qué sale del stream-json hacia el server y qué no (resultados, rutas, secretos,
// lo tecleado en tools ajenas a la plataforma y query/fragmento de las urls).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StreamContent, StreamLine } from '../src/claude.js';
import { clip, displayUrl, feedEventsFromStream, redactPaths, summarizeToolUse, systemEvent, type FeedContext } from '../src/feed.js';
import { maskSecrets, SECRET_MASK } from '../src/secret-mask.js';

const ctx: FeedContext = { cwd: '/home/u/dev/app/.duckhunt/worktrees/conv-88', home: '/home/u', bodyMaxChars: 4000, toolArgMaxChars: 200 };

const assistant = (content: object[]): StreamLine => ({ type: 'assistant', message: { content: content as StreamContent[] } });

test('prosa y tool calls del asistente; nunca thinking ni tool_result', () => {
  const events = feedEventsFromStream(
    assistant([
      { type: 'thinking', thinking: 'pienso' },
      { type: 'text', text: '  Voy a leer el fichero.  ' },
      { type: 'tool_use', name: 'Read', input: { file_path: `${ctx.cwd}/src/a.ts`, offset: 10, limit: 5 } },
    ]),
    ctx,
  );
  assert.deepEqual(events, [
    { kind: 'text', body: 'Voy a leer el fichero.' },
    { kind: 'tool', tool: 'Read', body: 'src/a.ts:10-14' },
  ]);
  assert.deepEqual(feedEventsFromStream({ type: 'user', message: { content: [{ type: 'tool_result', text: 'SECRETO' }] } }, ctx), []);
  assert.deepEqual(feedEventsFromStream({ type: 'result', result: 'x' }, ctx), []);
});

test('tools internas del cli (ToolSearch) fuera del feed', () => {
  const events = feedEventsFromStream(
    assistant([
      { type: 'tool_use', name: 'ToolSearch', input: { query: 'select:duckhunt-ask-user' } },
      { type: 'tool_use', name: 'mcp__duckhunt__duckhunt-ask-user', input: { kind: 'yes_no', question: '¿sigo?' } },
    ]),
    ctx,
  );
  assert.deepEqual(events.map((e) => e.tool), ['mcp__duckhunt__duckhunt-ask-user']);
});

test('rutas: relativas dentro del worktree, solo el nombre fuera', () => {
  assert.equal(summarizeToolUse('Edit', { file_path: `${ctx.cwd}/lib/b.ts`, old_string: 'x', new_string: 'y' }, ctx), 'lib/b.ts');
  assert.equal(summarizeToolUse('Read', { file_path: '/home/u/.aws/credentials' }, ctx), '…/credentials');
  assert.equal(summarizeToolUse('Write', { file_path: 'rel/c.md', content: 'no debe salir' }, ctx), 'rel/c.md');
  assert.equal(summarizeToolUse('Grep', { pattern: 'TODO', path: `${ctx.cwd}/src`, glob: '*.ts' }, ctx), 'TODO · src · *.ts');
  assert.equal(summarizeToolUse('Glob', { pattern: '**/*.svelte' }, ctx), '**/*.svelte');
});

test('bash: primera línea del comando, recortada y con rutas redactadas', () => {
  assert.equal(summarizeToolUse('Bash', { command: `cd ${ctx.cwd} && git status\ngit diff`, description: 'x' }, ctx), 'cd . && git status …');
  const long = summarizeToolUse('Bash', { command: `echo ${'a'.repeat(500)}` }, ctx);
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});

test('tools mcp: refs primero y campos cortos, sin textos largos', () => {
  const body = summarizeToolUse('mcp__duckhunt__duckhunt-note-add', { targetId: 318, kind: 'progress', body: 'nota larguísima', author: 'claude' }, ctx);
  assert.equal(body, 't#318 kind=progress author=claude');
  assert.equal(summarizeToolUse('mcp__duckhunt__duckhunt-entry-get', { entryId: 42 }, ctx), 'e#42');
});

test('tecleado de tools ajenas a la plataforma: solo su longitud; las de la plataforma, tal cual (t#495)', () => {
  const run: FeedContext = { ...ctx, platformServer: 'duckhunt' };
  // un mcp ajeno cualquiera (las sesiones de navegador del daemon tienen su resumen propio: el test de abajo).
  const fill = summarizeToolUse('mcp__odysea__fill', { selector: '#password', value: 'hunter2' }, run);
  assert.equal(fill, 'selector=#password value=‹7›');
  assert.ok(!fill.includes('hunter2'));
  assert.equal(summarizeToolUse('mcp__odysea__evaluate', { expression: 'document.cookie' }, run), 'expression=‹15›');
  assert.equal(summarizeToolUse('mcp__odysea__handle_dialog', { action: 'accept', promptText: 'secreto' }, run), 'action=accept promptText=‹7›');
  // la plataforma ya recibe sus propios argumentos con la llamada: ocultarlos no protege nada.
  assert.equal(summarizeToolUse('mcp__duckhunt__duckhunt-set-custom-field', { targetId: 5, value: 'Alta' }, run), 't#5 value=Alta');
  // sin servidor de la plataforma conocido, todo se redacta.
  assert.equal(summarizeToolUse('mcp__duckhunt__duckhunt-set-custom-field', { targetId: 5, value: 'Alta' }, ctx), 't#5 value=‹4›');
});

test('urls: solo origen y ruta, nunca query ni fragmento; de esquemas no web, solo el esquema (t#495)', () => {
  assert.equal(displayUrl('https://acme.atlassian.net/browse/OKT-1?token=abc#x'), 'https://acme.atlassian.net/browse/OKT-1?…');
  assert.equal(displayUrl('http://localhost:5173/app'), 'http://localhost:5173/app');
  assert.equal(displayUrl('data:text/html,<b>secreto</b>'), 'data:…');
  assert.equal(displayUrl('file:///home/u/.ssh/id_rsa'), 'file:…');
  assert.equal(displayUrl('no es una url'), 'no es una url');
  assert.equal(summarizeToolUse('WebFetch', { url: 'https://api.example.com/v1/items?api_key=s3cr3t', prompt: 'x' }, ctx), 'https://api.example.com/v1/items?…');
  assert.equal(summarizeToolUse('mcp__res_browser_jira__navigate', { url: 'https://acme.atlassian.net/login?next=/x' }, ctx), 'url=https://acme.atlassian.net/login?…');
});

test('secretos enmascarados antes de recortar', () => {
  const key = 'AKIAABCDEFGHIJKLMNOP';
  assert.equal(maskSecrets(`id ${key} ok`), `id ${SECRET_MASK} ok`);
  assert.equal(maskSecrets('token ghp_abcdefghijklmnopqrstuvwxyz0123'), `token ${SECRET_MASK}`);
  assert.equal(maskSecrets('curl -H "Authorization: Bearer abc.def-ghi_jkl"'), `curl -H "Authorization: ${SECRET_MASK}"`);
  assert.equal(maskSecrets('xoxb-1234567890-abcdef'), SECRET_MASK);
  assert.equal(maskSecrets('dha_0123456789abcdefXYZ'), SECRET_MASK);
  const bash = summarizeToolUse('Bash', { command: `aws configure set aws_secret_access_key abc && export AWS_ACCESS_KEY_ID=${key}` }, ctx);
  assert.ok(!bash.includes(key));
  const text = feedEventsFromStream(assistant([{ type: 'text', text: `la clave es ${key}` }]), ctx);
  assert.equal(text[0]?.body, `la clave es ${SECRET_MASK}`);
});

test('texto y notas de sistema recortados al tope del claim', () => {
  const small: FeedContext = { ...ctx, bodyMaxChars: 10 };
  assert.equal(feedEventsFromStream(assistant([{ type: 'text', text: 'abcdefghijklmnop' }]), small)[0]?.body, 'abcdefghi…');
  assert.deepEqual(systemEvent(`checkout ${ctx.home}/dev/app`, ctx), { kind: 'system', body: 'checkout ~/dev/app' });
  assert.equal(clip('abc', 5), 'abc');
  assert.equal(redactPaths(`${ctx.cwd}/x y ${ctx.home}/z`, ctx), './x y ~/z');
});

test('tools de una sesión de navegador: el selector, la tecla, la acción o el largo del js; nunca lo tecleado (t#495, M7)', () => {
  const b = (tool: string): string => `mcp__res_browser_jira__${tool}`;
  assert.equal(summarizeToolUse(b('fill'), { selector: '#password', value: 'hunter2' }, ctx), '#password');
  assert.equal(summarizeToolUse(b('select_option'), { selector: '#pais', values: ['es'] }, ctx), '#pais');
  assert.equal(summarizeToolUse(b('evaluate'), { expression: 'document.cookie' }, ctx), 'js ‹15›');
  assert.equal(summarizeToolUse(b('evaluate'), { expression: 'el => el.value', selector: 'input' }, ctx), 'js ‹14› input');
  assert.equal(summarizeToolUse(b('handle_dialog'), { action: 'accept', promptText: 'secreto' }, ctx), 'accept');
  assert.equal(summarizeToolUse(b('press_key'), { key: 'Enter' }, ctx), 'Enter');
  // el resto, el genérico: la url sin query.
  assert.equal(summarizeToolUse(b('navigate'), { url: 'https://acme.atlassian.net/x?token=1' }, ctx), 'url=https://acme.atlassian.net/x?…');
});
