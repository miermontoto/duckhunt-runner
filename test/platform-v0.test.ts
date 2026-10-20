// la spec v0 en el daemon (t#495, M4): el discovery se valida antes de mandar un token (rutas del mismo server, la
// audiencia de la credencial, la versión y los topes), las capabilities salen como features y attestations, y un
// claim v0 se APLICA (platforms/claim-v0.ts): tools del render de toolset ∩ techo (nunca las listas del claim),
// recursos de sus grants, y rechazo entero si un grant no se puede servir. los 87 claims v0 de los fixtures se
// aplican y su render solo difiere de las listas del server en lo explicado. y de punta a punta contra un server v0
// de verdad (http en 127.0.0.1): discovery → claim → lease → events → result, un result duplicado sin reintentos y
// un cancel atendido en un latido.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { detectClaude, OPTIONAL_FLAGS, type ClaudeInfo } from '../src/claude.js';
import { loadConfig } from '../src/config.js';
import { allRunConfigDirs } from '../src/paths.js';
import { CLAIM_REJECT, claimOfV0, ClaimRejectedError, type V0Enforcement } from '../src/platforms/claim-v0.js';
import { parseDiscovery } from '../src/platforms/discovery.js';
import { LEGACY_CEILING, LEGACY_EXPOSE, type ToolsetCeiling } from '../src/platforms/types.js';
import { v0Announce } from '../src/platforms/v0.js';
import { runConfigDeny } from '../src/run-mcp-config.js';
import { secretPathsDeny } from '../src/secret-paths.js';
import { shadowOf } from '../src/toolset/shadow.js';
import { DUCKHUNT_EXT_ENDPOINT, V0_ENDPOINT, V0_FEATURE } from '../src/vendor/runner-protocol/index.js';
import { internals, type DaemonInternals, type SupervisorInternals } from './daemon-harness.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
const BASE = 'https://plataforma.test';
const REPO = 'okt/api';
const TYPES = ['repo', 'aws'];
const TRUSTED: V0Enforcement = { ceiling: LEGACY_CEILING, expose: LEGACY_EXPOSE, resourceTypes: TYPES, awsCli: true };
const PROTOCOL_HEADER = 'agent-runner-protocol';
const HOLD_POLL_MS = 20;
const WAIT_TIMEOUT_MS = 20_000;
// el latido mínimo del daemon (MIN_HEARTBEAT_MS) más holgura: lo que puede tardar en atender un cancel.
const CANCEL_WITHIN_MS = 5_000 + 3_000;

type Obj = Record<string, unknown>;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const v0Cases = (): string[] => fs.readdirSync(new URL('v0/', FIXTURES)).filter((f) => f.endsWith('.json')).sort();
const v0Run = (file: string): Obj => (JSON.parse(fs.readFileSync(new URL(`v0/${file}`, FIXTURES), 'utf8')) as { run: Obj }).run;
const capsOf = (file: string): string[] => (JSON.parse(fs.readFileSync(new URL(`toolset-v1/${file}`, FIXTURES), 'utf8')) as { capabilities: string[] }).capabilities;
const toolsetOf = (run: Obj): Obj => (run.policy as Obj).toolset as Obj;

function rejected(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof ClaimRejectedError && err.code === code, `esperaba ${code}`);
}

const discovery = (base: string, patch: Obj = {}): Obj => ({
  protocol: 'agent-runner',
  protocol_versions: ['0'],
  issuer: base,
  authorization_server_metadata: `${base}/.well-known/oauth-authorization-server`,
  resource: `${base}/api/runner`,
  oob_redirect_uri: `${base}/oauth/authorized`,
  endpoints: { ...V0_ENDPOINT },
  features: Object.values(V0_FEATURE),
  backends: ['claude_code'],
  extensions: [{ ns: 'x-duckhunt', version: '1', endpoints: { ...DUCKHUNT_EXT_ENDPOINT } }],
  limits: { announceMax: 64, eventBatchMax: 50, eventBodyMaxChars: 4000, eventToolMaxChars: 120, resultMaxChars: 20000, errorMaxChars: 2000, stderrTailMaxChars: 8000, requestBytesMax: 1048576 },
  ...patch,
});

