// auditoría local por plataforma (t#495, M6.6): un run de verdad (claude falso) deja `claimed` y `closed` en
// <runnerHome>/audit/<id>/ (0600 en 0700) sin el prompt, el resultado, los argumentos de las tools, paths ni tokens; un
// claim rechazado deja `rejected` con su código; la línea nunca pasa de 4 KB; la retención y el tope por plataforma;
// la cuota diaria que sale de ella (estado budget hasta medianoche); la cli `audit`, `status --platforms` y el prefijo
// del log de una plataforma que no es la legacy.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, test, type TestContext } from 'node:test';
import { auditCommand, parseSince } from '../src/audit-cli.js';
import { AUDIT_EVENT, AUDIT_LINE_MAX_BYTES, AuditLog, auditLine, claimedRecord, closedRecord, DAY_MS, monthOf, pruneAudit, readAudit, type AuditRecord, type ClosedRecord } from '../src/audit.js';
import { parseClaim, type ClaimResponse } from '../src/claim.js';
import { OPTIONAL_FLAGS } from '../src/claude.js';
import { configPath, loadConfig, loadStoredConfig, runnerHome, type RunnerConfig } from '../src/config.js';
import { auditPath } from '../src/paths.js';
import { CLAIM_RESULT } from '../src/platforms/platform.js';
import { PLATFORM_STATE } from '../src/platforms/supervisor.js';
import { RunLease } from '../src/run-lease.js';
import { writeServerState } from '../src/server-state.js';
import { platformsStatus } from '../src/status.js';
import { internals, legacyOf, type DaemonInternals, type SupervisorInternals } from './daemon-harness.js';
import { fakeFactories, type FakePlatform } from './fake-platform.js';

const FIXTURES = new URL('../../test/fixtures/', import.meta.url);
// lo que nunca puede acabar en la auditoría.
const MARKER = { prompt: 'PROMPT_MARKER_4f1', arg: 'ARG_MARKER_9c2', result: 'RESULT_MARKER_77a', token: 'TOKEN_MARKER_b0e', checkout: 'CHECKOUT_MARKER_d31' } as const;
const COST_USD = 0.42;
const TURNS = 3;
const realPath = process.env.PATH;
let root = '';
let bin = '';
let dir = '';

const cfg = (extra: Partial<RunnerConfig> = {}): RunnerConfig => ({
  baseUrl: 'https://duckhunt.test',
  clientId: 'c1',
  refreshToken: 'r1',
  label: 'fa',
  machineId: 'm-1',
  repos: { 'okt/api': { path: path.join(dir, MARKER.checkout) } },
  aws: {},
  defaults: { maxConcurrent: 2 },
  ...extra,
});
const entry = (id: string, extra: object = {}): object => ({ protocol: 'duckhunt-42', trusted: true, credential: { baseUrl: `https://${id}.test`, clientId: `${id}-1`, refreshToken: 'r' }, ...extra });
const write = (platforms: object | null): void =>
  fs.writeFileSync(configPath(), JSON.stringify(platforms === null ? cfg() : { ...cfg(), version: 2, platforms }), { mode: 0o600 });

async function daemon(t: TestContext, platforms: object | null): Promise<{ d: DaemonInternals; created: Map<string, FakePlatform> }> {
  write(platforms);
  const { factories, created } = fakeFactories();
  const d = internals(loadConfig()!, { factories });
  await d.reloadConfig();
  (d as unknown as { claude: unknown }).claude = { version: '2.1.296', supported: new Set(OPTIONAL_FLAGS) };
  return { d, created };
}

// el claim de los fixtures con un prompt, un token y un servidor que se reconocen si se cuelan.
const markedClaim = (): ClaimResponse => {
  const claim = parseClaim(JSON.parse(fs.readFileSync(new URL('claim-kits/prompt-read-full.json', FIXTURES), 'utf8')) as unknown);
  return { ...claim, prompt: `${MARKER.prompt} mira el repo`, mcp: { ...claim.mcp, token: MARKER.token } };
};

const records = (platform: string): AuditRecord[] => readAudit(0, platform);

// toda cadena del registro: ninguna puede ser un path absoluto.
const strings = (v: unknown): string[] =>
  typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...strings(x)]) : [];

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'duckhunt-runner-audit-'));
  bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  // claude falso: dos Bash y un Read con argumentos marcados, y un resultado marcado.
  const lines = [
    { type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-test', tools: [] },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'miro' },
          { type: 'tool_use', name: 'Bash', input: { command: `cat /etc/${MARKER.arg}` } },
          { type: 'tool_use', name: 'Read', input: { file_path: `/home/u/${MARKER.arg}` } },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        ],
      },
    },
    { type: 'result', subtype: 'success', is_error: false, result: MARKER.result, total_cost_usd: COST_USD, num_turns: TURNS, session_id: 's-1' },
  ];
  fs.writeFileSync(path.join(bin, 'claude'), `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(lines.map((l) => JSON.stringify(l)).join('\n'))} + '\\n');\n`, { mode: 0o755 });
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(root, 'case-'));
  process.env.DUCKHUNT_RUNNER_CONFIG = path.join(dir, 'runner.json');
  process.env.DUCKHUNT_RUNNER_HOME = path.join(dir, 'home');
  process.env.PATH = `${bin}${path.delimiter}${realPath}`;
});

