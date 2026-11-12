// salida de claude fijada byte a byte (t#440 P0): cómo traduce el daemon lo que dice `claude -p` (su stream-json, su
// stderr y su exit code) a lo que ve el server (feed, progress, status y los cambios de turno de un proceso vivo), lo
// que escribe en el stdin de una sesión viva (live-session.ts) y el catálogo de slash commands que resuelve del init.
// es la red del seam de drivers (P1): mover claude tras una interfaz no puede cambiar ni un byte de esto.
// el claude falso (fakes/fake-claude.ts) reproduce transcripts enlatados: el prompt (o el primer mensaje de stdin) dice
// cuál (SCRIPT:<nombre>). cubren init, el agente principal y un subagente (parent_tool_use_id), tareas, result con éxito,
// sin presupuesto (error_max_budget_usd), con error y sin result, una reanudación fallida con su reintento, y un result y
// un stderr enormes con secretos dentro (clampReport, maskSecrets y el recorte de 20k del texto de un turno).
// UPDATE_CLAUDE_OUTPUT=1 lo reescribe (solo para capturar, nunca para tapar una diferencia).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { detectClaude, type ClaudeInfo } from '../src/claude.js';
import { parseClaim, type ClaimResponse } from '../src/claim.js';
import { loadConfig, type RunnerConfig } from '../src/config.js';
import { RunLease } from '../src/run-lease.js';
import { internals, legacyOf, setClaudeInfo, type DaemonInternals } from './daemon-harness.js';
import { FAKE_CLAUDE_VERSION, writeFakeClaude } from './fakes/fake-claude.js';

const GOLDEN = new URL('../../test/golden/claude-output.json', import.meta.url);
const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
const UPDATE = process.env.UPDATE_CLAUDE_OUTPUT === '1';
const MACHINE = '6f1d7c1e-5b0a-4c34-9b8e-2a3f7c1d9e01';
const BASE_HOST = 'claude-output.test';
const SID = '0b7c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';
// uuids de mensajes del asistente (dónde podrá retomarse, t#564) y el id del mensaje en vivo (t#636, fase 3).
const UUID_FIRST = '11111111-1111-4111-8111-111111111111';
const UUID_LAST = '33333333-3333-4333-8333-333333333333';
const UUID_SUB = '44444444-4444-4444-8444-444444444444';
const LIVE_MESSAGE_ID = '22222222-2222-4222-8222-222222222222';
// más que todo tope: el del texto de un turno y el del result del status (20k), el del feed (4k) y el del stderr (4k).
const HUGE_CHARS = 25_000;
const STDERR_LINES = 40;
const STDERR_LINE_CHARS = 300;
const WAIT_POLL_MS = 20;
const WAIT_TIMEOUT_MS = 10_000;

// secretos sintéticos con la forma de los de verdad, montados en ejecución: el texto del repo (público) no lleva
// ninguno que un escáner pueda confundir.
const SECRETS = {
  aws: `${'AKIA'}${'Q'.repeat(16)}`,
  github: `${'gh'}p_${'a'.repeat(36)}`,
  anthropic: `${'sk-'}ant-${'b'.repeat(40)}`,
  bearer: `Bearer ${'c'.repeat(32)}`,
};
const secretLine = `token=${SECRETS.github} key ${SECRETS.aws} ${SECRETS.anthropic} curl -H "Authorization: ${SECRETS.bearer}"`;
const huge = (head: string): string => `${head}\n${'x'.repeat(HUGE_CHARS)}\n${secretLine}\nfin`;

const savedEnv = { ...process.env };
let root = '';
let bin = '';
let userHome = '';
let claude: ClaudeInfo = { version: null, supported: new Set() };

// --- transcripts ---

interface Script {
  stdout: unknown[];
  stderr?: string[];
  exit?: number;
  // proceso vivo: lo que dice tras acusar un mensaje de la persona (fase 3) y tras parar una tarea (fase 2).
  onMessage?: unknown[];
  onStop?: unknown[];
}

