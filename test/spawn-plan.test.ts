// plan de lanzamiento de un run legacy, fijado byte a byte (t#495, M2): para cada claim de duckhunt (los fixtures
// de test/fixtures y casos sintéticos: repo, sin repo, aws mapeada, sin mapear o solo región, worktree de
// conversación reutilizado, reanudación fallida, run de reglas, checkout compartido, symlink que escapa, prepare
// roto) el daemon de verdad ejecuta el run contra un `claude` falso que anota su argv, su cwd, su env y el
// mcp-config que recibe, y un server falso que guarda progress, feed y status. todo se normaliza (rutas del
// tmpdir, sufijos aleatorios, shas) y se compara con test/golden/spawn-plan.json, que se capturó con el daemon de
// antes de los recursos (P3): el refactor no puede mover ni un byte de lo que ve claude ni de lo que ve el server.
// UPDATE_SPAWN_PLAN=1 lo reescribe (solo para capturar, nunca para tapar una diferencia).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { detectClaude, OPTIONAL_FLAGS, type ClaudeInfo } from '../src/claude.js';
import { parseClaim, TOOLSET_V1, type ClaimResponse } from '../src/claim.js';
import { internals, legacyOf, type DaemonInternals as Harness } from './daemon-harness.js';
import { loadConfig, type RunnerConfig } from '../src/config.js';
import { RunLease } from '../src/run-lease.js';
import { allRunConfigDirs } from '../src/paths.js';
import { runConfigDeny } from '../src/run-mcp-config.js';
import { secretPathsDeny } from '../src/secret-paths.js';

const GOLDEN = new URL('../../test/golden/spawn-plan.json', import.meta.url);
const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
const UPDATE = process.env.UPDATE_SPAWN_PLAN === '1';
const MACHINE = '6f1d7c1e-5b0a-4c34-9b8e-2a3f7c1d9e01';
const ACCOUNT = '123456789012';
const UNMAPPED_ACCOUNT = '999999999999';
const REPO = 'okt/api';
// argumentos largos (listas de tools, prompts) van como hash + longitud.
const LONG_ARG_CHARS = 200;
const HASH_CHARS = 16;
const HOLD_POLL_MS = 20;
// espera máxima a que el run retenido arranque o el segundo pida turno.
const HOLD_TIMEOUT_MS = 15_000;
// fecha fija de los commits: shas deterministas.
const GIT_DATE = '2026-01-01T00:00:00Z';

const savedEnv = { ...process.env };
let root = '';
let bin = '';
let origin = '';
let escapingOrigin = '';
let claude: ClaudeInfo = { version: null, supported: new Set() };
// env del proceso durante el test: lo que el daemon recibe como process.env (el diff se mide contra él).
let baseEnv: Record<string, string> = {};

const sha = (s: string): string => crypto.createHash('sha256').update(s).digest('hex').slice(0, HASH_CHARS);

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_AUTHOR_DATE: GIT_DATE,
  GIT_COMMITTER_DATE: GIT_DATE,
});
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], { cwd, env: gitEnv(), encoding: 'utf-8' }).trim();