afterEach(() => {
  process.env.PATH = realPath;
  process.exitCode = 0;
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('un run de verdad: claimed y closed con lo que dice la cabecera, y nada del prompt, el resultado, los argumentos, paths ni tokens', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { d } = await daemon(t, { beta: entry('beta') });
  const claim = markedClaim();
  await d.executeRun(legacyOf(d), claim, new RunLease(claim.run.id));
  await d.executeRun(d.supervisors.get('beta')!, claim, new RunLease(claim.run.id));

  const file = path.join(auditPath('duckhunt'), `${monthOf(Date.now())}.jsonl`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(auditPath('duckhunt')).mode & 0o777, 0o700);
  const text = fs.readFileSync(file, 'utf8');
  [...Object.values(MARKER), claim.mcp.url, runnerHome(), dir, os.homedir()].forEach((m) => assert.ok(!text.includes(m), `la auditoría no lleva ${m}`));
  text
    .trim()
    .split('\n')
    .forEach((line) => {
      assert.ok(Buffer.byteLength(line) < AUDIT_LINE_MAX_BYTES);
      assert.deepEqual(strings(JSON.parse(line)).filter((s) => s.startsWith('/')), [], 'ni un path');
    });

  const [claimed, closed] = records('duckhunt');
  assert.equal(claimed?.event, AUDIT_EVENT.claimed);
  assert.equal(closed?.event, AUDIT_EVENT.closed);
  if (claimed?.event !== AUDIT_EVENT.claimed || closed?.event !== AUDIT_EVENT.closed) return;
  assert.deepEqual(
    [claimed.platform, claimed.protocol, claimed.runId, claimed.segment, claimed.kind, claimed.profile, claimed.promptSha256],
    ['duckhunt', 'duckhunt-42', '31', 1, 'prompt', 'read', createHash('sha256').update(claim.prompt).digest('hex')],
  );
  assert.deepEqual(claimed.grants, [{ type: 'repo', key: 'okt/api', access: 'read' }]);
  assert.deepEqual([claimed.mcpServers, claimed.toolset], [['duckhunt'], null]);
  assert.ok(claimed.attestations.length > 0);
  assert.deepEqual(closed.outcome, { status: 'done', code: null });
  assert.deepEqual([closed.costUsd, closed.numTurns, closed.model], [COST_USD, TURNS, 'claude-test']);
  assert.deepEqual(closed.toolCalls, { total: 3, byTool: { Bash: 2, Read: 1 } });
  assert.deepEqual(closed.materialized, [{ type: 'repo', key: 'okt/api', degraded: true, isolated: false }], 'el checkout no está: corrió en el scratch');
  assert.ok(closed.durationMs >= 0 && closed.lockWaitMs >= 0 && closed.endedAt >= closed.startedAt);

  // beta: su propia auditoría, la aws aislada y el log con su id; la legacy con el prefijo de siempre.
  const betaClosed = records('beta').find((r): r is ClosedRecord => r.event === AUDIT_EVENT.closed);
  assert.deepEqual(betaClosed?.materialized, [
    { type: 'aws', key: null, degraded: false, isolated: true },
    { type: 'repo', key: 'okt/api', degraded: true, isolated: false },
  ]);
  const lines = log.mock.calls.map((c) => String(c.arguments[0]));
  assert.ok(lines.some((l) => l.startsWith('[runner] run 31 reclamado')));
  assert.ok(lines.some((l) => l.startsWith('[runner:beta] run 31 reclamado')));
  assert.ok(lines.some((l) => l.startsWith('[runner:beta] run 31 terminado (done)')));
  assert.ok(!lines.some((l) => l.startsWith('[runner:duckhunt]')), 'la legacy nunca lleva id');
});

test('un claim rechazado deja `rejected` con el código del runner; uno legacy que no parsea, claim_invalid', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { d, created } = await daemon(t, { beta: entry('beta') });
  const said = { state: 'claimed', runner: null };
  created.get('beta')!.claims = [
    { kind: CLAIM_RESULT.invalid, runId: 'r_9', error: 'claim rechazado por el runner (resource_not_exposed: grant de repo okt/x: no está expuesto a esta plataforma)', said, commandsPending: false },
  ];
  created.get('duckhunt')!.claims = [{ kind: CLAIM_RESULT.invalid, runId: '12', error: 'claim inválido: run sin entryId', said, commandsPending: false }];
  await d.pollOnce(d.supervisors.get('beta')!);
  await d.pollOnce(legacyOf(d));
  assert.deepEqual(
    [...records('beta'), ...records('duckhunt')].map((r) => (r.event === AUDIT_EVENT.rejected ? [r.platform, r.runId, r.code] : r.event)),
    [
      ['beta', 'r_9', 'resource_not_exposed'],
      ['duckhunt', '12', 'claim_invalid'],
    ],
  );
});