test('discovery: se acepta el de la plataforma de esta credencial; nunca rutas a otro host, otra audiencia, otra versión o topes rotos', () => {
  const doc = parseDiscovery(discovery(BASE), BASE);
  assert.equal(doc.endpoints.claim, '/api/runner/v0/claim');
  assert.equal(doc.extensions.get('x-duckhunt')?.conversations, '/api/runner/ext/x-duckhunt/conversations');
  const bad = (patch: Obj): void => assert.throws(() => parseDiscovery(discovery(BASE, patch), BASE), /discovery v0 inválido/);
  bad({ endpoints: { ...V0_ENDPOINT, claim: '//otro.test/claim' } });
  bad({ endpoints: { ...V0_ENDPOINT, claim: 'https://otro.test/api/runner/v0/claim' } });
  bad({ endpoints: { ...V0_ENDPOINT, lease: '/api/runner/v0/runs/lease' } });
  bad({ resource: 'https://otro.test/api/runner' });
  bad({ protocol_versions: ['1'] });
  bad({ protocol: 'otra-cosa' });
  bad({ limits: { announceMax: 64 } });
  const odd = parseDiscovery(discovery(BASE, { extensions: [{ ns: 'sin-x', endpoints: {} }, { ns: 'x-mal', endpoints: { a: '//otro.test/a' } }] }), BASE);
  assert.deepEqual([...odd.extensions.keys()], ['x-mal'], 'una extensión mal formada se ignora');
  assert.deepEqual(odd.extensions.get('x-mal'), {}, 'y sus rutas a otro host, también');
});

test('las capabilities como features y attestations de v0; las implícitas no viajan', () => {
  assert.deepEqual(v0Announce(['events', 'checkout', 'read_shell', 'aws', 'native_memory', 'repo_edit', 'secret_paths', 'seed_budget', 'aws_strict', 'worktree_report', 'logout', 'model', 'toolset_v1']), {
    features: ['toolset_v1', 'resources.repo', 'checkout', 'backend.claude_code.read_shell', 'resources.cloud.aws', 'backend.claude_code.native_memory', 'x-duckhunt.repo_edit', 'x-duckhunt.seed_budget', 'x-duckhunt.worktree_report', 'model'],
    attestations: ['secret_paths', 'aws_strict'],
  });
});

test('los 87 claims v0 de los fixtures se aplican: id público, recursos de sus grants y un render que solo difiere en lo explicado', () => {
  const cases = v0Cases();
  assert.equal(cases.length, 87);
  cases.forEach((file) => {
    const raw = v0Run(file);
    const awsCli = capsOf(file).includes('aws');
    const { claim, narrowed } = claimOfV0(raw, { ...TRUSTED, awsCli });
    assert.deepEqual(narrowed, [], `${file}: el techo de confianza no recorta`);
    assert.equal(claim.run.id, 'r_fixture', file);
    assert.deepEqual(claim.toolset, { v: 1 }, `${file}: manda con toolset_v1 (la aws sin grant se aísla)`);
    const grants = (toolsetOf(raw).grants as { type: string; key: string }[]).map((g) => `${g.type}:${g.key}`);
    assert.deepEqual(claim.resources?.map((r) => `${r.type}:${r.key}`), grants, `${file}: un recurso por grant`);
    assert.ok(claim.toolsetShadow, `${file}: las listas del server solo para la sombra`);
    const { shadow } = shadowOf(claim.toolsetShadow, LEGACY_CEILING, { mcpServerName: claim.mcp.serverName, awsCli });
    assert.ok(shadow.explained, `${file}: el render difiere de las listas del server en algo no explicado`);
  });
});

