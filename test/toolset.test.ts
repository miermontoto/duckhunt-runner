// toolset_v1 en sombra (t#495, M5): el render del daemon contra las listas que el server manda en cada caso de su
// matriz (test/fixtures/toolset-v1, vendorizados del protocolo), la validación estricta del toolset, su corte con el
// techo de la plataforma, que el claim lo guarde en sombra sin tocar claim.toolset y el diff recortado.
// la única diferencia admitida es la buscada (TOOLSET_SHADOW_KNOWN.awsWithoutGrant): un run de lectura sin grant de
// aws, al que el kit legacy da la aws en lectura con la identidad por defecto de la máquina y toolset_v1 no (decisión
// de t#495: `aws.default` la expone el usuario a mano). esos casos tienen que casar EXACTO quitando esos patrones.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseClaim } from '../src/claim.js';
import { LEGACY_CEILING, DEFAULT_CEILING, type ToolsetCeiling } from '../src/platforms/types.js';
import { intersectToolset } from '../src/toolset/intersect.js';
import { parseToolsetV1 } from '../src/toolset/parse.js';
import { AWS_READ_ALLOWED, renderClaudeTools, type ClaudeTools } from '../src/toolset/render.js';
import { compareToolset } from '../src/toolset/shadow.js';
import {
  RUNNER_CAPABILITY,
  RUNNER_TOOLSET_SHADOW_ID_MAX_CHARS,
  RUNNER_TOOLSET_SHADOW_IDS_MAX,
  TOOLSET_SHADOW_KNOWN,
  type ToolsetV1,
} from '../src/vendor/runner-protocol/index.js';

// los tests compilan a dist-test/test: los fixtures se leen del árbol fuente.
const FIXTURES = new URL('../../test/fixtures/', import.meta.url);

interface V1Fixture {
  capabilities: string[];
  toolset: unknown;
  tools: { allowed: string[]; disallowed: string[] };
  permissionMode: string;
  mcpServerName: string;
}

const readJson = <T>(rel: string): T => JSON.parse(fs.readFileSync(new URL(rel, FIXTURES), 'utf8')) as T;
const V1_FILES = fs
  .readdirSync(new URL('toolset-v1/', FIXTURES))
  .filter((f) => f.endsWith('.json'))
  .sort();
const AWS_READ = new Set(AWS_READ_ALLOWED);

const base: ToolsetV1 = {
  v: 1,
  shell: 'full',
  fsWrite: true,
  memory: true,
  web: true,
  vcsPush: true,
  grants: [
    { type: 'repo', key: 'acme/api', access: 'full' },
    { type: 'aws', key: '123456789012' },
  ],
  platformTools: ['duckhunt-entry-get', 'duckhunt-note-add'],
};

test('render: cada caso de la matriz del server da sus listas; la única diferencia, la buscada y solo ella', (t) => {
  assert.equal(V1_FILES.length, fs.readdirSync(new URL('claim-kits/', FIXTURES)).length, 'un toolset_v1 por claim de la matriz');
  const outcome = V1_FILES.map((file) => {
    const fx = readJson<V1Fixture>(`toolset-v1/${file}`);
    const toolset = parseToolsetV1(fx.toolset);
    const ctx = { mcpServerName: fx.mcpServerName, awsCli: fx.capabilities.includes(RUNNER_CAPABILITY.aws) };
    const server: ClaudeTools = { ...fx.tools, permissionMode: fx.permissionMode };
    const rendered = renderClaudeTools(toolset, ctx);
    const shadow = compareToolset(server, toolset, ctx);
    assert.equal(shadow.explained, true, `${file}: ${JSON.stringify(shadow.diff)}`);
    if (shadow.match) {
      // orden incluido: el render repite el del server.
      assert.deepEqual(rendered, server, file);
      return 'match';
    }
    // allowlist (ver cabecera): sin grant de aws, lo único que falta son los patrones de la aws en lectura (y lo dice
    // explained: el server no lo avisa).
    assert.deepEqual(shadow.known, [TOOLSET_SHADOW_KNOWN.awsWithoutGrant], file);
    assert.deepEqual(rendered, { ...server, allowed: server.allowed.filter((id) => !AWS_READ.has(id)) }, file);
    return 'awsWithoutGrant';
  });
  const count = (kind: string): number => outcome.filter((o) => o === kind).length;
  t.diagnostic(`${count('match')} sin diferencia, ${count('awsWithoutGrant')} con la diferencia buscada (aws sin grant), de ${V1_FILES.length}`);
  assert.ok(count('match') > 0);
});