// origin bare con main (README, settings de proyecto con un allow que se espeja) y, opcionalmente, un symlink
// commiteado que sale del checkout.
function makeOrigin(name: string, links: Record<string, string> = {}): string {
  const work = path.join(root, `${name}-work`);
  fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
  git(work, 'init', '-q');
  fs.writeFileSync(path.join(work, 'README.md'), 'hola\n');
  fs.writeFileSync(path.join(work, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(make:*)', 'Write(docs/**)'] } }));
  Object.entries(links).forEach(([link, target]) => fs.symlinkSync(target, path.join(work, link)));
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  const bare = path.join(root, `${name}.git`);
  git(root, 'clone', '-q', '--bare', work, bare);
  return bare;
}

// `claude` falso: --version/--help como el de verdad (todos los flags opcionales); un run anota lo que recibe en
// <case>/spawns.jsonl (el case es el primer padre del mcp-config con la config del caso) y contesta un stream-json mínimo. el prompt puede
// pedir esperar a un fichero (HOLD:<f>) o fallar (FAIL); --resume gone simula una sesión que no está. con una sesión de
// navegador en el mcp-config (res_browser_*, t#495 M7) anota la copia que recibe y le añade una cookie, como odysea al
// guardar un token rotado (sin ella, lo de siempre).
function writeFakeClaude(): void {
  const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
if (args[0] === '--help') { console.log(${JSON.stringify(OPTIONAL_FLAGS.join('\n'))}); process.exit(0); }
const mcpFile = args[args.indexOf('--mcp-config') + 1];
let caseDir = path.dirname(mcpFile);
while (!fs.existsSync(path.join(caseDir, 'runner.json'))) caseDir = path.dirname(caseDir);
const browsers = Object.entries(JSON.parse(fs.readFileSync(mcpFile, 'utf8')).mcpServers).filter(([name]) => name.startsWith('res_browser_'));
const copies = browsers.map(([name, s]) => ({ name, state: JSON.parse(fs.readFileSync(s.env.ODYSEA_STATE_FILE, 'utf8')) }));
browsers.forEach(([, s]) => {
  const st = JSON.parse(fs.readFileSync(s.env.ODYSEA_STATE_FILE, 'utf8'));
  st.cookies.push({ name: 'rotated', value: 'nuevo', domain: 'acme.atlassian.net', path: '/', expires: -1 });
  fs.writeFileSync(s.env.ODYSEA_STATE_FILE, JSON.stringify(st));
});
fs.appendFileSync(path.join(caseDir, 'spawns.jsonl'), JSON.stringify({ argv: args, cwd: process.cwd(), env: process.env, mcp: fs.readFileSync(mcpFile, 'utf8'), ...(copies.length > 0 ? { copies } : {}) }) + '\\n');
const prompt = args[args.length - 1];
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const finish = () => {
  if (resume === 'gone') { process.stderr.write('No conversation found with session ID: gone\\n'); process.exit(1); }
  const sid = resume || 'sess-new';
  out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5' });
  out({ type: 'assistant', message: { content: [{ type: 'text', text: 'miro el repo' }, { type: 'tool_use', name: 'Read', input: { file_path: path.join(process.cwd(), 'README.md') } }] } });
  if (prompt.includes('FAIL')) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'roto', session_id: sid }); process.exit(1); }
  out({ type: 'result', subtype: 'success', is_error: false, result: 'hecho', total_cost_usd: 0.5, num_turns: 2, session_id: sid });
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

interface Case {
  name: string;
  raw: Record<string, unknown>;
  // config del caso sobre la base (repos, aws, defaults).
  cfg?: (base: RunnerConfig, dir: string) => RunnerConfig;
  // claims que corren en el mismo caso uno tras otro (segmentos de la misma fila) o a la vez (`parallel`).
  then?: Record<string, unknown>[];
  parallel?: boolean;
  // origin del checkout (por defecto el normal) o ninguno (el path mapeado no es un repo).
  origin?: 'escaping' | 'none';
  // retoque del claim ya parseado (lo que ningún claim legacy trae: la marca toolset_v1).
  patch?: (claim: ClaimResponse) => ClaimResponse;
  // plataforma que ejecuta los claims (por defecto la legacy).
  platform?: string;
  // la máquina tiene aws cli (por defecto no: el harness no detecta la suya). el render de toolset_v1 la mira.
  awsCli?: boolean;
}

interface DaemonInternals extends Harness {
  claude: ClaudeInfo;
  secretDeny: string[];
  hasAws: boolean;
  refreshBrowserHealth(force?: boolean): Promise<void>;
}

const fixtureCases = (): Case[] =>
  ['claims', 'claim-kits'].flatMap((dir) =>
    fs
      .readdirSync(new URL(`${dir}/`, FIXTURES))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => ({ name: `${dir}/${f.replace(/\.json$/, '')}`, raw: JSON.parse(fs.readFileSync(new URL(`${dir}/${f}`, FIXTURES), 'utf8')) as Record<string, unknown> })),
  );

const kit = (name: string): Record<string, unknown> => JSON.parse(fs.readFileSync(new URL(`claim-kits/${name}.json`, FIXTURES), 'utf8')) as Record<string, unknown>;
const withRun = (raw: Record<string, unknown>, run: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...raw,
  run: { ...(raw.run as Record<string, unknown>), ...run },
  ...extra,
});
// run de reglas heredado (servers anteriores a t#465 P6): sin perfil, con turnos y presupuesto.
const ruleRun = (id: number, prompt = 'investiga la alarma'): Record<string, unknown> =>
  withRun(kit('prompt-edit-full'), { id, kind: 'investigate', profile: null, isolation: undefined, seed: null, sessionId: null }, { prompt, maxTurns: 30, maxBudgetUsd: 2 });

function syntheticCases(): Case[] {
  const read = kit('prompt-read-full');
  const edit = kit('prompt-edit-full');
  const checkoutEdit = kit('prompt-edit-checkout');
  const template = kit('template-full-aws-announced');
  return [
    { name: 'synthetic/rule-worktree-done', raw: ruleRun(901) },
    { name: 'synthetic/rule-worktree-failed', raw: ruleRun(902, 'investiga y FAIL') },
    {
      name: 'synthetic/rule-checkout-worktree-false-skip',
      raw: ruleRun(903),
      cfg: (c) => ({ ...c, repos: { [REPO]: { ...c.repos[REPO]!, worktree: false, dangerouslySkipPermissions: true } } }),
    },
    { name: 'synthetic/aws-unmapped-account', raw: withRun(template, { id: 904, aws: { accountId: UNMAPPED_ACCOUNT, region: 'eu-west-1' } }) },
    { name: 'synthetic/aws-region-only', raw: withRun(template, { id: 905, aws: { accountId: null, region: 'us-east-1' } }) },
    { name: 'synthetic/aws-mapped-region-from-claim', raw: withRun(template, { id: 906 }), cfg: (c) => ({ ...c, aws: { [ACCOUNT]: { profile: 'okt-prod' } } }) },
    { name: 'synthetic/repo-checkout-missing', raw: withRun(read, { id: 907 }), cfg: (c, dir) => ({ ...c, repos: { [REPO]: { path: path.join(dir, 'no-existe') } } }) },
    { name: 'synthetic/repo-not-git', raw: withRun(read, { id: 908 }), origin: 'none' },
    { name: 'synthetic/conversation-reused', raw: withRun(edit, { id: 909, segment: 1 }), then: [withRun(edit, { id: 909, segment: 2, sessionId: 'sess-new' })] },
    { name: 'synthetic/resume-gone-fallback', raw: withRun(read, { id: 910, sessionId: 'gone' }, { fallbackPrompt: 'empieza de cero' }) },
    {
      name: 'synthetic/checkout-shared-turn',
      raw: withRun(checkoutEdit, { id: 911 }, { prompt: 'HOLD:<hold>' }),
      then: [withRun(checkoutEdit, { id: 912 }, { prompt: 'segundo en el checkout' })],
      parallel: true,
    },
    { name: 'synthetic/escaping-symlink', raw: withRun(read, { id: 913 }), origin: 'escaping' },
    { name: 'synthetic/defaults-model-budget', raw: withRun(template, { id: 914 }), cfg: (c) => ({ ...c, defaults: { ...c.defaults, model: 'sonnet', maxBudgetUsd: 3 } }) },
    { name: 'synthetic/edit-no-repo-scratch', raw: withRun(edit, { id: 915, repo: null, branch: null, isolation: undefined }) },
  ];
}

// --- normalización: nada del tmpdir, de la aleatoriedad o de la máquina en el plan ---

const normalizer = (dir: string): ((s: string) => string) => {
  const roots = Array.from(new Set([fs.realpathSync(root), root])).sort((a, b) => b.length - a.length);
  const caseRel = path.relative(root, dir);
  return (s) =>
    roots
      .reduce((acc, r) => acc.split(`${r}/${caseRel}`).join('<case>').split(r).join('<root>'), s)
      .replace(/(mcp|aws)-([A-Za-z0-9_-]+?)-[0-9a-f]{8}(?=\.json|\/|"|$|\))/g, '$1-$2-<rand>')
      // el motivo de git depende del sistema de ficheros del tmpdir (¿hay un punto de montaje por medio?).
      .replace(/not a git repository \(or any [^)]*\)(: \.git)?/g, 'not a git repository')
      .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
      .replace(/@[0-9a-f]{7}\b/g, '@<sha>');
};

interface Spawn {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  mcp: string;
}

// argv legible: las listas de tools como hash + lo que el daemon añadió por su cuenta; el prompt por su origen.
function argvPlan(argv: string[], claim: ClaimResponse, norm: (s: string) => string): unknown[] {
  const promptAt = argv.indexOf('--') + 1;
  return argv.map((a, i) => {
    if (i === promptAt) return a === claim.prompt ? '<claim.prompt>' : a === claim.fallbackPrompt ? '<claim.fallbackPrompt>' : `<prompt ${sha(norm(a))}>`;
    if (argv[i - 1] === '--allowedTools') {
      const list = a.split(',');
      return { allowed: sha(norm(a)), count: list.length, notFromClaim: list.filter((t) => !claim.tools.allowed.includes(t)).map(norm), dropped: claim.tools.allowed.filter((t) => !list.includes(t)) };
    }
    if (argv[i - 1] === '--disallowedTools') {
      const list = a.split(',');
      return { disallowed: sha(norm(a)), count: list.length, notFromClaim: list.filter((t) => !claim.tools.disallowed.includes(t)).map(norm) };
    }
    const n = norm(a);
    return n.length > LONG_ARG_CHARS ? `<${sha(n)} len=${n.length}>` : n;
  });
}

function envPlan(env: Record<string, string>, norm: (s: string) => string): unknown {
  const set = Object.fromEntries(
    Object.entries(env)
      .filter(([k, v]) => baseEnv[k] !== v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, norm(v)]),
  );
  const removed = Object.keys(baseEnv)
    .filter((k) => !Object.hasOwn(env, k))
    .sort();
  return { set, removed };
}

// server falso de un caso: el token endpoint y /api/runner; guarda por run lo que importa al plan.
interface Recorded {
  progress: string[];
  feed: unknown[];
  status: string[];
}

const BASE_HOST = 'duckhunt.test';
const realFetch = globalThis.fetch;
const servers = new Map<string, Map<string, Recorded>>();

function installFetch(): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/oauth/token')) return Response.json({ access_token: 'a', refresh_token: 'r2', expires_in: 3600 });
    const runs = servers.get(url.host);
    const m = /\/api\/runner\/runs\/([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!runs || !m) return Response.json({ ok: true });
    const [, runId, what] = m;
    const rec = runs.get(runId!) ?? { progress: [], feed: [], status: [] };
    runs.set(runId!, rec);
    const body = String(init?.body);
    if (what === 'heartbeat') return Response.json({ status: 'running', cancel: false });
    if (what === 'progress') rec.progress.push(body);
    // el feed se aplana: cuántos lotes salen depende del reloj, los eventos no.
    if (what === 'events') rec.feed.push(...((JSON.parse(body) as { events: unknown[] }).events ?? []));
    if (what === 'status') rec.status.push(body);
    return Response.json({ ok: true });
  }) as typeof fetch;
}

const listDir = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

async function runCase(c: Case): Promise<unknown> {
  const slug = c.name.replace(/[^a-z0-9]+/gi, '-');
  const dir = path.join(root, 'cases', slug);
  const host = `${slug}.${BASE_HOST}`.toLowerCase();
  fs.mkdirSync(dir, { recursive: true });
  const checkout = path.join(dir, 'checkout');
  if (c.origin === 'none') fs.mkdirSync(checkout);
  else git(dir, 'clone', '-q', c.origin === 'escaping' ? escapingOrigin : origin, checkout);
  const configFile = path.join(dir, 'runner.json');
  const home = path.join(dir, 'home');
  const base: RunnerConfig = {
    baseUrl: `https://${host}`,
    clientId: 'c1',
    refreshToken: 'r1',
    label: 'fa',
    machineId: MACHINE,
    machineHost: 'fa',
    repos: { [REPO]: { path: checkout } },
    aws: { [ACCOUNT]: { profile: 'okt-prod', region: 'eu-west-1' } },
    defaults: {},
  };
  fs.writeFileSync(configFile, JSON.stringify(c.cfg ? c.cfg(base, dir) : base), { mode: 0o600 });
  const runs = new Map<string, Recorded>();
  servers.set(host, runs);

  // el daemon lee config y home del env del proceso en cada acceso: los casos van de uno en uno.
  process.env.DUCKHUNT_RUNNER_CONFIG = configFile;
  process.env.DUCKHUNT_RUNNER_HOME = home;
  const d = internals(loadConfig()!) as DaemonInternals;
  await d.reloadConfig();
  // lo que hace run() al arrancar, sin el loop ni las señales: también la salud de las sesiones de navegador (sin
  // ninguna configurada, nada: ni se busca odysea).
  await d.refreshBrowserHealth(true);
  d.claude = claude;
  d.hasAws = c.awsCli === true;
  allRunConfigDirs().forEach(runConfigDeny);
  d.secretDeny = secretPathsDeny(process.env).rules;
  const hold = path.join(dir, 'hold');
  const claims = [c.raw, ...(c.then ?? [])].map((raw) => (c.patch ?? ((cl: ClaimResponse) => cl))(parseClaim(JSON.parse(JSON.stringify(raw).replaceAll('<hold>', hold)) as unknown)));
  const sup = c.platform ? d.supervisors.get(c.platform)! : legacyOf(d);
  const exec = (claim: ClaimResponse): Promise<void> => d.executeRun(sup, claim, new RunLease(claim.run.id));
  if (c.parallel) {
    const first = exec(claims[0]!);
    await waitFor(() => fs.existsSync(`${hold}.started`));
    const rest = claims.slice(1).map(exec);
    // el segundo ya espera turno: su feed (con la nota de esperar) sale antes de soltar al primero.
    await waitFor(() => (runs.get(claims[1]!.run.id)?.feed.length ?? 0) > 0);
    fs.writeFileSync(hold, '');
    await Promise.all([first, ...rest]);
  } else {
    // i/o secuencial: segmentos de la misma fila, en orden.
    for (const claim of claims) await exec(claim);
  }

  const norm = normalizer(dir);
  const spawnsFile = path.join(dir, 'spawns.jsonl');
  const spawns = (fs.existsSync(spawnsFile) ? fs.readFileSync(spawnsFile, 'utf8').trim().split('\n') : []).map((l) => JSON.parse(l) as Spawn);
  const claimFor = (s: Spawn): ClaimResponse => claims.find((cl) => s.mcp.includes(cl.mcp.token) && (s.argv.at(-1) === cl.prompt || s.argv.at(-1) === cl.fallbackPrompt)) ?? claims[0]!;
  const orderedRuns = [...new Set(claims.map((cl) => cl.run.id))];
  return {
    spawns: spawns.map((s) => ({ cwd: norm(s.cwd), argv: argvPlan(s.argv, claimFor(s), norm), env: envPlan(s.env, norm), mcp: norm(s.mcp) })),
    runs: Object.fromEntries(
      orderedRuns.map((id) => {
        const rec = runs.get(id) ?? { progress: [], feed: [], status: [] };
        return [id, { progress: rec.progress.map(norm), feed: rec.feed.map((e) => JSON.parse(norm(JSON.stringify(e))) as unknown), status: rec.status.map(norm) }];
      }),
    ),
    // lo que queda en disco tras el run: run-config vacío (mcp-config y aws vacía borrados), worktrees conservados.
    left: {
      runConfig: listDir(path.join(home, 'run-config')).map(norm),
      worktrees: listDir(path.join(checkout, '.duckhunt', 'worktrees')),
      exclude: fs.existsSync(path.join(checkout, '.git', 'info', 'exclude')) ? fs.readFileSync(path.join(checkout, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#')) : [],
    },
  };
}

async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + HOLD_TIMEOUT_MS;
  while (!done()) {
    if (Date.now() > deadline) throw new Error('espera agotada en el caso de turno compartido');
    await new Promise((r) => setTimeout(r, HOLD_POLL_MS));
  }
}

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-plan-'));
  bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  writeFakeClaude();
  const userHome = path.join(root, 'user');
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true });
  // settings de usuario con un allow que el kit de lectura espeja a su deny.
  fs.writeFileSync(path.join(userHome, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test:*)', 'Edit(src/**)', 'Read(**)'] } }));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  // env controlado: el del usuario (aws por defecto, restos de una sesión de claude, una api key vacía) sin
  // nada de la máquina que corre el test salvo el PATH.
  baseEnv = {
    PATH: `${bin}${path.delimiter}${savedEnv.PATH ?? ''}`,
    HOME: userHome,
    TMPDIR: root,
    LANG: 'C.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    AWS_PROFILE: 'user-default',
    AWS_ACCESS_KEY_ID: 'AKIAUSERDEFAULTKEY00',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'outer-session',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-del-usuario',
    ANTHROPIC_API_KEY: '',
  };
  Object.keys(process.env).forEach((k) => delete process.env[k]);
  Object.assign(process.env, baseEnv);
  origin = makeOrigin('origin');
  escapingOrigin = makeOrigin('escaping', { fuera: outside });
  claude = await detectClaude();
  installFetch();
});

after(() => {
  globalThis.fetch = realFetch;
  Object.keys(process.env).forEach((k) => delete process.env[k]);
  Object.assign(process.env, savedEnv);
  fs.rmSync(root, { recursive: true, force: true });
});

test('el plan de lanzamiento de cada claim legacy es el de antes de los recursos, byte a byte', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  assert.equal(claude.version, '9.9.9 (Claude Code)');
  const cases = [...fixtureCases(), ...syntheticCases()];
  const plans: Record<string, unknown> = {};
  // i/o secuencial: los casos comparten el env del proceso (config y home del daemon).
  for (const c of cases) plans[c.name] = await runCase(c);
  const text = `${JSON.stringify(plans, null, 2)}\n`;
  if (UPDATE) {
    fs.mkdirSync(path.dirname(GOLDEN.pathname), { recursive: true });
    fs.writeFileSync(GOLDEN, text);
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(plans), Object.keys(golden), 'los mismos casos');
  Object.keys(golden).forEach((name) => assert.deepEqual(plans[name], golden[name], name));
});

// fuera del golden: lo que un claim legacy no hace nunca (t#495, M2 P5).
test('aislar la aws solo con toolset_v1: sin aws pedida, la aws vacía; el mismo claim legacy, la del usuario', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const raw = withRun(kit('prompt-read-full'), { id: 950, aws: null });
  type Plan = { spawns: { env: { set: Record<string, string>; removed: string[] } }[]; runs: Record<string, { feed: { body: string }[] }>; left: { runConfig: string[] } };
  const legacy = (await runCase({ name: 'isolate/legacy', raw })) as Plan;
  const v1 = (await runCase({ name: 'isolate/toolset-v1', raw, patch: (cl) => ({ ...cl, toolset: { v: TOOLSET_V1 } }) })) as Plan;
  const [legacyEnv, v1Env] = [legacy.spawns[0]!.env, v1.spawns[0]!.env];
  assert.equal(legacyEnv.removed.includes('AWS_PROFILE'), false, 'legacy: el perfil del usuario sigue');
  assert.equal(legacyEnv.set.AWS_CONFIG_FILE, undefined);
  assert.ok(v1Env.removed.includes('AWS_PROFILE') && v1Env.removed.includes('AWS_ACCESS_KEY_ID'), 'toolset_v1: sin perfil ni claves');
  assert.match(v1Env.set.AWS_CONFIG_FILE ?? '', /^<case>\/home\/run-config\/aws-950-<rand>\/config$/);
  assert.equal(v1Env.set.AWS_EC2_METADATA_DISABLED, 'true');
  assert.equal(v1Env.set.AWS_DEFAULT_REGION, undefined, 'sin región');
  assert.equal(v1.runs['950']!.feed.some((e) => e.body.includes('aws')), false, 'aislar no avisa: es lo esperado');
  assert.deepEqual(v1.left.runConfig, [], 'la aws vacía se borra al cerrar');
});

// fuera del golden: dos plataformas en la config (t#495, M6.3).
test('dos plataformas: cada run niega el scratch de la otra; el de la nueva no ve lo que no le expone y corre con la aws aislada', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  type Plan = { spawns: { cwd: string; argv: unknown[]; env: { set: Record<string, string>; removed: string[] } }[]; runs: Record<string, { feed: { body: string }[] }> };
  const withBeta = (c: RunnerConfig): RunnerConfig =>
    ({ ...c, version: 2, platforms: { beta: { protocol: 'duckhunt-42', trusted: true, credential: { baseUrl: c.baseUrl, clientId: 'b1', refreshToken: 'rb' } } } }) as unknown as RunnerConfig;
  const denied = (plan: Plan): string[] => {
    const argv = plan.spawns[0]!.argv;
    return (argv[argv.indexOf('--disallowedTools') + 1] as { notFromClaim: string[] }).notFromClaim;
  };
  const raw = withRun(kit('prompt-read-full'), { id: 960, aws: null });
  const legacy = (await runCase({ name: 'platforms/legacy', raw, cfg: withBeta })) as Plan;
  assert.equal(legacy.spawns[0]!.cwd, '<case>/checkout/.duckhunt/worktrees/conv-960', 'la legacy, como siempre');
  assert.ok(denied(legacy).includes('Read(/<case>/home/platforms/beta/scratch/**)'), 'el scratch de beta');
  assert.ok(denied(legacy).includes('Read(/<case>/home/platforms/beta/run-config/**)'), 'y su run-config, desde que existe en la config');
  assert.equal(legacy.spawns[0]!.env.removed.includes('AWS_PROFILE'), false);

  const beta = (await runCase({ name: 'platforms/beta', raw: withRun(raw, { id: 961 }), cfg: withBeta, platform: 'beta' })) as Plan;
  assert.equal(beta.spawns[0]!.cwd, '<case>/home/platforms/beta/scratch', 'el repo no le está expuesto: su scratch');
  assert.ok(beta.runs['961']!.feed.some((e) => e.body.includes('no mapeado')));
  assert.ok(denied(beta).includes('Read(/<case>/home/scratch/**)'), 'el scratch de duckhunt');
  assert.ok(['Read(/<case>/home/run-config/**)', 'Read(/<case>/home/platforms/beta/run-config/**)'].every((r) => denied(beta).includes(r)));
  assert.ok(!denied(beta).includes('Read(/<case>/home/platforms/beta/scratch/**)'), 'el suyo no: es su cwd');
  assert.ok(beta.spawns[0]!.env.removed.includes('AWS_PROFILE'), 'sin la aws del usuario');
  assert.match(beta.spawns[0]!.env.set.AWS_CONFIG_FILE ?? '', /^<case>\/home\/platforms\/beta\/run-config\/aws-961-<rand>\/config$/);
});

// fuera del golden: toolset_v1 en sombra (t#495, M5).
// el interruptor del flip (defaults.toolsetRender: false): la config de un caso que vuelve a la sombra sin el flip.
const renderOff = (c: RunnerConfig): RunnerConfig => ({ ...c, defaults: { ...c.defaults, toolsetRender: false } });

test('el interruptor del flip (toolsetRender: false): la sombra sin el flip, el spawn de siempre y solo el status lleva toolsetShadow', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  // el caso de un daemon sin aws cli: el harness no detecta la suya, así que server y daemon coinciden.
  const name = 'prompt-read-no-aws-cli';
  const v1 = JSON.parse(fs.readFileSync(new URL(`toolset-v1/${name}.json`, FIXTURES), 'utf8')) as { toolset: unknown };
  type Plan = { spawns: unknown[]; runs: Record<string, { status: string[] }> };
  const legacy = (await runCase({ name: 'shadow/legacy', raw: withRun(kit(name), { id: 980 }), cfg: renderOff })) as Plan;
  const shadowed = (await runCase({ name: 'shadow/toolset-v1', raw: withRun(kit(name), { id: 980 }, { toolset: v1.toolset }), cfg: renderOff })) as Plan;
  assert.deepEqual(shadowed.spawns, legacy.spawns, 'cwd, env, argv y mcp-config idénticos: la sombra no toca el spawn');
  const statusOf = (p: Plan): Record<string, unknown>[] => p.runs['980']!.status.map((s) => JSON.parse(s) as Record<string, unknown>);
  assert.equal(statusOf(legacy).some((s) => 'toolsetShadow' in s), false, 'sin toolset, el status de siempre');
  const [closed, ...more] = statusOf(shadowed);
  assert.equal(more.length, 0);
  const { toolsetShadow, ...rest } = closed!;
  assert.deepEqual(rest, statusOf(legacy)[0], 'lo demás del status, igual');
  assert.deepEqual(toolsetShadow, { match: true, explained: true, known: [], diff: null });
});

// --- el flip de toolset_v1 (t#495, M5): fuera del golden ---

type FlipPlan = {
  spawns: { cwd: string; env: { set: Record<string, string>; removed: string[] }; argv: unknown[] }[];
  runs: Record<string, { status: string[]; feed: { body: string }[] }>;
};
// el toolset que el server manda para un caso de la matriz (toolset-v1/, o toolset-v1-aws-default/ si la máquina
// anuncia su aws por defecto).
const toolsetFx = (name: string, dir = 'toolset-v1'): { grants: unknown[] } & Record<string, unknown> =>
  (JSON.parse(fs.readFileSync(new URL(`${dir}/${name}.json`, FIXTURES), 'utf8')) as { toolset: { grants: unknown[] } & Record<string, unknown> }).toolset;
const withToolset = (name: string, id: number, dir?: string): Record<string, unknown> => withRun(kit(name), { id }, { toolset: toolsetFx(name, dir) });
// la aws por defecto de la máquina, mapeada (`resource add aws default personal`).
const awsDefault = (c: RunnerConfig): RunnerConfig => ({ ...c, aws: { ...c.aws, default: { profile: 'personal' } } });
// lo que la lista de tools del spawn tiene de más y de menos frente a la del server (argvPlan).
const allowedOf = (p: FlipPlan): { notFromClaim: string[]; dropped: string[] } => {
  const { notFromClaim, dropped } = p.spawns[0]!.argv.find((a): a is { notFromClaim: string[]; dropped: string[] } => typeof a === 'object' && a !== null && 'dropped' in a)!;
  return { notFromClaim, dropped };
};
const AWS_PATTERN_PREFIX = 'Bash(aws ';
const statusOf = (p: FlipPlan, id: number): Record<string, unknown> => JSON.parse(p.runs[String(id)]!.status[0]!) as Record<string, unknown>;

test('flip: con su cuenta mapeada, el spawn de hoy salido del render', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const name = 'template-full-aws-announced';
  const legacy = (await runCase({ name: 'flip/legacy', raw: withRun(kit(name), { id: 960 }), cfg: renderOff, awsCli: true })) as FlipPlan;
  const render = (await runCase({ name: 'flip/render', raw: withToolset(name, 960), awsCli: true })) as FlipPlan;
  assert.deepEqual(render.spawns, legacy.spawns, 'cwd, env (su perfil), argv y mcp-config: los de hoy');
  assert.deepEqual(statusOf(render, 960).toolsetShadow, { match: true, explained: true, known: [], diff: null });
});

test('flip: sin cuenta, la aws de la máquina solo con `default` expuesta (lectura con sus patrones, edición entera)', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const isolated = (p: FlipPlan, id: number): void => {
    const { env } = p.spawns[0]!;
    assert.ok(env.removed.includes('AWS_PROFILE') && env.removed.includes('AWS_ACCESS_KEY_ID'), `${id}: sin el perfil ni las claves del usuario`);
    assert.match(env.set.AWS_CONFIG_FILE ?? '', new RegExp(`^<case>/home/run-config/aws-${id}-<rand>/config$`), `${id}: la aws vacía`);
  };
  const withDefault = (p: FlipPlan, id: number): void => {
    assert.equal(p.spawns[0]!.env.set.AWS_PROFILE, 'personal', `${id}: el perfil de \`default\``);
    assert.equal(p.spawns[0]!.env.set.AWS_CONFIG_FILE, undefined, `${id}: nada de aws vacía`);
  };
  // lectura sin `default`: aislada y sin los patrones de la aws en lectura que el server daba con la identidad por defecto.
  const read = (await runCase({ name: 'flip/read-no-default', raw: withToolset('prompt-read-full', 961), awsCli: true })) as FlipPlan;
  isolated(read, 961);
  assert.ok(allowedOf(read).dropped.length > 0 && allowedOf(read).dropped.every((id) => id.startsWith(AWS_PATTERN_PREFIX)), 'solo faltan los patrones de la aws');
  assert.deepEqual(allowedOf(read).notFromClaim, []);
  // la comparación, ahora al revés: lo que el server daba y el render no, explicado (el diff viaja recortado).
  const shadow = statusOf(read, 961).toolsetShadow as { match: boolean; explained: boolean; known: string[]; diff: { allowedMissing: string[]; allowedExtra: string[] } };
  assert.deepEqual([shadow.match, shadow.explained, shadow.known, shadow.diff.allowedExtra], [false, true, ['aws_without_grant'], []]);
  assert.deepEqual(shadow.diff.allowedMissing, allowedOf(read).dropped.slice(0, shadow.diff.allowedMissing.length));
  // lectura con `default`: su perfil y las mismas listas que el server.
  const readDefault = (await runCase({ name: 'flip/read-default', raw: withToolset('prompt-read-full', 962, 'toolset-v1-aws-default'), cfg: awsDefault, awsCli: true })) as FlipPlan;
  withDefault(readDefault, 962);
  assert.deepEqual(allowedOf(readDefault), { notFromClaim: [], dropped: [] }, 'el render da las listas del server');
  // edición sin `default`: Bash entero, pero sin la aws de la máquina.
  const edit = (await runCase({ name: 'flip/edit-no-default', raw: withToolset('prompt-edit-full', 963), awsCli: true })) as FlipPlan;
  isolated(edit, 963);
  assert.deepEqual(allowedOf(edit), { notFromClaim: [], dropped: [] });
  // edición con `default`: su perfil.
  const editDefault = (await runCase({ name: 'flip/edit-default', raw: withToolset('prompt-edit-full', 964, 'toolset-v1-aws-default'), cfg: awsDefault, awsCli: true })) as FlipPlan;
  withDefault(editDefault, 964);
});

test('flip: un run en el checkout trabaja donde siempre', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const name = 'prompt-edit-checkout';
  const legacy = (await runCase({ name: 'flip/checkout-legacy', raw: withRun(kit(name), { id: 965 }), cfg: renderOff })) as FlipPlan;
  const render = (await runCase({ name: 'flip/checkout-render', raw: withToolset(name, 965) })) as FlipPlan;
  assert.equal(render.spawns[0]!.cwd, legacy.spawns[0]!.cwd);
  assert.deepEqual(allowedOf(render), { notFromClaim: [], dropped: [] });
});

test('flip: un grant que el daemon no puede cumplir rechaza el claim con su código, sin lanzar nada', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const base = toolsetFx('prompt-read-full');
  // un tipo que el daemon no sirve en un run: nunca se quita en silencio.
  const unknown = (await runCase({
    name: 'flip/unknown-grant',
    raw: withRun(kit('prompt-read-full'), { id: 966 }, { toolset: { ...base, grants: [...base.grants, { type: 'kube', key: 'prod', access: 'read' }] } }),
  })) as FlipPlan;
  assert.equal(unknown.spawns.length, 0);
  assert.equal(statusOf(unknown, 966).status, 'failed');
  assert.match(String(statusOf(unknown, 966).error), /^claim rechazado por el runner \(resource_type_unknown: grant de kube/);
  // una sesión de navegador (t#495, M7) que el usuario no expone a duckhunt: su exposición de siempre no las lleva.
  const browser = (await runCase({
    name: 'flip/browser-not-exposed',
    raw: withRun(kit('prompt-read-full'), { id: 968 }, { toolset: { ...base, grants: [...base.grants, { type: 'browser', key: 'jira', access: 'read' }] } }),
  })) as FlipPlan;
  assert.equal(browser.spawns.length, 0);
  assert.match(String(statusOf(browser, 968).error), /^claim rechazado por el runner \(resource_not_exposed: grant de browser jira/);
  // una clave que el usuario no expone a duckhunt.
  const hidden = (await runCase({
    name: 'flip/repo-not-exposed',
    raw: withToolset('prompt-read-full', 967),
    cfg: (c) => ({ ...c, version: 2, platforms: { duckhunt: { expose: { repo: [], aws: '*' } } } }) as unknown as RunnerConfig,
  })) as FlipPlan;
  assert.equal(hidden.spawns.length, 0);
  assert.match(String(statusOf(hidden, 967).error), /^claim rechazado por el runner \(resource_not_exposed: grant de repo /);
});

// --- sesiones de navegador (t#495, M7): fuera del golden ---

const BROWSER_KEY = 'jira';
const BROWSER_ORIGIN = 'https://acme.atlassian.net';
// lo que guarda el vault: la cookie de la sesión y una de otro sitio que la copia del run nunca lleva.
const VAULT_STATE = {
  cookies: [
    { name: 'sid', value: 's1', domain: 'acme.atlassian.net', path: '/', expires: -1 },
    { name: 'other', value: 'x', domain: 'evil.test', path: '/', expires: -1 },
  ],
  origins: [],
};
type BrowserSpawn = Spawn & { copies?: { name: string; state: { cookies: { name: string; domain: string }[] } }[] };

// odysea falso (solo --identify: el run no lo lanza, lo lanzaría claude).
function fakeOdysea(): string {
  const file = path.join(root, 'odysea-bin', 'odysea');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!${process.execPath}\nif (process.argv[2] === '--identify') console.log(JSON.stringify({ name: '@miermontoto/odysea', tool: 'odysea', protocol: 1, version: '0.5.1' }));\n`, { mode: 0o755 });
  return file;
}

// la config del caso con la sesión `jira` (exclusiva o no) expuesta a duckhunt, su vault y el odysea falso.
const withBrowser =
  (exclusive: boolean) =>
  (c: RunnerConfig, dir: string): RunnerConfig => {
    const vault = path.join(dir, 'vault');
    fs.mkdirSync(vault, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(vault, `${BROWSER_KEY}.json`), JSON.stringify(VAULT_STATE), { mode: 0o600 });
    return {
      ...c,
      version: 2,
      resources: { browser: { [BROWSER_KEY]: { session: BROWSER_KEY, origins: [BROWSER_ORIGIN], ...(exclusive ? { exclusive: true } : {}) } } },
      providers: { browser: { bin: fakeOdysea(), vaultDir: vault } },
      platforms: { duckhunt: { expose: { repo: '*', aws: '*', browser: '*' } } },
    } as unknown as RunnerConfig;
  };

const browserFx = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(new URL(`claims-browser/${name}.json`, FIXTURES), 'utf8')) as Record<string, unknown>;
const caseDir = (name: string): string => path.join(root, 'cases', name.replace(/[^a-z0-9]+/gi, '-'));
const browserSpawns = (name: string): BrowserSpawn[] =>
  fs.readFileSync(path.join(caseDir(name), 'spawns.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as BrowserSpawn);
const flagValue = (argv: string[], flag: string): string[] => (argv[argv.indexOf(flag) + 1] ?? '').split(',');
const vaultCookies = (name: string): string[] =>
  (JSON.parse(fs.readFileSync(path.join(caseDir(name), 'vault', `${BROWSER_KEY}.json`), 'utf8')) as typeof VAULT_STATE).cookies.map((c) => c.name);

test('navegador: la sesión llega al run como su servidor mcp, con la copia filtrada, las tools de su acceso y `session` negada', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const name = 'browser/read-shared';
  const plan = (await runCase({ name, raw: browserFx('prompt-read-browser-read'), cfg: withBrowser(false) })) as { runs: Record<string, { status: string[] }>; left: { runConfig: string[] } };
  const [spawn] = browserSpawns(name);
  assert.ok(spawn, 'claude se lanzó');
  const server = (JSON.parse(spawn.mcp) as { mcpServers: Record<string, { type: string; command: string; env: Record<string, string> }> }).mcpServers[`res_browser_${BROWSER_KEY}`];
  assert.ok(server, 'el servidor de la sesión en el mcp-config');
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, path.join(root, 'odysea-bin', 'odysea'));
  assert.deepEqual(
    { origins: server.env.ODYSEA_ALLOWED_ORIGINS, session: server.env.ODYSEA_SESSION_TOOL, autosave: server.env.ODYSEA_AUTOSAVE_MS },
    { origins: BROWSER_ORIGIN, session: '0', autosave: undefined },
    'sin exclusiva no se autoguarda',
  );
  assert.deepEqual(spawn.copies?.[0]?.state.cookies.map((c) => c.name), ['sid'], 'la copia del run, filtrada a sus orígenes');
  const allowed = flagValue(spawn.argv, '--allowedTools');
  assert.ok(allowed.includes(`mcp__res_browser_${BROWSER_KEY}__navigate`) && allowed.includes(`mcp__res_browser_${BROWSER_KEY}__dom_snapshot`), 'las de lectura');
  assert.ok(!allowed.includes(`mcp__res_browser_${BROWSER_KEY}__click`) && !allowed.includes(`mcp__res_browser_${BROWSER_KEY}__evaluate`), 'nada de interact ni full en read');
  assert.ok(flagValue(spawn.argv, '--disallowedTools').includes(`mcp__res_browser_${BROWSER_KEY}__session`), 'session, negada');
  assert.equal(JSON.parse(plan.runs[String((browserFx('prompt-read-browser-read').run as { id: number }).id)]!.status[0]!).status, 'done');
  assert.deepEqual(plan.left.runConfig.filter((f) => f.startsWith('browser-')), [], 'la copia se tira al cerrar');
  assert.deepEqual(vaultCookies(name).sort(), ['other', 'sid'], 'sin exclusiva no vuelve nada al vault');
});

test('navegador: una sesión exclusiva devuelve al vault lo que el run cambió; el vault, negado a un kit de edición', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const name = 'browser/edit-exclusive';
  await runCase({ name, raw: browserFx('prompt-edit-browser-full'), cfg: withBrowser(true) });
  const [spawn] = browserSpawns(name);
  assert.ok(spawn);
  const server = (JSON.parse(spawn.mcp) as { mcpServers: Record<string, { env: Record<string, string> }> }).mcpServers[`res_browser_${BROWSER_KEY}`]!;
  assert.ok(server.env.ODYSEA_AUTOSAVE_MS, 'exclusiva: odysea autoguarda la copia');
  const allowed = flagValue(spawn.argv, '--allowedTools');
  assert.ok(allowed.includes(`mcp__res_browser_${BROWSER_KEY}__evaluate`), 'full en edición');
  // el vault en el deny de un kit de edición (no solo en los de lectura).
  const vault = path.join(caseDir(name), 'vault');
  assert.ok(flagValue(spawn.argv, '--disallowedTools').some((r) => r.startsWith('Read(/') && r.includes(`${fs.realpathSync(vault)}/**`)), 'el vault, negado a Read en edición');
  assert.deepEqual(vaultCookies(name).sort(), ['other', 'rotated', 'sid'], 'lo que el run guardó vuelve al vault; lo de otros sitios del vault se queda');
});

test('navegador: una sesión que no sirve (caducada) hace fallar el run sin lanzarlo; una sin mapear, degrada', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});
  const expired = { ...VAULT_STATE, cookies: [{ name: 'sid', value: 's1', domain: 'acme.atlassian.net', path: '/', expires: 1 }] };
  const raw = browserFx('prompt-read-browser-read');
  const runId = (raw.run as { id: number }).id;
  const plan = (await runCase({
    name: 'browser/expired',
    raw,
    cfg: (c, dir) => {
      const cfg = withBrowser(false)(c, dir);
      fs.writeFileSync(path.join(dir, 'vault', `${BROWSER_KEY}.json`), JSON.stringify(expired));
      return cfg;
    },
  })) as { spawns: unknown[]; runs: Record<string, { status: string[] }> };
  assert.equal(plan.spawns.length, 0, 'no se lanza');
  assert.match(JSON.parse(plan.runs[String(runId)]!.status[0]!).error, /^no se pudo preparar el run: recurso browser jira no disponible \(expired\)/);
  // la sesión expuesta pero sin entrada en la config de esta máquina: el run sigue sin navegador, con su aviso.
  const unmapped = (await runCase({
    name: 'browser/unmapped',
    raw,
    cfg: (c) => ({ ...c, version: 2, platforms: { duckhunt: { expose: { repo: '*', aws: '*', browser: '*' } } } }) as unknown as RunnerConfig,
  })) as { spawns: { mcp: string }[]; runs: Record<string, { feed: { body: string }[] }> };
  assert.equal(unmapped.spawns.length, 1);
  assert.ok(!unmapped.spawns[0]!.mcp.includes('res_browser_'));
  assert.ok(unmapped.runs[String(runId)]!.feed.some((e) => e.body.includes('no mapeada en este runner')));
});

// --- lectura de objetos s3 (t#495, 0.13.0): fuera del golden ---

const S3_SCOPE = 'acme-alb-logs/AWSLogs/';
const withS3Read = (c: RunnerConfig): RunnerConfig => ({ ...c, aws: { ...c.aws, [ACCOUNT]: { ...c.aws[ACCOUNT]!, s3Read: [S3_SCOPE] } } });
type McpConfigFile = { mcpServers: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }> };

test('lectura s3: con s3Read y el render, su servidor res_aws_<cuenta> y la tool en el allow; con el interruptor, ni una ni otra', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const name = 's3/render';
  const render = (await runCase({ name, raw: withToolset('template-full-aws-announced', 980), cfg: withS3Read, awsCli: true })) as FlipPlan;
  const [spawn] = browserSpawns(name);
  assert.ok(flagValue(spawn!.argv, '--allowedTools').includes(`mcp__res_aws_${ACCOUNT}__s3_read`), 'la tool, en el allow');
  const server = (JSON.parse(spawn!.mcp) as McpConfigFile).mcpServers[`res_aws_${ACCOUNT}`];
  assert.ok(server, 'su servidor, en el mcp-config del run');
  assert.deepEqual([server.command, server.args?.at(-1)], [process.execPath, 'mcp-s3']);
  assert.equal(server.env?.AWS_PROFILE, 'okt-prod', 'con la aws del run');
  assert.ok(render.runs['980']!.feed.some((e) => e.body === `lectura de objetos s3 de ${ACCOUNT}: ${S3_SCOPE}`));
  // con el interruptor del flip (las listas del server): ni la tool ni el servidor, con una nota.
  const offName = 's3/render-off';
  const off = (await runCase({ name: offName, raw: withRun(kit('template-full-aws-announced'), { id: 981 }), cfg: (c) => renderOff(withS3Read(c)), awsCli: true })) as FlipPlan;
  const [offSpawn] = browserSpawns(offName);
  assert.ok(!flagValue(offSpawn!.argv, '--allowedTools').some((tool) => tool.endsWith('__s3_read')));
  assert.ok(!offSpawn!.mcp.includes('res_aws_'));
  assert.ok(off.runs['981']!.feed.some((e) => e.body.includes('no se ofrece: solo con el render del daemon')));
});