const init = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'system',
  subtype: 'init',
  session_id: SID,
  model: 'claude-opus-5-5',
  tools: ['Read', 'Grep', 'Bash', 'Agent'],
  mcp_servers: [{ name: 'duckhunt', status: 'connected' }],
  permissionMode: 'dontAsk',
  uuid: '00000000-0000-4000-8000-000000000000',
  ...extra,
});
const say = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
  session_id: SID,
  parent_tool_use_id: null,
  ...extra,
});
const use = (id: string, name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  session_id: SID,
  parent_tool_use_id: null,
  ...extra,
});
const toolResult = (id: string, content: string, parent: string | null = null): Record<string, unknown> => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  session_id: SID,
  parent_tool_use_id: parent,
});
const result = (subtype: string, isError: boolean, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'result',
  subtype,
  is_error: isError,
  result: text,
  total_cost_usd: 1.25,
  num_turns: 4,
  duration_ms: 1234,
  session_id: SID,
  modelUsage: { 'claude-opus-5-5': { inputTokens: 10, outputTokens: 20, costUSD: 1.25 } },
  ...extra,
});

// un turno completo: catálogo slash en el init, agente principal con tools (también de mcp), un subagente con su
// parent_tool_use_id y su tarea, y un result con éxito.
const fullTurn: Script = {
  stdout: [
    init({ slash_commands: ['revisa', 'herr:lint', 'compact', 'review'], skills: ['review', 'herr:doc'], plugins: [{ name: 'herr', path: '<plugin>' }] }),
    say('miro el repo', { uuid: UUID_FIRST }),
    use('toolu_read', 'Read', { file_path: '<home>/notas.md' }),
    toolResult('toolu_read', 'contenido'),
    use('toolu_mcp', 'mcp__duckhunt__duckhunt-entry-get', { id: 42 }),
    toolResult('toolu_mcp', '{"id":42}'),
    use('toolu_sub', 'Agent', { description: 'busca los tests', prompt: 'encuentra los tests del login', subagent_type: 'Explore' }),
    { type: 'system', subtype: 'task_started', task_id: 'task1', tool_use_id: 'toolu_sub', task_type: 'local_agent', description: 'busca los tests', session_id: SID },
    say('busco en test/', { parent_tool_use_id: 'toolu_sub', uuid: UUID_SUB }),
    use('toolu_grep', 'Grep', { pattern: 'login', path: 'test' }, { parent_tool_use_id: 'toolu_sub' }),
    toolResult('toolu_grep', 'test/login.test.ts', 'toolu_sub'),
    { type: 'system', subtype: 'task_notification', task_id: 'task1', status: 'completed', session_id: SID },
    toolResult('toolu_sub', 'test/login.test.ts'),
    say('listo', { uuid: UUID_LAST }),
    result('success', false, 'hecho: el login falla por el token'),
  ],
};

const SCRIPTS: Record<string, Script> = {
  'full-turn': fullTurn,
  'budget-exhausted': {
    stdout: [init(), say('sigo', { uuid: UUID_FIRST }), result('error_max_budget_usd', true, 'me quedé sin presupuesto')],
    exit: 1,
  },
  'error-during-execution': {
    stdout: [init(), say('pruebo', { uuid: UUID_FIRST }), result('error_during_execution', true, 'algo se rompió')],
    stderr: ['aviso: algo raro', `error: ${secretLine}`],
    exit: 1,
  },
  'crash-no-result': { stdout: [init()], stderr: ['Error: no pude conectar', `    at ${SECRETS.bearer}`], exit: 3 },
  'resume-gone': { stdout: [], stderr: ['No conversation found with session ID: gone'], exit: 1 },
  'resume-gone-fallback': { stdout: [init(), say('empiezo de cero', { uuid: UUID_FIRST }), result('success', false, 'hecho de cero')] },
  'huge-success': {
    stdout: [init(), say(huge('te cuento'), { uuid: UUID_FIRST }), use('toolu_bash', 'Bash', { command: `echo ${secretLine} ${'y'.repeat(HUGE_CHARS)}` }), result('success', false, huge('resultado'))],
    stderr: Array.from({ length: STDERR_LINES }, (_, i) => `${i} ${secretLine} ${'z'.repeat(STDERR_LINE_CHARS)}`),
  },
  'huge-error': {
    stdout: [init(), say('vaya', { uuid: UUID_FIRST }), result('error_during_execution', true, huge('se rompió'))],
    stderr: Array.from({ length: STDERR_LINES }, (_, i) => `${i} ${secretLine} ${'z'.repeat(STDERR_LINE_CHARS)}`),
    exit: 1,
  },
  // proceso vivo, fase 3: el primer turno deja una tarea en segundo plano (stdin sigue abierto) con un result enorme (el
  // recorte de 20k del turno); el mensaje de la persona abre el segundo.
  'live-turns': {
    stdout: [
      init(),
      use('toolu_bg', 'Agent', { description: 'en segundo plano', prompt: 'mira los logs', run_in_background: true }, { uuid: UUID_FIRST }),
      { type: 'system', subtype: 'task_started', task_id: 'bgtask1', tool_use_id: 'toolu_bg', task_type: 'local_agent', description: 'en segundo plano', session_id: SID },
      result('success', false, huge(`lanzado ${secretLine}`)),
    ],
    onMessage: [say('leo tu mensaje', { uuid: UUID_LAST }), { type: 'system', subtype: 'task_notification', task_id: 'bgtask1', status: 'completed', session_id: SID }, result('success', false, 'segundo turno', { total_cost_usd: 2.5 })],
  },
  // proceso vivo, fase 2: parar la tarea de fondo desde el buzón (control_request stop_task).
  'live-stop': {
    stdout: [
      init(),
      use('toolu_bg', 'Agent', { description: 'en segundo plano', prompt: 'mira los logs', run_in_background: true }, { uuid: UUID_FIRST }),
      { type: 'system', subtype: 'task_started', task_id: 'bgtask1', tool_use_id: 'toolu_bg', task_type: 'local_agent', description: 'en segundo plano', session_id: SID },
      result('success', false, 'lanzado'),
    ],
    onStop: [{ type: 'system', subtype: 'task_notification', task_id: 'bgtask1', status: 'stopped', session_id: SID }, say('la tarea se paró', { uuid: UUID_LAST }), result('success', false, 'parada')],
  },
};