// el flip (t#495, M5): ante una máquina que anuncia su aws por defecto, el server concede `default` a los runs sin
// cuenta, así que la diferencia buscada solo queda en los que traen una cuenta que la máquina no anuncia (aws_strict).
test('render ante una máquina que anuncia su aws por defecto: las listas del server sin diferencia, salvo una cuenta no anunciada', (t) => {
  const files = fs
    .readdirSync(new URL('toolset-v1-aws-default/', FIXTURES))
    .filter((f) => f.endsWith('.json'))
    .sort();
  assert.ok(files.length > 0 && files.every((f) => V1_FILES.includes(f)), 'un caso de la matriz cada uno');
  const outcome = files.map((file) => {
    const fx = readJson<V1Fixture>(`toolset-v1-aws-default/${file}`);
    const toolset = parseToolsetV1(fx.toolset);
    const ctx = { mcpServerName: fx.mcpServerName, awsCli: fx.capabilities.includes(RUNNER_CAPABILITY.aws) };
    const server: ClaudeTools = { ...fx.tools, permissionMode: fx.permissionMode };
    const shadow = compareToolset(server, toolset, ctx);
    assert.equal(shadow.explained, true, `${file}: ${JSON.stringify(shadow.diff)}`);
    if (shadow.match) {
      assert.deepEqual(renderClaudeTools(toolset, ctx), server, file);
      return 'match';
    }
    // la única que queda: la cuenta del run no la anuncia la máquina, ni cae en `default`.
    assert.ok(!toolset.grants.some((g) => g.type === 'aws'), `${file}: con grant de aws no debería quedar diferencia`);
    assert.deepEqual(shadow.known, [TOOLSET_SHADOW_KNOWN.awsWithoutGrant], file);
    return 'awsWithoutGrant';
  });
  const count = (kind: string): number => outcome.filter((o) => o === kind).length;
  t.diagnostic(`${count('match')} sin diferencia, ${count('awsWithoutGrant')} con una cuenta no anunciada, de ${files.length}`);
  assert.ok(count('awsWithoutGrant') < outcome.length / 2, 'casi todos casan: la aws por defecto cubre lo que daba el kit legacy');
});

test('parse: un toolset válido pasa tal cual; lo que no casa con el cable se rechaza entero', () => {
  assert.deepEqual(parseToolsetV1(base), base);
  const bad: [string, unknown][] = [
    ['no objeto', 'x'],
    ['campo desconocido', { ...base, extra: true }],
    ['otra versión', { ...base, v: 2 }],
    ['shell fuera de catálogo', { ...base, shell: 'root' }],
    ['flag que falta', { ...base, web: undefined }],
    ['flag no booleano', { ...base, vcsPush: 'sí' }],
    ['grants no lista', { ...base, grants: {} }],
    ['grant con campo desconocido', { ...base, grants: [{ type: 'repo', key: 'a/b', path: '/etc' }] }],
    ['tipo de grant no válido', { ...base, grants: [{ type: 'Repo', key: 'a/b' }] }],
    ['clave con espacios', { ...base, grants: [{ type: 'repo', key: 'a b' }] }],
    ['acceso fuera de catálogo', { ...base, grants: [{ type: 'repo', key: 'a/b', access: 'root' }] }],
    ['grants repetidos', { ...base, grants: [{ type: 'repo', key: 'a/b' }, { type: 'repo', key: 'a/b', access: 'full' }] }],
    ['demasiados grants', { ...base, grants: Array.from({ length: 33 }, (_, i) => ({ type: 'repo', key: `a/${i}` })) }],
    ['tool con coma', { ...base, platformTools: ['a,b'] }],
    ['tool no texto', { ...base, platformTools: [1] }],
  ];
  bad.forEach(([what, raw]) => assert.throws(() => parseToolsetV1(raw), /toolset_v1 inválido/, what));
});