test('las tools salen del render, nunca de las listas del claim', () => {
  const raw = clone(v0Run('prompt-read-full.json'));
  ((raw.backend as Obj).claude_code as Obj).allowed = ['Bash', 'Edit', 'mcp__duckhunt__lo-que-sea'];
  const { claim } = claimOfV0(raw, TRUSTED);
  assert.ok(!claim.tools.allowed.includes('Bash') && !claim.tools.allowed.includes('Edit'));
  assert.ok(!claim.tools.allowed.includes('mcp__duckhunt__lo-que-sea'));
  assert.ok(claim.tools.allowed.includes('mcp__duckhunt__duckhunt-run-reply'));
});

test('rechazos: tipo que no se sirve, clave no expuesta, techo sin acceso, recurso sin grant, campo de policy desconocido, mcp reservado', () => {
  const base = v0Run('prompt-read-full.json');
  const withGrant = (grant: Obj): Obj => {
    const raw = clone(base);
    (toolsetOf(raw).grants as Obj[]).push(grant);
    return raw;
  };
  rejected(() => claimOfV0(withGrant({ type: 'browser', key: 'jira', access: 'read' }), TRUSTED), CLAIM_REJECT.unknownType);
  rejected(() => claimOfV0(base, { ...TRUSTED, expose: { repo: ['otro/repo'] } }), CLAIM_REJECT.notExposed);
  rejected(() => claimOfV0(base, { ...TRUSTED, ceiling: { ...LEGACY_CEILING, access: {} } }), CLAIM_REJECT.notAllowed);
  const orphan = clone(base);
  (orphan.resources as Obj[]).push({ type: 'aws', key: '123456789012', params: { region: 'eu-west-1' } });
  rejected(() => claimOfV0(orphan, TRUSTED), CLAIM_REJECT.withoutGrant);
  const policyField = clone(base);
  (policyField.policy as Obj).sandbox = 'none';
  rejected(() => claimOfV0(policyField, TRUSTED), CLAIM_REJECT.unknownPolicy);
  const limitsField = clone(base);
  ((limitsField.policy as Obj).limits as Obj).turns = 3;
  rejected(() => claimOfV0(limitsField, TRUSTED), CLAIM_REJECT.unknownPolicy);
  const toolsetField = clone(base);
  toolsetOf(toolsetField).root = true;
  rejected(() => claimOfV0(toolsetField, TRUSTED), CLAIM_REJECT.invalid);
  const reserved = clone(base);
  (reserved.mcpServers as Obj[])[0]!.name = 'res_browser_jira';
  rejected(() => claimOfV0(reserved, TRUSTED), CLAIM_REJECT.invalid);
  rejected(() => claimOfV0(withGrant({ type: 'repo', key: 'okt/web', access: 'read' }), TRUSTED), CLAIM_REJECT.invalid);
  rejected(() => claimOfV0({ ...clone(base), id: 'no vale' }, TRUSTED), CLAIM_REJECT.invalid);
});

test('el techo acota: shell, escritura, web, push y el acceso de cada grant al mínimo; un run de lectura nunca escribe', () => {
  const ceiling: ToolsetCeiling = { shell: 'read', fsWrite: false, memory: true, web: false, vcsPush: false, access: { repo: 'read', aws: 'read' }, platformTools: '*' };
  const { claim, narrowed } = claimOfV0(v0Run('prompt-edit-full.json'), { ...TRUSTED, ceiling });
  assert.deepEqual(narrowed, ['shell', 'fsWrite', 'web', 'vcsPush', `grant:repo:${REPO}`]);
  ['Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'].forEach((t) => assert.ok(!claim.tools.allowed.includes(t), t));
  assert.equal(claim.resources?.[0]?.access, 'read');
  const greedy = clone(v0Run('prompt-read-full.json'));
  Object.assign(toolsetOf(greedy), { shell: 'full', fsWrite: true });
  const read = claimOfV0(greedy, TRUSTED);
  assert.deepEqual(read.narrowed, ['profile:read']);
  assert.ok(!read.claim.tools.allowed.includes('Bash') && !read.claim.tools.allowed.includes('Edit'));
});