// el claude falso: reproduce el transcript que pide el prompt. sin stdin vivo, sale con su exit code; con él, anota cada
// línea que recibe (<caso>/stdin.jsonl), acusa los mensajes con uuid y contesta a stop_task, y sale al cerrarse stdin.
const REPLAY_BODY = `const caseDir = caseDirOf(mcpFile);
const scripts = path.join(caseDir, '..', '..', 'scripts');
const load = (prompt) => JSON.parse(fs.readFileSync(path.join(scripts, /SCRIPT:(\\S+)/.exec(prompt)[1] + '.json'), 'utf8'));
const replay = (s) => {
  (s.stderr ?? []).forEach((l) => process.stderr.write(l + '\\n'));
  s.stdout.forEach(out);
};
if (!args.includes('--input-format')) {
  const s = load(args[args.length - 1]);
  replay(s);
  process.exitCode = s.exit ?? 0;
} else {
  let s = null;
  let buf = '';
  const onLine = (line) => {
    fs.appendFileSync(path.join(caseDir, 'stdin.jsonl'), line + '\\n');
    const msg = JSON.parse(line);
    if (s === null) {
      s = load(msg.message.content);
      replay(s);
      return;
    }
    if (msg.type === 'user' && msg.uuid) {
      out({ type: 'user', isReplay: true, uuid: msg.uuid, message: msg.message, session_id: ${JSON.stringify(SID)} });
      (s.onMessage ?? []).forEach(out);
      return;
    }
    if (msg.type === 'control_request' && msg.request && msg.request.subtype === 'stop_task') {
      out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: {} } });
      (s.onStop ?? []).forEach(out);
    }
  };
  process.stdin.on('data', (d) => {
    buf += d;
    let k;
    while ((k = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, k);
      buf = buf.slice(k + 1);
      onLine(line);
    }
  });
  process.stdin.on('end', () => process.exit(s?.exit ?? 0));
}
`;

// --- casos ---

interface Case {
  name: string;
  kit: string;
  run: Record<string, unknown>;
  extra?: Record<string, unknown>;
  // la orden que el buzón da una vez a un proceso vivo.
  inbox?: Record<string, unknown>;
  // el caso sube un catálogo de slash commands: se espera a que llegue.
  slash?: boolean;
}

// sin repo: el scratch del daemon (ni git ni worktrees en el plan de la salida).
const scratch = (id: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, repo: null, branch: null, isolation: undefined, sessionId: null, ...extra });