test('la línea nunca pasa de 4 KB: se recorta lo largo antes que partirla', () => {
  const long = (i: number): string => `${'x'.repeat(70)}-${i}`;
  const claim = markedClaim();
  const base = { platform: 'beta', protocol: 'agent-runner/0', at: Date.now() };
  const closed = closedRecord(base, claim, {
    startedAt: Date.now(),
    lockWaitMs: 0,
    materialized: Array.from({ length: 30 }, (_, i) => ({ type: long(i), key: long(i), degraded: false, isolated: false })),
    report: { status: 'done', toolCalls: 99 },
    toolsByName: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [long(i), i])),
    code: null,
  });
  const line = auditLine(closed);
  assert.ok(Buffer.byteLength(line) <= AUDIT_LINE_MAX_BYTES);
  assert.deepEqual((JSON.parse(line) as ClosedRecord).outcome, { status: 'done', code: null }, 'lo esencial queda');
  const claimed = claimedRecord(base, claim, { grants: Array.from({ length: 40 }, (_, i) => ({ type: long(i), key: long(i), access: 'read', params: {} })), toolset: null, attestations: [] });
  assert.ok(Buffer.byteLength(auditLine(claimed)) <= AUDIT_LINE_MAX_BYTES);
});

test('retención: fuera los meses que acabaron antes del corte y, sobre el tope, los más viejos; el último nunca', () => {
  const now = new Date(2026, 9, 20).getTime();
  const at = (id: string, files: Record<string, number>): void => {
    fs.mkdirSync(auditPath(id), { recursive: true });
    Object.entries(files).forEach(([f, size]) => fs.writeFileSync(path.join(auditPath(id), f), 'x'.repeat(size)));
  };
  at('duckhunt', { '2026-07.jsonl': 1, '2026-08.jsonl': 1, '2026-09.jsonl': 1, '2026-10.jsonl': 1 });
  at('beta', { '2026-08.jsonl': 100, '2026-09.jsonl': 100, '2026-10.jsonl': 100 });
  at('gamma', { '2026-10.jsonl': 500 });
  // duckhunt: julio y agosto por la retención; beta: agosto por la retención y septiembre por el tope.
  assert.equal(pruneAudit(now, 40, 150), 4);
  assert.deepEqual(fs.readdirSync(auditPath('duckhunt')).sort(), ['2026-09.jsonl', '2026-10.jsonl'], 'julio y agosto acabaron antes del corte');
  assert.deepEqual(fs.readdirSync(auditPath('beta')), ['2026-10.jsonl'], 'sobre el tope, los más viejos');
  assert.deepEqual(fs.readdirSync(auditPath('gamma')), ['2026-10.jsonl'], 'el último, aunque pase del tope');
});

test('cuota del día: agotada (segmentos o coste), no reclama y queda en budget; al día siguiente vuelve', async (t) => {
  t.mock.method(console, 'log', () => {});
  const now = new Date(2026, 9, 20, 12).getTime();
  t.mock.timers.enable({ apis: ['Date'], now });
  const claim = markedClaim();
  const log = new AuditLog();
  log.append(claimedRecord({ platform: 'beta', protocol: 'duckhunt-42', at: now - 1000 }, claim, { grants: [], toolset: null, attestations: [] }));
  log.append(closedRecord({ platform: 'gamma', protocol: 'duckhunt-42', at: now - 1000 }, claim, { startedAt: now - 2000, lockWaitMs: 0, materialized: [], report: { status: 'done', costUsd: 0.6 }, toolsByName: {}, code: null }));
  const { d, created } = await daemon(t, { beta: entry('beta', { runsPerDay: 1 }), gamma: entry('gamma', { budgetUsdPerDay: 0.5 }) });
  const [beta, gamma] = [d.supervisors.get('beta')!, d.supervisors.get('gamma')!];
  assert.equal(await d.pollOnce(beta), false);
  assert.equal(await d.pollOnce(gamma), false);
  assert.deepEqual([beta.state, gamma.state], [PLATFORM_STATE.budget, PLATFORM_STATE.budget]);
  assert.deepEqual([created.get('beta')!.announces.length, created.get('gamma')!.announces.length], [0, 0], 'ni reclaman');
  assert.equal((beta as unknown as { claiming: boolean }).claiming, false);
  t.mock.timers.setTime(now + DAY_MS);
  await d.pollOnce(beta);
  assert.equal(beta.state, PLATFORM_STATE.active, 'otro día, con cuota');
  assert.equal(created.get('beta')!.announces.length, 1);
});