test('la aws: un grant de `default` expuesto es un recurso del run; sin grant, el claim manda igual (y la aws se aísla)', () => {
  const raw = clone(v0Run('prompt-read-full.json'));
  (toolsetOf(raw).grants as Obj[]).push({ type: 'aws', key: 'default', access: 'read' });
  (raw.resources as Obj[]).push({ type: 'aws', key: 'default', params: { region: 'eu-west-1' } });
  const { claim } = claimOfV0(raw, { ...TRUSTED, expose: { repo: '*', aws: ['default'] } });
  assert.deepEqual(claim.resources?.find((r) => r.type === 'aws'), { type: 'aws', key: 'default', access: 'read', params: { region: 'eu-west-1' } });
  rejected(() => claimOfV0(raw, { ...TRUSTED, expose: { repo: '*', aws: ['123456789012'] } }), CLAIM_REJECT.notExposed);
});

// --- de punta a punta contra un server v0 de verdad ---

interface Seen {
  path: string;
  protocol: string | undefined;
  body: Obj;
}

interface FakeV0 {
  url: string;
  seen: Seen[];
  cancel: boolean;
  close(): Promise<void>;
}

// server v0 mínimo: discovery, token oauth, claim (un run y luego nada), lease, events, result (el segundo del mismo
// segmento, duplicate) y las conversaciones de la extensión.
function fakeV0(run: (url: string) => Obj): Promise<FakeV0> {
  const state: FakeV0 = { url: '', seen: [], cancel: false, close: async () => {} };
  let claimed = false;
  const results = new Set<string>();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', state.url);
      const reply = (data: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json', 'agent-runner-protocol': '0' });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === '/.well-known/agent-runner') return reply(discovery(state.url));
      // el token oauth va como formulario: aquí no se lee.
      if (url.pathname === '/oauth/token') return reply({ access_token: 'tok', refresh_token: 'rb2', expires_in: 3600 });
      const body = (raw ? JSON.parse(raw) : {}) as Obj;
      state.seen.push({ path: url.pathname, protocol: req.headers[PROTOCOL_HEADER] as string | undefined, body });
      if (url.pathname === V0_ENDPOINT.claim) {
        const first = !claimed;
        claimed = true;
        return reply(first ? { run: run(state.url), runner: { id: '7', name: null, paused: false, accepts: ['all'], maxSlots: null } } : { run: null, state: 'idle' });
      }
      const m = /\/runs\/([^/]+)\/(lease|events|result)$/.exec(url.pathname);
      if (m?.[2] === 'lease') return reply(state.cancel ? { cancel: true, reason: 'canceled' } : { cancel: false });
      if (m?.[2] === 'events') return reply({ accepted: (body.events as unknown[]).length, lastSeq: 1 });
      if (m?.[2] === 'result') {
        const key = `${m[1]}/${String(body.segment)}`;
        const duplicate = results.has(key);
        results.add(key);
        return reply({ run: { id: m[1], status: body.status }, ...(duplicate ? { duplicate: true } : {}) });
      }
      if (url.pathname === DUCKHUNT_EXT_ENDPOINT.conversations) return reply({ open: body.runIds });
      res.writeHead(404).end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      state.close = () => new Promise((done) => server.close(() => done()));
      resolve(state);
    }),
  );
}

const savedEnv = { ...process.env };
let root = '';
let claude: ClaudeInfo = { version: null, supported: new Set() };

