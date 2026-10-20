// la plataforma local (t#495, M7): `runner run` con el claude falso, sin daemon (el núcleo en este proceso, con el
// lock) y con él (por local.sock). la respuesta a stdout y el feed a stderr; el consentimiento de una escalada (77
// sin tty ni --yes, o con --yes sin unattendedEscalation); el techo y la exposición de platforms.local; ask_user →
// exit 3 → --resume; reply blocker → 2; ctrl-c cancela por el latido (130); --wait sin slot → 75; el lock que hace
// negarse a `start`; y el mcp de loopback (token por segmento, tools/list, tools/call, revocación).

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { OPTIONAL_FLAGS } from '../src/claude.js';
import { configPath, loadConfig } from '../src/config.js';
import { RunnerDaemon } from '../src/daemon.js';
import { LocalMcpServer, type TokenSubject } from '../src/local/mcp.js';
import { localSocketPath } from '../src/local/socket.js';
import { EVENTS_TTL_MS, loadConversation, type Conversation } from '../src/local/store.js';
import { auditPath, platformHome } from '../src/paths.js';
import { LocalPlatform } from '../src/platforms/local.js';
import { platformsCommand } from '../src/platforms-cli.js';
import { RUN_EXIT, runCommand, type RunIo } from '../src/run-cli.js';
import { fakeFactories } from './fake-platform.js';

const execFileP = promisify(execFile);
const HOLD_POLL_MS = 50;
const WAIT_TIMEOUT_MS = 20_000;
// el latido de la local es de 5 s: un ctrl-c llega en uno (y algo de margen para cerrar).
const CANCEL_WITHIN_MS = 9_000;
const INDEX_JS = fileURLToPath(new URL('../src/index.js', import.meta.url));

const savedEnv = { ...process.env };
let root = '';
let caseDir = '';

// `claude` falso: --version/--help como el de verdad; un run anota argv y mcp-config en <caso>/spawns.jsonl, llama
// a las tools de la plataforma local según su prompt (ASK:, BLOCK:) y contesta un stream-json mínimo, o espera a un
// fichero (HOLD:<f>) hasta que lo maten.
function writeFakeClaude(bin: string): void {
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === '--help') { console.log(${JSON.stringify(OPTIONAL_FLAGS.join('\n'))}); process.exit(0); }
const mcpFile = args[args.indexOf('--mcp-config') + 1];
const mcp = JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers.local;
let caseDir = path.dirname(mcpFile);
while (!fs.existsSync(path.join(caseDir, 'runner.json'))) caseDir = path.dirname(caseDir);
fs.appendFileSync(path.join(caseDir, 'spawns.jsonl'), JSON.stringify({ argv: args, mcp }) + '\\n');
const prompt = args[args.length - 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const call = (name, args) => fetch(mcp.url, { method: 'POST', headers: { ...mcp.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }).then((r) => r.json());
const finish = (text) => {
  out({ type: 'system', subtype: 'init', session_id: 'sess-' + process.pid, model: 'claude-opus-5-5' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'miro el problema' }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.25, num_turns: 1, session_id: 'sess-' + process.pid });
};
const ask = /ASK:(.+)/.exec(prompt);
const block = /BLOCK:(.+)/.exec(prompt);
const hold = /HOLD:(\\S+)/.exec(prompt);
if (ask) call('ask_user', { kind: 'text', question: ask[1] }).then(() => finish('pregunté'));
else if (block) call('reply', { kind: 'blocker', body: block[1] }).then(() => finish('no seguí'));
else if (hold) {
  fs.writeFileSync(hold[1] + '.started', '');
  const wait = () => (fs.existsSync(hold[1]) ? finish('hecho') : setTimeout(wait, ${HOLD_POLL_MS}));
  wait();
} else finish('hecho: ' + prompt);
`;
  fs.writeFileSync(path.join(bin, 'claude'), script, { mode: 0o755 });
}

interface FakeIo extends RunIo {
  out: string[];
  err: string[];
  answers: string[];
  signal(s: NodeJS.Signals): void;
}

function fakeIo(isTTY: boolean, answers: string[] = []): FakeIo {
  let handler: ((s: NodeJS.Signals) => void) | null = null;
  const io: FakeIo = {
    out: [],
    err: [],
    answers,
    isTTY,
    stdout: (t) => void io.out.push(t),
    stderr: (t) => void io.err.push(t),
    ask: async (prompt) => {
      io.err.push(prompt);
      return io.answers.shift() ?? '';
    },
    onSignal: (h) => {
      handler = h;
      return () => {
        handler = null;
      };
    },
    signal: (s) => handler?.(s),
  };
  return io;
}

const writeConfig = (extra: object = {}): void =>
  fs.writeFileSync(configPath(), JSON.stringify({ repos: {}, aws: {}, defaults: {}, ...extra }), { mode: 0o600 });

const spawnsOf = (): { argv: string[]; mcp: { url: string } }[] => {
  const file = path.join(caseDir, 'spawns.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; mcp: { url: string } }) : [];
};

const quiet = (t: TestContext): void => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
};

async function waitFor(cond: () => boolean): Promise<void> {
  const start = Date.now();
  // i/o secuencial: sondeo hasta que se cumpla.
  while (!cond()) {
    if (Date.now() - start > WAIT_TIMEOUT_MS) throw new Error('timeout esperando');
    await new Promise((r) => setTimeout(r, HOLD_POLL_MS));
  }
}

const conversationIn = (io: FakeIo): Conversation => {
  const id = /conversación (l-\S+)/.exec(io.err.join(''))?.[1];
  assert.ok(id, 'el cli dice qué conversación abrió');
  return loadConversation(id)!;
};

before(() => {
  // corto: el socket unix no admite rutas largas.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  writeFakeClaude(bin);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ''}`;
});