test('techo: mínimo por nivel y AND por flag; un grant de un tipo sin techo se cae; lo recortado se anota', () => {
  assert.deepEqual(intersectToolset(base, LEGACY_CEILING), {
    toolset: { ...base, grants: [base.grants[0]!, { ...base.grants[1]!, access: 'read' }] },
    narrowed: [],
  });
  assert.deepEqual(intersectToolset(base, DEFAULT_CEILING), {
    toolset: { ...base, shell: 'none', fsWrite: false, memory: false, web: false, vcsPush: false, grants: [] },
    narrowed: ['shell', 'fsWrite', 'memory', 'web', 'vcsPush', 'grant:repo:acme/api', 'grant:aws:123456789012'],
  });
  const ceiling: ToolsetCeiling = { ...LEGACY_CEILING, shell: 'read', vcsPush: false, access: { repo: 'read' }, platformTools: ['duckhunt-entry-get'] };
  assert.deepEqual(intersectToolset(base, ceiling), {
    toolset: { ...base, shell: 'read', vcsPush: false, grants: [{ type: 'repo', key: 'acme/api', access: 'read' }], platformTools: ['duckhunt-entry-get'] },
    narrowed: ['shell', 'vcsPush', 'grant:repo:acme/api', 'grant:aws:123456789012', 'platformTools'],
  });
  // pedir menos que el techo no es recortar.
  assert.deepEqual(intersectToolset({ ...base, shell: 'none', web: false }, LEGACY_CEILING).narrowed, []);
});

test('claim: el toolset va en sombra con las listas del server tal cual; claim.toolset sigue null', (t) => {
  const kit = readJson<Record<string, unknown>>('claim-kits/prompt-read-full.json');
  const v1 = readJson<V1Fixture>('toolset-v1/prompt-read-full.json');
  const claim = parseClaim({ ...kit, toolset: v1.toolset });
  assert.equal(claim.toolset, null, 'en sombra: nada aísla ni cambia el spawn');
  assert.deepEqual(claim.toolsetShadow?.toolset, parseToolsetV1(v1.toolset));
  assert.deepEqual(claim.toolsetShadow?.server, { ...v1.tools, permissionMode: v1.permissionMode }, 'las del server, antes del deny forzado de lectura');
  assert.ok(claim.tools.disallowed.length > v1.tools.disallowed.length, 'el spawn sí lleva el deny forzado');
  assert.equal(parseClaim(kit).toolsetShadow, null, 'sin toolset, sin sombra');
  const warn = t.mock.method(console, 'warn', () => {});
  const broken = parseClaim({ ...kit, toolset: { ...(v1.toolset as object), extra: 1 } });
  assert.equal(broken.toolsetShadow, null, 'uno mal formado no tumba el claim');
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /toolset_v1 inválido: el toolset con campos desconocidos \(extra\): sin sombra/);
});

test('sombra: el diff se recorta a los topes del server; el permission mode del daemon, si difiere', () => {
  const toolset = { ...base, shell: 'none' as const, grants: [] };
  const ctx = { mcpServerName: 'duckhunt', awsCli: true };
  const many = Array.from({ length: RUNNER_TOOLSET_SHADOW_IDS_MAX + 5 }, (_, i) => `mcp__duckhunt__tool-${i}-${'x'.repeat(RUNNER_TOOLSET_SHADOW_ID_MAX_CHARS)}`);
  const server: ClaudeTools = { ...renderClaudeTools(toolset, ctx), permissionMode: 'default' };
  const shadow = compareToolset({ ...server, allowed: [...server.allowed, ...many] }, toolset, ctx);
  assert.equal(shadow.match, false);
  assert.equal(shadow.explained, false);
  assert.deepEqual(shadow.known, []);
  assert.equal(shadow.diff?.allowedMissing.length, RUNNER_TOOLSET_SHADOW_IDS_MAX);
  assert.ok(shadow.diff?.allowedMissing.every((id) => id.length <= RUNNER_TOOLSET_SHADOW_ID_MAX_CHARS));
  assert.equal(shadow.diff?.permissionMode, 'dontAsk');
  assert.deepEqual(compareToolset({ ...server, permissionMode: 'dontAsk' }, toolset, ctx), { match: true, explained: true, known: [], diff: null });
});