// `claude` falso: --version/--help como el de verdad; un run anota argv y mcp-config en <caso>/spawns.jsonl y
// contesta un stream-json mínimo, o espera a un fichero (HOLD:<f>) hasta que lo maten.
function writeFakeClaude(bin: string): void {
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === '--help') { console.log(${JSON.stringify(OPTIONAL_FLAGS.join('\n'))}); process.exit(0); }
const mcpFile = args[args.indexOf('--mcp-config') + 1];
let caseDir = path.dirname(mcpFile);
while (!fs.existsSync(path.join(caseDir, 'runner.json'))) caseDir = path.dirname(caseDir);
fs.appendFileSync(path.join(caseDir, 'spawns.jsonl'), JSON.stringify({ argv: args, mcp: fs.readFileSync(mcpFile, 'utf8') }) + '\\n');
const prompt = args[args.length - 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const finish = () => {
  out({ type: 'system', subtype: 'init', session_id: 'sess-new', model: 'claude-opus-5-5' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'miro el problema' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'hecho', total_cost_usd: 0.5, num_turns: 2, session_id: 'sess-new' });
};
const hold = /HOLD:(\\S+)/.exec(prompt);
if (!hold) finish();
else {
  fs.writeFileSync(hold[1] + '.started', '');
  const wait = () => (fs.existsSync(hold[1]) ? finish() : setTimeout(wait, ${HOLD_POLL_MS}));
  wait();
}
`;
  fs.writeFileSync(path.join(bin, 'claude'), script, { mode: 0o755 });
}

async function waitFor(cond: () => boolean): Promise<void> {
  const start = Date.now();
  // i/o secuencial: sondeo hasta que se cumpla.
  while (!cond()) {
    if (Date.now() - start > WAIT_TIMEOUT_MS) throw new Error('timeout esperando');
    await new Promise((r) => setTimeout(r, HOLD_POLL_MS));
  }
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-v0-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  writeFakeClaude(bin);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
  claude = await detectClaude();
});

after(() => {
  process.env = { ...savedEnv };
  fs.rmSync(root, { recursive: true, force: true });
});

// el run v0 del caso: el de prompt-read-no-repo con sus servidores mcp en el fake (dos) y unas listas del server
// que piden más de lo que el toolset da (no deben llegar a claude).
const e2eRun = (prompt: string) => (url: string): Obj => {
  const run = clone(v0Run('prompt-read-no-repo.json'));
  run.id = 'r_e2e';
  run.prompt = prompt;
  run.lease = { heartbeatMs: 1 };
  run.mcpServers = [
    { name: 'duckhunt', url: `${url}/mcp`, token: 'tok-run', expiresAt: 0 },
    { name: 'extra', url: `${url}/mcp-extra`, token: 'tok-extra', expiresAt: 0 },
  ];
  ((run.backend as Obj).claude_code as Obj).allowed = ['Bash', 'Edit'];
  return run;
};

async function daemonFor(server: FakeV0, slug: string): Promise<{ d: DaemonInternals; sup: SupervisorInternals; dir: string }> {
  const dir = path.join(root, slug);
  fs.mkdirSync(dir);
  const configFile = path.join(dir, 'runner.json');
  const ceiling = { shell: 'read', fsWrite: false, memory: false, web: true, vcsPush: false, access: { repo: 'read' } };
  const beta = { protocol: 'agent-runner/0', credential: { baseUrl: server.url, clientId: 'b1', refreshToken: 'rb' }, expose: {}, ceiling };
  const cfg = { baseUrl: 'https://duckhunt.invalid', clientId: 'c1', refreshToken: 'r1', label: 'fa', repos: {}, aws: {}, defaults: {}, version: 2, platforms: { beta } };
  fs.writeFileSync(configFile, JSON.stringify(cfg), { mode: 0o600 });
  process.env.DUCKHUNT_RUNNER_CONFIG = configFile;
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  const d = internals(loadConfig()!);
  await d.reloadConfig();
  // lo que hace run() al arrancar, sin el loop ni las señales.
  const live = d as unknown as { claude: ClaudeInfo; secretDeny: string[] };
  live.claude = claude;
  allRunConfigDirs().forEach(runConfigDeny);
  live.secretDeny = secretPathsDeny(process.env).rules;
  const sup = d.supervisors.get('beta');
  assert.ok(sup, 'la plataforma v0 se supervisa sin `trusted`: su techo se aplica');
  return { d, sup, dir };
}

const spawnsOf = (dir: string): { argv: string[]; mcp: string }[] =>
  fs.readFileSync(path.join(dir, 'spawns.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; mcp: string });

test('de punta a punta: discovery → claim → lease → events → result, con las tools del render y un result duplicado sin reintentos', async (t) => {
  t.mock.method(console, 'log', () => {});
  const server = await fakeV0(e2eRun('mira qué falla'));
  try {
    const { d, sup, dir } = await daemonFor(server, 'e2e');
    assert.equal(await d.pollOnce(sup), true, 'reclamó el run');
    await waitFor(() => server.seen.some((s) => s.path.endsWith('/result')));
    assert.ok(server.seen.every((s) => s.protocol === '0'), 'la cabecera de versión en toda petición de v0');
    const claim = server.seen.find((s) => s.path === V0_ENDPOINT.claim)!.body;
    assert.deepEqual((claim.backend as Obj).id, 'claude_code');
    assert.ok((claim.features as string[]).includes('toolset_v1'));
    assert.deepEqual(claim.resources, [
      { type: 'repo', keys: [] },
      { type: 'aws', keys: [] },
    ]);
    assert.ok(server.seen.some((s) => s.path === '/api/runner/v0/runs/r_e2e/events'), 'el feed por el id público');
    const result = server.seen.find((s) => s.path.endsWith('/result'))!.body;
    assert.deepEqual([result.segment, result.status, result.result], [1, 'done', 'hecho']);
    assert.deepEqual(result.session, { handle: 'sess-new', resumed: false });
    assert.equal((result.usage as Obj).costUsd, 0.5);
    const [spawn] = spawnsOf(dir);
    const allowed = spawn!.argv[spawn!.argv.indexOf('--allowedTools') + 1]!.split(',');
    assert.ok(!allowed.includes('Bash') && !allowed.includes('Edit'), 'las listas del claim nunca llegan a claude');
    assert.ok(allowed.includes('mcp__duckhunt__duckhunt-run-reply') && allowed.includes('mcp__extra__duckhunt-run-reply'), 'las tools de la plataforma en sus dos servidores');
    assert.deepEqual(Object.keys((JSON.parse(spawn!.mcp) as { mcpServers: Obj }).mcpServers), ['duckhunt', 'extra']);
    // el mismo result otra vez: la plataforma responde duplicate y el daemon no reintenta.
    const before = server.seen.length;
    await sup.platform.result('r_e2e', { status: 'done', segment: 1 });
    assert.equal(server.seen.length, before + 1);
  } finally {
    await server.close();
  }
});

test('de punta a punta: un cancel de la plataforma mata el run en un latido y el result sale como canceled', async (t) => {
  t.mock.method(console, 'log', () => {});
  const hold = path.join(root, 'cancel-hold');
  const server = await fakeV0(e2eRun(`espera HOLD:${hold}`));
  try {
    const { d, sup } = await daemonFor(server, 'cancel');
    await d.pollOnce(sup);
    await waitFor(() => fs.existsSync(`${hold}.started`));
    const start = Date.now();
    server.cancel = true;
    await waitFor(() => server.seen.some((s) => s.path.endsWith('/result')));
    assert.ok(Date.now() - start < CANCEL_WITHIN_MS, 'atendido en un latido');
    const result = server.seen.find((s) => s.path.endsWith('/result'))!.body;
    assert.equal(result.status, 'canceled');
  } finally {
    await server.close();
  }
});