beforeEach(() => {
  caseDir = fs.mkdtempSync(path.join(root, 'c-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(caseDir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(caseDir, 'h');
  writeConfig();
});

afterEach(() => {
  process.env.DUCKHUNT_RUNNER_CONFIG = savedEnv.DUCKHUNT_RUNNER_CONFIG;
  process.env.DUCKHUNT_RUNNER_HOME = savedEnv.DUCKHUNT_RUNNER_HOME;
});

after(() => {
  process.env = { ...savedEnv };
  fs.rmSync(root, { recursive: true, force: true });
});

test('sin daemon: la respuesta a stdout, el feed a stderr, las tools de la local en su mcp de loopback y el lock suelto al acabar', async (t) => {
  quiet(t);
  const io = fakeIo(false);
  assert.equal(await runCommand(['mira qué falla'], io), RUN_EXIT.done);
  assert.equal(io.out.join(''), 'hecho: mira qué falla\n', 'solo la respuesta en stdout');
  assert.match(io.err.join(''), /miro el problema/, 'el feed en stderr');
  const [spawn] = spawnsOf();
  const allowed = spawn!.argv[spawn!.argv.indexOf('--allowedTools') + 1]!.split(',');
  assert.ok(allowed.includes('mcp__local__ask_user') && allowed.includes('mcp__local__reply'));
  assert.ok(!allowed.includes('Edit') && !allowed.includes('Write'), 'lectura por defecto');
  assert.match(spawn!.mcp.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  const c = conversationIn(io);
  assert.equal(c.status, 'done');
  assert.ok(c.sessionId?.startsWith('sess-'));
  assert.ok(fs.readdirSync(auditPath('local')).length > 0, 'pasa por la auditoría');
  assert.ok(!fs.existsSync(path.join(process.env.DUCKHUNT_RUNNER_HOME!, 'daemon.lock')), 'el lock se suelta');
});

test('consentimiento: una escalada sin tty ni --yes, o con --yes sin unattendedEscalation, se niega (77); en tty se pregunta', async (t) => {
  quiet(t);
  const noTty = fakeIo(false);
  assert.equal(await runCommand(['--profile', 'edit', 'arregla esto'], noTty), RUN_EXIT.refused);
  assert.match(noTty.err.join(''), /más que lectura .*shell entera.*escribir ficheros/);
  assert.equal(await runCommand(['--profile', 'edit', '--yes', 'arregla esto'], fakeIo(false)), RUN_EXIT.refused, '--yes sin tty no basta');
  const no = fakeIo(true, ['n']);
  assert.equal(await runCommand(['--profile', 'edit', 'arregla esto'], no), RUN_EXIT.refused);
  assert.match(no.err.join(''), /\+ shell entera/);
  assert.equal(spawnsOf().length, 0, 'nada se lanzó');
  assert.equal(await runCommand(['--profile', 'edit', 'arregla esto'], fakeIo(true, ['s'])), RUN_EXIT.done);
  writeConfig({ version: 2, platforms: { local: { unattendedEscalation: true } } });
  assert.equal(await runCommand(['--profile', 'edit', '--yes', 'arregla esto'], fakeIo(false)), RUN_EXIT.done, 'con unattendedEscalation, --yes vale sin tty');
  const edit = spawnsOf().at(-1)!.argv;
  assert.ok(edit[edit.indexOf('--allowedTools') + 1]!.split(',').includes('Edit'), 'la edición llega a claude');
});

test('el techo y la exposición de platforms.local: lo que recortaría o una clave sin exponer se niega antes de lanzar', async (t) => {
  quiet(t);
  writeConfig({ repos: { 'acme/api': { path: path.join(caseDir, 'api') } }, version: 2, platforms: { local: { ceiling: { vcsPush: false } } } });
  const push = fakeIo(true, ['s']);
  assert.equal(await runCommand(['--push', 'sube esto'], push), RUN_EXIT.refused);
  assert.match(push.err.join(''), /techo de la plataforma local no lo permite: vcsPush/);
  const repo = fakeIo(false);
  assert.equal(await runCommand(['--repo', 'acme/api', 'mira el repo'], repo), RUN_EXIT.refused);
  assert.match(repo.err.join(''), /`duckhunt-runner platforms expose local repo acme\/api`/);
  const unmapped = fakeIo(false);
  assert.equal(await runCommand(['--repo', 'acme/otro', 'mira'], unmapped), RUN_EXIT.usage);
  assert.equal(await runCommand(['--grant', 'repo', 'x'], fakeIo(false)), RUN_EXIT.usage, 'un grant sin clave es de uso');
  assert.equal(spawnsOf().length, 0);
});

test('ask_user sin tty: exit 3 con la pregunta; --resume sigue la sesión con la respuesta como prompt', async (t) => {
  quiet(t);
  const first = fakeIo(false);
  assert.equal(await runCommand(['ASK:¿qué rama?'], first), RUN_EXIT.waiting);
  assert.match(first.err.join(''), /¿qué rama\?[\s\S]*--resume (l-\S+)/);
  const c = conversationIn(first);
  assert.equal(c.status, 'waiting');
  const resumed = fakeIo(false);
  assert.equal(await runCommand(['--resume', c.id, 'main'], resumed), RUN_EXIT.done);
  assert.equal(resumed.out.join(''), 'hecho: main\n');
  const [, second] = spawnsOf();
  assert.equal(second!.argv[second!.argv.indexOf('--resume') + 1], c.sessionId, 'la misma sesión');
  assert.equal(loadConversation(c.id)!.transcript[0]?.answer, 'main');
  assert.equal(await runCommand(['--resume', c.id, 'otra'], fakeIo(false)), RUN_EXIT.failed, 'ya no espera respuesta');
  assert.equal(await runCommand(['--resume', c.id, '--profile', 'edit', 'x'], fakeIo(false)), RUN_EXIT.usage, 'con --resume no hay flags de política');
});

test('ask_user en una tty: se contesta aquí y la conversación sigue en el mismo proceso', async (t) => {
  quiet(t);
  const io = fakeIo(true, ['main']);
  assert.equal(await runCommand(['ASK:¿qué rama?'], io), RUN_EXIT.done);
  assert.equal(io.out.join(''), 'hecho: main\n');
  assert.equal(spawnsOf().length, 2);
});

test('reply blocker: exit 2 con su body en stdout', async (t) => {
  quiet(t);
  const io = fakeIo(false);
  assert.equal(await runCommand(['BLOCK:no tengo acceso al repo'], io), RUN_EXIT.blocker);
  assert.equal(io.out.join(''), 'no tengo acceso al repo\n');
});

test('ctrl-c cancela por el latido: el run muere en uno y sale con 130', async (t) => {
  quiet(t);
  const hold = path.join(caseDir, 'hold');
  const io = fakeIo(false);
  const running = runCommand([`HOLD:${hold}`], io);
  await waitFor(() => fs.existsSync(`${hold}.started`));
  const start = Date.now();
  io.signal('SIGINT');
  assert.equal(await running, RUN_EXIT.sigint);
  assert.ok(Date.now() - start < CANCEL_WITHIN_MS, 'en un latido');
  assert.equal(conversationIn(io).status, 'canceled');
});

test('sin daemon el lock queda tomado: `start` se niega mientras dura', async (t) => {
  quiet(t);
  writeConfig({ baseUrl: 'https://duckhunt.invalid', clientId: 'c1', refreshToken: 'r1' });
  const hold = path.join(caseDir, 'hold');
  const io = fakeIo(false);
  const running = runCommand([`HOLD:${hold}`], io);
  await waitFor(() => fs.existsSync(`${hold}.started`));
  const start = await execFileP(process.execPath, [INDEX_JS, 'start'], { env: process.env }).then(
    () => null,
    (err: { code: number; stderr: string }) => err,
  );
  assert.ok(start, '`start` no arranca');
  assert.equal(start.code, 1);
  assert.match(start.stderr, /ya hay un daemon en marcha \(pid \d+/);
  fs.writeFileSync(hold, '');
  assert.equal(await running, RUN_EXIT.done);
});

test('con el daemon en marcha: por local.sock, compartiendo sus slots (--wait sin slot → 75)', async (t) => {
  quiet(t);
  writeConfig({ baseUrl: 'https://duckhunt.invalid', clientId: 'c1', refreshToken: 'r1' });
  const daemon = new RunnerDaemon(loadConfig()!, { factories: fakeFactories().factories });
  const running = daemon.run();
  try {
    await waitFor(() => fs.existsSync(localSocketPath()));
    assert.equal((fs.statSync(localSocketPath()).mode & 0o777).toString(8), '600');
    const io = fakeIo(false);
    assert.equal(await runCommand(['mira qué falla'], io), RUN_EXIT.done);
    assert.equal(io.out.join(''), 'hecho: mira qué falla\n');
    assert.ok(!fs.existsSync(path.join(process.env.DUCKHUNT_RUNNER_HOME!, 'daemon.lock')), 'por el socket no toma el lock');
    // un slot para la local: con uno en marcha, otro con --wait no lo consigue.
    const hold = path.join(caseDir, 'hold');
    const first = fakeIo(false);
    const busy = runCommand([`HOLD:${hold}`], first);
    await waitFor(() => fs.existsSync(`${hold}.started`));
    assert.equal(await runCommand(['--wait', '1s', 'otro'], fakeIo(false)), RUN_EXIT.noSlot);
    fs.writeFileSync(hold, '');
    assert.equal(await busy, RUN_EXIT.done);
  } finally {
    daemon.stop();
    await running;
  }
  assert.ok(!fs.existsSync(localSocketPath()), 'el socket se quita al parar');
});

test('mcp de loopback: sin token 401; con el del segmento, initialize, tools/list y tools/call; revocado, 401', async () => {
  const calls: { subject: TokenSubject; tool: string; args: Record<string, unknown> }[] = [];
  const mcp = new LocalMcpServer((subject, tool, args) => {
    calls.push({ subject, tool, args });
    if (args.kind === 'mal') throw new Error('kind: yes_no | text | form');
    return 'anotado';
  });
  await mcp.start();
  try {
    const post = (body: unknown, token?: string): Promise<Response> =>
      fetch(mcp.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const rpc = (method: string, params: object = {}): object => ({ jsonrpc: '2.0', id: 7, method, params });
    assert.equal((await post(rpc('tools/list'))).status, 401);
    const subject = { conversation: 'l-01J00000000000000000000000', segment: 1 };
    const token = mcp.issue(subject);
    const init = (await (await post(rpc('initialize', { protocolVersion: '2025-03-26' }), token)).json()) as { result: { protocolVersion: string } };
    assert.equal(init.result.protocolVersion, '2025-03-26');
    assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, token)).status, 202);
    const list = (await (await post(rpc('tools/list'), token)).json()) as { result: { tools: { name: string }[] } };
    assert.deepEqual(list.result.tools.map((x) => x.name), ['ask_user', 'reply']);
    const ok = (await (await post(rpc('tools/call', { name: 'ask_user', arguments: { kind: 'text', question: '¿rama?' } }), token)).json()) as { result: { content: { text: string }[]; isError?: boolean } };
    assert.equal(ok.result.content[0]!.text, 'anotado');
    assert.deepEqual(calls[0], { subject, tool: 'ask_user', args: { kind: 'text', question: '¿rama?' } });
    const bad = (await (await post(rpc('tools/call', { name: 'ask_user', arguments: { kind: 'mal' } }), token)).json()) as { result: { isError: boolean } };
    assert.equal(bad.result.isError, true, 'un argumento que no vale vuelve como error de tool');
    const unknown = (await (await post(rpc('resources/list'), token)).json()) as { error: { code: number } };
    assert.equal(unknown.error.code, -32601);
    assert.equal((await fetch(mcp.url, { headers: { Authorization: `Bearer ${token}` } })).status, 405, 'sin sse');
    mcp.revoke(subject);
    assert.equal((await post(rpc('tools/list'), token)).status, 401, 'revocado con su result');
  } finally {
    await mcp.close();
  }
});

test('platforms expose local: crea su entrada con los valores por defecto; el feed viejo se poda al arrancar', async (t) => {
  quiet(t);
  writeConfig({ repos: { 'acme/api': { path: path.join(caseDir, 'api') } } });
  await platformsCommand(['expose', 'local', 'repo', 'acme/api']);
  const saved = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as { platforms: { local: { trusted: boolean; expose: object; ceiling: { shell: string } } } };
  assert.deepEqual(saved.platforms.local.expose, { repo: ['acme/api'] });
  assert.equal(saved.platforms.local.trusted, true);
  assert.equal(saved.platforms.local.ceiling.shell, 'full');
  const events = path.join(platformHome('local'), 'events');
  fs.mkdirSync(events, { recursive: true });
  const old = path.join(events, 'l-01J00000000000000000000000.ndjson');
  fs.writeFileSync(old, '{}\n');
  const stale = new Date(Date.now() - EVENTS_TTL_MS - 1000);
  fs.utimesSync(old, stale, stale);
  const local = new LocalPlatform({ enforcement: () => ({ ceiling: { shell: 'none', fsWrite: false, memory: false, web: false, vcsPush: false, access: {}, platformTools: '*' }, expose: {}, resourceTypes: [], awsCli: false }) });
  await local.start();
  await local.close();
  assert.ok(!fs.existsSync(old));
});

test('`run` sin prompt sigue siendo `start` (con aviso de obsoleto); `run --help`, el uso', async () => {
  fs.rmSync(configPath(), { force: true });
  const bare = await execFileP(process.execPath, [INDEX_JS, 'run'], { env: process.env }).then(
    () => null,
    (err: { code: number; stderr: string }) => err,
  );
  assert.ok(bare);
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /`run` sin prompt arranca el daemon como `start`: está obsoleto/);
  assert.match(bare.stderr, /sin config/, 'el camino de `start`');
  const help = await execFileP(process.execPath, [INDEX_JS, 'run', '--help'], { env: process.env });
  assert.match(help.stdout, /duckhunt-runner run \[--repo/);
});