const CASES: Case[] = [
  { name: 'full-turn', kit: 'prompt-read-full', run: scratch(801), slash: true },
  { name: 'budget-exhausted', kit: 'prompt-read-full', run: scratch(802) },
  { name: 'error-during-execution', kit: 'prompt-read-full', run: scratch(803) },
  { name: 'crash-no-result', kit: 'prompt-read-full', run: scratch(804) },
  { name: 'resume-gone', kit: 'prompt-read-full', run: scratch(805, { sessionId: 'gone' }), extra: { fallbackPrompt: 'SCRIPT:resume-gone-fallback' } },
  { name: 'huge-success', kit: 'prompt-read-full', run: scratch(806) },
  { name: 'huge-error', kit: 'prompt-read-full', run: scratch(807) },
  { name: 'live-turns', kit: 'prompt-edit-live-turns', run: scratch(808, { segment: 1 }), extra: { live: { waitMs: 1000, turns: true } }, inbox: { id: LIVE_MESSAGE_ID, kind: 'message', text: 'y mira también los tests' } },
  { name: 'live-stop', kit: 'prompt-edit-live-turns', run: scratch(809, { segment: 1 }), extra: { live: { waitMs: 1000 } }, inbox: { id: 'cmd-1', kind: 'stop_task', taskId: 'bgtask1' } },
];

const kit = (name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(new URL(`claim-kits/${name}.json`, FIXTURES), 'utf8')) as Record<string, unknown>;

// --- server falso: guarda por run lo que importa a la salida ---

interface Recorded {
  progress: string[];
  feed: unknown[];
  status: string[];
  turns: string[];
  inboxServed: boolean;
}
interface Server {
  runs: Map<string, Recorded>;
  slash: string[];
  inbox: Record<string, unknown> | undefined;
}
const realFetch = globalThis.fetch;
const servers = new Map<string, Server>();

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/oauth/token')) return Response.json({ access_token: 'a', refresh_token: 'r2', expires_in: 3600 });
    const server = servers.get(url.host);
    const body = String(init?.body);
    if (server && url.pathname.endsWith('/slash-commands')) {
      server.slash.push(body);
      return Response.json({ ok: true });
    }
    const m = /\/api\/runner\/runs\/([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!server || !m) return Response.json({ ok: true });
    const [, runId, what] = m;
    const rec = server.runs.get(runId!) ?? { progress: [], feed: [], status: [], turns: [], inboxServed: false };
    server.runs.set(runId!, rec);
    if (what === 'heartbeat') return Response.json({ status: 'running', cancel: false });
    if (what === 'inbox') {
      if (rec.inboxServed || !server.inbox) return Response.json({ commands: [] });
      rec.inboxServed = true;
      return Response.json({ commands: [server.inbox] });
    }
    if (what === 'turn') {
      rec.turns.push(body);
      return Response.json({ segment: (JSON.parse(body) as { segment: number }).segment + 1 });
    }
    if (what === 'delivered') rec.turns.push(body);
    if (what === 'progress') rec.progress.push(body);
    // el feed se aplana: cuántos lotes salen depende del reloj, los eventos no.
    if (what === 'events') rec.feed.push(...((JSON.parse(body) as { events: unknown[] }).events ?? []));
    if (what === 'status') rec.status.push(body);
    return Response.json({ ok: true });
  }) as typeof fetch;
}

// --- normalización: nada del tmpdir ni de la máquina ---