test('cli `audit`: tabla, jsonl y filtros por plataforma y desde cuándo; uso con flags que no existen', (t) => {
  const out = t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  const now = Date.now();
  const claim = markedClaim();
  const log = new AuditLog();
  log.append(claimedRecord({ platform: 'duckhunt', protocol: 'duckhunt-42', at: now - 10 * DAY_MS }, claim, { grants: [], toolset: null, attestations: [] }));
  log.append(claimedRecord({ platform: 'beta', protocol: 'duckhunt-42', at: now - 1000 }, claim, { grants: [{ type: 'repo', key: 'okt/api', access: 'read', params: {} }], toolset: null, attestations: [] }));
  log.append(closedRecord({ platform: 'beta', protocol: 'duckhunt-42', at: now }, claim, { startedAt: now - 5000, lockWaitMs: 0, materialized: [], report: { status: 'failed' }, toolsByName: { Bash: 2 }, code: 'timeout' }));
  auditCommand(['--json', '--platform', 'beta'], now);
  assert.deepEqual(out.mock.calls.map((c) => (JSON.parse(String(c.arguments[0])) as AuditRecord).event), ['claimed', 'closed']);
  out.mock.resetCalls();
  auditCommand([], now);
  const table = out.mock.calls.map((c) => String(c.arguments[0]));
  assert.match(table[0]!, /^hora\s+plataforma\s+run/);
  assert.equal(table.length, 3, 'la de hace 10 días queda fuera de los 7 de por defecto');
  assert.ok(table.some((l) => l.includes('repo:okt/api(read)')) && table.some((l) => l.includes('failed (timeout)') && l.includes('Bash×2')));
  out.mock.resetCalls();
  auditCommand(['--since', '30d'], now);
  assert.equal(out.mock.calls.length, 4);
  auditCommand(['--nope'], now);
  assert.equal(process.exitCode, 1);
  assert.equal(parseSince('2026-10-01', now), new Date(2026, 9, 1).getTime());
  assert.equal(parseSince('mañana', now), null);
});

test('`status --platforms`: cada plataforma con su estado, lo que dijo su server, su cuota, su techo, lo expuesto y sus 24 h', () => {
  const now = Date.now();
  write({ beta: entry('beta', { paused: true, runsPerDay: 5, slots: 1, expose: { repo: ['okt/api'] } }) });
  writeServerState({ at: now - 60_000, baseUrl: 'https://duckhunt.test', clientId: 'c1', state: null, runner: null, kept: null }, 'duckhunt');
  const claim = markedClaim();
  const log = new AuditLog();
  log.append(claimedRecord({ platform: 'beta', protocol: 'duckhunt-42', at: now - 1000 }, claim, { grants: [], toolset: null, attestations: [] }));
  log.append(closedRecord({ platform: 'beta', protocol: 'duckhunt-42', at: now }, claim, { startedAt: now - 1000, lockWaitMs: 0, materialized: [], report: { status: 'failed', costUsd: 0.25 }, toolsByName: {}, code: 'exit_code' }));
  const lines = platformsStatus(loadStoredConfig()!, [{ issue: { repo: 'okt/api', kind: 'missing' }, detail: 'okt/api: el checkout no existe' }], now);
  const at = (prefix: string): number => lines.findIndex((l) => l.startsWith(prefix));
  assert.ok(at('duckhunt · duckhunt-42 · https://duckhunt.test · credencial sí · trusted') >= 0, lines.join('\n'));
  assert.ok(lines.includes('  estado: activa'));
  assert.ok(lines.some((l) => l.startsWith('  en duckhunt: hace 60 s')));
  const beta = at('beta · duckhunt-42 · https://beta.test · credencial sí · trusted');
  assert.ok(beta > 0);
  const block = lines.slice(beta + 1);
  [
    '  estado: en pausa (la config): no reclama, sus runs siguen',
    '  en beta: sin datos (el daemon aún no ha reclamado con esta credencial)',
    '  cuota: 1 slot (de 2) · hoy 1/5 segmentos · 0.25 usd',
    '  techo: shell none · escritura no · memoria no · web no · push no · acceso ninguno',
    '  expuesto: repo okt/api · aws nada',
    '  avisos: 1',
    '  24 h: 1 segmentos · 1 fallidos · 0 rechazados · 0.25 usd',
  ].forEach((line) => assert.ok(block.includes(line), `${line}\n---\n${block.join('\n')}`));
  assert.ok(block.some((l) => l.startsWith('    ⚠ okt/api: ')), 'el aviso del repo que ve');
});
