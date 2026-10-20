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
// pedir esperar a un fichero (HOLD:<f>) o fallar (FAIL); --resume gone simula una sesión que no está.
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
fs.appendFileSync(path.join(caseDir, 'spawns.jsonl'), JSON.stringify({ argv: args, cwd: process.cwd(), env: process.env, mcp: fs.readFileSync(mcpFile, 'utf8') }) + '\\n');
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
}

interface DaemonInternals extends Harness {
  claude: ClaudeInfo;
  secretDeny: string[];
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
  // lo que hace run() al arrancar, sin el loop ni las señales.
  d.claude = claude;
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