const RUNNER_ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));
const normalizer = (): ((s: string) => string) => {
  const roots = Array.from(new Set([fs.realpathSync(root), root])).sort((a, b) => b.length - a.length);
  return (s) =>
    roots
      .reduce((acc, r) => acc.split(r).join('<root>'), s.split(RUNNER_ENTRY).join('<runner>').split(process.execPath).join('<node>'))
      .replace(/mcp-([A-Za-z0-9_-]+?)-[0-9a-f]{8}(?=\.json|\/|"|$|\))/g, 'mcp-$1-<rand>');
};

async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  // i/o secuencial: sondeo hasta que se cumpla.
  while (!done()) {
    if (Date.now() > deadline) throw new Error('espera agotada');
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
  }
}

async function runCase(c: Case): Promise<unknown> {
  const dir = path.join(root, 'cases', c.name);
  fs.mkdirSync(dir, { recursive: true });
  const host = `${c.name}.${BASE_HOST}`;
  const configFile = path.join(dir, 'runner.json');
  const config: RunnerConfig = { baseUrl: `https://${host}`, clientId: 'c1', refreshToken: 'r1', label: 'fa', machineId: MACHINE, machineHost: 'fa', repos: {}, aws: {}, defaults: {} };
  fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const server: Server = { runs: new Map(), slash: [], inbox: c.inbox };
  servers.set(host, server);
  // el daemon lee config y home del env del proceso en cada acceso: los casos van de uno en uno.
  process.env.DUCKHUNT_RUNNER_CONFIG = configFile;
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  const d = internals(loadConfig()!) as DaemonInternals & { refreshBrowserHealth(force?: boolean): Promise<void> };
  await d.reloadConfig();
  await d.refreshBrowserHealth(true);
  setClaudeInfo(d, claude);
  const raw = kit(c.kit);
  const claimRaw = { ...raw, run: { ...(raw.run as Record<string, unknown>), ...c.run }, prompt: `SCRIPT:${c.name}`, ...(c.extra ?? {}) };
  const claim: ClaimResponse = parseClaim(claimRaw as unknown, { canBypass: true });
  await d.executeRun(legacyOf(d), claim, new RunLease(claim.run.id));
  if (c.slash) await waitFor(() => server.slash.length > 0);

  const norm = normalizer();
  const rec = server.runs.get(claim.run.id) ?? { progress: [], feed: [], status: [], turns: [], inboxServed: false };
  const stdinFile = path.join(dir, 'stdin.jsonl');
  return {
    ...(fs.existsSync(stdinFile) ? { stdin: fs.readFileSync(stdinFile, 'utf8').trim().split('\n').map(norm) } : {}),
    progress: rec.progress.map(norm),
    feed: rec.feed.map((e) => JSON.parse(norm(JSON.stringify(e))) as unknown),
    status: rec.status.map(norm),
    ...(rec.turns.length > 0 ? { turns: rec.turns.map(norm) } : {}),
    ...(server.slash.length > 0 ? { slash: server.slash.map((s) => JSON.parse(norm(s)) as unknown) } : {}),
  };
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-output-'));
  bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  writeFakeClaude(bin, REPLAY_BODY);
  // la config de claude code del usuario: un comando suyo y un plugin con otro (el catálogo slash los resuelve).
  userHome = path.join(root, 'user');
  const plugin = path.join(root, 'plugins', 'herr');
  fs.mkdirSync(path.join(userHome, '.claude', 'commands'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(userHome, '.claude', 'commands', 'revisa.md'), `---\ndescription: revisa el diff con ${SECRETS.github}\nargument-hint: <rama>\n---\nrevisa $ARGUMENTS\n`);
  fs.writeFileSync(path.join(plugin, 'commands', 'lint.md'), '---\ndescription: pasa el linter\n---\nlint\n');
  const scripts = path.join(root, 'scripts');
  fs.mkdirSync(scripts);
  const fill = (s: string): string => s.split('<plugin>').join(plugin).split('<home>').join(userHome);
  Object.entries(SCRIPTS).forEach(([name, s]) => fs.writeFileSync(path.join(scripts, `${name}.json`), fill(JSON.stringify(s))));
  // env controlado: nada de la máquina que corre el test salvo el PATH.
  const baseEnv = { PATH: `${bin}${path.delimiter}${savedEnv.PATH ?? ''}`, HOME: userHome, TMPDIR: root, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1' };
  Object.keys(process.env).forEach((k) => delete process.env[k]);
  Object.assign(process.env, baseEnv);
  claude = await detectClaude();
  installFetch();
});

after(() => {
  globalThis.fetch = realFetch;
  Object.keys(process.env).forEach((k) => delete process.env[k]);
  Object.assign(process.env, savedEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

test('la salida de claude (stream-json, stderr, exit y stdin vivo) llega al server igual, byte a byte', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  assert.equal(claude.version, FAKE_CLAUDE_VERSION);
  const outputs: Record<string, unknown> = {};
  // i/o secuencial: los casos comparten el env del proceso (config y home del daemon).
  for (const c of CASES) outputs[c.name] = await runCase(c);
  const text = `${JSON.stringify(outputs, null, 2)}\n`;
  // ningún secreto sale de la máquina: ni en el feed, ni en el status, ni en los turnos, ni en el catálogo.
  Object.values(SECRETS).forEach((s) => assert.equal(text.includes(s), false, 'un secreto llegó al server'));
  if (UPDATE) {
    fs.mkdirSync(path.dirname(GOLDEN.pathname), { recursive: true });
    fs.writeFileSync(GOLDEN, text);
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(outputs), Object.keys(golden), 'los mismos casos');
  Object.keys(golden).forEach((name) => assert.deepEqual(outputs[name], golden[name], name));
});
